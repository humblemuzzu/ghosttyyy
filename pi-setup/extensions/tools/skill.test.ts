import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { createSkillTool } from "./skill";

const root = mkdtempSync(join(tmpdir(), "skill-tool-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeSkill(name: string, opts: { disableModelInvocation?: boolean; files?: string[] } = {}): Skill {
	const baseDir = join(root, "anywhere", name);
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(join(baseDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name} body\n`);
	for (const f of opts.files ?? []) writeFileSync(join(baseDir, f), "x");
	return {
		name,
		description: "test skill",
		filePath: join(baseDir, "SKILL.md"),
		baseDir,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: opts.disableModelInvocation ?? false,
	};
}

async function load(skills: Skill[], name: string) {
	const tool = createSkillTool(() => skills);
	const result: any = await tool.execute("t", { name }, undefined, undefined, { cwd: root } as any);
	return { text: result.content[0].text as string, isError: result.isError === true };
}

describe("skill tool", () => {
	test("loads a skill from wherever pi resolved it, frontmatter stripped", async () => {
		const r = await load([makeSkill("alpha", { files: ["ref.md"] })], "alpha");
		expect(r.isError).toBe(false);
		expect(r.text).toStartWith('<loaded_skill name="alpha">\n# alpha body');
		expect(r.text).not.toContain("description: test skill");
		expect(r.text).toContain(`<file>${join(root, "anywhere", "alpha", "ref.md")}</file>`);
	});

	test("a skill on disk but not in pi's list is not loadable", async () => {
		makeSkill("orphan");
		const r = await load([makeSkill("beta")], "orphan");
		expect(r.isError).toBe(true);
		expect(r.text).toBe('skill "orphan" not found.\n\navailable skills: beta');
	});

	test("a disable-model-invocation skill is neither loadable nor listed", async () => {
		const r = await load([makeSkill("hidden", { disableModelInvocation: true }), makeSkill("gamma")], "hidden");
		expect(r.isError).toBe(true);
		expect(r.text).toBe('skill "hidden" not found.\n\navailable skills: gamma');
	});

	test("with no skills loaded the error says so instead of listing nothing", async () => {
		const r = await load([], "anything");
		expect(r.isError).toBe(true);
		expect(r.text).toContain("no skills are loaded in this session");
	});

	test("the list is read at call time, not captured at registration", async () => {
		let skills: Skill[] = [];
		const tool = createSkillTool(() => skills);
		skills = [makeSkill("late")];
		const result: any = await tool.execute("t", { name: "late" }, undefined, undefined, { cwd: root } as any);
		expect(result.isError).toBeUndefined();
	});
});
