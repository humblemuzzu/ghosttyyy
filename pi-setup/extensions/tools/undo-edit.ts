/**
 * undo_edit tool — reverts the last edit made to a file.
 *
 * uses lib/file-tracker's disk-based change records to find and
 * revert the most recent non-reverted change for a given file.
 *
 * branch awareness: scans the current session branch (via
 * sessionManager.getBranch()) to extract tool call IDs, then
 * only considers changes from those IDs. this prevents undoing
 * edits from a different conversation branch.
 *
 * mutex-locked to prevent concurrent undo + edit on the same file.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	findLatestChange,
	findMovePartner,
	loadChanges,
	reapplyChange,
	revertChange,
	simpleDiff,
	type FileChange,
} from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";
import { boxRendererWindowed, textSection, osc8Link, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";

const COLLAPSED_EXCERPTS: Excerpt[] = [
	{ focus: "head" as const, context: 3 },
	{ focus: "tail" as const, context: 5 },
];

/**
 * extract tool call IDs from the current session branch.
 * session entries with type "message" and role "assistant" carry the
 * assistant's tool calls as content blocks of type "toolCall" (pi's
 * normalized format). we collect all tool call IDs so findLatestChange
 * can filter to only branch-visible changes.
 *
 * falls back to empty array if getBranch() isn't available (e.g.,
 * running in a context where session tree access is restricted).
 */
function getActiveToolCallIds(sessionManager: any): string[] {
	try {
		const branch = sessionManager.getBranch?.();
		if (!Array.isArray(branch)) return [];

		const ids: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg?.role !== "assistant") continue;

			// pi normalizes every provider's assistant tool calls into CONTENT
			// BLOCKS of type "toolCall" — { type: "toolCall", id, name, arguments }.
			// This is pi's own stable internal format (not a provider wire format
			// like anthropic "tool_use" or openai "tool_calls"), so matching it is
			// exact and complete. The previous code matched only "tool_use" /
			// "tool_calls" and therefore NEVER matched — that was the root bug.
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block && typeof block === "object" && block.type === "toolCall" && block.id) {
						ids.push(block.id);
					}
				}
			}
		}
		return ids;
	} catch {
		return [];
	}
}

export function createUndoEditTool(): ToolDefinition {
	return {
		name: "undo_edit",
		label: "Undo Edit",
		description:
			"Undo the last change made to a file.\n\n" +
			"By default this reverts the WHOLE change that last touched the file — so undoing " +
			"one file of a multi-file apply_patch call rolls back every file that call wrote, " +
			"and undoing a move restores the file to its original path. Pass scope: \"file\" to " +
			"revert only the named path.\n\n" +
			"Returns a diff showing what was undone. Use redo_edit to put it back.",

		parameters: Type.Object({
			path: Type.String({
				description:
					"The absolute path to the file whose last edit should be undone (must be absolute, not relative).",
			}),
			scope: Type.Optional(
				Type.Union([Type.Literal("call"), Type.Literal("file")], {
					description:
						'"call" (default) reverts every file written by the change that last touched this path; "file" reverts only this path.',
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			text.setText(theme.fg("toolTitle", theme.bold("Undo ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text("(no output)", 0, 0));
				return container;
			}
			const renderer = boxRendererWindowed(
				() => [textSection(undefined, content.text)],
				{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
			);
			container.addChild(renderer);
			return container;
		},

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const activeIds = getActiveToolCallIds(ctx.sessionManager);

				if (activeIds.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "no edits found to undo (no tool calls in current branch).",
							},
						],
						isError: true,
					} as any;
				}

				const latest = findLatestChange(sessionId, resolved, activeIds);
				if (!latest) {
					return {
						content: [
							{
								type: "text" as const,
								text: `no edits found to undo for ${path.basename(resolved)}.`,
							},
						],
						isError: true,
					} as any;
				}

				/*
				 * UNDO IS A STACK, NOT RANDOM ACCESS.
				 *
				 * Reaching past a newer change produces a state nobody can reason
				 * about. grok-4.5's example: create A and C in one batch, later
				 * move A to B, then undo the create batch. Undoing a creation
				 * means "delete it" — but A is not there any more, so the delete
				 * is a no-op and the content lives on at B, with its creation
				 * history marked undone. Not data loss, but an incoherent state,
				 * and incoherent is how data loss starts.
				 *
				 * So: refuse when a LATER still-applied change touches any path
				 * this undo would revert, and name what to undo first. This is
				 * exactly the invalidation rule `redo_edit` uses, pointed the
				 * other way — undo and redo now agree on what "newer" means.
				 *
				 * Independent work is unaffected: editing A then B leaves no
				 * later change on A, so undoing A is still allowed.
				 */
				const scopeIsFile = (params as any).scope === "file";
				const targetUris = new Set(
					loadChanges(sessionId, latest.toolCallId)
						.filter((c) => !c.reverted && (!scopeIsFile || c.uri === latest.change.uri))
						.map((c) => c.uri),
				);
				/*
				 * ORDER COMES FROM THE BRANCH, NOT FROM `timestamp`.
				 *
				 * `Date.now()` is millisecond-resolution, so two tool calls in
				 * quick succession can carry the SAME timestamp — and a
				 * strictly-greater comparison then reads them as concurrent and
				 * lets the undo through. `activeIds` is the branch in order, so a
				 * later index is later in time by construction, with no clock to
				 * be wrong about.
				 */
				const targetIndex = activeIds.lastIndexOf(latest.toolCallId);
				const blockedBy = new Set<string>();
				for (let i = targetIndex + 1; i < activeIds.length; i++) {
					for (const change of loadChanges(sessionId, activeIds[i]!)) {
						if (change.reverted || !targetUris.has(change.uri)) continue;
						blockedBy.add(path.basename(change.uri.replace(/^file:\/\//, "")));
					}
				}
				if (blockedBy.size > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`cannot undo that change: something newer has since modified ${[...blockedBy].join(", ")}. ` +
									`Undo the newer change first, or the result would be a file whose history says it was ` +
									`never created while its content still exists somewhere.`,
							},
						],
						isError: true,
					} as any;
				}

				/*
				 * WHOLE-CALL UNDO IS THE DEFAULT.
				 *
				 * one apply_patch call is one logical change, and the records were
				 * always grouped by tool call on disk — but undo only ever reverted
				 * a single path, so a 7-file batch needed 7 undos and a move needed
				 * exactly the right 2 (getting it wrong lost the file). Reverting
				 * the call is what "undo that" has always meant to whoever typed
				 * it, and it makes the move case correct by construction rather
				 * than by pairing heuristics.
				 */
				if ((params as any).scope !== "file") {
					const siblings = loadChanges(sessionId, latest.toolCallId).filter((c) => !c.reverted);
					// newest first: a batch may write the same path more than once
					const ordered = [...siblings].sort((a, b) => b.timestamp - a.timestamp);
					const undone: string[] = [];
					for (const change of ordered) {
						if (revertChange(sessionId, latest.toolCallId, change.id)) {
							undone.push(change.uri.replace(/^file:\/\//, ""));
						}
					}
					if (undone.length > 0) {
						const target = latest.change;
						const diff = simpleDiff(path.basename(resolved), target.after, target.before);
						const others = undone.filter((p) => p !== resolved);
						const note =
							others.length > 0
								? `\n\n(this was one change across ${undone.length} files — also restored: ${others
										.map((p) => path.basename(p))
										.join(", ")})`
								: "";
						return {
							content: [{ type: "text" as const, text: diff + note }],
							details: { header: resolved },
						} as any;
					}
				}

				const reverted = revertChange(sessionId, latest.toolCallId, latest.change.id);
				if (!reverted) {
					return {
						content: [
							{
								type: "text" as const,
								text: `failed to revert — change may have already been undone.`,
							},
						],
						isError: true,
					} as any;
				}

				// show reverse diff (after → before)
				const diff = simpleDiff(
					path.basename(resolved),
					reverted.after,
					reverted.before,
				);

				let result = diff;
				// beforeExists is authoritative when present (apply_patch records it);
				// older records only have isNewFile.
				const existedBefore = reverted.beforeExists ?? !reverted.isNewFile;
				if (!existedBefore) {
					result += `\n\n(file was created by the reverted edit — file removed)`;
				} else if (reverted.afterExists === false) {
					result += `\n\n(file was deleted by the reverted edit — file restored)`;
				}

				/*
				 * UNDO A MOVE AS ONE OPERATION, NOT TWO HALVES.
				 *
				 * a move is recorded as a deletion at the source plus a creation
				 * at the destination. undoing one half alone is destructive both
				 * ways: revert the destination and the file is gone from both
				 * places; revert the source and it exists twice. so reverting
				 * either half reverts its partner, which is what "undo the move"
				 * has always meant to whoever typed it.
				 */
				const pairing = findMovePartner(sessionId, latest.toolCallId, reverted);
				if (pairing.partner) {
					const partnerPath = pairing.partner.uri.replace(/^file:\/\//, "");
					const undonePartner = revertChange(sessionId, latest.toolCallId, pairing.partner.id);
					result += undonePartner
						? `\n(this was a move — its other half was reverted too: ${path.basename(partnerPath)})`
						: `\n(WARNING: this was a move, but its other half at ${partnerPath} could not be reverted — check both paths)`;
				} else if (pairing.ambiguous.length > 0) {
					// only reachable for records written before movePartnerUri
					// existed. saying nothing here is what made this look like data
					// loss: the file is recoverable, but only if you know to look.
					result +=
						`\n(WARNING: this looks like half of a move, but ${pairing.ambiguous.length} files in that change ` +
						`hold identical content so the other half cannot be identified. ` +
						`If a file seems missing, undo one of these too: ${pairing.ambiguous.join(", ")})`;
				}

				return { content: [{ type: "text" as const, text: result }], details: { header: resolved } } as any;
			});
		},
	};
}

/**
 * the undone change sitting DIRECTLY on top of the file's current state.
 *
 * REDO POPS THE BOTTOM OF THE UNDONE RUN, NOT THE TIP.
 *
 * undo removes from the top of the applied stack, and it now refuses to reach
 * past a newer change — so the undone changes for a path are always a
 * contiguous run at the top. The one to put back first is therefore the
 * OLDEST of that run: the step the file would take next.
 *
 * Scanning newest-first instead (which this did at first) jumps straight to
 * the tip and silently skips every middle step: with L1→L2→L3 undone twice
 * down to L1, one redo produced L3 and reported the diff as L2→L3 while the
 * file said L1. Reported by grok-4.5.
 *
 * the mirror of `findLatestChange`, which filters reverted records OUT.
 */
function findRedoCandidate(
	sessionId: string,
	filePath: string,
	activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
	const uri = `file://${path.resolve(filePath)}`;
	for (const toolCallId of activeToolCallIds) {
		const match = loadChanges(sessionId, toolCallId)
			.filter((c) => c.reverted && c.uri === uri)
			.sort((a, b) => a.timestamp - b.timestamp)[0];
		if (match) return { toolCallId, change: match };
	}
	return null;
}

export function createRedoEditTool(): ToolDefinition {
	return {
		name: "redo_edit",
		label: "Redo Edit",
		description:
			"Re-apply a change that undo_edit reverted.\n\n" +
			"Redoes the whole change, matching undo_edit's default scope: if the undo restored " +
			"several files, the redo re-applies all of them. Repeated calls walk back up one " +
			"step at a time, in the order the undos happened.\n\n" +
			"Refused if the file has been changed since it was undone — the recorded content is " +
			"stale by then, and writing it would silently discard the newer work.",

		parameters: Type.Object({
			path: Type.String({
				description: "The absolute path to the file whose undone change should be re-applied.",
			}),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			text.setText(theme.fg("toolTitle", theme.bold("Redo ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text("(no output)", 0, 0));
				return container;
			}
			container.addChild(
				boxRendererWindowed(() => [textSection(undefined, content.text)], {
					collapsed: { excerpts: COLLAPSED_EXCERPTS },
					expanded: {},
				}),
			);
			return container;
		},

		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const activeIds = getActiveToolCallIds(ctx.sessionManager);
				const fail = (text: string) =>
					({ content: [{ type: "text" as const, text }], isError: true }) as any;

				if (activeIds.length === 0) {
					return fail("nothing to redo (no tool calls in current branch).");
				}

				const candidate = findRedoCandidate(sessionId, resolved, activeIds);
				if (!candidate) {
					return fail(`nothing to redo for ${path.basename(resolved)}.`);
				}

				/*
				 * THE ONLY RULE THAT MAKES REDO SAFE.
				 *
				 * Redo writes bytes recorded BEFORE the undo. If anything has
				 * edited this path since, those bytes describe a state that no
				 * longer follows from the current file, and re-applying them
				 * silently discards the newer work. This is the classic
				 * redo-invalidation trap, and getting it wrong is worse than
				 * having no redo at all — which is why there wasn't one until the
				 * check existed.
				 */
				// branch order, not `timestamp`, for the same reason undo uses it:
				// two calls in one millisecond share a timestamp and would read
				// as concurrent.
				const uri = `file://${path.resolve(resolved)}`;
				const candidateIndex = activeIds.lastIndexOf(candidate.toolCallId);
				for (let i = candidateIndex + 1; i < activeIds.length; i++) {
					for (const change of loadChanges(sessionId, activeIds[i]!)) {
						if (change.uri !== uri || change.reverted) continue;
						return fail(
							`cannot redo ${path.basename(resolved)}: it has been changed since that undo, ` +
								`so re-applying would discard the newer edit. Make the change again instead.`,
						);
					}
				}

				// oldest first, so a call that wrote the same path twice ends on
				// its final state rather than its first.
				const siblings = loadChanges(sessionId, candidate.toolCallId)
					.filter((c) => c.reverted)
					.sort((a, b) => a.timestamp - b.timestamp);

				const redone: string[] = [];
				for (const change of siblings) {
					if (reapplyChange(sessionId, candidate.toolCallId, change.id)) {
						redone.push(change.uri.replace(/^file:\/\//, ""));
					}
				}
				if (redone.length === 0) return fail(`nothing to redo for ${path.basename(resolved)}.`);

				const diff = simpleDiff(
					path.basename(resolved),
					candidate.change.before,
					candidate.change.after,
				);
				const others = redone.filter((p) => p !== resolved);
				const note =
					others.length > 0
						? `\n\n(re-applied ${redone.length} files — also: ${others
								.map((p) => path.basename(p))
								.join(", ")})`
						: "";
				return {
					content: [{ type: "text" as const, text: diff + note }],
					details: { header: resolved },
				} as any;
			});
		},
	};
}
