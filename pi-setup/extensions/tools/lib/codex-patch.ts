/**
 * codex-patch — parser + fuzzy applier for the Codex `*** Begin Patch` envelope.
 *
 * PROVENANCE
 * ported verbatim from bdsqqq/dots `user/pi/packages/core/codex-patch/index.ts`
 * (MIT, commit e04b620). the matching/applying core is his and is unchanged.
 * the PARSER has since been deliberately loosened — see TOLERANCE below.
 *
 * WHY WE HAVE IT
 * this is the patch FORMAT parser used by the `apply_patch` tool (Phase 4). it
 * has nothing to do with which model you run — it is simply the edit envelope,
 * and apply_patch cannot parse anything without it.
 *
 * NOTABLE BEHAVIOUR (all carried over from upstream)
 *   - preserves the file's original BOM and CRLF/LF line endings
 *   - 4-tier fuzzy line matching: exact -> trimEnd -> trim -> unicode-normalised
 *     (so smart quotes / dash variants / trailing-whitespace drift still apply)
 *   - tolerates a trailing blank line when locating a chunk
 *   - applies replacements back-to-front so earlier splices don't shift later
 *     line indices
 *
 * TOLERANCE (ours, added 2026-08-12)
 * this envelope is OpenAI's V4A format: their models were trained on it and
 * every other model was not. the format itself is not negotiable — it is what a
 * pasted codex patch looks like — but the PUNCTUATION around it is, and losing
 * a round trip to a stray asterisk is pure tax. so the parser now accepts every
 * near-miss that has exactly one sane reading:
 *   - `*** Begin Patch ***`, `** Begin patch`, odd spacing, any case
 *   - prose before the begin marker or after the end marker (sliced away)
 *   - a `<<EOF` heredoc wrapper, with or without a leading command word
 *   - `@@ -1,3 +1,3 @@` — git's line numbers are dropped, and any trailing
 *     function hint is kept as the anchor
 *   - header spellings models actually guess: Create/New File, Remove File,
 *     Edit/Modify/Change File, Write/Replace/Overwrite File, Rename to
 *   - an Add/Write block written WITHOUT `+` prefixes (all-or-nothing: a
 *     PARTIALLY prefixed block is still an error, because that is a slip
 *     rather than a style, and guessing which lines were meant eats content)
 *   - a bare blank line inside a `+` block, which upstream failed the whole
 *     patch over — the single most annoying way to lose a 200-line file
 *
 * STILL STRICT, ON PURPOSE
 * a patch with NO end marker at all is an error, never an implicit
 * end-of-patch: a patch truncated mid-generation looks exactly like one whose
 * author forgot the marker, and guessing turns a dropped stream into a
 * half-written file.
 *
 * the honest limit of that guarantee: the envelope ends at the LAST end-marker
 * line, and `isEndLine` trims, so a hunk's context line ` *** End Patch` is
 * indistinguishable from a real terminator IF the stream is cut off right
 * after it. upstream had the identical hole (its last-line equality check also
 * trimmed) and closing it would break marker padding, which the test
 * "accepts whitespace-padded patch envelope markers" requires. an unprefixed
 * Add/Write body is the one case we CAN close, and `readContentBlock` does.
 *
 * MARKERS INSIDE CONTENT
 * a header is only a header at column 0. `matchHeader` trims the END of a line
 * but never the start, so the context line ` *** Update File: x` stays content.
 * only the top-level dispatch, where no chunk is open, tolerates indentation.
 *
 * this file intentionally has ZERO imports — keep it that way.
 */

export interface PatchChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "write"; path: string; content: string }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath?: string;
      chunks: PatchChunk[];
    };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

const BEGIN_RE = /^\*{2,}\s*Begin\s+Patch\s*\**\s*$/i;
const END_RE = /^\*{2,}\s*End\s+Patch\s*\**\s*$/i;
const MOVE_RE = /^\*{2,}\s*(?:Move|Rename)\s+to\s*:\s*/i;
const END_OF_FILE_RE = /^\*{2,}\s*End\s+of\s+File\s*\**\s*$/i;
const CONTENT_RE = /^\*{2,}\s*(?:Begin\s+)?Content\s*\**\s*$/i;
const END_CONTENT_RE = /^\*{2,}\s*End\s+Content\s*\**\s*$/i;

/** git-style hunk numbers: `@@ -1,3 +1,3 @@`, optionally with a trailing hint. */
const HUNK_NUMBERS_RE = /^@@+\s*-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@*\s*/;

type HeaderKind = "add" | "write" | "delete" | "update";

/**
 * header spellings we accept. no two patterns may overlap, and none can collide
 * with `Begin/End Patch` (those carry no path and no colon).
 */
const HEADERS: Array<{ re: RegExp; kind: HeaderKind }> = [
  { re: /^\*{2,}\s*(?:Add|Create|New)\s+File\s*:\s*/i, kind: "add" },
  { re: /^\*{2,}\s*(?:Write|Replace|Overwrite)\s+File\s*:\s*/i, kind: "write" },
  { re: /^\*{2,}\s*(?:Delete|Remove)\s+File\s*:\s*/i, kind: "delete" },
  {
    re: /^\*{2,}\s*(?:Update|Edit|Modify|Change|Patch)\s+File\s*:\s*/i,
    kind: "update",
  },
];

export function isBeginLine(line: string): boolean {
  return BEGIN_RE.test(line.trim());
}

export function isEndLine(line: string): boolean {
  return END_RE.test(line.trim());
}

/**
 * does this line, AT COLUMN 0, look like any patch marker?
 *
 * used to refuse an unprefixed content block that contains one, rather than
 * letting `unwrapPatch`'s terminator scan silently eat it. `+`-prefixed and
 * explicit `*** Content` blocks cannot hit this, which is the whole point of
 * offering them.
 */
function looksLikeMarker(rawLine: string): boolean {
  const line = rawLine.trimEnd();
  return (
    BEGIN_RE.test(line) ||
    END_RE.test(line) ||
    MOVE_RE.test(line) ||
    END_OF_FILE_RE.test(line) ||
    CONTENT_RE.test(line) ||
    END_CONTENT_RE.test(line) ||
    matchHeader(line) !== undefined
  );
}

interface HeaderMatch {
  kind: HeaderKind;
  path: string;
}

/**
 * `allowIndent` is load-bearing, not a convenience.
 *
 * inside an open chunk a leading space IS the context marker, so the line
 * ` *** Update File: x` must stay file content — a property upstream got right
 * and a naive `.trim()` here would silently destroy (there are two tests for
 * it). only the top-level dispatch, where no chunk is open, may trim the start.
 */
function matchHeader(rawLine: string, allowIndent = false): HeaderMatch | undefined {
  const line = allowIndent ? rawLine.trim() : rawLine.trimEnd();
  for (const { re, kind } of HEADERS) {
    const match = re.exec(line);
    if (match) return { kind, path: line.slice(match[0].length).trim() };
  }
  return undefined;
}

function fail(line: number, message: string): never {
  throw new Error(`invalid patch at line ${line}: ${message}`);
}

/**
 * `apply_patch <<"EOF" … EOF`. openai's own documentation shows the envelope
 * wrapped this way, so models paste it verbatim; the leading command word is
 * optional because they also drop it.
 */
const HEREDOC_OPEN_RE =
  /^(?:[\w./\\-]+[ \t]+)*<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*$/;

export function stripHeredoc(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const opener = lines[0] ? HEREDOC_OPEN_RE.exec(lines[0].trim()) : null;
  if (!opener || lines.length < 3) return text;
  const tag = opener[2];
  for (let index = lines.length - 1; index > 0; index--) {
    if (lines[index]?.trim() === tag) return lines.slice(1, index).join("\n");
  }
  return text;
}

function unwrapPatch(input: string): string[] {
  const lines = stripHeredoc(input).trim().split(/\r?\n/);

  // slice BETWEEN the markers rather than demanding they be the first and last
  // lines: models narrate around them ("Here's the patch:"), and prose outside
  // the envelope cannot change what the envelope means.
  const begin = lines.findIndex(isBeginLine);
  if (begin < 0) {
    throw new Error(`invalid patch: first line must be '${BEGIN}'`);
  }
  // scan backwards so a marker-looking line inside content loses to the real
  // terminator, which is by definition the last one.
  let end = -1;
  for (let index = lines.length - 1; index > begin; index--) {
    if (isEndLine(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    throw new Error(
      `invalid patch: last line must be '${END}'. a patch cut off mid-generation looks exactly like one missing its marker, so it is refused rather than half-applied — re-send the whole envelope.`,
    );
  }
  return lines.slice(begin, end + 1);
}

function assertPath(value: string, what: string, lineNumber: number): string {
  if (!value) fail(lineNumber, `${what} requires a path`);
  if (value.includes("\0")) fail(lineNumber, "paths must not contain NUL bytes");
  return value;
}

function joinContent(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * turn the lines under an Add/Write header into file content.
 *
 * two accepted spellings:
 *   1. every line `+`-prefixed: the canonical V4A form.
 *   2. NO line prefixed: the whole block verbatim.
 *
 * the third spelling — an explicit `*** Content` / `*** End Content` block —
 * is handled by the caller, because it changes where the block ENDS and so
 * cannot be decided after the lines have already been collected.
 *
 * a partially prefixed block is rejected — see TOLERANCE at the top of the file.
 */
function readContentBlock(
  block: string[],
  kind: "add" | "write",
  headerLine: number,
): string {
  // a bare blank line before the next header is formatting, not content. an
  // INTENTIONAL trailing blank line is spelled `+`, which is not blank here.
  const lines = [...block];
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const nonEmpty = lines.filter((line) => line.length > 0);
  const prefixed = nonEmpty.filter((line) => line.startsWith("+"));

  if (nonEmpty.length === 0) {
    if (kind === "add") {
      fail(
        headerLine,
        "Add File must contain content (to create an empty file use '*** Write File:' or the { path, content } form)",
      );
    }
    return "";
  }
  if (prefixed.length === nonEmpty.length) {
    return joinContent(
      lines.map((line) => (line.startsWith("+") ? line.slice(1) : line)),
    );
  }
  if (prefixed.length === 0) {
    /*
     * REFUSE, do not truncate.
     *
     * `unwrapPatch` ends the envelope at the LAST end-marker anywhere in the
     * text, so an unprefixed body containing one loses everything after it —
     * silently, reported as success. measured: a file documenting this very
     * format came back missing its last line.
     *
     * `+` prefixes and the explicit `*** Content` block both make content
     * unmistakable, so they are unaffected; this is only the convenience path
     * refusing a case it cannot read unambiguously.
     */
    const marker = lines.findIndex(looksLikeMarker);
    if (marker >= 0) {
      fail(
        headerLine + marker + 1,
        `this unprefixed block contains a line that looks like a patch marker (${JSON.stringify(lines[marker])}), so where the file ends is ambiguous. prefix every content line with '+', or wrap the body in '*** Content' / '*** End Content'.`,
      );
    }
    return joinContent(lines);
  }

  const offset = lines.findIndex(
    (line) => line.length > 0 && !line.startsWith("+"),
  );
  fail(
    headerLine + offset + 1,
    `every Add File content line must start with '+', and this one does not: ${JSON.stringify(lines[offset])}. prefix every line, or none of them.`,
  );
}

export function parseCodexPatch(input: string): PatchOperation[] {
  const lines = unwrapPatch(input);
  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    const header = matchHeader(raw, true);
    if (!header) {
      fail(
        lineNumber,
        "expected a file header: '*** Update File: <path>', '*** Add File: <path>', '*** Write File: <path>' or '*** Delete File: <path>'",
      );
    }
    const filePath = assertPath(header.path, "a file header", lineNumber);
    index++;

    if (header.kind === "add" || header.kind === "write") {
      let content: string;
      if (CONTENT_RE.test((lines[index] ?? "").trimEnd())) {
        // an explicit block ends ONLY at its own marker, so its lines are
        // never inspected for file headers. that is the entire point of it:
        // it is the one way to write a file whose content contains lines
        // like `*** Update File: x`. scanning for headers first (as the
        // non-explicit path must) would cut the block short.
        index++;
        const raw: string[] = [];
        while (
          index < lines.length - 1 &&
          !END_CONTENT_RE.test((lines[index] ?? "").trimEnd())
        ) {
          raw.push(lines[index] ?? "");
          index++;
        }
        if (index < lines.length - 1) index++; // consume the closing marker
        content = joinContent(raw);
      } else {
        const block: string[] = [];
        while (index < lines.length - 1 && !matchHeader(lines[index] ?? "")) {
          block.push(lines[index] ?? "");
          index++;
        }
        content = readContentBlock(block, header.kind, lineNumber);
      }
      operations.push({ type: header.kind, path: filePath, content });
      continue;
    }

    if (header.kind === "delete") {
      operations.push({ type: "delete", path: filePath });
      continue;
    }

    {
      const path = filePath;
      let movePath: string | undefined;
      const moveLine = (lines[index] ?? "").trim();
      const moveMatch = MOVE_RE.exec(moveLine);
      if (moveMatch) {
        movePath = assertPath(
          moveLine.slice(moveMatch[0].length).trim(),
          "'*** Move to:'",
          index + 1,
        );
        index++;
      }

      const chunks: PatchChunk[] = [];
      let current: PatchChunk | undefined;
      const ensureChunk = (): PatchChunk => {
        current ??= { oldLines: [], newLines: [], endOfFile: false };
        if (!chunks.includes(current)) chunks.push(current);
        return current;
      };

      while (
        index < lines.length - 1 &&
        !matchHeader(lines[index] ?? "")
      ) {
        const updateLine = lines[index] ?? "";
        let trimmed = updateLine.trimEnd();
        if (trimmed.startsWith("@@")) {
          // A NUMBERED HEADER IS GIT'S, INCLUDING ITS HINT.
          //
          // the numbers are noise here — the context IS the address. the
          // trailing function hint goes with them, and that is not obvious:
          // in V4A `@@ foo` is a REQUIRED anchor that must match a line
          // exactly, whereas git's hint is a truncated, approximate label for
          // the enclosing scope. promoting it to an anchor turns a working
          // patch into "failed to find context 'someFn'".
          //
          // dropping it only widens the search, and the ambiguity guard still
          // refuses to place a hunk it cannot place uniquely.
          if (HUNK_NUMBERS_RE.test(trimmed)) trimmed = "@@";
        }
        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          if (
            current &&
            current.oldLines.length === 0 &&
            current.newLines.length === 0
          ) {
            fail(index + 1, "empty update chunk");
          }
          current = {
            ...(trimmed.length > 2 ? { context: trimmed.slice(3) } : {}),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };
          chunks.push(current);
        } else if (END_OF_FILE_RE.test(trimmed)) {
          const chunk = ensureChunk();
          if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
            fail(index + 1, "empty update chunk");
          }
          chunk.endOfFile = true;
        } else if (updateLine === "") {
          const chunk = ensureChunk();
          chunk.oldLines.push("");
          chunk.newLines.push("");
        } else if (updateLine.startsWith(" ")) {
          const value = updateLine.slice(1);
          const chunk = ensureChunk();
          chunk.oldLines.push(value);
          chunk.newLines.push(value);
        } else if (updateLine.startsWith("+")) {
          ensureChunk().newLines.push(updateLine.slice(1));
        } else if (updateLine.startsWith("-")) {
          ensureChunk().oldLines.push(updateLine.slice(1));
        } else {
          fail(
            index + 1,
            "update lines must start with ' ', '+', '-', '@@', or an end-of-file marker",
          );
        }
        index++;
      }

      if (
        current &&
        current.oldLines.length === 0 &&
        current.newLines.length === 0
      ) {
        fail(index, "empty update chunk");
      }
      if (chunks.length === 0 && !movePath) {
        fail(lineNumber, "Update File must contain a change or move");
      }
      operations.push({ type: "update", path, movePath, chunks });
      continue;
    }
  }

  if (operations.length === 0)
    throw new Error("invalid patch: no file operations");
  return operations;
}

function normalizeFuzzy(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function equalAt(
  lines: string[],
  pattern: string[],
  index: number,
  normalize: (value: string) => string,
): boolean {
  return pattern.every(
    (line, offset) =>
      normalize(lines[index + offset] ?? "") === normalize(line),
  );
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  return seekSequenceAll(lines, pattern, start, endOfFile).hits[0];
}

/** leading whitespace of a line. */
function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * re-indent a hunk's replacement lines to the file's real indentation.
 *
 * only used when the old lines matched via a whitespace-insensitive
 * normalizer, which means the patch's own indentation was WRONG. inserting the
 * replacement verbatim then rewrites the file's indentation to the model's
 * mistake — observed live: claude-opus grepped instead of reading, wrote the
 * hunk one space too deep, and the file silently gained a leading space.
 *
 * the shift is computed from the first line and applied uniformly, so relative
 * indentation inside the hunk is preserved.
 */
function shiftLine(line: string, patchIndent: string, fileIndent: string): string {
  if (line.trim().length === 0) return line;
  return line.startsWith(patchIndent)
    ? fileIndent + line.slice(patchIndent.length)
    : fileIndent + line.trimStart();
}

/**
 * refuse a re-indent that cannot reproduce the file's OWN indentation.
 *
 * THE IDEA: we already know the right answer for the old lines — they are the
 * file. So apply the exact same shift to them and check it reproduces what is
 * actually on disk. If the transformation cannot even rebuild the lines it was
 * derived from, it has no business being applied to the new ones.
 *
 * This is what catches the case the earlier mix-detector missed. That check
 * lived inside `reindentToFile`, which returns early when the FIRST line's
 * indent already matches — so a hunk anchored at column 0 (`build:` in a
 * Makefile) skipped every check, and the tab-indented recipe line underneath it
 * was silently rewritten with spaces. No mixing, no error, broken build.
 * Reported by grok-4.5 after the first fix, 2026-08-12.
 *
 * Only INDENTATION is compared, not the whole line: the match may have been
 * made through the unicode/whitespace normalisers, so the text itself is
 * legitimately allowed to differ.
 */
function assertShiftIsFaithful(
  oldLines: string[],
  fileLines: string[],
  match: number,
  patchIndent: string,
  fileIndent: string,
  filePath: string,
): void {
  for (let offset = 0; offset < oldLines.length; offset++) {
    const expected = indentOf(shiftLine(oldLines[offset]!, patchIndent, fileIndent));
    const actual = indentOf(fileLines[match + offset] ?? "");
    if (expected === actual) continue;
    const describe = (indent: string) =>
      indent.includes("\t") ? (indent.includes(" ") ? "mixed tabs and spaces" : "tabs") : "spaces";
    throw new Error(
      `indentation mismatch in ${filePath} at line ${match + offset + 1}: the file indents with ` +
        `${describe(actual)} and your text uses ${describe(oldLines[offset] ?? "")}, so applying it ` +
        `would rewrite the file's indentation style. copy the exact text from a fresh read — in a ` +
        `Makefile or Python file this changes what the code means.`,
    );
  }
}

function reindentToFile(
  newLines: string[],
  patchIndent: string,
  fileIndent: string,
  filePath: string,
): string[] {
  if (patchIndent === fileIndent) return newLines;
  const shifted = newLines.map((line) => shiftLine(line, patchIndent, fileIndent));

  /*
   * REFUSE TO INVENT AN INDENT STYLE THE FILE DOES NOT USE.
   *
   * the shift above fixes the OUTER level by construction — it prepends the
   * file's own indent — but any deeper level inside the hunk keeps whatever
   * character the patch used. so a tab-indented file patched with a
   * space-indented hunk comes back as `\t  return 2;`: outer tab, inner
   * spaces. that is silent byte corruption, and in a Makefile (where a tab is
   * syntax) or mixed-indent Python it is outright breakage.
   *
   * mixing is the exact signature of that translation, and it cannot be
   * repaired without guessing the file's indent WIDTH — so this refuses
   * instead. the safe case (same character, different depth) never mixes and
   * is unaffected, which is the case the fuzzy tier exists for.
   *
   * found by grok-4.5 stress-testing the tool, 2026-08-12.
   */
  const mixes = (line: string) => {
    const indent = indentOf(line);
    return indent.includes("\t") && indent.includes(" ");
  };
  if (shifted.some(mixes) && !newLines.some(mixes)) {
    throw new Error(
      `indentation mismatch in ${filePath}: the file indents with ${
        fileIndent.includes("\t") ? "tabs" : "spaces"
      } but your text uses ${patchIndent.includes("\t") ? "tabs" : "spaces"}, ` +
        `and translating the nested levels would mix the two. copy the exact text from a fresh read of the file.`,
    );
  }
  return shifted;
}

/**
 * every index where `pattern` matches, at the FIRST normalizer strength that
 * matches at all.
 *
 * matching escalates exact -> trimEnd -> trim -> fuzzy, and stops at the first
 * level that produces any hit: a pattern that matches exactly in one place must
 * not be called ambiguous just because a sloppier comparison also matches
 * somewhere else.
 *
 * callers use the count to detect an ambiguous hunk (see applyPatchChunks).
 */
function seekSequenceAll(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
): { hits: number[]; exact: boolean } {
  if (pattern.length === 0) return { hits: [start], exact: true };
  if (pattern.length > lines.length) return { hits: [], exact: true };
  const first = endOfFile ? lines.length - pattern.length : start;
  const last = lines.length - pattern.length;
  const normalizers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
    normalizeFuzzy,
  ];
  for (const [level, normalize] of normalizers.entries()) {
    const hits: number[] = [];
    for (let index = first; index <= last; index++) {
      if (equalAt(lines, pattern, index, normalize)) hits.push(index);
    }
    // levels 0 and 1 only differ in TRAILING whitespace, so leading
    // indentation is still trustworthy; 2 and 3 strip leading whitespace too.
    if (hits.length > 0) return { hits, exact: level <= 1 };
  }
  return { hits: [], exact: true };
}

export function applyPatchChunks(
  content: string,
  chunks: PatchChunk[],
  filePath: string,
): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? content.slice(1) : content;
  const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const normalized = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const replacements: Array<{
    index: number;
    oldLength: number;
    newLines: string[];
  }> = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = seekSequence(lines, [chunk.context], cursor, false);
      if (contextIndex === undefined) {
        throw new Error(
          `failed to find context '${chunk.context}' in ${filePath}`,
        );
      }
      cursor = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({
        index: lines.length,
        oldLength: 0,
        newLines: chunk.newLines,
      });
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequenceAll(lines, oldLines, cursor, chunk.endOfFile);
    if (found.hits.length === 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seekSequenceAll(lines, oldLines, cursor, chunk.endOfFile);
    }
    const matches = found.hits;
    if (matches.length === 0) {
      throw new Error(
        `failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    /*
     * AMBIGUITY GUARD (not in upstream, and not in OpenAI's reference either).
     *
     * upstream takes the first match. when a hunk's context appears more than
     * once — a repeated log line, an identical field in two structs — that
     * silently edits the WRONG occurrence and reports success. verified: a
     * bare `@@` hunk for a line appearing in two functions patched the first
     * one, with no warning.
     *
     * `edit`'s old_str path has always refused this ("found N occurrences").
     * this brings apply_patch to the same standard.
     *
     * an explicit `@@ <anchor>` is treated as the author having expressed
     * WHERE they mean: the cursor already sits after that anchor, so a first
     * match beyond it is intentional and allowed. only an unanchored,
     * genuinely ambiguous hunk is rejected.
     */
    if (matches.length > 1 && chunk.context === undefined && !chunk.endOfFile) {
      throw new Error(
        `ambiguous hunk in ${filePath}: these lines match ${matches.length} places.\n` +
          `add surrounding context lines, or anchor the hunk with '@@ <enclosing line>', ` +
          `so the intended location is unambiguous:\n${oldLines.join("\n")}`,
      );
    }
    const match = matches[0];

    // the match ignored leading whitespace, so trust the FILE's indentation
    // rather than the patch's (see reindentToFile).
    if (!found.exact && oldLines.length > 0) {
      const patchIndent = indentOf(oldLines[0]!);
      const fileIndent = indentOf(lines[match] ?? "");
      // prove the shift on the lines whose answer we already know, THEN use it
      assertShiftIsFaithful(oldLines, lines, match, patchIndent, fileIndent, filePath);
      newLines = reindentToFile(newLines, patchIndent, fileIndent, filePath);
    }

    replacements.push({
      index: match,
      oldLength: oldLines.length,
      newLines,
    });
    cursor = match + oldLines.length;
  }

  for (const replacement of [...replacements].sort(
    (a, b) => b.index - a.index,
  )) {
    lines.splice(
      replacement.index,
      replacement.oldLength,
      ...replacement.newLines,
    );
  }
  const result = `${lines.join("\n")}\n`;
  return bom + (lineEnding === "\r\n" ? result.replace(/\n/g, "\r\n") : result);
}

