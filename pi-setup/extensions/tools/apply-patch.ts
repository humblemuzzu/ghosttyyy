/**
 * apply_patch — apply a Codex-format patch envelope as one validated batch.
 *
 * PROVENANCE
 * ported from bdsqqq/dots `user/pi/packages/extensions/apply-patch/index.ts`
 * (MIT, commit e04b620). the mutation logic is his and is kept faithfully —
 * it is careful code and the edge cases it handles are real. adapted to our
 * layout and conventions:
 *   - `@bds_pi/*` -> `./lib/*`, `typebox` -> `@sinclair/typebox`,
 *     `@earendil-works/*` -> `@mariozechner/*`, 2-space -> tabs
 *   - his `toolPolicy.evaluateToolPolicy/loadToolPolicy` -> our
 *     `evaluatePermission/loadPermissions` (same call shape, our names)
 *   - his `fileTracker.saveChanges` -> ours (added in this phase; our storage
 *     layout already supported several changes per tool call)
 *   - his `withFileLocks` -> ours (added in this phase, sorted acquisition)
 *   - his pi-core `renderDiff` result rendering is REPLACED by our
 *     Shiki-highlighted renderer (see RENDERING below)
 *
 * WHY THIS REPLACES edit + write
 * one envelope can add, update, delete and move any number of files, and the
 * whole batch either lands or does not. `edit` mutates one file per call with
 * no cross-file atomicity, so a 3-file refactor could fail halfway and leave
 * the tree inconsistent. here every target is snapshotted first, all hunks are
 * matched against in-memory content, and nothing is written until every
 * operation has succeeded.
 *
 * SAFETY PROPERTIES (all inherited from his implementation)
 *   - context must match exactly, so a stale or hallucinated hunk fails loudly
 *     instead of corrupting the file
 *   - symlinks and hard-linked files are refused (they alias other paths)
 *   - paths that resolve to the same file, or contain one another, are refused
 *     (case-insensitive filesystems are detected, which matters on this mac)
 *   - a write or tracking failure rolls every file back to its snapshot
 *   - added content containing placeholders like "// ... rest unchanged" is
 *     rejected, which is the main way a model silently deletes code
 *
 * NOT crash-safe: killing the process mid-commit can leave a partial batch.
 *
 * RENDERING
 * his version renders with pi core's plain `renderDiff`. ours keeps the
 * Shiki-highlighted, side-by-side diff we already use for `edit`. because
 * `createShikiDiffComponent` detects language from a single file path and
 * renders `parsePatchFiles(...)[0]`, a multi-file patch gets ONE component
 * PER FILE rather than one for the batch — otherwise only the first file
 * would be highlighted and the rest would silently vanish from the view.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { applyPatchChunks, parseCodexPatch, type PatchOperation } from "./lib/codex-patch";
import { requireParam } from "./lib/params";
import { resolveToAbsolute } from "./lib/fs";
import { saveChanges, simpleDiff } from "./lib/file-tracker";
import { withFileLocks } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { createShikiDiffComponent } from "./lib/shiki-diff";
import { formatBoxesWindowed, osc8Link, type BoxBlock, type BoxLine, type BoxSection, type Excerpt } from "./lib/box-format";
import { computeDiffStats, formatStats, sumStats } from "./lib/diff-stats";
import { getContainer, getText } from "./lib/tui";

/**
 * lark grammar for providers that support constrained sampling (OpenAI).
 * harmless elsewhere — pi only forwards it when the provider asks for it.
 */
const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

/**
 * the envelope format, shown to the model in the schema AND repeated in every
 * format error. models do not reliably infer it from prose — measured: haiku
 * burned 15 consecutive failed calls against a description with no example.
 */
const ENVELOPE_EXAMPLE = `*** Begin Patch
*** Update File: src/app.ts
@@
 unchanged context line
-old line
+new line
*** End Patch`;

/*
 * SCHEMA SHAPE IS CONSTRAINED BY GRAMMAR SAMPLING — do not "improve" it.
 *
 * `constrainedSampling` below requires the schema to have EXACTLY ONE required
 * string property (pi-ai `inferGrammarInputProperty`, constrained-sampling.js
 * line 38). Adding optional alias properties is fine; making `input` optional
 * is NOT — `required` becomes [] and every request on an OpenAI-family model
 * dies with "cannot use grammar constrained sampling".
 *
 * That failure is invisible on Anthropic: pi-ai returns early when the provider
 * has no grammar support (same file, line 68), so the schema is never checked.
 * It surfaced only on `openai-codex/gpt-5.6-sol`.
 *
 * `additionalProperties` is deliberately NOT false, so a model that adds a
 * stray key reaches execute() (where normalizeEnvelope can explain itself)
 * instead of being rejected by the validator with a generic message.
 */
const ApplyPatchParameters = Type.Object({
	input: Type.String({
		description: [
			"The ENTIRE patch envelope as ONE string. This is the only parameter:",
			"do not pass a file path — every path lives inside the envelope on a",
			"'*** Add File:' / '*** Update File:' / '*** Delete File:' line.",
			"",
			"Must begin with '*** Begin Patch' and end with '*** End Patch'.",
			"NOT a unified diff: no ---/+++ headers, and '@@' carries no line numbers.",
			"",
			ENVELOPE_EXAMPLE,
		].join("\n"),
	}),
});

/** parameter names models actually reach for, canonical first. */
const INPUT_PARAMS = ["input", "patch", "envelope", "diff", "content"] as const;

interface Snapshot {
	path: string;
	exists: boolean;
	content?: string;
	mode?: number;
}

export interface ApplyPatchChange {
	path: string;
	kind: "added" | "modified" | "deleted";
	diff: string;
}

interface PlannedChange extends ApplyPatchChange {
	before: string;
	after: string;
}

export interface ApplyPatchDetails {
	changes: ApplyPatchChange[];
}

// --- anti-laziness guard ---

/**
 * placeholders that mean the model elided real code instead of writing it.
 * letting these through is how a "small edit" silently deletes a file body.
 */
const REDACTION_PATTERNS = [
	/\[REDACTED\]/i,
	/\[\.\.\.omitted.*?\]/i,
	/\[(?:rest|remaining) of .{1,40} unchanged\]/i,
	/\/\/ \.\.\.(?: rest| remaining)? (?:of )?(?:the )?(?:file|code|content|implementation).*(?:unchanged|omitted)/i,
	/(?:\/\/|#) \.\.\. existing (?:code|content|implementation)/i,
];

/**
 * reject a patch whose ADDED lines introduce a placeholder.
 *
 * counts before vs after rather than matching outright: a file may legitimately
 * already contain such a line (this very file does), and only a NEW one — i.e.
 * the model substituting a placeholder for real content — is an error.
 */
function assertNoRedaction(operation: PatchOperation): void {
	const beforeLines =
		operation.type === "update" ? operation.chunks.flatMap((chunk) => chunk.oldLines) : [];
	const afterLines =
		operation.type === "add"
			? operation.content.split("\n")
			: operation.type === "update"
				? operation.chunks.flatMap((chunk) => chunk.newLines)
				: [];
	for (const pattern of REDACTION_PATTERNS) {
		const beforeCount = beforeLines.filter((line) => pattern.test(line)).length;
		const matches = afterLines.filter((line) => pattern.test(line));
		if (matches.length > beforeCount) {
			throw new Error(
				`patch rejected: added content contains placeholder '${matches[0]}'; include the actual content`,
			);
		}
	}
}

// --- input normalisation ---

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";

/**
 * clean up the envelope before parsing, and fail with a message that TEACHES
 * the format rather than just naming the first broken line.
 *
 * two things models actually do, both measured here:
 *   - wrap the envelope in a ``` fence (it looks like a code block to them)
 *   - send a plain unified diff (---/+++/@@ -1,4 +1,4 @@), which is the far
 *     more common diff format in training data
 *
 * fences are stripped silently. a unified diff is NOT auto-converted: its
 * hunk headers may be invented, and quietly reinterpreting a patch is exactly
 * the kind of "helpful" behaviour that corrupts files. it is rejected with an
 * explicit explanation of the difference instead.
 */
function normalizeEnvelope(raw: string): string {
	let text = raw.trim();

	// strip a surrounding markdown fence, with or without a language tag
	const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	if (fenced?.[1]) text = fenced[1].trim();

	if (text.startsWith(BEGIN_MARKER)) return text;

	const looksUnified = /^(---|\+\+\+|diff --git|@@ -\d)/m.test(text);
	if (looksUnified) {
		throw new Error(
			`this is a unified diff, but apply_patch takes a Codex patch envelope.\n` +
				`differences: wrap the whole patch in '${BEGIN_MARKER}' / '${END_MARKER}', ` +
				`name each file with '*** Update File: <path>' (or Add File / Delete File) ` +
				`instead of ---/+++ headers, and write '@@' alone with no line numbers.\n\n` +
				`example:\n${ENVELOPE_EXAMPLE}`,
		);
	}

	throw new Error(
		`patch must start with '${BEGIN_MARKER}' and end with '${END_MARKER}'.\n\nexample:\n${ENVELOPE_EXAMPLE}`,
	);
}

// --- path safety ---

/**
 * capture a file's pre-patch state, refusing paths that alias other files.
 *
 * symlinks and hard links are rejected rather than followed: writing through
 * one mutates a file the patch never named, which defeats the snapshot/rollback
 * guarantee.
 */
function snapshot(file: string): Snapshot {
	let pathStat: fs.Stats;
	try {
		pathStat = fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: file, exists: false };
		}
		throw error;
	}
	if (pathStat.isSymbolicLink()) {
		throw new Error(`symbolic link paths are not supported: ${file}`);
	}
	const stat = fs.statSync(file);
	if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
	if (stat.nlink > 1) {
		throw new Error(`hard-linked files are not supported: ${file}`);
	}
	return { path: file, exists: true, content: fs.readFileSync(file, "utf8"), mode: stat.mode };
}

function operationPaths(
	operation: PatchOperation,
	cwd: string,
): { source: string; destination?: string } {
	const source = path.resolve(resolveToAbsolute(operation.path, cwd));
	const destination =
		operation.type === "update" && operation.movePath
			? path.resolve(resolveToAbsolute(operation.movePath, cwd))
			: undefined;
	if (destination === source) {
		throw new Error(`patch move source and destination are identical: ${source}`);
	}
	return { source, destination };
}

/**
 * resolve the deepest existing ancestor with realpath, then re-append the
 * not-yet-existing tail. plain realpath would throw for a file being created.
 *
 * MUST use `realpathSync.native`, not `realpathSync` — they disagree on macOS.
 *
 * node's JS `realpathSync` resolves symlinks but preserves the case you asked
 * with, so `realpathSync("dup.txt")` returns `dup.txt` even when the file on
 * disk is `Dup.txt`. `realpathSync.native` calls the OS and returns the true
 * on-disk casing, which is exactly what pi core's file-mutation queue does
 * (it keys by the ASYNC `fs/promises.realpath`, which is also native-backed).
 *
 * with the JS variant, two case-variant paths stayed distinct here, slipped
 * past the alias check below, and then collapsed to ONE key inside pi's queue
 * — so we nested an acquisition of a key we already held and the tool hung
 * forever. verified empirically on this machine; a case-sensitive filesystem
 * never shows it, which is why it is not a bug upstream.
 */
function canonicalMutationPath(file: string): string {
	const suffix: string[] = [];
	let ancestor = file;
	while (!fs.existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		suffix.unshift(path.basename(ancestor));
		ancestor = parent;
	}
	return path.join(fs.realpathSync.native(ancestor), ...suffix);
}

/**
 * probe whether this path lives on a case-insensitive filesystem, by flipping
 * the case of one letter and asking whether it resolves to the same inode.
 *
 * macOS defaults to case-insensitive, so `src/App.ts` and `src/app.ts` are ONE
 * file — a patch naming both would otherwise clobber itself silently.
 */
function usesCaseInsensitivePaths(file: string): boolean {
	let ancestor = file;
	while (!fs.existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
	while (true) {
		const name = path.basename(ancestor);
		const index = name.search(/[a-z]/i);
		if (index >= 0) {
			const character = name[index]!;
			const swapped =
				character === character.toLowerCase()
					? character.toUpperCase()
					: character.toLowerCase();
			const variant = path.join(
				path.dirname(ancestor),
				`${name.slice(0, index)}${swapped}${name.slice(index + 1)}`,
			);
			if (variant !== ancestor && fs.existsSync(variant)) {
				// `.native` for the same reason as canonicalMutationPath: the JS
				// realpath echoes the requested casing, so this comparison was
				// always false on macOS and the detection silently never fired.
				return fs.realpathSync.native(variant) === fs.realpathSync.native(ancestor);
			}
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
}

function pathComparisonKey(file: string): string {
	return usesCaseInsensitivePaths(file) ? file.toLowerCase() : file;
}

/** refuse a batch where one target sits inside another (a path and its parent). */
function assertNoPathHierarchyConflicts(files: string[]): void {
	for (const ancestor of files) {
		for (const descendant of files) {
			if (ancestor === descendant) continue;
			const relative = path.relative(ancestor, descendant);
			if (
				relative &&
				!relative.startsWith(`..${path.sep}`) &&
				relative !== ".." &&
				!path.isAbsolute(relative)
			) {
				throw new Error(`patch paths cannot contain one another: ${ancestor}, ${descendant}`);
			}
		}
	}
}

// --- commit / rollback ---

function missingParentDirectories(files: string[]): string[] {
	const missing = new Set<string>();
	for (const file of files) {
		let directory = path.dirname(file);
		while (!fs.existsSync(directory)) {
			missing.add(directory);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	// deepest first, so rmdir unwinds children before parents
	return [...missing].sort((a, b) => b.length - a.length);
}

function restoreSnapshots(snapshots: Snapshot[], createdDirectories: string[] = []): void {
	const errors: unknown[] = [];
	for (const before of snapshots) {
		try {
			if (!before.exists) {
				fs.rmSync(before.path, { force: true });
				continue;
			}
			fs.mkdirSync(path.dirname(before.path), { recursive: true });
			fs.writeFileSync(before.path, before.content ?? "", "utf8");
			if (before.mode !== undefined) fs.chmodSync(before.path, before.mode);
		} catch (error) {
			errors.push(error);
		}
	}
	for (const directory of createdDirectories) {
		try {
			fs.rmdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "apply_patch rollback was incomplete");
	}
}

/**
 * hold pi's own per-file mutation queue for every target.
 *
 * this is the queue pi's built-in tools use, so taking it keeps us serialized
 * against them; our `withFileLocks` is a second, independent layer for our own
 * tools. recursing acquires them all before running `fn`.
 */
function withMutationQueues<T>(files: string[], fn: () => Promise<T>): Promise<T> {
	const paths = [...new Set(files)].sort();
	const acquire = (index: number): Promise<T> => {
		const file = paths[index];
		return file ? withFileMutationQueue(file, () => acquire(index + 1)) : fn();
	};
	return acquire(0);
}

/** write every planned file; on any failure restore all snapshots. */
function commitChanges(
	snapshots: Snapshot[],
	finalContents: Map<string, string | undefined>,
	finalModes: Map<string, number | undefined>,
	createdDirectories: string[],
): void {
	try {
		for (const before of snapshots) {
			const after = finalContents.get(before.path);
			if (after === undefined) {
				fs.rmSync(before.path, { force: true });
			} else {
				fs.mkdirSync(path.dirname(before.path), { recursive: true });
				fs.writeFileSync(before.path, after, "utf8");
				const mode = finalModes.get(before.path);
				if (mode !== undefined) fs.chmodSync(before.path, mode);
			}
		}
	} catch (error) {
		try {
			restoreSnapshots(snapshots, createdDirectories);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"apply_patch failed and rollback was incomplete",
			);
		}
		throw error;
	}
}

// --- display helpers ---

/**
 * the collapsed call line: which files this patch touches.
 *
 * shows basenames, and elides past the third — a 25-file batch rendered as 25
 * absolute paths wraps over several lines and pushes everything else off
 * screen. the full list is always in the result below it.
 */
function describeCall(input: string): string {
	const paths = input.split("\n").flatMap((line) => {
		const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
		return match?.[1] ? [path.basename(match[1].trim())] : [];
	});
	if (paths.length === 0) return "...";
	if (paths.length <= 3) return paths.join(", ");
	return `${paths.slice(0, 3).join(", ")} +${paths.length - 3} more`;
}

/** compact model-facing summary; the human-facing diff is rendered from details. */
function formatResult(changes: ApplyPatchChange[]): string {
	const marker = { added: "A", modified: "M", deleted: "D" } as const;
	return changes.map((change) => `${marker[change.kind]} ${change.path}`).join("\n");
}

function shortenPath(file: string): string {
	const home = os.homedir();
	return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/**
 * the name shown in a diff box header.
 *
 * `edit` shows a bare basename, which reads well because it only ever touches
 * one file. apply_patch is multi-file, so a bare basename can be ambiguous
 * (two `index.ts` in one patch). preferring a cwd-relative path keeps it short
 * where it matters and unambiguous where it counts.
 */
function displayName(file: string, cwd: string): string {
	const relative = path.relative(cwd, file);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return shortenPath(file);
}

/**
 * rewrite the `---`/`+++` header paths inside a unified diff for DISPLAY only.
 *
 * pi-diff reads those headers to title its own rendering, so without this the
 * Shiki view shows the absolute path while our fallback box shows the short
 * one — the same file labelled two different ways in one result.
 */
function relabelDiff(diff: string, label: string): string {
	return diff
		.replace(/^--- .*$/m, `--- ${label}`)
		.replace(/^\+\+\+ .*$/m, `+++ ${label}`);
}

/**
 * unified diff -> BoxSection[], for the plain fallback renderer used until
 * Shiki has loaded. same shape as edit-file's, one section per file.
 */
function parseDiffToSections(filename: string, diffText: string): BoxSection[] {
	const lines = diffText.split("\n");
	const blocks: BoxBlock[] = [];
	let currentLines: BoxLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const line of lines) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

		const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunkMatch) {
			if (currentLines.length > 0) {
				blocks.push({ lines: currentLines });
				currentLines = [];
			}
			oldLine = parseInt(hunkMatch[1], 10);
			newLine = parseInt(hunkMatch[2], 10);
			continue;
		}

		if (line.startsWith("-")) {
			currentLines.push({ gutter: String(oldLine), text: line, highlight: true });
			oldLine++;
		} else if (line.startsWith("+")) {
			currentLines.push({ gutter: String(newLine), text: line, highlight: true });
			newLine++;
		} else {
			currentLines.push({ gutter: String(oldLine), text: line, highlight: false });
			oldLine++;
			newLine++;
		}
	}

	if (currentLines.length > 0) blocks.push({ lines: currentLines });
	return [{ header: filename, blocks }];
}

const HUNK_EXCERPTS: Excerpt[] = [
	{ focus: "head", context: 12 },
	{ focus: "tail", context: 13 },
];

export function createApplyPatchTool(): ToolDefinition<typeof ApplyPatchParameters, ApplyPatchDetails> {
	return {
		name: "apply_patch",
		label: "Apply Patch",
		description:
			"Apply a Codex-format patch as a validated batch. Supports Add File, Update File, Delete File, Move to, multiple files, and multiple hunks. Every update must match before commit; ordinary write or tracking failures are rolled back. Process termination during commit is not crash-safe.",
		promptSnippet: "Apply precise Codex-format patches to one or more files",
		/*
		 * these reach EVERY model. grammar-constrained sampling only exists on
		 * OpenAI-family providers, so on Anthropic / Kimi / DeepSeek / Sakana this
		 * wording is the only thing keeping call syntax correct. the first line
		 * targets the one mistake actually observed in testing: passing a separate
		 * file-path argument instead of putting paths inside the envelope.
		 */
		promptGuidelines: [
			"apply_patch takes exactly one argument, `input`: the whole '*** Begin Patch' … '*** End Patch' envelope as a single string. It has no path argument — file paths belong on the '*** Update File:' / '*** Add File:' / '*** Delete File:' lines inside it.",
			"Use apply_patch for all text file creation, modification, deletion, and moves instead of edit, write, or shell redirection.",
			"Keep apply_patch hunks small and include enough unchanged context for an unambiguous match.",
			"Split unrelated or very large apply_patch changes into consecutive calls.",
		],
		parameters: ApplyPatchParameters,
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: APPLY_PATCH_GRAMMAR },
		},
		executionMode: "sequential",

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const Container = getContainer();
			const raw = args?.input ?? args?.patch ?? args?.envelope ?? "";
			const header =
				theme.fg("toolTitle", theme.bold("apply_patch ")) +
				theme.fg("dim", describeCall(raw));

			// while streaming, show the envelope as it arrives so a long patch
			// is visible in flight rather than as a frozen header.
			if (!context?.isPartial || !raw) {
				const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(header);
				return text;
			}
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(raw, 0, 0));
			return container;
		},

		async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("apply_patch aborted");

			const resolvedInput = requireParam(params, INPUT_PARAMS, "apply_patch");
			if ("error" in resolvedInput) return resolvedInput.error as any;

			const operations = parseCodexPatch(normalizeEnvelope(resolvedInput.value));
			operations.forEach(assertNoRedaction);

			const resolved = operations.map((operation) => ({
				operation,
				...operationPaths(operation, ctx.cwd),
			}));
			const allPaths = [
				...new Set(
					resolved.flatMap(({ source, destination }) =>
						destination ? [source, destination] : [source],
					),
				),
			];

			const canonicalPaths = allPaths.map(canonicalMutationPath);
			const comparisonPaths = canonicalPaths.map(pathComparisonKey);
			assertNoPathHierarchyConflicts(comparisonPaths);
			const aliases = comparisonPaths.filter(
				(file, index) => comparisonPaths.indexOf(file) !== index,
			);
			if (aliases.length > 0) {
				throw new Error(
					`patch paths resolve to the same file: ${[...new Set(aliases)].join(", ")}`,
				);
			}

			// same permission layer bash.ts uses, so a rule denying writes under a
			// protected root applies to patches too.
			const verdict = evaluatePermission(
				"apply_patch",
				{ paths: canonicalPaths, sessionCwd: ctx.cwd },
				loadPermissions(),
			);
			if (verdict.action === "reject") {
				throw new Error(verdict.message ?? "patch rejected by permission rules");
			}

			return withMutationQueues(canonicalPaths, () => {
				// pi's mutation queue takes no AbortSignal, so a long wait behind
				// another tool's lock is not interruptible. check on the way out of
				// the queue to narrow the window before we start mutating.
				if (signal?.aborted) throw new Error("apply_patch aborted");
				return withFileLocks(canonicalPaths, async () => {
					const snapshots = allPaths.map(snapshot);
					const createdDirectories = missingParentDirectories(allPaths);
					const byPath = new Map(snapshots.map((item) => [item.path, item]));
					const finalContents = new Map<string, string | undefined>(
						snapshots.map((item) => [item.path, item.content]),
					);
					const finalModes = new Map<string, number | undefined>(
						snapshots.map((item) => [item.path, item.mode]),
					);

					// apply every operation IN MEMORY first — nothing touches disk
					// until all of them have succeeded.
					for (const { operation, source, destination } of resolved) {
						if (signal?.aborted) throw new Error("apply_patch aborted");
						const current = finalContents.get(source);
						if (operation.type === "add") {
							// UPSTREAM BUG FIX (bdsqqq's version omits this guard).
							//
							// without it, `*** Add File:` on a path that already exists
							// replaces the whole file with the patch body — silently, and
							// with no context matching to catch it. a model that thinks a
							// file is new destroys it. verified: a 4-line file became one
							// line, reported only as "M path".
							//
							// `delete` and `update` below both guard on `current`; `add` was
							// the only asymmetric branch. wholesale replacement is still
							// possible, but must be spelled Delete File + Add File.
							if (current !== undefined) {
								throw new Error(
									`file already exists: ${source}; use '*** Update File:' to modify it, or '*** Delete File:' first to replace it wholesale`,
								);
							}
							finalContents.set(source, operation.content);
						} else if (operation.type === "delete") {
							if (current === undefined) throw new Error(`file not found: ${source}`);
							finalContents.set(source, undefined);
							finalModes.set(source, undefined);
						} else {
							if (current === undefined) throw new Error(`file not found: ${source}`);
							const updated = applyPatchChunks(current, operation.chunks, source);
							if (destination) {
								// a move is modelled as delete(source) + add(destination),
								// carrying the original mode across.
								const sourceMode = finalModes.get(source);
								finalContents.set(source, undefined);
								finalModes.set(source, undefined);
								finalContents.set(destination, updated);
								finalModes.set(destination, sourceMode);
							} else {
								finalContents.set(source, updated);
							}
						}
					}

					const changes: PlannedChange[] = [];
					for (const before of snapshots) {
						const after = finalContents.get(before.path);
						const afterExists = after !== undefined;
						const afterMode = finalModes.get(before.path);
						if (
							before.content === after &&
							before.exists === afterExists &&
							before.mode === afterMode
						) {
							continue;
						}
						const beforeContent = before.content ?? "";
						const afterContent = after ?? "";
						changes.push({
							path: before.path,
							kind: !before.exists ? "added" : after === undefined ? "deleted" : "modified",
							before: beforeContent,
							after: afterContent,
							diff: simpleDiff(before.path, beforeContent, afterContent),
						});
					}
					if (changes.length === 0) throw new Error("patch made no changes");
					if (signal?.aborted) throw new Error("apply_patch aborted");

					commitChanges(snapshots, finalContents, finalModes, createdDirectories);

					// record for undo_edit. a tracking failure rolls the batch back,
					// so we never leave an un-undoable change on disk.
					const sessionId = ctx.sessionManager.getSessionId();
					try {
						saveChanges(
							sessionId,
							toolCallId,
							changes.map((change) => ({
								uri: `file://${change.path}`,
								before: change.before,
								after: change.after,
								diff: change.diff,
								isNewFile: !byPath.get(change.path)?.exists,
								beforeExists: byPath.get(change.path)?.exists ?? false,
								afterExists: finalContents.get(change.path) !== undefined,
								beforeMode: byPath.get(change.path)?.mode,
								afterMode:
									finalContents.get(change.path) === undefined
										? undefined
										: fs.statSync(change.path).mode,
								timestamp: Date.now(),
							})),
						);
					} catch (error) {
						try {
							restoreSnapshots(snapshots, createdDirectories);
						} catch (rollbackError) {
							throw new AggregateError(
								[error, rollbackError],
								"apply_patch tracking failed and rollback was incomplete",
							);
						}
						throw error;
					}

					const resultChanges = changes.map(
						({ before: _before, after: _after, ...change }) => change,
					);
					return {
						content: [{ type: "text" as const, text: formatResult(resultChanges) }],
						details: { changes: resultChanges },
					};
				});
			});
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const Container = getContainer();
			const Text = getText();
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const changes: ApplyPatchChange[] = result.details?.changes ?? [];

			// errors and no-change results have no details — show the text.
			if (changes.length === 0) {
				const text = (result.content ?? [])
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n");
				container.addChild(new Text(theme.fg("dim", text || "(no changes)"), 0, 0));
				return container;
			}

			const cwd: string = context?.cwd ?? process.cwd();

			/*
			 * HEADER: match `edit` exactly for the common single-file case.
			 *
			 * `edit` prints one stats line (`~1`) and lets the box header carry the
			 * filename. the first version of this renderer printed BOTH a
			 * "1 file changed" line AND a "modified <abs path>" line above a box
			 * whose header repeated the same path — three lines of chrome and the
			 * path twice, per file. over a run of small patches that is a wall of
			 * noise, and it looked nothing like the rest of our tools.
			 *
			 * so: file count only when it adds information (>1 file), and always
			 * the same `+n ~n -n` summary `edit` shows.
			 */
			const perFile = changes.map((change) => ({
				change,
				display: displayName(change.path, cwd),
				sections: parseDiffToSections(displayName(change.path, cwd), change.diff),
			}));
			const stats = sumStats(perFile.map((f) => computeDiffStats(f.sections)));
			const countPrefix =
				changes.length > 1 ? theme.fg("dim", `${changes.length} files `) : "";
			container.addChild(new Text(countPrefix + formatStats(stats, theme), 0, 0));

			// collapsed shows the last file only (matching how `edit` collapses to
			// the last hunk); expanded shows every file.
			const shown = expanded ? perFile : perFile.slice(-1);

			for (const { change, display, sections } of shown) {
				const linked = change.path.startsWith("/")
					? osc8Link(`file://${change.path}`, display)
					: display;

				// a deleted file has no post-state to highlight, and rendering its
				// former body as one huge red block is noise — so it gets a single
				// labelled line instead of a box.
				if (change.kind === "deleted") {
					container.addChild(new Text(`${theme.fg("dim", "deleted ")}${linked}`, 0, 0));
					continue;
				}

				const fallback = (width: number): string[] =>
					formatBoxesWindowed(
						sections.map((s) => ({
							...s,
							header: linked,
							blocks: !expanded && s.blocks.length > 1 ? s.blocks.slice(-1) : s.blocks,
						})),
						{ maxSections: 1, excerpts: HUNK_EXCERPTS },
						undefined,
						width,
					).split("\n");

				// one component PER FILE: createShikiDiffComponent renders
				// parsePatchFiles(...)[0] and detects language from a single path,
				// so a shared component would show only the first file.
				container.addChild(
					createShikiDiffComponent({
						diffText: relabelDiff(change.diff, display),
						filePath: change.path,
						expanded,
						split: true,
						fallback,
						invalidate: context?.invalidate,
					}),
				);
			}

			return container;
		},
	} as any;
}
