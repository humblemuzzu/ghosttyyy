/**
 * codex-patch — parser + fuzzy applier for the Codex `*** Begin Patch` envelope.
 *
 * PROVENANCE
 * ported verbatim from bdsqqq/dots `user/pi/packages/core/codex-patch/index.ts`
 * (MIT, commit e04b620). the implementation is unchanged; only this header was
 * added and the inline `import.meta.vitest` block was moved to
 * `codex-patch.test.ts` so it runs under bun:test like the rest of our suite.
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
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath?: string;
      chunks: PatchChunk[];
    };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function fail(line: number, message: string): never {
  throw new Error(`invalid patch at line ${line}: ${message}`);
}

function unwrapPatch(input: string): string[] {
  let lines = input.trim().split(/\r?\n/);
  const first = lines[0];
  const last = lines.at(-1);
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith("EOF") &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== BEGIN) {
    throw new Error(`invalid patch: first line must be '${BEGIN}'`);
  }
  if (lines.at(-1)?.trim() !== END) {
    throw new Error(`invalid patch: last line must be '${END}'`);
  }
  return lines;
}

function headerPath(line: string, marker: string, lineNumber: number): string {
  const value = line.trim().slice(marker.length).trim();
  if (!value) fail(lineNumber, `${marker.trim()} requires a path`);
  if (value.includes("\0"))
    fail(lineNumber, "paths must not contain NUL bytes");
  return value;
}

function isOperationHeader(line: string): boolean {
  return (
    line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE)
  );
}

export function parseCodexPatch(input: string): PatchOperation[] {
  const lines = unwrapPatch(input);
  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    const lineNumber = index + 1;

    if (line.startsWith(ADD)) {
      const path = headerPath(line, ADD, lineNumber);
      index++;
      const added: string[] = [];
      while (
        index < lines.length - 1 &&
        !isOperationHeader(lines[index] ?? "")
      ) {
        const addedLine = lines[index] ?? "";
        if (!addedLine.startsWith("+")) {
          fail(index + 1, "every Add File content line must start with '+'");
        }
        added.push(addedLine.slice(1));
        index++;
      }
      if (added.length === 0) fail(lineNumber, "Add File must contain content");
      operations.push({ type: "add", path, content: `${added.join("\n")}\n` });
      continue;
    }

    if (line.startsWith(DELETE)) {
      operations.push({
        type: "delete",
        path: headerPath(line, DELETE, lineNumber),
      });
      index++;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = headerPath(line, UPDATE, lineNumber);
      index++;
      let movePath: string | undefined;
      if ((lines[index] ?? "").trim().startsWith(MOVE)) {
        movePath = headerPath((lines[index] ?? "").trim(), MOVE, index + 1);
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
        !isOperationHeader(lines[index] ?? "")
      ) {
        const updateLine = lines[index] ?? "";
        const trimmed = updateLine.trimEnd();
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
        } else if (trimmed === END_OF_FILE) {
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

    fail(
      lineNumber,
      "expected an Add File, Delete File, or Update File header",
    );
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
function reindentToFile(
  newLines: string[],
  patchIndent: string,
  fileIndent: string,
): string[] {
  if (patchIndent === fileIndent) return newLines;
  return newLines.map((line) => {
    if (line.trim().length === 0) return line;
    return line.startsWith(patchIndent)
      ? fileIndent + line.slice(patchIndent.length)
      : fileIndent + line.trimStart();
  });
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
      newLines = reindentToFile(
        newLines,
        indentOf(oldLines[0]),
        indentOf(lines[match] ?? ""),
      );
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

