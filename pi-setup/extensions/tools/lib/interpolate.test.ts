/**
 * run: bun test user/pi/extensions/tools/lib/interpolate.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, interpolatePromptVars } from "./interpolate";

const cwd = "/home/user/project";

describe("interpolatePromptVars", () => {
	test("resolves all basic vars", () => {
		const prompt = "cwd={cwd} roots={roots} wsroot={wsroot} workingDir={workingDir} date={date} os={os}";
		const result = interpolatePromptVars(prompt, cwd, { repo: "gh:test", sessionId: "s-123" });

		expect(result).toContain(`cwd=${cwd}`);
		expect(result).toContain("roots=");
		expect(result).toContain("wsroot=");
		expect(result).toContain(`workingDir=${cwd}`);
		expect(result).toContain("os=");
		expect(result).not.toContain("{cwd}");
		expect(result).not.toContain("{roots}");
		expect(result).not.toContain("{date}");
		expect(result).not.toContain("{os}");
	});

	test("resolves repo and sessionId from extra context", () => {
		const prompt = "Repository: {repo}\nSession: {sessionId}";
		const result = interpolatePromptVars(prompt, cwd, { repo: "https://github.com/test/repo", sessionId: "abc-123" });

		expect(result).toContain("Repository: https://github.com/test/repo");
		expect(result).toContain("Session: abc-123");
	});

	test("drops entire line when value is empty", () => {
		const prompt = "Working directory: {cwd}\nRepository: {repo}\nSession ID: {sessionId}\nDone.";
		const result = interpolatePromptVars(prompt, cwd, { repo: "", sessionId: "" });

		expect(result).toContain(`Working directory: ${cwd}`);
		expect(result).not.toContain("Repository");
		expect(result).not.toContain("Session ID");
		expect(result).toContain("Done.");
	});

	test("drops line when extra context is omitted entirely", () => {
		const prompt = "Dir: {cwd}\nRepo: {repo}\nEnd.";
		const result = interpolatePromptVars(prompt, cwd);

		expect(result).toContain(`Dir: ${cwd}`);
		expect(result).not.toContain("Repo");
		expect(result).toContain("End.");
	});

	test("no double-interpolation when a value contains another var pattern", () => {
		const prompt = "Repo: {repo}\nDate: {date}";
		const result = interpolatePromptVars(prompt, cwd, { repo: "my-{date}-repo", sessionId: "" });

		expect(result).toContain("Repo: my-{date}-repo");
		expect(result).toMatch(/Date: \w+/);
	});

	test("replaces multiple occurrences of same var", () => {
		const prompt = "{cwd} and also {cwd}";
		const result = interpolatePromptVars(prompt, cwd, { repo: "x", sessionId: "y" });

		expect(result).toBe(`${cwd} and also ${cwd}`);
	});

	test("multiline ls expansion preserves surrounding content", () => {
		const prompt = "Files:\n{ls}\nEnd.";
		const result = interpolatePromptVars(prompt, cwd, { repo: "x", sessionId: "y" });

		// ls resolves to something (git root listing) or empty — either way, End. must survive
		expect(result).toContain("End.");
	});

	test("empty ls drops the line", () => {
		// /tmp has no .git, so findGitRoot falls back to cwd, and listing /nonexistent fails
		const prompt = "Before\n{ls}\nAfter";
		const result = interpolatePromptVars(prompt, "/nonexistent/path/unlikely", { repo: "x", sessionId: "y" });

		expect(result).toContain("Before");
		expect(result).toContain("After");
	});
});

describe("findGitRoot", () => {
	// these build a throwaway tree instead of relying on process.cwd() being
	// inside a git repo. the old version asserted "this test file lives inside a
	// git repo", which is false when the tools run from the deployed
	// ~/.pi/agent/extensions/tools copy — so the suite failed there for
	// environmental reasons rather than real ones.
	let tmp: string;

	const makeTree = (gitAs: "dir" | "file") => {
		const root = join(tmp, `repo-${gitAs}`);
		const nested = join(root, "src", "deep", "nested");
		mkdirSync(nested, { recursive: true });
		if (gitAs === "dir") mkdirSync(join(root, ".git"), { recursive: true });
		else writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
		return { root, nested };
	};

	test("walks up from a nested dir to the repo root", () => {
		tmp = mkdtempSync(join(tmpdir(), "interpolate-gitroot-"));
		try {
			const { root, nested } = makeTree("dir");
			expect(findGitRoot(nested)).toBe(root);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("treats a .git FILE as a root (git worktrees / submodules)", () => {
		tmp = mkdtempSync(join(tmpdir(), "interpolate-gitroot-"));
		try {
			const { root, nested } = makeTree("file");
			expect(findGitRoot(nested)).toBe(root);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("returns the repo root itself when already at the root", () => {
		tmp = mkdtempSync(join(tmpdir(), "interpolate-gitroot-"));
		try {
			const { root } = makeTree("dir");
			expect(findGitRoot(root)).toBe(root);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("falls back to dir when no git root exists", () => {
		const result = findGitRoot("/tmp/nonexistent-no-git-here");
		expect(result).toBe("/tmp/nonexistent-no-git-here");
	});
});
