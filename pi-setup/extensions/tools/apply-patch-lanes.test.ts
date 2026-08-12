/**
 * apply_patch — the four call lanes, their tolerances, and their refusals.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM apply-patch.test.ts
 * that file pins the DISK contract: atomicity, rollback, symlink refusal, the
 * case-alias deadlock, undo records. this one pins the WIRE contract: what a
 * model is allowed to type. they fail for different reasons and should not be
 * read as one thing.
 *
 * everything here runs the real `execute()` against a real temp filesystem —
 * no mocks — because a lane that parses correctly and then writes the wrong
 * bytes is exactly the failure we are trying to prevent.
 *
 * the generated blocks are deliberate. an alias table is a claim about many
 * inputs, so it is tested over all of them rather than over the three someone
 * happened to think of; the fuzz blocks are seeded, so a failure reproduces.
 */

import { test, expect, afterAll, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApplyPatchTool } from "./apply-patch";
import { createRedoEditTool, createUndoEditTool } from "./undo-edit";
import { toolArgSummary } from "./lib/sub-agent-render";
import * as ft from "./lib/file-tracker";

const tool = createApplyPatchTool() as any;
const DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-lanes-")));
const SESSION = `apply-patch-lanes-${Date.now()}`;
const ctx = { cwd: DIR, sessionManager: { getSessionId: () => SESSION } };

let calls = 0;
let fixtures = 0;

const call = (args: unknown) => tool.execute(`lane-${calls++}`, args, undefined, undefined, ctx);
const read = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const exists = (name: string) => fs.existsSync(path.join(DIR, name));

/** a fresh file per case, so no test can be perturbed by another. */
function fixture(content: string, extension = ".ts"): string {
	const name = `f${fixtures++}${extension}`;
	fs.writeFileSync(path.join(DIR, name), content);
	return name;
}

function freshName(extension = ".ts"): string {
	return `n${fixtures++}${extension}`;
}

/** run a call expected to be refused, and return the message. */
async function refuse(args: unknown): Promise<string> {
	try {
		await call(args);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`expected refusal, but the call succeeded: ${JSON.stringify(args).slice(0, 200)}`);
}

afterAll(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.rmSync(path.join(os.homedir(), ".pi", "file-changes", SESSION), {
		recursive: true,
		force: true,
	});
	console.log(`\n[apply-patch-lanes] ${calls} real tool calls executed`);
});

// ---------------------------------------------------------------------------
// lane 1 — write a whole file
// ---------------------------------------------------------------------------

describe("write lane", () => {
	test("creates a file that does not exist", async () => {
		const name = freshName();
		const result = await call({ path: name, content: "hello\n" });
		expect(read(name)).toBe("hello\n");
		expect(result.details.lane).toBe("write");
		expect(result.details.changes[0].kind).toBe("added");
	});

	test("replaces a file that does exist, without a delete+add dance", async () => {
		const name = fixture("old body\nsecond line\n");
		const result = await call({ path: name, content: "new body\n" });
		expect(read(name)).toBe("new body\n");
		expect(result.details.changes).toHaveLength(1);
		expect(result.details.changes[0].kind).toBe("modified");
	});

	test("writes content exactly, including a missing trailing newline", async () => {
		// deliberately NOT normalised. silently appending a newline is a content
		// change nobody asked for, and it would make the tool's output differ
		// from what the caller can see it sent.
		const name = freshName();
		await call({ path: name, content: "no trailing newline" });
		expect(read(name)).toBe("no trailing newline");
	});

	test("truncates a file to empty when content is the empty string", async () => {
		const name = fixture("something\n");
		await call({ path: name, content: "" });
		expect(read(name)).toBe("");
	});

	test("creates missing parent directories", async () => {
		const name = `deep/nested/tree/${freshName()}`;
		await call({ path: name, content: "x\n" });
		expect(read(name)).toBe("x\n");
	});

	test("round-trips CRLF, BOM, tabs and astral characters byte for byte", async () => {
		const payload = "\uFEFFline one\r\n\tindented\r\n// 🎉 🖐 क्त्र ok\r\n";
		const name = freshName();
		await call({ path: name, content: payload });
		expect(read(name)).toBe(payload);
	});

	test("writes content that itself looks like a patch envelope", async () => {
		// a file ABOUT the format must not be reinterpreted AS the format.
		const payload = "*** Begin Patch\n*** Update File: x\n*** End Patch\n";
		const name = freshName(".md");
		await call({ path: name, content: payload });
		expect(read(name)).toBe(payload);
	});

	test("handles a large file in one call", async () => {
		const payload = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`;
		const name = freshName();
		await call({ path: name, content: payload });
		expect(read(name)).toBe(payload);
	});

	test("op: create refuses to clobber, op: write does not", async () => {
		const name = fixture("original\n");
		const message = await refuse({ op: "create", path: name, content: "replacement\n" });
		expect(message).toMatch(/already exists/i);
		expect(read(name)).toBe("original\n");
		await call({ op: "write", path: name, content: "replacement\n" });
		expect(read(name)).toBe("replacement\n");
	});

	test("a write that changes nothing is refused rather than logged as an edit", async () => {
		const name = fixture("same\n");
		expect(await refuse({ path: name, content: "same\n" })).toMatch(/no changes/i);
	});
});

// ---------------------------------------------------------------------------
// lane 2 — edit part of a file
// ---------------------------------------------------------------------------

describe("edit lane", () => {
	test("replaces a unique span inside a line", async () => {
		const name = fixture("const size = 28;\nconst other = 1;\n");
		const result = await call({ path: name, old_string: "size = 28", new_string: "size = 32" });
		expect(read(name)).toBe("const size = 32;\nconst other = 1;\n");
		expect(result.details.lane).toBe("edit");
	});

	test("replaces a span covering several lines", async () => {
		const name = fixture("a\nb\nc\nd\n");
		await call({ path: name, old_string: "b\nc", new_string: "B\nC\nC2" });
		expect(read(name)).toBe("a\nB\nC\nC2\nd\n");
	});

	test("deletes the matched text when new_string is empty", async () => {
		const name = fixture("keep me, drop me\n");
		await call({ path: name, old_string: ", drop me", new_string: "" });
		expect(read(name)).toBe("keep me\n");
	});

	test("refuses an ambiguous match instead of taking the first", async () => {
		const name = fixture("x();\ny();\nx();\n");
		const message = await refuse({ path: name, old_string: "x();", new_string: "z();" });
		expect(message).toMatch(/matches 2 places/);
		expect(message).toMatch(/line 1/);
		expect(message).toMatch(/line 3/);
		expect(message).toMatch(/replace_all/);
		expect(read(name)).toBe("x();\ny();\nx();\n");
	});

	test("replace_all changes every occurrence", async () => {
		const name = fixture("x();\ny();\nx();\n");
		await call({ path: name, old_string: "x();", new_string: "z();", replace_all: true });
		expect(read(name)).toBe("z();\ny();\nz();\n");
	});

	test('accepts replace_all sent as the string "true"', async () => {
		// some providers stringify booleans on the way out.
		const name = fixture("p\np\n");
		await call({ path: name, old_string: "p", new_string: "q", replace_all: "true" });
		expect(read(name)).toBe("q\nq\n");
	});

	test("more surrounding context disambiguates", async () => {
		const name = fixture("if (a) {\n  run();\n}\nif (b) {\n  run();\n}\n");
		await call({ path: name, old_string: "if (b) {\n  run();", new_string: "if (b) {\n  walk();" });
		expect(read(name)).toBe("if (a) {\n  run();\n}\nif (b) {\n  walk();\n}\n");
	});

	test("falls back to whole-line matching when only the indentation is wrong", async () => {
		// the grep-instead-of-read case: the model has the right line and the
		// wrong leading whitespace. the file's indentation wins.
		const name = fixture("class A {\n    doThing() {\n      return 1;\n    }\n}\n");
		await call({
			path: name,
			old_string: "doThing() {\n  return 1;\n}",
			new_string: "doThing() {\n  return 2;\n}",
		});
		expect(read(name)).toBe("class A {\n    doThing() {\n      return 2;\n    }\n}\n");
	});

	test("re-indents a uniform-depth hunk to the file's own indent character", async () => {
		// one indentation level, so the shift is exact: a Makefile patched with
		// space-indented text keeps its tabs. tabs are SYNTAX here — getting
		// this wrong breaks the build silently.
		const name = fixture("build:\n\tgcc -o app main.c\n\tstrip app\n", ".mk");
		await call({
			path: name,
			old_string: "  gcc -o app main.c\n  strip app",
			new_string: "  gcc -O2 -o app main.c\n  strip app",
		});
		expect(read(name)).toBe("build:\n\tgcc -O2 -o app main.c\n\tstrip app\n");
	});

	test("refuses to translate NESTED indentation between tabs and spaces", async () => {
		/*
		 * the outer level is fixed by construction (the file's own indent is
		 * prepended), but deeper levels keep the patch's character — so a
		 * tab-indented file came back as `\t  return 2;`, outer tab and inner
		 * spaces. silent byte corruption, and breakage in Makefiles and Python.
		 * found by grok-4.5 stress-testing the tool.
		 */
		const original = "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n";
		const name = fixture(original);
		const message = await refuse({
			path: name,
			old_string: "  if (x) {\n    return 1;\n  }",
			new_string: "  if (x) {\n    return 2;\n  }",
		});
		expect(message).toMatch(/indentation mismatch/i);
		expect(message).toMatch(/file indents with tabs and your text uses spaces/i);
		expect(read(name)).toBe(original);
	});

	test("refuses an indent swap even when the hunk is anchored at column 0", async () => {
		/*
		 * THE HOLE IN THE FIRST FIX. the guard lived inside the re-indent step,
		 * which returns early when the FIRST line's indent already matches — so
		 * a hunk anchored on `build:` at column 0 skipped every check and the
		 * tab-indented recipe underneath it was rewritten with spaces. No mixing,
		 * no error, broken Makefile. Found by grok-4.5 after the first fix.
		 *
		 * the guard now proves the shift against the file's own lines instead of
		 * inspecting only line one.
		 */
		const original = "build:\n\tgcc -o app main.c\n";
		const name = fixture(original, ".mk");
		const message = await refuse({
			path: name,
			old_string: "build:\n  gcc -o app main.c",
			new_string: "build:\n  gcc -O2 -o app main.c",
		});
		expect(message).toMatch(/indentation mismatch/i);
		expect(read(name)).toBe(original);
	});

	test("still re-indents when the shift genuinely reproduces the file", async () => {
		// same character, different depth — the case the fuzzy tier exists for.
		// it must survive the stricter guard.
		const name = fixture("class A {\n    doThing() {\n        return 1;\n    }\n}\n");
		await call({
			path: name,
			old_string: "  doThing() {\n      return 1;\n  }",
			new_string: "  doThing() {\n      return 2;\n  }",
		});
		expect(read(name)).toBe("class A {\n    doThing() {\n        return 2;\n    }\n}\n");
	});

	test("an ambiguity error shows the actual line at each match", async () => {
		// picking the right occurrence is the whole task; a bare list of line
		// numbers makes the caller re-read the file to do it.
		const name = fixture("a = run();\nb = 2;\nc = run();\n");
		const message = await refuse({ path: name, old_string: "run()", new_string: "walk()" });
		expect(message).toContain("line 1: a = run();");
		expect(message).toContain("line 3: c = run();");
	});

	test("a diagnosis from the fallback is never degraded into 'not found'", async () => {
		// applyEdit swallows the fallback's error to write a better message.
		// it must swallow ONLY "could not locate this text" — an ambiguity or
		// an indentation mismatch is a different problem entirely.
		const name = fixture("function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n");
		const message = await refuse({
			path: name,
			old_string: "  if (x) {\n    return 1;\n  }",
			new_string: "  if (x) {\n    return 2;\n  }",
		});
		expect(message).not.toMatch(/was not found/i);
	});

	test("falls back through unicode quote drift", async () => {
		const name = fixture('const msg = "hi";\n');
		await call({
			path: name,
			old_string: "const msg = \u201Chi\u201D;",
			new_string: 'const msg = "bye";',
		});
		expect(read(name)).toBe('const msg = "bye";\n');
	});

	test("an ambiguous fallback stays ambiguous rather than becoming not-found", async () => {
		// the fallback swallows its own errors to produce a better message; an
		// ambiguity refusal must survive that, or the caller goes looking for
		// the wrong problem entirely.
		const name = fixture("  dup()\nmid\n\tdup()\n");
		const message = await refuse({ path: name, old_string: "dup()", new_string: "x()" });
		expect(message).toMatch(/matches 2 places|ambiguous/i);
	});

	test("preserves CRLF and BOM through an exact edit", async () => {
		const name = fixture("\uFEFFalpha\r\nbeta\r\n");
		await call({ path: name, old_string: "beta", new_string: "gamma" });
		expect(read(name)).toBe("\uFEFFalpha\r\ngamma\r\n");
	});

	test("matches a multi-line span in a CRLF file sent with plain newlines", async () => {
		const name = fixture("one\r\ntwo\r\nthree\r\n");
		await call({ path: name, old_string: "two\nthree", new_string: "TWO\nTHREE" });
		expect(read(name)).toBe("one\r\nTWO\r\nTHREE\r\n");
	});

	test("treats regex metacharacters as literal text", async () => {
		const name = fixture("value = a.b*c?[d](e)$f^g\n");
		await call({ path: name, old_string: "a.b*c?[d](e)$f^g", new_string: "ok" });
		expect(read(name)).toBe("value = ok\n");
	});

	test("handles a replacement containing $& and $1, which a naive replace() would expand", async () => {
		const name = fixture("token\n");
		await call({ path: name, old_string: "token", new_string: "$& and $1 and $$" });
		expect(read(name)).toBe("$& and $1 and $$\n");
	});

	test("handles replace_all with a replacement containing $&", async () => {
		const name = fixture("t\nt\n");
		await call({ path: name, old_string: "t", new_string: "$&x", replace_all: true });
		expect(read(name)).toBe("$&x\n$&x\n");
	});

	test("edits the very first and very last bytes of a file", async () => {
		const name = fixture("head\nmiddle\ntail\n");
		await call({ path: name, old_string: "head", new_string: "HEAD" });
		await call({ path: name, old_string: "tail", new_string: "TAIL" });
		expect(read(name)).toBe("HEAD\nmiddle\nTAIL\n");
	});

	test("reports the nearest line when the text is not found", async () => {
		const name = fixture('function saveOrder() {\n  logger.debug("save");\n}\n');
		const message = await refuse({
			path: name,
			old_string: '  logger.debug("saving");',
			new_string: '  logger.debug("saved");',
		});
		expect(message).toMatch(/not found/i);
		expect(message).toMatch(/closest match/i);
		expect(message).toContain('logger.debug("save");');
	});

	test("says so when the text is present but the whitespace differs", async () => {
		const name = fixture("const    spaced   = 1;\n");
		const message = await refuse({ path: name, old_string: "const spaced = 1;", new_string: "x" });
		expect(message).toMatch(/whitespace differs/i);
	});

	test("refuses an edit to a file that does not exist", async () => {
		expect(await refuse({ path: "nope-missing.ts", old_string: "a", new_string: "b" })).toMatch(
			/not found/i,
		);
	});

	test("refuses an empty old_string", async () => {
		const name = fixture("body\n");
		expect(await refuse({ path: name, old_string: "", new_string: "x" })).toMatch(
			/nothing to find/i,
		);
	});

	test("refuses old_string without new_string, rather than guessing deletion", async () => {
		const name = fixture("body\n");
		const message = await refuse({ path: name, old_string: "body" });
		expect(message).toMatch(/new_string/);
		expect(message).toMatch(/empty string/);
	});

	test("an edit that changes nothing is refused", async () => {
		const name = fixture("same\n");
		expect(await refuse({ path: name, old_string: "same", new_string: "same" })).toMatch(
			/no changes/i,
		);
	});
});

// ---------------------------------------------------------------------------
// lane 3 — ops batch
// ---------------------------------------------------------------------------

describe("batch lane", () => {
	test("applies write, edit, delete and move in one call", async () => {
		const edited = fixture("keep\ntarget\n");
		const doomed = fixture("bye\n");
		const moved = fixture("cargo\n");
		const created = freshName();
		const destination = freshName();

		const result = await call({
			ops: [
				{ op: "write", path: created, content: "made\n" },
				{ op: "edit", path: edited, old_string: "target", new_string: "hit" },
				{ op: "delete", path: doomed },
				{ op: "move", path: moved, to: destination },
			],
		});

		expect(result.details.lane).toBe("batch");
		expect(read(created)).toBe("made\n");
		expect(read(edited)).toBe("keep\nhit\n");
		expect(exists(doomed)).toBe(false);
		expect(exists(moved)).toBe(false);
		expect(read(destination)).toBe("cargo\n");
	});

	test("infers each op from the fields present", async () => {
		const edited = fixture("alpha\n");
		const created = freshName();
		await call({
			ops: [
				{ path: created, content: "new\n" },
				{ path: edited, old_string: "alpha", new_string: "omega" },
			],
		});
		expect(read(created)).toBe("new\n");
		expect(read(edited)).toBe("omega\n");
	});

	test("rolls the whole batch back when any op fails", async () => {
		const good = fixture("before\n");
		const created = freshName();
		const message = await refuse({
			ops: [
				{ path: good, old_string: "before", new_string: "after" },
				{ path: created, content: "orphan\n" },
				{ path: "does-not-exist.ts", old_string: "x", new_string: "y" },
			],
		});
		expect(message).toMatch(/not found/i);
		expect(read(good)).toBe("before\n");
		expect(exists(created)).toBe(false);
	});

	test("applies several edits to the SAME file in order", async () => {
		const name = fixture("one\ntwo\nthree\n");
		await call({
			ops: [
				{ path: name, old_string: "one", new_string: "1" },
				{ path: name, old_string: "three", new_string: "3" },
			],
		});
		expect(read(name)).toBe("1\ntwo\n3\n");
	});

	test("a later op sees the earlier op's result", async () => {
		const name = fixture("start\n");
		await call({
			ops: [
				{ path: name, old_string: "start", new_string: "middle" },
				{ path: name, old_string: "middle", new_string: "end" },
			],
		});
		expect(read(name)).toBe("end\n");
	});

	test("accepts a JSON-stringified ops array", async () => {
		// pi-tasks was removed from this setup because array parameters arrived
		// stringified and every call it gated failed. accepting it costs four
		// lines here.
		const name = freshName();
		await call({ ops: JSON.stringify([{ op: "write", path: name, content: "from json\n" }]) });
		expect(read(name)).toBe("from json\n");
	});

	test("accepts a single op object where an array was expected", async () => {
		const name = freshName();
		await call({ ops: { op: "write", path: name, content: "single\n" } });
		expect(read(name)).toBe("single\n");
	});

	test("refuses an empty ops array", async () => {
		expect(await refuse({ ops: [] })).toMatch(/empty/i);
	});

	test("names the offending index when one entry is malformed", async () => {
		const name = freshName();
		const message = await refuse({
			ops: [{ op: "write", path: name, content: "a\n" }, { path: "x.ts" }],
		});
		expect(message).toContain("ops[1]");
		expect(exists(name)).toBe(false);
	});

	test("refuses a non-object entry", async () => {
		expect(await refuse({ ops: ["*** Begin Patch"] })).toContain("ops[0]");
	});

	test("accepts pi's OWN native edit shape verbatim", async () => {
		// { path, edits: [{ oldText, newText }] } is what pi's built-in edit
		// tool takes, so it is the single most likely thing a model emits.
		// `edits` is an ops key, so entries inherit the top-level path.
		const name = fixture("alpha\nbeta\ngamma\n");
		await call({
			path: name,
			edits: [
				{ oldText: "alpha", newText: "A" },
				{ oldText: "gamma", newText: "G" },
			],
		});
		expect(read(name)).toBe("A\nbeta\nG\n");
	});

	test("accepts Claude Code's MultiEdit shape verbatim", async () => {
		const name = fixture("one\ntwo\n");
		await call({
			file_path: name,
			edits: [
				{ old_string: "one", new_string: "1" },
				{ old_string: "two", new_string: "2" },
			],
		});
		expect(read(name)).toBe("1\n2\n");
	});

	test("an entry's own path still wins over the inherited one", async () => {
		const inherited = fixture("inherited\n");
		const explicitFile = fixture("explicit\n");
		await call({
			path: inherited,
			ops: [
				{ old_string: "inherited", new_string: "changed" },
				{ path: explicitFile, old_string: "explicit", new_string: "also changed" },
			],
		});
		expect(read(inherited)).toBe("changed\n");
		expect(read(explicitFile)).toBe("also changed\n");
	});

	test("refuses ops that silently drop a field the chosen operation ignores", async () => {
		// each of these reads as two intentions. carrying on would delete or
		// rename a file the caller was trying to rewrite.
		const a = fixture("body\n");
		expect(await refuse({ ops: [{ op: "delete", path: a, content: "new\n" }] })).toMatch(
			/say what you actually want/i,
		);
		const b = fixture("body\n");
		expect(await refuse({ ops: [{ op: "move", path: b, to: freshName(), content: "new\n" }] })).toMatch(
			/cannot also change/i,
		);
		const c = fixture("body\n");
		expect(
			await refuse({ path: c, old_string: "body", new_string: "x", to: freshName() }),
		).toMatch(/cannot also rename/i);

		expect(read(a)).toBe("body\n");
		expect(read(b)).toBe("body\n");
		expect(read(c)).toBe("body\n");
	});

	test("a move refuses to clobber an existing destination", async () => {
		// `add` refuses to overwrite and the move branch did not, so a rename
		// onto an occupied path replaced that file's real content and reported
		// success. `{ path, to }` makes that two fields, so it needs the guard.
		const source = fixture("source content\n");
		const occupied = fixture("IMPORTANT existing content\n");
		const message = await refuse({ path: source, to: occupied });
		expect(message).toMatch(/destination already exists/i);
		expect(read(source)).toBe("source content\n");
		expect(read(occupied)).toBe("IMPORTANT existing content\n");
	});

	test("a move onto a free path still works", async () => {
		const source = fixture("cargo\n");
		const free = freshName();
		await call({ path: source, to: free });
		expect(exists(source)).toBe(false);
		expect(read(free)).toBe("cargo\n");
	});

	test("a write refuses a stray `to` rather than dropping it", async () => {
		const name = fixture("body\n");
		const message = await refuse({ path: name, content: "new\n", to: freshName() });
		expect(message).toMatch(/cannot also rename/i);
		expect(read(name)).toBe("body\n");
	});
});

// ---------------------------------------------------------------------------
// lane 4 — the envelope, and everything it now forgives
// ---------------------------------------------------------------------------

describe("envelope lane", () => {
	test("still applies a canonical patch", async () => {
		const name = fixture("old line\n");
		const result = await call({
			input: `*** Begin Patch\n*** Update File: ${name}\n@@\n-old line\n+new line\n*** End Patch`,
		});
		expect(read(name)).toBe("new line\n");
		expect(result.details.lane).toBe("envelope");
	});

	const tolerated: Array<[string, (name: string) => string]> = [
		[
			"trailing stars on the markers",
			(n) => `*** Begin Patch ***\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch ***`,
		],
		["lowercase markers", (n) => `*** begin patch\n*** update file: ${n}\n@@\n-a\n+b\n*** end patch`],
		["two stars instead of three", (n) => `** Begin Patch\n** Update File: ${n}\n@@\n-a\n+b\n** End Patch`],
		[
			"extra spacing in the markers",
			(n) => `***  Begin   Patch\n*** Update File:   ${n}\n@@\n-a\n+b\n***  End   Patch`,
		],
		["git hunk line numbers", (n) => `*** Begin Patch\n*** Update File: ${n}\n@@ -1,1 +1,1 @@\n-a\n+b\n*** End Patch`],
		[
			"git hunk numbers with a function hint (the hint is git's, and is dropped)",
			(n) => `*** Begin Patch\n*** Update File: ${n}\n@@ -1,1 +1,1 @@ someFn\n-a\n+b\n*** End Patch`,
		],
		["a heredoc wrapper", (n) => `<<EOF\n*** Begin Patch\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch\nEOF`],
		[
			"a heredoc with a leading command",
			(n) => `apply_patch <<"EOF"\n*** Begin Patch\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch\nEOF`,
		],
		["a markdown fence", (n) => "```\n" + `*** Begin Patch\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch` + "\n```"],
		[
			"a fence with a language tag",
			(n) => "```diff\n" + `*** Begin Patch\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch` + "\n```",
		],
		[
			"narration before and after",
			(n) => `Here is the patch:\n*** Begin Patch\n*** Update File: ${n}\n@@\n-a\n+b\n*** End Patch\nLet me know.`,
		],
		["Edit File as the header", (n) => `*** Begin Patch\n*** Edit File: ${n}\n@@\n-a\n+b\n*** End Patch`],
		["Modify File as the header", (n) => `*** Begin Patch\n*** Modify File: ${n}\n@@\n-a\n+b\n*** End Patch`],
		["Change File as the header", (n) => `*** Begin Patch\n*** Change File: ${n}\n@@\n-a\n+b\n*** End Patch`],
		["Patch File as the header", (n) => `*** Begin Patch\n*** Patch File: ${n}\n@@\n-a\n+b\n*** End Patch`],
		["no space after the colon", (n) => `*** Begin Patch\n*** Update File:${n}\n@@\n-a\n+b\n*** End Patch`],
		[
			"leading whitespace on the header",
			(n) => `*** Begin Patch\n   *** Update File: ${n}\n@@\n-a\n+b\n*** End Patch`,
		],
		[
			"windows line endings throughout",
			(n) => `*** Begin Patch\r\n*** Update File: ${n}\r\n@@\r\n-a\r\n+b\r\n*** End Patch`,
		],
	];

	for (const [label, build] of tolerated) {
		test(`tolerates ${label}`, async () => {
			const name = fixture("a\n");
			await call({ input: build(name) });
			expect(read(name)).toBe("b\n");
		});
	}

	test("Write File replaces a whole file from the envelope", async () => {
		const name = fixture("stale\n");
		await call({ input: `*** Begin Patch\n*** Write File: ${name}\n+fresh\n*** End Patch` });
		expect(read(name)).toBe("fresh\n");
	});

	test("Write File accepts a raw block with no plus prefixes", async () => {
		const name = fixture("stale\n");
		await call({
			input: `*** Begin Patch\n*** Write File: ${name}\nfresh one\nfresh two\n*** End Patch`,
		});
		expect(read(name)).toBe("fresh one\nfresh two\n");
	});

	test("an explicit Content block carries lines that start with stars", async () => {
		const name = freshName(".md");
		await call({
			input: `*** Begin Patch\n*** Write File: ${name}\n*** Content\n*** Update File: not-a-header\ntext\n*** End Content\n*** End Patch`,
		});
		expect(read(name)).toBe("*** Update File: not-a-header\ntext\n");
	});

	test("Create File and Remove File are understood", async () => {
		const doomed = fixture("gone\n");
		const born = freshName();
		await call({
			input: `*** Begin Patch\n*** Create File: ${born}\n+hi\n*** Remove File: ${doomed}\n*** End Patch`,
		});
		expect(read(born)).toBe("hi\n");
		expect(exists(doomed)).toBe(false);
	});

	test("Rename to is understood as Move to", async () => {
		const from = fixture("payload\n");
		const to = freshName();
		await call({
			input: `*** Begin Patch\n*** Update File: ${from}\n*** Rename to: ${to}\n*** End Patch`,
		});
		expect(exists(from)).toBe(false);
		expect(read(to)).toBe("payload\n");
	});

	test("a rename does not rewrite the file's bytes", async () => {
		// applying zero hunks used to run the applier anyway, which appends a
		// trailing newline. a rename must be a rename.
		const from = fixture("no trailing newline");
		const to = freshName();
		await call({
			input: `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n*** End Patch`,
		});
		expect(read(to)).toBe("no trailing newline");
	});

	test("a bare blank line inside an Add block is content, not a parse error", async () => {
		const name = freshName();
		await call({ input: `*** Begin Patch\n*** Add File: ${name}\n+one\n\n+three\n*** End Patch` });
		expect(read(name)).toBe("one\n\nthree\n");
	});

	test("still refuses a partially prefixed Add block", async () => {
		const name = freshName();
		const message = await refuse({
			input: `*** Begin Patch\n*** Add File: ${name}\n+one\ntwo\n+three\n*** End Patch`,
		});
		expect(message).toMatch(/must start with '\+'/);
		expect(exists(name)).toBe(false);
	});

	test("refuses an UNPREFIXED block whose content contains a marker line", async () => {
		// the envelope ends at the last end-marker anywhere in the text, so an
		// unprefixed body carrying one loses everything after it — silently,
		// reported as success. measured: a file documenting this very format
		// came back missing its last line.
		const name = freshName(".md");
		const message = await refuse({
			input: `*** Begin Patch\n*** Add File: ${name}\nHere is an example patch:\n*** Begin Patch\n*** End Patch`,
		});
		expect(message).toMatch(/looks like a patch marker/i);
		expect(message).toMatch(/\*\*\* Content/);
		expect(exists(name)).toBe(false);
	});

	test("the two unambiguous spellings carry marker lines fine", async () => {
		// the refusal above must not make marker-bearing content unwritable —
		// it only rejects the one spelling that cannot be read unambiguously.
		const viaPlus = freshName(".md");
		await call({
			input: `*** Begin Patch\n*** Add File: ${viaPlus}\n+Here is an example patch:\n+*** Begin Patch\n+*** End Patch\n*** End Patch`,
		});
		expect(read(viaPlus)).toBe("Here is an example patch:\n*** Begin Patch\n*** End Patch\n");

		const viaContent = freshName(".md");
		await call({
			input: `*** Begin Patch\n*** Write File: ${viaContent}\n*** Content\nHere is an example patch:\n*** Begin Patch\n*** End Content\n*** End Patch`,
		});
		expect(read(viaContent)).toBe("Here is an example patch:\n*** Begin Patch\n");

		// and the structured lane never had the problem at all
		const viaWrite = freshName(".md");
		await call({ path: viaWrite, content: "*** Begin Patch\n*** End Patch\n" });
		expect(read(viaWrite)).toBe("*** Begin Patch\n*** End Patch\n");
	});

	test("still refuses a patch with no end marker", async () => {
		// a truncated stream looks exactly like this. half-applying it would be
		// the worst possible outcome.
		const name = fixture("a\n");
		const message = await refuse({ input: `*** Begin Patch\n*** Update File: ${name}\n@@\n-a\n+b` });
		expect(message).toMatch(/last line must be/);
		expect(message).toMatch(/cut off mid-generation/);
		expect(read(name)).toBe("a\n");
	});

	test("still refuses a unified diff instead of guessing its hunk positions", async () => {
		const name = fixture("a\n");
		const message = await refuse({
			input: `--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n-a\n+b`,
		});
		expect(message).toMatch(/unified diff/i);
		expect(read(name)).toBe("a\n");
	});

	test("still refuses an unanchored ambiguous hunk", async () => {
		const name = fixture("dup\nmid\ndup\n");
		expect(
			await refuse({
				input: `*** Begin Patch\n*** Update File: ${name}\n@@\n-dup\n+new\n*** End Patch`,
			}),
		).toMatch(/ambiguous/i);
	});
});

// ---------------------------------------------------------------------------
// key aliases — generated over the whole table, not a sample
// ---------------------------------------------------------------------------

// mirrors apply-patch.ts on purpose: an independent copy is what makes this a
// contract test rather than a restatement of the implementation.
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "fileName", "target_file"];
const CONTENT_KEYS = [
	"content",
	"contents",
	"new_content",
	"new_contents",
	"newContent",
	"file_text",
	"text",
	"body",
];
const OLD_KEYS = ["old_string", "old_str", "oldText", "old_text", "old", "search", "before"];
const NEW_KEYS = ["new_string", "new_str", "newText", "new_text", "new", "replace", "after"];

describe("alias matrix", () => {
	for (const pathKey of PATH_KEYS) {
		for (const contentKey of CONTENT_KEYS) {
			test(`write via { ${pathKey}, ${contentKey} }`, async () => {
				const name = freshName();
				await call({ [pathKey]: name, [contentKey]: "written\n" });
				expect(read(name)).toBe("written\n");
			});
		}
	}

	// path spellings are covered exhaustively above; here the point is the
	// old/new pair, so three path spellings keep the cross product honest
	// without making it pointless.
	for (const pathKey of ["path", "file_path", "filename"]) {
		for (const oldKey of OLD_KEYS) {
			for (const newKey of NEW_KEYS) {
				test(`edit via { ${pathKey}, ${oldKey}, ${newKey} }`, async () => {
					const name = fixture("alpha beta\n");
					await call({ [pathKey]: name, [oldKey]: "beta", [newKey]: "gamma" });
					expect(read(name)).toBe("alpha gamma\n");
				});
			}
		}
	}
});

// ---------------------------------------------------------------------------
// refusals: shapes that must never be guessed at
// ---------------------------------------------------------------------------

// built at runtime on purpose: a literal one here would trip apply_patch's own
// anti-elision guard while this very file was being written.
const ELISION = ["// ...", "rest of the", "file unchanged"].join(" ");

describe("refusals", () => {
	test("refuses a call naming two lanes at once", async () => {
		const name = fixture("a\n");
		const message = await refuse({ path: name, content: "whole\n", old_string: "a", new_string: "b" });
		expect(message).toMatch(/more than one kind of change/i);
		expect(message).toContain("accepted shapes");
		expect(read(name)).toBe("a\n");
	});

	test("refuses an ops ENTRY naming two lanes at once", async () => {
		// the same conflict one level down, where the outer guard cannot see it.
		const name = fixture("a\n");
		const message = await refuse({
			ops: [{ path: name, content: "whole\n", old_string: "a", new_string: "b" }],
		});
		expect(message).toMatch(/two different operations/i);
		expect(message).toContain("ops[0]");
		expect(read(name)).toBe("a\n");
	});

	test("refuses ops alongside an envelope", async () => {
		const name = fixture("a\n");
		const message = await refuse({
			ops: [{ path: name, content: "x\n" }],
			input: `*** Begin Patch\n*** Update File: ${name}\n@@\n-a\n+b\n*** End Patch`,
		});
		expect(message).toMatch(/more than one kind of change/i);
		expect(read(name)).toBe("a\n");
	});

	test("refuses an empty call, and shows every accepted shape", async () => {
		const message = await refuse({});
		expect(message).toMatch(/no file change was described/i);
		for (const shape of ["write", "edit", "delete", "move", "batch", "envelope"]) {
			expect(message).toContain(shape);
		}
	});

	test("refuses a path with nothing to do, and echoes the keys it got", async () => {
		const message = await refuse({ file_path: "lonely.ts" });
		expect(message).toMatch(/says nothing about what to change/i);
		expect(message).toContain("file_path");
	});

	test("refuses an unknown op with the list of real ones", async () => {
		const name = fixture("a\n");
		const message = await refuse({ op: "frobnicate", path: name, content: "b\n" });
		expect(message).toMatch(/unknown op/i);
		expect(message).toMatch(/write, edit, delete, move or add/);
	});

	test("a generic `type` key is not mistaken for an operation", async () => {
		// `type: "text/plain"` next to a perfectly good write must not become
		// "unknown op". only op/operation/action/kind are authoritative.
		const name = freshName();
		await call({ path: name, content: "fine\n", type: "text/plain" });
		expect(read(name)).toBe("fine\n");
	});

	test("a bare `target` is not accepted as a path", async () => {
		// it reads as a move DESTINATION at least as naturally as a source. a
		// path alias that can be misread writes the wrong file; a missing one
		// only produces an error.
		const message = await refuse({ target: "wrong.ts", content: "nope\n" });
		expect(message).toMatch(/no file path|no file change/i);
		expect(exists("wrong.ts")).toBe(false);
	});

	test("cursor's `target_file` IS accepted as a path", async () => {
		const name = freshName();
		await call({ target_file: name, content: "ok\n" });
		expect(read(name)).toBe("ok\n");
	});

	test("refuses content that is really a broken envelope", async () => {
		// rescuing this as a write would put a half-written patch INTO a file.
		const message = await refuse({
			path: "rescue.ts",
			input: "*** Begin Patch\n*** Update File: rescue.ts\n",
		});
		expect(message).toMatch(/last line must be/);
		expect(exists("rescue.ts")).toBe(false);
	});

	test("rescues a plain blob sent under input when a path is present", async () => {
		const name = freshName(".svg");
		await call({ path: name, input: "<svg></svg>\n" });
		expect(read(name)).toBe("<svg></svg>\n");
	});

	test("does NOT rescue a blob sent under a key that means 'patch'", async () => {
		// the sharpest edge in the whole normaliser. `{ path, diff: "-old\n+new" }`
		// is a model fumbling a patch, and writing those two lines INTO the file
		// destroys it while reporting success. the key name is the evidence.
		const name = fixture("old\n");
		const message = await refuse({ path: name, diff: "-old\n+new" });
		expect(read(name)).toBe("old\n");
		expect(message).toMatch(/Begin Patch|unified diff/i);

		for (const key of ["patch", "envelope", "patch_text"]) {
			const victim = fixture("old\n");
			await refuse({ path: victim, [key]: "not really a patch" });
			expect(read(victim)).toBe("old\n");
		}
	});

	test("refuses content next to new_string, not just next to old_string", async () => {
		const name = fixture("a\n");
		const message = await refuse({
			ops: [{ path: name, content: "whole\n", new_string: "partial" }],
		});
		expect(message).toMatch(/two different operations/i);
		expect(read(name)).toBe("a\n");
	});

	test("reports the operation as the lane, not a catch-all", async () => {
		const doomed = fixture("bye\n");
		expect((await call({ op: "delete", path: doomed })).details.lane).toBe("delete");
		const from = fixture("cargo\n");
		const to = freshName();
		expect((await call({ path: from, to })).details.lane).toBe("move");
	});

	test("rescues an envelope sent under content when no path is present", async () => {
		const name = fixture("a\n");
		await call({ content: `*** Begin Patch\n*** Update File: ${name}\n@@\n-a\n+b\n*** End Patch` });
		expect(read(name)).toBe("b\n");
	});

	test("still refuses a placeholder that would elide real code", async () => {
		const original = "function big() {\n  real();\n  code();\n}\n";
		const name = fixture(original);
		const message = await refuse({
			path: name,
			content: `function big() {\n  ${ELISION}\n}\n`,
		});
		expect(message).toMatch(/placeholder/i);
		expect(read(name)).toBe(original);
	});

	test("allows rewriting a file that ALREADY contained such a phrase", async () => {
		// the guard counts before vs after; a file about placeholders is legal.
		const original = `${ELISION}\nbody\n`;
		const name = fixture(original);
		await call({ path: name, content: `${original}more\n` });
		expect(read(name)).toBe(`${original}more\n`);
	});

	test("still refuses a symlinked path", async () => {
		const real = fixture("secret\n");
		const link = `link-${fixtures++}.ts`;
		fs.symlinkSync(path.join(DIR, real), path.join(DIR, link));
		expect(await refuse({ path: link, content: "hijacked\n" })).toMatch(/symbolic link/i);
		expect(read(real)).toBe("secret\n");
	});

	test("two writes to the same file in one batch apply in order", async () => {
		// NOT an alias conflict: the batch model is explicitly sequential (a
		// later op sees the earlier op's result), so the degenerate case of two
		// writes is simply last-wins. the alias guard exists for two DIFFERENT
		// spellings of one path — see the case-variant test in apply-patch.test.ts.
		const name = fixture("a\n");
		await call({
			ops: [
				{ path: name, content: "one\n" },
				{ path: `./${name}`, content: "two\n" },
			],
		});
		expect(read(name)).toBe("two\n");
	});

	test("a second create of the same path in one batch is still refused", async () => {
		// `add` is the anti-clobber op, and the in-memory state is what it
		// checks — so it catches a duplicate inside a single batch too.
		const name = freshName();
		const message = await refuse({
			ops: [
				{ op: "add", path: name, content: "first\n" },
				{ op: "add", path: name, content: "second\n" },
			],
		});
		expect(message).toMatch(/already exists/i);
		expect(exists(name)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// seeded fuzz — the part that finds what nobody thought of
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and reproducible, which is the whole point. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FRAGMENTS = [
	"const x = 1;",
	"  return value;",
	"\tif (ok) {",
	"}",
	"// comment",
	'const s = "quoted";',
	"const u = 'single';",
	"héllo wörld",
	"日本語のテキスト",
	"emoji 🎉 here",
	"back\\slash",
	"dollar $ and ${brace}",
	"star *** not a header",
	"@@ looks like a hunk",
	"+leading plus",
	"-leading minus",
	" leading space",
	"trailing space   ",
	'<svg viewBox="0 0 24 24" />',
];

function randomBody(next: () => number, lines: number): string[] {
	return Array.from({ length: lines }, (_, index) => {
		const fragment = FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!;
		// a unique token per line keeps "this span is unique" true by
		// construction, so a fuzz failure means a real bug and not a collision.
		return `${fragment} /*u${index}*/`;
	});
}

describe("fuzz: edit round-trip", () => {
	const next = rng(0x5eed);
	const CASES = 300;

	test(`${CASES} random single-span edits land exactly where a string splice would`, async () => {
		for (let iteration = 0; iteration < CASES; iteration++) {
			const lineCount = 1 + Math.floor(next() * 12);
			const body = randomBody(next, lineCount);
			const eol = next() < 0.25 ? "\r\n" : "\n";
			const bom = next() < 0.15 ? "\uFEFF" : "";
			const trailing = next() < 0.8 ? eol : "";
			const original = bom + body.join(eol) + trailing;
			const name = fixture(original, ".txt");

			const target = body[Math.floor(next() * body.length)]!;
			const replacement = `replaced-${iteration}`;
			await call({ path: name, old_string: target, new_string: replacement });

			expect(read(name)).toBe(original.replace(target, replacement));
		}
	});
});

describe("fuzz: nothing is written when anything fails", () => {
	const next = rng(0xc0ffee);
	const CASES = 150;

	test(`${CASES} random failing batches leave the tree untouched`, async () => {
		for (let iteration = 0; iteration < CASES; iteration++) {
			const body = randomBody(next, 1 + Math.floor(next() * 6));
			const original = `${body.join("\n")}\n`;
			const survivor = fixture(original, ".txt");
			const created = freshName(".txt");
			const target = body[Math.floor(next() * body.length)]!;

			const doomed = [
				{ path: "definitely-missing.txt", old_string: "x", new_string: "y" },
				{ path: survivor, old_string: `absent-${iteration}`, new_string: "z" },
				{ op: "delete", path: "definitely-missing.txt" },
			][iteration % 3]!;

			await refuse({
				ops: [
					{ path: survivor, old_string: target, new_string: `changed-${iteration}` },
					{ path: created, content: "should not survive\n" },
					doomed,
				],
			});

			expect(read(survivor)).toBe(original);
			expect(exists(created)).toBe(false);
		}
	});
});

describe("fuzz: write round-trip", () => {
	const next = rng(0xbeef);
	const CASES = 200;

	test(`${CASES} random whole-file writes are byte-exact`, async () => {
		for (let iteration = 0; iteration < CASES; iteration++) {
			const body = randomBody(next, 1 + Math.floor(next() * 20));
			const eol = next() < 0.3 ? "\r\n" : "\n";
			const payload = (next() < 0.1 ? "\uFEFF" : "") + body.join(eol) + (next() < 0.7 ? eol : "");
			const name = next() < 0.5 ? freshName(".txt") : fixture("pre-existing\n", ".txt");
			await call({ path: name, content: payload });
			expect(read(name)).toBe(payload);
		}
	});
});

describe("fuzz: envelope survives its own tolerances", () => {
	const next = rng(0xfeed);
	const CASES = 200;

	const wrappers: Array<(patch: string) => string> = [
		(patch) => patch,
		(patch) => "```\n" + patch + "\n```",
		(patch) => "```diff\n" + patch + "\n```",
		(patch) => `<<EOF\n${patch}\nEOF`,
		(patch) => `apply_patch <<"EOF"\n${patch}\nEOF`,
		(patch) => `Here you go:\n${patch}\nDone.`,
		(patch) =>
			patch
				.replace("*** Begin Patch", "*** Begin Patch ***")
				.replace(/\*\*\* End Patch$/, "*** End Patch ***"),
		(patch) => patch.replace("*** Update File:", "*** Edit File:"),
		(patch) => patch.replace("\n@@\n", "\n@@ -1,1 +1,1 @@\n"),
	];

	test(`${CASES} wrapped envelopes all apply identically`, async () => {
		for (let iteration = 0; iteration < CASES; iteration++) {
			const body = randomBody(next, 2 + Math.floor(next() * 6));
			const original = `${body.join("\n")}\n`;
			const target = body[Math.floor(next() * body.length)]!;
			const replacement = `wrapped-${iteration}`;
			const name = fixture(original, ".txt");

			const patch = `*** Begin Patch\n*** Update File: ${name}\n@@\n-${target}\n+${replacement}\n*** End Patch`;
			const wrapper = wrappers[iteration % wrappers.length]!;
			await call({ input: wrapper(patch) });

			expect(read(name)).toBe(original.replace(target, replacement));
		}
	});
});

// ---------------------------------------------------------------------------
// the sub-agent tree line must understand every lane too
// ---------------------------------------------------------------------------

describe("sub-agent summary", () => {
	test("names the file for each lane, not just the envelope", () => {
		expect(toolArgSummary("apply_patch", { path: "/a/b/icon.svg", content: "x" })).toBe("icon.svg");
		expect(
			toolArgSummary("apply_patch", { path: "src/app.ts", old_string: "a", new_string: "b" }),
		).toBe("app.ts");
		expect(
			toolArgSummary("apply_patch", {
				ops: [
					{ path: "one.ts", content: "x" },
					{ path: "two.ts", content: "y" },
				],
			}),
		).toBe("one.ts, two.ts");
		expect(
			toolArgSummary("apply_patch", {
				input: "*** Begin Patch\n*** Write File: deep/three.ts\n+x\n*** End Patch",
			}),
		).toBe("three.ts");
	});
});

// ---------------------------------------------------------------------------
// undo must work through the NEW lanes, not just the envelope
// ---------------------------------------------------------------------------

describe("undo_edit through every lane", () => {
	/** revert every change a call recorded, newest first, like undo_edit does. */
	function revertAll(toolCallId: string): void {
		const changes = ft.loadChanges(SESSION, toolCallId);
		for (const change of [...changes].reverse()) {
			ft.revertChange(SESSION, toolCallId, change.id);
		}
	}

	test("undoing a write that CREATED a file removes it", async () => {
		const name = freshName();
		const id = `undo-${calls}`;
		await tool.execute(id, { path: name, content: "made\n" }, undefined, undefined, ctx);
		expect(exists(name)).toBe(true);
		revertAll(id);
		expect(exists(name)).toBe(false);
	});

	test("undoing a write that REPLACED a file restores the old bytes", async () => {
		const original = "original\nbody\n";
		const name = fixture(original);
		const id = `undo-${calls}-r`;
		await tool.execute(id, { path: name, content: "replaced\n" }, undefined, undefined, ctx);
		expect(read(name)).toBe("replaced\n");
		revertAll(id);
		expect(read(name)).toBe(original);
	});

	test("undoing an edit restores the exact previous text", async () => {
		const original = "const size = 28;\n";
		const name = fixture(original);
		const id = `undo-${calls}-e`;
		await tool.execute(
			id,
			{ path: name, old_string: "28", new_string: "32" },
			undefined,
			undefined,
			ctx,
		);
		expect(read(name)).toBe("const size = 32;\n");
		revertAll(id);
		expect(read(name)).toBe(original);
	});

	test("undoing EITHER half of a move restores the original, losing nothing", async () => {
		/*
		 * a move is two path histories: delete src + create dst. undoing one
		 * half alone used to be destructive both ways — grok-4.5 reproduced
		 * real data loss with content it called 'gold-bar-do-not-lose'.
		 * reverting either half must now revert both.
		 */
		const PRECIOUS = "gold-bar-do-not-lose\n";
		for (const undoWhich of ["destination", "source"] as const) {
			const source = fixture(PRECIOUS);
			const destination = freshName();
			const id = `undo-move-${calls}-${undoWhich}`;
			await tool.execute(id, { path: source, to: destination }, undefined, undefined, ctx);
			expect(exists(source)).toBe(false);
			expect(read(destination)).toBe(PRECIOUS);

			const target = undoWhich === "destination" ? destination : source;
			const record = ft.findLatestChange(SESSION, path.join(DIR, target), [id]);
			expect(record).not.toBeNull();
			ft.revertChange(SESSION, id, record!.change.id);
			const pairing = ft.findMovePartner(SESSION, id, record!.change);
			expect(pairing.partner).not.toBeNull();
			expect(pairing.ambiguous).toHaveLength(0);
			ft.revertChange(SESSION, id, pairing.partner!.id);

			// back to exactly one file, at the original path, with its bytes
			expect(read(source)).toBe(PRECIOUS);
			expect(exists(destination)).toBe(false);
		}
	});

	test("an unrelated delete in the same batch is not mistaken for a move", async () => {
		// the pairing rule needs matching bytes AND uniqueness, or a batch that
		// moves one file and deletes another would revert the wrong thing.
		const moved = fixture("cargo\n");
		const unrelated = fixture("different bytes entirely\n");
		const destination = freshName();
		const id = `undo-mixed-${calls}`;
		await tool.execute(
			id,
			{ ops: [{ path: moved, to: destination }, { op: "delete", path: unrelated }] },
			undefined,
			undefined,
			ctx,
		);
		const deletion = ft.loadChanges(SESSION, id).find((c) => c.uri.endsWith(unrelated))!;
		expect(ft.findMovePartner(SESSION, id, deletion).partner).toBeNull();
	});

	test("the move pair is RECORDED, so identical bytes elsewhere cannot confuse it", async () => {
		/*
		 * the case that beat the byte-matching heuristic: a batch that moves x→z
		 * AND deletes y, where x and y hold identical content. Guessing cannot
		 * tell which deletion belongs to the move. So apply_patch now writes the
		 * pairing down at the moment it performs the move, and the reader stops
		 * guessing entirely. Found by grok-4.5.
		 */
		const SAME = "identical-bytes\n";
		const moved = fixture(SAME);
		const decoy = fixture(SAME);
		const destination = freshName();
		const id = `undo-decoy-${calls}`;
		await tool.execute(
			id,
			{ ops: [{ path: moved, to: destination }, { op: "delete", path: decoy }] },
			undefined,
			undefined,
			ctx,
		);

		const created = ft.loadChanges(SESSION, id).find((c) => c.uri.endsWith(destination))!;
		const pairing = ft.findMovePartner(SESSION, id, created);
		expect(pairing.ambiguous).toHaveLength(0);
		// exactly the file that moved, not the decoy that happened to match
		expect(pairing.partner!.uri.endsWith(moved)).toBe(true);
	});

	test("undoing a batch restores every file it touched", async () => {
		const editedBefore = "keep\ntarget\n";
		const edited = fixture(editedBefore);
		const doomedBefore = "bye\n";
		const doomed = fixture(doomedBefore);
		const created = freshName();
		const id = `undo-${calls}-b`;

		await tool.execute(
			id,
			{
				ops: [
					{ path: created, content: "made\n" },
					{ path: edited, old_string: "target", new_string: "hit" },
					{ op: "delete", path: doomed },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(exists(created)).toBe(true);
		expect(read(edited)).toBe("keep\nhit\n");
		expect(exists(doomed)).toBe(false);

		revertAll(id);
		expect(exists(created)).toBe(false);
		expect(read(edited)).toBe(editedBefore);
		expect(read(doomed)).toBe(doomedBefore);
	});
});

// ---------------------------------------------------------------------------
// undo_edit / redo_edit driven through their real execute()
// ---------------------------------------------------------------------------

describe("undo and redo as one operation", () => {
	const undoTool = createUndoEditTool() as any;
	const redoTool = createRedoEditTool() as any;

	/** undo/redo only consider tool calls visible in the current branch. */
	const branchCtx = (ids: string[]) => ({
		cwd: DIR,
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () =>
				ids.map((id) => ({
					type: "message",
					message: { role: "assistant", content: [{ type: "toolCall", id }] },
				})),
		},
	});

	const runUndo = (ids: string[], args: unknown) =>
		undoTool.execute("undo-call", args, undefined, undefined, branchCtx(ids));
	const runRedo = (ids: string[], args: unknown) =>
		redoTool.execute("redo-call", args, undefined, undefined, branchCtx(ids));

	test("one undo reverts the WHOLE batch, not one file of it", async () => {
		// grok-4.5's main daily complaint: a 7-file batch needed 7 undos.
		const a = fixture("a-before\n");
		const b = fixture("b-before\n");
		const created = freshName();
		const id = `batch-undo-${calls}`;
		await tool.execute(
			id,
			{
				ops: [
					{ path: a, old_string: "a-before", new_string: "a-after" },
					{ path: b, old_string: "b-before", new_string: "b-after" },
					{ path: created, content: "made\n" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(read(a)).toBe("a-after\n");

		const result = await runUndo([id], { path: path.join(DIR, a) });
		expect(result.isError).toBeFalsy();
		expect(read(a)).toBe("a-before\n");
		expect(read(b)).toBe("b-before\n");
		expect(exists(created)).toBe(false);
		expect(result.content[0].text).toMatch(/one change across 3 files/i);
	});

	test('scope: "file" still reverts just the one path', async () => {
		const a = fixture("a1\n");
		const b = fixture("b1\n");
		const id = `scoped-undo-${calls}`;
		await tool.execute(
			id,
			{
				ops: [
					{ path: a, old_string: "a1", new_string: "a2" },
					{ path: b, old_string: "b1", new_string: "b2" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		await runUndo([id], { path: path.join(DIR, a), scope: "file" });
		expect(read(a)).toBe("a1\n");
		expect(read(b)).toBe("b2\n");
	});

	test("undoing a move through the tool restores the original path", async () => {
		const PRECIOUS = "gold-bar-do-not-lose\n";
		const source = fixture(PRECIOUS);
		const destination = freshName();
		const id = `move-undo-${calls}`;
		await tool.execute(id, { path: source, to: destination }, undefined, undefined, ctx);
		expect(exists(source)).toBe(false);

		await runUndo([id], { path: path.join(DIR, destination) });
		expect(read(source)).toBe(PRECIOUS);
		expect(exists(destination)).toBe(false);
	});

	test("redo puts the whole change back", async () => {
		const a = fixture("start\n");
		const created = freshName();
		const id = `redo-${calls}`;
		await tool.execute(
			id,
			{
				ops: [
					{ path: a, old_string: "start", new_string: "end" },
					{ path: created, content: "made\n" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		await runUndo([id], { path: path.join(DIR, a) });
		expect(read(a)).toBe("start\n");
		expect(exists(created)).toBe(false);

		const result = await runRedo([id], { path: path.join(DIR, a) });
		expect(result.isError).toBeFalsy();
		expect(read(a)).toBe("end\n");
		expect(read(created)).toBe("made\n");
	});

	test("redo REFUSES once the file has moved on", async () => {
		/*
		 * the classic redo-invalidation trap. the recorded "after" predates the
		 * newer edit, so re-applying it would silently discard that work. this
		 * check is the only reason redo is safe to offer at all.
		 */
		const a = fixture("v1\n");
		const first = `redo-stale-${calls}`;
		await tool.execute(first, { path: a, old_string: "v1", new_string: "v2" }, undefined, undefined, ctx);
		await runUndo([first], { path: path.join(DIR, a) });
		expect(read(a)).toBe("v1\n");

		const second = `redo-stale-b-${calls}`;
		await tool.execute(second, { path: a, old_string: "v1", new_string: "v3" }, undefined, undefined, ctx);
		expect(read(a)).toBe("v3\n");

		const result = await runRedo([first, second], { path: path.join(DIR, a) });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/changed since that undo/i);
		// the newer work is untouched, which is the whole point
		expect(read(a)).toBe("v3\n");
	});

	test("refuses to undo past a newer change to the same file", async () => {
		/*
		 * grok-4.5's "deep undo history" edge, made concrete: create A and C in
		 * one batch, later move A elsewhere, then try to undo the create batch.
		 * Undoing a creation means "delete it", but A is no longer there — so
		 * the delete is a no-op and the content lives on at the move
		 * destination with its creation history marked undone. No data loss,
		 * but a state nobody can reason about.
		 */
		const a = freshName();
		const c = freshName();
		const createId = `deep-create-${calls}`;
		await tool.execute(
			createId,
			{ ops: [{ path: a, content: "A\n" }, { path: c, content: "C\n" }] },
			undefined,
			undefined,
			ctx,
		);

		const movedTo = freshName();
		const moveId = `deep-move-${calls}`;
		await tool.execute(moveId, { path: a, to: movedTo }, undefined, undefined, ctx);
		expect(read(movedTo)).toBe("A\n");

		// reach back past the move, by targeting the OTHER file of that batch
		const result = await runUndo([createId, moveId], { path: path.join(DIR, c) });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/something newer has since modified/i);

		// nothing moved, and the sane route still works: undo the move first
		expect(read(movedTo)).toBe("A\n");
		expect(read(c)).toBe("C\n");
		await runUndo([createId, moveId], { path: path.join(DIR, movedTo) });
		expect(read(a)).toBe("A\n");
		const after = await runUndo([createId, moveId], { path: path.join(DIR, c) });
		expect(after.isError).toBeFalsy();
		expect(exists(a)).toBe(false);
		expect(exists(c)).toBe(false);
	});

	test("independent changes are still undoable in any order", async () => {
		// the rule must only bite when a NEWER change touched the SAME path;
		// editing one file then another leaves both independently undoable.
		const first = fixture("first-v1\n");
		const second = fixture("second-v1\n");
		const idA = `indep-a-${calls}`;
		const idB = `indep-b-${calls}`;
		await tool.execute(idA, { path: first, old_string: "first-v1", new_string: "first-v2" }, undefined, undefined, ctx);
		await tool.execute(idB, { path: second, old_string: "second-v1", new_string: "second-v2" }, undefined, undefined, ctx);

		const result = await runUndo([idA, idB], { path: path.join(DIR, first) });
		expect(result.isError).toBeFalsy();
		expect(read(first)).toBe("first-v1\n");
		expect(read(second)).toBe("second-v2\n");
	});

	test("two undos then two redos walk back one step at a time", async () => {
		/*
		 * REDO POPS THE BOTTOM OF THE UNDONE RUN, NOT THE TIP.
		 *
		 * the first version scanned newest-first, so undoing L3→L2→L1 and then
		 * redoing jumped straight to L3, skipping L2 entirely — and reported the
		 * diff as L2→L3 while the file actually held L1. Reported by grok-4.5,
		 * who noted single-step redo passed and hid it.
		 */
		const f = fixture("L1\n");
		const second = `multi-redo-b-${calls}`;
		await tool.execute(second, { path: f, old_string: "L1", new_string: "L2" }, undefined, undefined, ctx);
		const third = `multi-redo-c-${calls}`;
		await tool.execute(third, { path: f, old_string: "L2", new_string: "L3" }, undefined, undefined, ctx);
		expect(read(f)).toBe("L3\n");

		const branch = [second, third];
		await runUndo(branch, { path: path.join(DIR, f) });
		expect(read(f)).toBe("L2\n");
		await runUndo(branch, { path: path.join(DIR, f) });
		expect(read(f)).toBe("L1\n");

		// the middle step must come back FIRST, and the diff must describe it
		const first = await runRedo(branch, { path: path.join(DIR, f) });
		expect(first.isError).toBeFalsy();
		expect(read(f)).toBe("L2\n");
		expect(first.content[0].text).toContain("-L1");
		expect(first.content[0].text).toContain("+L2");

		const secondRedo = await runRedo(branch, { path: path.join(DIR, f) });
		expect(secondRedo.isError).toBeFalsy();
		expect(read(f)).toBe("L3\n");

		// and the stack is empty again
		const third_ = await runRedo(branch, { path: path.join(DIR, f) });
		expect(third_.isError).toBe(true);
		expect(read(f)).toBe("L3\n");
	});

	test("a new edit still invalidates redo of a deeper undo", async () => {
		// the ordering fix must not weaken the safety rule: with two steps
		// undone and fresh work on top, the stale bytes must stay refused.
		const f = fixture("v1\n");
		const b = `deep-inval-b-${calls}`;
		await tool.execute(b, { path: f, old_string: "v1", new_string: "v2" }, undefined, undefined, ctx);
		const c = `deep-inval-c-${calls}`;
		await tool.execute(c, { path: f, old_string: "v2", new_string: "v3" }, undefined, undefined, ctx);
		await runUndo([b, c], { path: path.join(DIR, f) });
		await runUndo([b, c], { path: path.join(DIR, f) });
		expect(read(f)).toBe("v1\n");

		const d = `deep-inval-d-${calls}`;
		await tool.execute(d, { path: f, old_string: "v1", new_string: "fresh" }, undefined, undefined, ctx);

		const result = await runRedo([b, c, d], { path: path.join(DIR, f) });
		expect(result.isError).toBe(true);
		expect(read(f)).toBe("fresh\n");
	});

	test("redo with nothing undone says so instead of guessing", async () => {
		const a = fixture("x\n");
		const id = `redo-none-${calls}`;
		await tool.execute(id, { path: a, old_string: "x", new_string: "y" }, undefined, undefined, ctx);
		const result = await runRedo([id], { path: path.join(DIR, a) });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/nothing to redo/i);
		expect(read(a)).toBe("y\n");
	});
});

describe("sub-agent summary (elision)", () => {
	test("names the file for each lane, not just the envelope", () => {
		expect(toolArgSummary("apply_patch", { path: "/a/b/icon.svg", content: "x" })).toBe("icon.svg");
		expect(
			toolArgSummary("apply_patch", { path: "src/app.ts", old_string: "a", new_string: "b" }),
		).toBe("app.ts");
		expect(
			toolArgSummary("apply_patch", {
				ops: [
					{ path: "one.ts", content: "x" },
					{ path: "two.ts", content: "y" },
				],
			}),
		).toBe("one.ts, two.ts");
		expect(
			toolArgSummary("apply_patch", {
				input: "*** Begin Patch\n*** Write File: deep/three.ts\n+x\n*** End Patch",
			}),
		).toBe("three.ts");
	});

	test("elides past the third file rather than wrapping the tree", () => {
		const summary = toolArgSummary("apply_patch", {
			ops: ["a", "b", "c", "d", "e"].map((n) => ({ path: `${n}.ts`, content: "x" })),
		});
		expect(summary).toBe("a.ts, b.ts, c.ts +2 more");
	});

	test("never returns raw JSON for a shape it does not recognise", () => {
		expect(toolArgSummary("apply_patch", {})).toBe("...");
	});
});
