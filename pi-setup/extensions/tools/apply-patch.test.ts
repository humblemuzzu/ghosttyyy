/**
 * apply_patch — behavioural tests against a real temp filesystem.
 *
 * these run the tool's actual execute() (no mocks) because every property
 * worth testing here IS a filesystem property: atomicity, rollback, alias
 * refusal, and the undo_edit records it leaves behind.
 *
 * the case-variant test is the important one — it is a REGRESSION TEST for a
 * deadlock. see canonicalMutationPath in apply-patch.ts: node's sync and async
 * realpath disagree about casing on macOS, which let two aliased paths pass
 * the alias check and then collapse to one key inside pi's file-mutation
 * queue, hanging the tool forever.
 */

import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApplyPatchTool } from "./apply-patch";
import * as ft from "./lib/file-tracker";

const tool = createApplyPatchTool() as any;
const DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-test-")));
const SESSION = `apply-patch-test-${Date.now()}`;
const ctx = { cwd: DIR, sessionManager: { getSessionId: () => SESSION } };

const p = (f: string) => path.join(DIR, f);
const read = (f: string) => fs.readFileSync(p(f), "utf8");
const write = (f: string, s: string) => fs.writeFileSync(p(f), s, "utf8");
const run = (input: string, id = `tc-${Math.random().toString(36).slice(2)}`) =>
	tool.execute(id, { input }, undefined, undefined, ctx);

/** run a patch expected to fail, returning the error message. */
async function expectFailure(input: string, id?: string): Promise<string> {
	try {
		await run(input, id);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the patch to be rejected, but it succeeded");
}

afterAll(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.rmSync(path.join(os.homedir(), ".pi", "file-changes", SESSION), {
		recursive: true,
		force: true,
	});
});

// --- core operations ---

test("Add File creates the file with content", async () => {
	const result = await run(`*** Begin Patch
*** Add File: a.txt
+hello
+world
*** End Patch`);
	expect(read("a.txt")).toBe("hello\nworld\n");
	expect(result.details.changes[0].kind).toBe("added");
});

test("Update File applies a hunk", async () => {
	await run(`*** Begin Patch
*** Update File: a.txt
@@
-hello
+HELLO
 world
*** End Patch`);
	expect(read("a.txt")).toBe("HELLO\nworld\n");
});

test("Update with non-matching context is rejected and changes nothing", async () => {
	const message = await expectFailure(`*** Begin Patch
*** Update File: a.txt
@@
-nonexistent line
+replacement
*** End Patch`);
	expect(message).toContain("failed to find expected lines");
	expect(read("a.txt")).toBe("HELLO\nworld\n");
});

test("Move to renames the file and removes the source", async () => {
	await run(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-HELLO
+MOVED
 world
*** End Patch`);
	expect(fs.existsSync(p("a.txt"))).toBe(false);
	expect(read("b.txt")).toBe("MOVED\nworld\n");
});

test("Delete File removes the file", async () => {
	await run(`*** Begin Patch
*** Delete File: b.txt
*** End Patch`);
	expect(fs.existsSync(p("b.txt"))).toBe(false);
});

test("creates missing parent directories", async () => {
	await run(`*** Begin Patch
*** Add File: deep/nested/x.txt
+deep
*** End Patch`);
	expect(read("deep/nested/x.txt")).toBe("deep\n");
});

// --- atomicity ---

test("a multi-file batch applies every file", async () => {
	const result = await run(`*** Begin Patch
*** Add File: m1.txt
+one
*** Add File: m2.txt
+two
*** Add File: m3.txt
+three
*** End Patch`);
	expect(result.details.changes.length).toBe(3);
	expect(read("m2.txt")).toBe("two\n");
});

test("one failing operation rolls back the whole batch", async () => {
	write("ok.txt", "original\n");
	const message = await expectFailure(`*** Begin Patch
*** Update File: ok.txt
@@
-original
+changed
*** Update File: missing.txt
@@
-nope
+nah
*** End Patch`);
	expect(message).toContain("file not found");
	// the first operation succeeded in memory but must not reach disk
	expect(read("ok.txt")).toBe("original\n");
});

test("a patch that changes nothing is rejected", async () => {
	write("same.txt", "unchanged\n");
	const message = await expectFailure(`*** Begin Patch
*** Update File: same.txt
@@
 unchanged
*** End Patch`);
	expect(message).toContain("no changes");
});

// --- safety guards ---

test("added content containing a placeholder is rejected", async () => {
	const message = await expectFailure(`*** Begin Patch
*** Add File: lazy.ts
+function foo() {
+  // ... rest of the implementation unchanged
+}
*** End Patch`);
	expect(message).toContain("placeholder");
	expect(fs.existsSync(p("lazy.ts"))).toBe(false);
});

test("symlinked paths are refused", async () => {
	write("real.txt", "real\n");
	fs.symlinkSync(p("real.txt"), p("link.txt"));
	const message = await expectFailure(`*** Begin Patch
*** Update File: link.txt
@@
-real
+hacked
*** End Patch`);
	expect(message).toContain("symbolic link");
	expect(read("real.txt")).toBe("real\n");
});

test("case-variant aliases are refused instead of deadlocking", async () => {
	write("Dup.txt", "x\n");
	const message = await expectFailure(`*** Begin Patch
*** Update File: Dup.txt
@@
-x
+y
*** Update File: dup.txt
@@
-x
+z
*** End Patch`);
	expect(message).toContain("resolve to the same file");
	expect(read("Dup.txt")).toBe("x\n");
});

// --- undo_edit integration ---

test("saveChanges records every file of a batch", async () => {
	const id = "undo-batch-1";
	await run(
		`*** Begin Patch
*** Add File: u1.txt
+first
*** Add File: u2.txt
+second
*** End Patch`,
		id,
	);
	const records = ft.loadChanges(SESSION, id);
	expect(records.length).toBe(2);
	expect(records.every((r) => r.beforeExists === false && r.afterExists === true)).toBe(true);
});

test("undoing a creation removes the file rather than emptying it", async () => {
	const id = "undo-create-1";
	await run(
		`*** Begin Patch
*** Add File: created.txt
+brand new
*** End Patch`,
		id,
	);
	const record = ft.loadChanges(SESSION, id)[0]!;
	ft.revertChange(SESSION, id, record.id);
	expect(fs.existsSync(p("created.txt"))).toBe(false);
});

test("undoing a deletion restores the content", async () => {
	write("gone.txt", "important data\n");
	const id = "undo-delete-1";
	await run(
		`*** Begin Patch
*** Delete File: gone.txt
*** End Patch`,
		id,
	);
	expect(fs.existsSync(p("gone.txt"))).toBe(false);
	const record = ft.loadChanges(SESSION, id)[0]!;
	ft.revertChange(SESSION, id, record.id);
	expect(read("gone.txt")).toBe("important data\n");
});

test("undoing a modification restores the previous content", async () => {
	write("mod.txt", "v1\n");
	const id = "undo-mod-1";
	await run(
		`*** Begin Patch
*** Update File: mod.txt
@@
-v1
+v2
*** End Patch`,
		id,
	);
	expect(read("mod.txt")).toBe("v2\n");
	const record = ft.loadChanges(SESSION, id)[0]!;
	ft.revertChange(SESSION, id, record.id);
	expect(read("mod.txt")).toBe("v1\n");
});

test("records written before apply_patch existed still revert", async () => {
	write("legacy.txt", "new content\n");
	const id = "legacy-1";
	// a pre-apply_patch record: no beforeExists/afterExists fields at all
	ft.saveChange(SESSION, id, {
		uri: `file://${p("legacy.txt")}`,
		before: "old content\n",
		after: "new content\n",
		diff: "",
		isNewFile: false,
		timestamp: Date.now(),
	});
	const record = ft.loadChanges(SESSION, id)[0]!;
	expect(record.beforeExists).toBeUndefined();
	ft.revertChange(SESSION, id, record.id);
	expect(read("legacy.txt")).toBe("old content\n");
});

test("Add File on an existing path is refused instead of clobbering it", async () => {
	// upstream (bdsqqq) has no guard here: `Add File` on an existing path
	// replaced the entire file with the patch body, silently. verified before
	// the fix: a 4-line file became 1 line and was reported only as "M path".
	write("precious.ts", "export function keepMe() {\n  return 1;\n}\n");
	const message = await expectFailure(`*** Begin Patch
*** Add File: precious.ts
+const oops = true;
*** End Patch`);
	expect(message).toContain("file already exists");
	expect(read("precious.ts")).toBe("export function keepMe() {\n  return 1;\n}\n");
});

test("Delete File then Add File replaces a file wholesale", async () => {
	// the supported way to do what the clobber accidentally allowed
	write("replaceme.ts", "old body\n");
	await run(`*** Begin Patch
*** Delete File: replaceme.ts
*** End Patch`);
	await run(`*** Begin Patch
*** Add File: replaceme.ts
+new body
*** End Patch`);
	expect(read("replaceme.ts")).toBe("new body\n");
});

// --- schema contract (guards a real outage) ---

test("schema satisfies pi-ai's grammar-sampling contract", () => {
	// pi-ai `inferGrammarInputProperty` (constrained-sampling.js:38) demands
	// EXACTLY ONE required string property whenever a tool declares
	// `constrainedSampling`. violating it makes every request on an
	// OpenAI-family model fail with "cannot use grammar constrained sampling"
	// — while Anthropic passes, because pi-ai returns early for providers
	// without grammar support (same file, line 68).
	//
	// this actually shipped: making `input` optional to accept aliases broke
	// every gpt-5.6 session while all Claude tests stayed green.
	const schema = tool.parameters as any;
	expect(tool.constrainedSampling).toBeDefined();
	expect(schema.type).toBe("object");
	expect(Array.isArray(schema.required)).toBe(true);
	expect(schema.required.length).toBe(1);
	expect(typeof schema.required[0]).toBe("string");
	expect(schema.properties[schema.required[0]].type).toBe("string");
});

test("a grammar variant is present and non-empty", () => {
	// resolveGrammarConstrainedSampling also throws when every variant is
	// blank, which would be the same class of OpenAI-only outage.
	const variants = (tool.constrainedSampling as any).variants;
	const lark = variants?.openai_lark;
	expect(typeof lark).toBe("string");
	expect(lark.trim().length > 0).toBe(true);
});

// --- ambiguity (the reason apply_patch can replace `edit`) ---

const AMBIGUOUS_BODY = `function saveUser(u) {
  logger.debug("saving");
  return db.put(u);
}

function saveOrder(o) {
  logger.debug("saving");
  return db.put(o);
}
`;

test("an unanchored hunk matching several places is REFUSED, not guessed", async () => {
	// upstream takes the first match and reports success, silently editing the
	// wrong function. `edit`'s old_str path has always refused this; the guard
	// in codex-patch brings apply_patch to the same standard.
	write("ambig.ts", AMBIGUOUS_BODY);
	const message = await expectFailure(`*** Begin Patch
*** Update File: ambig.ts
@@
-  logger.debug("saving");
+  logger.debug("saving order");
*** End Patch`);
	expect(message).toContain("ambiguous hunk");
	expect(read("ambig.ts")).toBe(AMBIGUOUS_BODY);
});

test("an '@@ anchor' disambiguates and targets the intended occurrence", async () => {
	write("anchored.ts", AMBIGUOUS_BODY);
	await run(`*** Begin Patch
*** Update File: anchored.ts
@@ function saveOrder(o) {
-  logger.debug("saving");
+  logger.debug("saving order");
*** End Patch`);
	const after = read("anchored.ts");
	expect(after.includes('order");\n  return db.put(o)')).toBe(true);
	expect(after.includes('order");\n  return db.put(u)')).toBe(false);
});

test("extra context lines also disambiguate", async () => {
	write("ctx.ts", AMBIGUOUS_BODY);
	await run(`*** Begin Patch
*** Update File: ctx.ts
@@
-  logger.debug("saving");
+  logger.debug("saving order");
   return db.put(o);
*** End Patch`);
	expect(read("ctx.ts").includes('order");\n  return db.put(o)')).toBe(true);
});
