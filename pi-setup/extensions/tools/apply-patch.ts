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
import {
	applyPatchChunks,
	isBeginLine,
	parseCodexPatch,
	stripHeredoc,
	type PatchChunk,
} from "./lib/codex-patch";
import { resolveToAbsolute } from "./lib/fs";
import { saveChanges, simpleDiff } from "./lib/file-tracker";
import { withFileLocks } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { createShikiDiffComponent } from "./lib/shiki-diff";
import { formatBoxesWindowed, osc8Link, type BoxBlock, type BoxLine, type BoxSection, type Excerpt } from "./lib/box-format";
import { computeDiffStats, formatStats, sumStats } from "./lib/diff-stats";
import { getContainer, getText } from "./lib/tui";

/**
 * the envelope format, repeated in every format error. models do not reliably
 * infer it from prose — measured: haiku burned 15 consecutive failed calls
 * against a description with no example.
 */
const ENVELOPE_EXAMPLE = `*** Begin Patch
*** Update File: src/app.ts
@@
 unchanged context line
-old line
+new line
*** End Patch`;

/*
 * FOUR WAYS TO SAY THE SAME THING — and why the schema looks like this.
 *
 * This tool used to take exactly one required string: the V4A envelope. That
 * is OpenAI's format, which their models were trained on and no other model
 * was, so every non-OpenAI model paid a translation tax on every edit and the
 * weak ones simply failed (see 2026-07-30-bdsqqq-port.md §3.6/§3.9).
 *
 * So the wire is now loose and the disk stays brutal. Four lanes, all landing
 * in the same engine — same permission check, same locks, same snapshot,
 * same all-or-nothing commit, same undo records:
 *
 *   write     { path, content }
 *   edit      { path, old_string, new_string }
 *   batch     { ops: [ ... ] }
 *   envelope  { input: "*** Begin Patch ..." }
 *
 * EVERY FIELD IS OPTIONAL, and that is forced, not sloppy: the lanes are
 * mutually exclusive, so no single field can be required without blocking the
 * other three. pi validates arguments against this schema BEFORE execute()
 * runs (pi-ai `validateToolArguments`), so a required field is a hard wall,
 * not a hint. The cost is that a malformed call is caught one layer later, in
 * `normalizeCall`, which is why its errors are written to be actionable.
 *
 * WHY `constrainedSampling` IS GONE (deliberate, do not re-add without reading
 * this). Grammar sampling forces OpenAI models to emit a syntactically valid
 * envelope at the token level, and it is genuinely good — but pi-ai's
 * `inferGrammarInputProperty` requires the schema to have EXACTLY ONE required
 * string property. That is mutually exclusive with the four lanes above. It
 * only ever applied to OpenAI-family providers (`resolveGrammarConstrainedSampling`
 * returns early elsewhere), i.e. to the one family that emits this format
 * correctly unaided. Declaring it with a schema it cannot satisfy does not
 * degrade — it THROWS and kills the whole turn — so it is removed, not left in.
 */
const OpParameters = Type.Object({
	op: Type.Optional(
		Type.String({
			description:
				"write | edit | delete | move | add. Optional: inferred from the fields present.",
		}),
	),
	path: Type.Optional(Type.String({ description: "File to change." })),
	content: Type.Optional(
		Type.String({ description: "write: the file's complete new contents." }),
	),
	old_string: Type.Optional(
		Type.String({ description: "edit: exact text to replace. Must be unique in the file." }),
	),
	new_string: Type.Optional(
		Type.String({ description: "edit: replacement text. Use \"\" to delete the old text." }),
	),
	replace_all: Type.Optional(
		Type.Boolean({ description: "edit: replace every occurrence instead of refusing when ambiguous." }),
	),
	to: Type.Optional(Type.String({ description: "move: destination path." })),
});

const ApplyPatchParameters = Type.Object({
	path: Type.Optional(
		Type.String({ description: "The file to write or edit. Pair with content, or with old_string + new_string." }),
	),
	content: Type.Optional(
		Type.String({ description: "Complete new contents for `path`. Creates the file or replaces it wholesale." }),
	),
	old_string: Type.Optional(
		Type.String({ description: "Exact text to find in `path`. Must appear exactly once unless replace_all is set." }),
	),
	new_string: Type.Optional(
		Type.String({ description: "Text to put in place of old_string. Pass \"\" to delete it." }),
	),
	replace_all: Type.Optional(
		Type.Boolean({ description: "Replace every occurrence of old_string instead of refusing when it is ambiguous." }),
	),
	op: Type.Optional(
		Type.String({ description: "Force a single operation: write | edit | delete | move | add. Rarely needed." }),
	),
	to: Type.Optional(Type.String({ description: "Destination path when op is move." })),
	ops: Type.Optional(
		Type.Array(OpParameters, {
			description:
				"Several operations applied as ONE all-or-nothing batch. Use this to change multiple files at once.",
		}),
	),
	input: Type.Optional(
		Type.String({
			description: [
				"A whole Codex/V4A patch envelope as one string, for multi-hunk edits",
				"or a patch pasted from elsewhere. Paths live inside it, on the",
				"'*** Add File:' / '*** Update File:' / '*** Delete File:' lines.",
				"NOT a unified diff: no ---/+++ headers, and '@@' needs no line numbers.",
				"",
				ENVELOPE_EXAMPLE,
			].join("\n"),
		}),
	),
});

/*
 * Key spellings models actually reach for. Canonical first.
 *
 * This is the `lib/params.ts` idea widened: the point is never to guess what
 * an argument MEANS, only to accept what it is CALLED. A key that changes the
 * operation (content vs old_string) is never inferred across lanes — a call
 * that names two lanes is rejected, not reconciled.
 */
const INPUT_KEYS = ["input", "patch", "envelope", "diff", "patch_text", "patchText"] as const;
/*
 * `target_file` is cursor's spelling and is unambiguous. a bare `target` is
 * NOT accepted, deliberately: it reads as a move DESTINATION at least as
 * naturally as a source, and a path alias that can be misread is worse than a
 * missing one — the miss produces an error, the misread produces a wrong file.
 */
const PATH_KEYS = [
	"path",
	"file_path",
	"filePath",
	"file",
	"filename",
	"fileName",
	"target_file",
] as const;
const CONTENT_KEYS = [
	"content",
	"contents",
	"new_content",
	"new_contents",
	"newContent",
	"file_text",
	"text",
	"body",
] as const;
const OLD_KEYS = ["old_string", "old_str", "oldText", "old_text", "old", "search", "before"] as const;
const NEW_KEYS = ["new_string", "new_str", "newText", "new_text", "new", "replace", "after"] as const;
const OPS_KEYS = ["ops", "operations", "edits", "changes"] as const;
const TO_KEYS = ["to", "move_to", "moveTo", "new_path", "newPath", "destination", "dest"] as const;
const REPLACE_ALL_KEYS = ["replace_all", "replaceAll", "all", "global"] as const;

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
	lane?: Lane;
}

// --- what the caller meant ---

/** which of the four call shapes was used; reported in details, and logged. */
export type Lane = "write" | "edit" | "delete" | "move" | "batch" | "envelope";

/**
 * the single internal vocabulary. every lane is translated into this before
 * anything touches disk, so there is exactly ONE apply loop, ONE rollback path
 * and ONE set of safety guards — adding a lane can never add a way to bypass
 * them.
 *
 * `add` and `write` are deliberately different operations, not a flag: `add`
 * refuses to overwrite (it is the envelope's create-a-new-file op, and a model
 * that thinks a file is new must not destroy it), while `write` means replace
 * and says so in its name.
 */
type Intent =
	| { type: "add"; path: string; content: string }
	| { type: "write"; path: string; content: string }
	| { type: "delete"; path: string }
	| { type: "edit"; path: string; old: string; new: string; replaceAll: boolean }
	| { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

/*
 * `type` and `command` are NOT here. they are generic enough to arrive with a
 * value that is not an operation at all (`type: "text/plain"`), and an
 * unrecognised op is a hard error — so accepting them would turn a valid write
 * into "unknown op". a missing op is inferred from the fields instead.
 */
const OP_KEYS = ["op", "operation", "action", "kind"] as const;

/**
 * what a single record can ask for. deliberately NOT `Intent["type"]`: there is
 * no `update` here, because multi-hunk updates only ever arrive through the
 * envelope. keeping the two vocabularies separate is what makes the switch
 * below exhaustive, so adding an intent cannot silently fall through it.
 */
type FieldOpKind = "write" | "add" | "edit" | "delete" | "move";

/** explicit `op` spellings -> our vocabulary. */
const OP_SYNONYMS: Record<string, FieldOpKind> = {
	write: "write", replace: "write", overwrite: "write", set: "write", put: "write",
	save: "write", create_file: "write", write_file: "write",
	add: "add", create: "add", new: "add",
	edit: "edit", str_replace: "edit", replace_string: "edit", substitute: "edit",
	modify: "edit", change: "edit", update: "edit", patch: "edit",
	delete: "delete", remove: "delete", rm: "delete", del: "delete", unlink: "delete",
	move: "move", rename: "move", mv: "move",
};

/**
 * read a string field under any of its spellings.
 *
 * `""` counts as PRESENT — this is the whole reason `lib/params.ts`'s
 * `resolveParam` cannot be reused here. Emptiness is meaningful in both lanes
 * that carry text: `new_string: ""` deletes the matched text, and
 * `content: ""` truncates a file. Treating empty as absent would silently turn
 * both into "you forgot an argument".
 */
function pickString(
	params: Record<string, unknown>,
	keys: readonly string[],
): { key: string; value: string } | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string") return { key, value };
	}
	return undefined;
}

function pickBoolean(params: Record<string, unknown>, keys: readonly string[]): boolean {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") return value;
		// some providers stringify booleans on the way out
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return false;
}

/**
 * read the ops array, tolerating the two shapes providers mangle it into.
 *
 * A JSON-STRINGIFIED ARRAY IS NOT HYPOTHETICAL: `pi-tasks` was removed from
 * this setup (2026-07-30) precisely because array parameters arrived as
 * strings and every call it gated failed. Accepting that here costs four
 * lines; refusing it costs the model a turn it cannot debug.
 */
function pickOps(params: Record<string, unknown>): unknown[] | undefined {
	for (const key of OPS_KEYS) {
		const value = params[key];
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object") return [value];
		// the length bound matters because `renderCall` reaches this on every
		// frame while a call streams in: an unbounded parse attempt per frame
		// would make a large patch render slowly.
		if (typeof value === "string" && value.length < 1_000_000 && value.trim().startsWith("[")) {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed)) return parsed;
			} catch {
				// not JSON after all; fall through so the shape error can explain
			}
		}
	}
	return undefined;
}

/** does this text look like SOMEONE'S attempt at a patch, rather than file content? */
function looksLikePatchAttempt(text: string): boolean {
	return /^\s*(?:\*{2,}\s*(?:Begin|End|Add|Update|Delete|Write|Create|Remove|Edit)\b|---\s|\+\+\+\s|diff --git|@@)/m.test(
		text,
	);
}

function quoteKeys(params: Record<string, unknown>): string {
	return JSON.stringify(Object.keys(params));
}

/** the menu. every rejection ends with this, so one failed call is enough. */
const SHAPES = [
	'  write     { "path": "f.ts", "content": "<the whole file>" }',
	'  edit      { "path": "f.ts", "old_string": "<exact text>", "new_string": "<replacement>" }',
	'  delete    { "path": "f.ts", "op": "delete" }',
	'  move      { "path": "old.ts", "to": "new.ts" }',
	'  batch     { "ops": [ { ... }, { ... } ] }   // one atomic all-or-nothing change',
	'  envelope  { "input": "*** Begin Patch\\n*** Update File: f.ts\\n@@\\n-old\\n+new\\n*** End Patch" }',
].join("\n");

function shapeError(message: string, params: Record<string, unknown>): Error {
	return new Error(
		`${message}\n\nyou sent keys: ${quoteKeys(params)}\n\naccepted shapes:\n${SHAPES}`,
	);
}

/**
 * one entry of the ops array, or the whole call when it names a single file.
 *
 * NEVER infers across lanes. `content` means write, `old_string` means edit,
 * and a record naming both is an error rather than a preference — silently
 * picking one is how a targeted edit becomes a whole-file overwrite.
 */
function intentFromFields(
	record: Record<string, unknown>,
	where: string,
	inheritedPath?: string,
): Intent {
	const explicit = pickString(record, OP_KEYS)?.value.trim().toLowerCase() ?? "";
	const filePath = pickString(record, PATH_KEYS)?.value.trim() || inheritedPath;
	const content = pickString(record, CONTENT_KEYS)?.value;
	const old = pickString(record, OLD_KEYS)?.value;
	const replacement = pickString(record, NEW_KEYS)?.value;
	const destination = pickString(record, TO_KEYS)?.value.trim();
	const replaceAll = pickBoolean(record, REPLACE_ALL_KEYS);

	if (content !== undefined && (old !== undefined || replacement !== undefined)) {
		throw shapeError(
			`${where}: this names two different operations — "content" replaces the whole file, "old_string" replaces part of it. Send one.`,
			record,
		);
	}
	if (!filePath) throw shapeError(`${where}: no file path.`, record);

	let kind: FieldOpKind | undefined;
	if (explicit) {
		kind = OP_SYNONYMS[explicit.replace(/[\s-]+/g, "_")];
		if (!kind) {
			throw shapeError(
				`${where}: unknown op ${JSON.stringify(explicit)}. Use write, edit, delete, move or add.`,
				record,
			);
		}
	} else if (old !== undefined || replacement !== undefined) {
		kind = "edit";
	} else if (content !== undefined) {
		kind = "write";
	} else if (destination) {
		kind = "move";
	} else {
		throw shapeError(
			`${where}: a path on its own says nothing about what to change.`,
			record,
		);
	}

	switch (kind) {
		case "write":
		case "add":
			if (content === undefined) {
				throw shapeError(
					`${where}: op "${kind}" needs "content" (the file's complete new text).`,
					record,
				);
			}
			if (destination) {
				throw shapeError(
					`${where}: a write cannot also rename — it replaces the file at "path". Send the move as a separate op.`,
					record,
				);
			}
			return { type: kind, path: filePath, content };
		case "edit": {
			if (old === undefined) {
				throw shapeError(
					`${where}: an edit needs "old_string" — the exact text to find. To replace the whole file, send "content" instead.`,
					record,
				);
			}
			if (old === "") {
				throw shapeError(`${where}: "old_string" is empty, so there is nothing to find.`, record);
			}
			if (replacement === undefined) {
				throw shapeError(
					`${where}: an edit needs "new_string". To delete the matched text, pass an empty string.`,
					record,
				);
			}
			if (destination) {
				throw shapeError(
					`${where}: an edit cannot also rename. Send two ops, or use a '*** Move to:' envelope.`,
					record,
				);
			}
			return { type: "edit", path: filePath, old, new: replacement, replaceAll };
		}
		case "delete":
			// a field the chosen op ignores is not harmless: it is evidence that
			// the caller meant something else, and carrying on would delete a
			// file they were trying to rewrite.
			if (content !== undefined || old !== undefined || destination) {
				throw shapeError(
					`${where}: a delete takes only a path, but this also carries content/old_string/to. Say what you actually want.`,
					record,
				);
			}
			return { type: "delete", path: filePath };
		case "move":
			if (!destination) {
				throw shapeError(`${where}: a move needs "to" (the destination path).`, record);
			}
			if (content !== undefined || old !== undefined) {
				throw shapeError(
					`${where}: a move cannot also change the file's contents. Send the move and the edit as two ops.`,
					record,
				);
			}
			// a rename is an update with no hunks; the apply loop carries the
			// bytes across untouched.
			return { type: "update", path: filePath, movePath: destination, chunks: [] };
	}
}

/**
 * work out which of the four lanes this call is, and translate it.
 *
 * ORDER IS THE CONTRACT: a call that reads as two lanes at once is refused
 * rather than resolved by precedence, because both readings mutate a file and
 * only one of them is what the caller meant.
 */
function normalizeCall(params: Record<string, unknown>): { intents: Intent[]; lane: Lane } {
	const ops = pickOps(params);
	// an empty envelope carries no information, so it is absent rather than a
	// second lane — models routinely emit every field they can see, and
	// `{ path, content, input: "" }` must not read as a conflict. `content: ""`
	// is NOT treated this way: truncating a file is a real request.
	const inputField = pickString(params, INPUT_KEYS);
	const input = inputField && inputField.value.trim().length > 0 ? inputField : undefined;
	const content = pickString(params, CONTENT_KEYS);
	const old = pickString(params, OLD_KEYS);
	const replacement = pickString(params, NEW_KEYS);
	const filePath = pickString(params, PATH_KEYS)?.value.trim();

	const named: string[] = [];
	if (ops) named.push("ops");
	if (input) named.push(`"${input.key}"`);
	if (content !== undefined) named.push(`"${content.key}"`);
	if (old !== undefined || replacement !== undefined) named.push("old_string/new_string");
	if (named.length > 1) {
		throw shapeError(
			`this call names more than one kind of change at once (${named.join(" and ")}), and they mean different things. Send one.`,
			params,
		);
	}

	if (ops) {
		if (ops.length === 0) throw shapeError("ops is empty — nothing to do.", params);
		/*
		 * A TOP-LEVEL PATH IS INHERITED BY ENTRIES THAT LACK ONE.
		 *
		 * this is not a nicety — it is the exact shape of pi's OWN native edit
		 * tool (`{ path, edits: [{ oldText, newText }] }`) and of Claude Code's
		 * MultiEdit (`{ file_path, edits: [{ old_string, new_string }] }`).
		 * `edits` is one of the OPS_KEYS, so without this the single most
		 * likely thing a Claude-family model emits lands as
		 * "ops[0]: no file path".
		 */
		const intents = ops.map((entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw shapeError(
					`ops[${index}] must be an object like { "op": "write", "path": "...", "content": "..." }.`,
					params,
				);
			}
			return intentFromFields(entry as Record<string, unknown>, `ops[${index}]`, filePath);
		});
		return { intents, lane: "batch" };
	}

	if (input) {
		/*
		 * a path next to a plain blob under the GENERIC key `input` is a write
		 * whose author reached for the wrong key name, and rescuing it is free.
		 *
		 * two gates, and both are load-bearing:
		 *   - the key must be `input`. `patch`, `diff`, `envelope` and
		 *     `patch_text` all say "this is a patch" in the name, so a malformed
		 *     one is an error — never file content. without this,
		 *     `{ path, diff: "-old\n+new" }` writes the DIFF into the file.
		 *   - it must not look like a patch attempt either way, which catches
		 *     the same mistake made under the generic key.
		 */
		if (filePath && input.key === "input" && !looksLikePatchAttempt(input.value)) {
			return { intents: [{ type: "write", path: filePath, content: input.value }], lane: "write" };
		}
		return { intents: parseCodexPatch(normalizeEnvelope(input.value)), lane: "envelope" };
	}

	// an envelope posted under a content-ish key, with no path to write it to.
	if (!filePath && content !== undefined && looksLikePatchAttempt(content.value)) {
		return { intents: parseCodexPatch(normalizeEnvelope(content.value)), lane: "envelope" };
	}

	if (content === undefined && old === undefined && replacement === undefined && !filePath) {
		throw shapeError("no file change was described.", params);
	}

	const intent = intentFromFields(params, "apply_patch");
	// `update` can only be a rename here (a multi-hunk update needs the
	// envelope), and `add` is a write that refuses to clobber. reporting the
	// operation rather than a catch-all keeps the telemetry worth reading.
	const lane: Lane =
		intent.type === "update" ? "move" : intent.type === "add" ? "write" : intent.type;
	return { intents: [intent], lane };
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
 *
 * `before` is the file's current text, which is why this runs inside the apply
 * loop rather than up front: a whole-file `write` has no old/new lines of its
 * own, so without the real file to compare against, every rewrite of a file
 * that legitimately contains such a phrase would be refused.
 */
function assertNoRedaction(intent: Intent, before: string | undefined): void {
	const beforeLines =
		intent.type === "update"
			? intent.chunks.flatMap((chunk) => chunk.oldLines)
			: intent.type === "edit"
				? intent.old.split("\n")
				: (before ?? "").split("\n");
	const afterLines =
		intent.type === "add" || intent.type === "write"
			? intent.content.split("\n")
			: intent.type === "edit"
				? intent.new.split("\n")
				: intent.type === "update"
					? intent.chunks.flatMap((chunk) => chunk.newLines)
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
 *
 * fences and heredocs are stripped silently, and the marker match itself is
 * tolerant (see codex-patch's TOLERANCE note) — so everything this function
 * still rejects is a genuine format mismatch rather than punctuation.
 */
function normalizeEnvelope(raw: string): string {
	let text = raw.trim();

	// strip a surrounding markdown fence, with or without a language tag
	const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
	if (fenced?.[1]) text = fenced[1].trim();

	// before the marker check, not after: a heredoc-wrapped envelope reached
	// the parser (which has always understood them) only if it got past here.
	text = stripHeredoc(text).trim();

	// the parser slices between the markers, so a begin line ANYWHERE means
	// this is an envelope with narration around it.
	if (text.split("\n").some(isBeginLine)) return text;

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
	operation: Intent,
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

// --- the edit lane ---

/**
 * how many non-overlapping times `needle` occurs, and where the first few are.
 *
 * the COUNT is exact while the position list is bounded: an error message that
 * says "matches 65 places" when it means "at least 65" is a lie, and a list of
 * 300k offsets is a memory problem. counting is a scan either way.
 */
function countOccurrences(
	haystack: string,
	needle: string,
): { total: number; positions: number[] } {
	const positions: number[] = [];
	let total = 0;
	if (needle.length === 0) return { total, positions };
	for (let from = 0; ; ) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) break;
		total++;
		if (positions.length < 8) positions.push(at);
		from = at + needle.length;
	}
	return { total, positions };
}

function lineNumberAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * cheap 0..1 likeness, used only to point at the line the caller probably meant.
 *
 * shared prefix + shared suffix over the longer length. deliberately NOT edit
 * distance: this runs over every line of a file on a path that has already
 * failed, and a quadratic algorithm there would turn a helpful message into a
 * hang on a large file. it is exact where it matters (near-identical lines).
 */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	return (prefix + suffix) / longest;
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * turn "not found" into "here is what the file actually says".
 *
 * a bare failure costs a re-read of the whole file; a five-line window costs
 * nothing and is usually enough to fix the call on the next turn.
 */
function nearestLinesHint(content: string, needle: string): string {
	// this allocates two copies of the file, so it is skipped on very large
	// ones: a helpful message must not become the reason a call falls over.
	const AFFORDABLE = 4_000_000;
	if (
		content.length < AFFORDABLE &&
		collapseWhitespace(content).includes(collapseWhitespace(needle))
	) {
		return "\n\nthe text IS in the file, but its whitespace differs. copy it from a fresh read, or match fewer lines.";
	}
	const wanted = needle.split("\n").find((line) => line.trim().length > 0)?.trim();
	if (!wanted) return "";
	const lines = content.split("\n");
	let best = -1;
	let bestScore = 0;
	for (let index = 0; index < lines.length; index++) {
		const score = similarity(wanted, lines[index]!.trim());
		if (score > bestScore) {
			bestScore = score;
			best = index;
		}
	}
	if (best < 0 || bestScore < 0.5) return "";
	const from = Math.max(0, best - 2);
	const to = Math.min(lines.length, best + 3);
	const gutter = String(to).length;
	const window = lines
		.slice(from, to)
		.map((line, offset) => `  ${String(from + offset + 1).padStart(gutter)} | ${line}`)
		.join("\n");
	return `\n\nclosest match:\n${window}\n\n  you sent: ${JSON.stringify(wanted)}\n  file has: ${JSON.stringify(lines[best]!.trim())}`;
}

/**
 * replace an exact span, with the same refusals the envelope lane has.
 *
 * three tiers, in order:
 *   1. exact substring — one hit replaces, several refuse (unless replace_all)
 *   2. whole-line fallback through `applyPatchChunks`, which brings the tested
 *      unicode/whitespace fuzz and the re-indent-to-the-file rule with it. this
 *      is what rescues a hunk copied out of a grep result with the wrong
 *      indentation.
 *   3. a message that shows the file
 *
 * an ambiguity refusal from tier 2 is re-thrown rather than swallowed: "this
 * matches three places" must never degrade into "not found", which would send
 * the caller looking for the wrong problem.
 */
function applyEdit(content: string, intent: Extract<Intent, { type: "edit" }>): string {
	const { total, positions } = countOccurrences(content, intent.old);

	if (total > 1 && !intent.replaceAll) {
		// show the LINE at each match, not just its number: picking the right
		// occurrence is the whole task, and a bare list of numbers makes the
		// caller re-read the file to do it.
		const lines = content.split("\n");
		const shown = positions.slice(0, 5).map((at) => {
			const number = lineNumberAt(content, at);
			return `  line ${number}: ${(lines[number - 1] ?? "").trim()}`;
		});
		const more = total > shown.length ? `\n  … and ${total - shown.length} more` : "";
		throw new Error(
			`old_string matches ${total} places in ${intent.path}:\n${shown.join("\n")}${more}\n` +
				`include more surrounding text so exactly one match remains, or pass replace_all: true.`,
		);
	}
	// split/join, never replace(): a replacement containing $& or $1 would be
	// expanded by String.replace's substitution rules and silently corrupted.
	if (total > 1) return content.split(intent.old).join(intent.new);
	if (total === 1) {
		const at = positions[0]!;
		return content.slice(0, at) + intent.new + content.slice(at + intent.old.length);
	}

	try {
		return applyPatchChunks(
			content,
			[
				{
					oldLines: intent.old.split("\n"),
					// "" means delete the matched lines outright rather than
					// leaving a blank one behind.
					newLines: intent.new === "" ? [] : intent.new.split("\n"),
					endOfFile: false,
				},
			],
			intent.path,
		);
	} catch (error) {
		/*
		 * swallow ONLY "I could not locate this text", because the message
		 * built below says that better. everything else the applier raises is a
		 * DIFFERENT diagnosis — an ambiguous hunk, an indentation mismatch —
		 * and degrading it into "not found" sends the caller hunting for the
		 * wrong problem. an allow-list of what to swallow, not of what to
		 * re-throw, so a newly added diagnosis surfaces by default.
		 */
		if (!/^failed to find/i.test((error as Error).message)) throw error;
	}

	throw new Error(
		`old_string was not found in ${intent.path}.${nearestLinesHint(content, intent.old)}`,
	);
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

const ENVELOPE_HEADER_RE =
	/^\*{2,}\s*(?:Add|Create|New|Delete|Remove|Update|Edit|Modify|Change|Patch|Write|Replace|Overwrite)\s+File\s*:\s*(.+)$/i;

/**
 * the collapsed call line: which files this call touches.
 *
 * shows basenames, and elides past the third — a 25-file batch rendered as 25
 * absolute paths wraps over several lines and pushes everything else off
 * screen. the full list is always in the result below it.
 *
 * reads the same alias tables `normalizeCall` does, so the header cannot drift
 * out of step with the lane that actually ran.
 */
function describeCall(args: Record<string, unknown> | undefined): string {
	if (!args) return "...";
	const names: string[] = [];
	const push = (value: string | undefined) => {
		if (value && value.trim()) names.push(path.basename(value.trim()));
	};

	push(pickString(args, PATH_KEYS)?.value);
	for (const entry of pickOps(args) ?? []) {
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			push(pickString(entry as Record<string, unknown>, PATH_KEYS)?.value);
		}
	}
	for (const line of (pickString(args, INPUT_KEYS)?.value ?? "").split("\n")) {
		const match = ENVELOPE_HEADER_RE.exec(line.trimEnd());
		if (match?.[1]) names.push(path.basename(match[1].trim()));
	}

	if (names.length === 0) return "...";
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

/**
 * opt-in lane telemetry, so "did the new shapes actually get used?" can be
 * answered with data instead of impressions. off unless PI_APPLY_PATCH_METRICS=1,
 * because a tool that writes to the home directory on every call as a side
 * effect of being called is a surprise, and surprises in a mutation tool are
 * exactly what we are trying to remove.
 */
function recordLane(lane: Lane, fileCount: number): void {
	if (process.env.PI_APPLY_PATCH_METRICS !== "1") return;
	try {
		fs.appendFileSync(
			path.join(os.homedir(), ".pi", "apply-patch-lanes.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), lane, files: fileCount })}\n`,
		);
	} catch {
		// telemetry must never be able to fail a real edit
	}
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
		description: [
			"Create, change, delete or move files. One call is one all-or-nothing batch:",
			"if any part fails, nothing is written.",
			"",
			"Four ways to call it — use whichever fits the change:",
			'  whole file      { "path": "src/icon.svg", "content": "<svg>…</svg>" }',
			'  part of a file  { "path": "src/app.ts", "old_string": "size = 28", "new_string": "size = 32" }',
			'  many files      { "ops": [ { "op": "write", "path": "a.ts", "content": "…" }, { "op": "edit", "path": "b.ts", "old_string": "…", "new_string": "…" } ] }',
			'  patch envelope  { "input": "*** Begin Patch\\n*** Update File: f.ts\\n@@\\n-old\\n+new\\n*** End Patch" }',
			"",
			"old_string must appear exactly once in the file — include a little surrounding",
			"text if it does not, or pass replace_all: true to change every occurrence.",
			"Never replace real code with a placeholder such as \"… rest unchanged\".",
		].join("\n"),
		promptSnippet: "Create, edit, delete or move files as one atomic batch",
		/*
		 * these reach EVERY model, and since `constrainedSampling` was removed
		 * they are now the ONLY thing shaping call syntax — there is no longer a
		 * token-level backstop on any provider. Lead with the two simple lanes:
		 * an earlier version led with the envelope and trained the hard path.
		 */
		promptGuidelines: [
			"Use apply_patch for every file creation, change, delete and move. Never modify a file with bash (no `sed -i`, no `>`/`>>` redirection, no `tee`, no heredoc) — that bypasses undo tracking, permission rules and secret scrubbing.",
			"apply_patch takes whichever shape fits: `{ path, content }` writes a whole file, `{ path, old_string, new_string }` changes part of one, `{ ops: [...] }` changes several files in one atomic batch, and `{ input }` takes a Codex `*** Begin Patch` envelope for multi-hunk edits.",
			"For an apply_patch edit, `old_string` must match the file exactly and appear exactly once — copy it from a fresh read rather than from memory, and use `replace_all` only when you really mean every occurrence.",
			"Prefer `{ path, content }` over delete-then-add when replacing a whole file, and put unrelated changes in separate calls.",
		],
		parameters: ApplyPatchParameters,
		executionMode: "sequential",

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const Container = getContainer();
			const record = (args ?? {}) as Record<string, unknown>;
			const raw =
				pickString(record, INPUT_KEYS)?.value ?? pickString(record, CONTENT_KEYS)?.value ?? "";
			const header =
				theme.fg("toolTitle", theme.bold("apply_patch ")) +
				theme.fg("dim", describeCall(record));

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

			const { intents, lane } = normalizeCall((params ?? {}) as Record<string, unknown>);

			const resolved = intents.map((operation) => ({
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
					/*
					 * which paths are the two halves of one move.
					 *
					 * recorded HERE, where it is known for certain, so `undo_edit`
					 * never has to infer it from matching bytes — an inference that
					 * is unanswerable when a batch moves one file and deletes
					 * another holding identical content.
					 */
					const movePartners = new Map<string, string>();

					// apply every operation IN MEMORY first — nothing touches disk
					// until all of them have succeeded.
					for (const { operation, source, destination } of resolved) {
						if (signal?.aborted) throw new Error("apply_patch aborted");
						const current = finalContents.get(source);
						assertNoRedaction(operation, current);
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
						} else if (operation.type === "write") {
							// unlike `add`, this is ALLOWED to replace an existing file:
							// that is what the caller asked for and what the word means.
							// the snapshot above is what makes it undoable, and `add`
							// still exists for "create, and fail if it is already there".
							finalContents.set(source, operation.content);
						} else if (operation.type === "edit") {
							if (current === undefined) throw new Error(`file not found: ${source}`);
							finalContents.set(source, applyEdit(current, { ...operation, path: source }));
						} else if (operation.type === "delete") {
							if (current === undefined) throw new Error(`file not found: ${source}`);
							finalContents.set(source, undefined);
							finalModes.set(source, undefined);
						} else {
							if (current === undefined) throw new Error(`file not found: ${source}`);
							// a rename carries the bytes across untouched. running the
							// applier over zero chunks would rewrite the file's trailing
							// newline, which is a content change nobody asked for.
							const updated =
								operation.chunks.length === 0
									? current
									: applyPatchChunks(current, operation.chunks, source);
							if (destination) {
								// A MOVE MUST NOT CLOBBER.
								//
								// `add` refuses to overwrite; the move branch did not, so a
								// rename onto an occupied path replaced that file's real
								// content and reported success. harmless-looking in the
								// envelope, where a move costs a whole `*** Move to:` line,
								// but `{ path, to }` now makes it two fields — so the guard
								// has to exist. `git mv` refuses this too.
								if (finalContents.get(destination) !== undefined) {
									throw new Error(
										`move destination already exists: ${destination}; delete it first, or send { path, content } if you meant to overwrite it`,
									);
								}
								movePartners.set(source, destination);
								movePartners.set(destination, source);
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
								movePartnerUri: movePartners.has(change.path)
									? `file://${movePartners.get(change.path)}`
									: undefined,
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
					recordLane(lane, resultChanges.length);
					return {
						content: [{ type: "text" as const, text: formatResult(resultChanges) }],
						details: { changes: resultChanges, lane },
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
