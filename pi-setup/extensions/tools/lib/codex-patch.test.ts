/**
 * tests for lib/codex-patch.ts
 *
 * ported from bdsqqq/dots `user/pi/packages/core/codex-patch/index.ts` (MIT,
 * commit e04b620), where they lived in an inline `import.meta.vitest` block.
 * converted to bun:test to match the rest of our suite; assertions unchanged.
 *
 * run: bun test lib/codex-patch.test.ts
 */

import { describe, expect, it } from "bun:test";
import { applyPatchChunks, parseCodexPatch } from "./codex-patch";

// upstream's tests lived inside the module and closed over these private
// markers. they are re-declared here rather than exported from codex-patch.ts,
// so the ported implementation stays byte-identical to upstream. if a marker
// ever changes, these tests fail loudly — which is the desired behaviour.
const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";


describe("parseCodexPatch", () => {
  it("parses add, delete, update, move, and multiple chunks", () => {
    const operations = parseCodexPatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Delete File: deleted.txt
*** Update File: old.txt
*** Move to: moved.txt
@@ first
-old
+new
@@
-tail
+done
*** End Patch`);
    expect(operations).toEqual([
      { type: "add", path: "added.txt", content: "hello\n" },
      { type: "delete", path: "deleted.txt" },
      {
        type: "update",
        path: "old.txt",
        movePath: "moved.txt",
        chunks: [
          {
            context: "first",
            oldLines: ["old"],
            newLines: ["new"],
            endOfFile: false,
          },
          {
            oldLines: ["tail"],
            newLines: ["done"],
            endOfFile: false,
          },
        ],
      },
    ]);
  });

  it("rejects malformed and empty patches", () => {
    expect(() => parseCodexPatch("not a patch")).toThrow("first line");
    expect(() => parseCodexPatch(`${BEGIN}\n${END}`)).toThrow(
      "no file operations",
    );
    expect(() => parseCodexPatch(`${BEGIN}\n${ADD}x\nplain\n${END}`)).toThrow(
      "must start with '+'",
    );
  });

  it("treats marker-like lines with a context prefix as file content", () => {
    const [operation] = parseCodexPatch(`*** Begin Patch
*** Update File: target.txt
@@
 *** Update File: literal.txt
-old
+new
*** End Patch`);

    expect(operation).toMatchObject({
      type: "update",
      chunks: [
        {
          oldLines: ["*** Update File: literal.txt", "old"],
          newLines: ["*** Update File: literal.txt", "new"],
        },
      ],
    });
  });

  it("treats the end marker with a context prefix as file content", () => {
    const [operation] = parseCodexPatch(`*** Begin Patch
*** Update File: target.txt
@@
 *** End Patch
-old
+new
*** End Patch`);

    expect(operation).toMatchObject({
      type: "update",
      chunks: [
        {
          oldLines: ["*** End Patch", "old"],
          newLines: ["*** End Patch", "new"],
        },
      ],
    });
  });

  it("accepts whitespace-padded patch envelope markers", () => {
    expect(
      parseCodexPatch(` *** Begin Patch
*** Add File: x.txt
+x
 *** End Patch `),
    ).toEqual([{ type: "add", path: "x.txt", content: "x\n" }]);
  });
});

describe("applyPatchChunks", () => {
  it("applies ordered chunks with context and fuzzy whitespace", () => {
    // DELIBERATE DIVERGENCE FROM UPSTREAM.
    //
    // upstream asserts "function x() {\nnew\n}\ndone\n" — note `new` at column
    // 0, even though the line it replaced (`  old  `) was indented inside the
    // function body. that is the fuzzy-match indentation bug: the hunk matched
    // only because leading whitespace was ignored, then its own (absent)
    // indentation was written to the file verbatim.
    //
    // seen in the wild on claude-opus, which grepped instead of reading and
    // produced a hunk one space off; the file silently gained a leading space.
    // applyPatchChunks now re-indents replacements to the FILE's indentation
    // whenever the match ignored leading whitespace.
    const result = applyPatchChunks(
      "function x() {\n  old  \n}\ntail\n",
      [
        {
          context: "function x() {",
          oldLines: ["old"],
          newLines: ["new"],
          endOfFile: false,
        },
        {
          oldLines: ["tail"],
          newLines: ["done"],
          endOfFile: true,
        },
      ],
      "x.ts",
    );
    expect(result).toBe("function x() {\n  new\n}\ndone\n");
  });

  it("preserves relative indentation when re-indenting a fuzzy match", () => {
    // the shift is computed from the first line and applied uniformly, so a
    // nested block keeps its shape rather than being flattened.
    const result = applyPatchChunks(
      "class A {\n    doThing() {\n      return 1;\n    }\n}\n",
      [
        {
          oldLines: ["doThing() {", "  return 1;", "}"],
          newLines: ["doThing() {", "  return 2;", "}"],
          endOfFile: false,
        },
      ],
      "a.ts",
    );
    expect(result).toBe("class A {\n    doThing() {\n      return 2;\n    }\n}\n");
  });

  it("leaves indentation alone when the match was exact", () => {
    const result = applyPatchChunks(
      "function x() {\n  old\n}\n",
      [{ oldLines: ["  old"], newLines: ["      deeper"], endOfFile: false }],
      "x.ts",
    );
    // the patch matched exactly, so its indentation is authoritative
    expect(result).toBe("function x() {\n      deeper\n}\n");
  });

  it("preserves BOM and CRLF", () => {
    expect(
      applyPatchChunks(
        "\uFEFFa\r\nb\r\n",
        [{ oldLines: ["b"], newLines: ["c"], endOfFile: false }],
        "x.txt",
      ),
    ).toBe("\uFEFFa\r\nc\r\n");
  });

  it("fails without matching context", () => {
    expect(() =>
      applyPatchChunks(
        "a\n",
        [{ oldLines: ["missing"], newLines: ["x"], endOfFile: false }],
        "x.txt",
      ),
    ).toThrow("failed to find expected lines");
  });
});

// --- our additions ---
// upstream covers whitespace fuzz + BOM/CRLF. these pin the two properties we
// specifically depend on for model-generated patches, so a future refactor of
// normalizeFuzzy/seekSequence can't silently regress them.
describe("codex-patch: properties we rely on", () => {
	it("applies a patch whose context drifted to unicode quotes/dashes", () => {
		const original = 'const msg = "hello";\nconst dash = a-b;\n';
		const result = applyPatchChunks(
			original,
			// model emitted curly quotes where the file has straight ones
			[{ oldLines: ['const msg = \u201Chello\u201D;'], newLines: ['const msg = "bye";'], endOfFile: false }],
			"x.ts",
		);
		expect(result).toBe('const msg = "bye";\nconst dash = a-b;\n');
	});

	it("applies a patch whose context drifted to a non-breaking space", () => {
		const original = "const a = 1;\n";
		const result = applyPatchChunks(
			original,
			[{ oldLines: ["const\u00A0a = 1;"], newLines: ["const a = 2;"], endOfFile: false }],
			"x.ts",
		);
		expect(result).toBe("const a = 2;\n");
	});

	it("applies later chunks without earlier splices shifting line indices", () => {
		const original = "l1\nl2\nl3\nl4\nl5\n";
		const result = applyPatchChunks(
			original,
			[
				{ oldLines: ["l1"], newLines: ["a1", "a2", "a3"], endOfFile: false },
				{ oldLines: ["l5"], newLines: ["z5"], endOfFile: false },
			],
			"x.txt",
		);
		expect(result).toBe("a1\na2\na3\nl2\nl3\nl4\nz5\n");
	});
});
