/**
 * skill tool — load a skill by name.
 *
 * serves exactly the skills pi resolved for <available_skills> (index.ts hands
 * them over from before_agent_start). it does no discovery of its own, so it
 * cannot disagree with the prompt about which skills exist or are disabled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stripFrontmatter, type Skill, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { boxRendererWindowed, textSection, COLLAPSED_EXCERPTS } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";

/** every file in the skill directory except SKILL.md, for the <skill_files> block. */
function collectSkillFiles(baseDir: string): string[] {
	const files: string[] = [];

	function walk(dir: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch { return; }

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name !== "SKILL.md") {
				files.push(full);
			}
		}
	}

	walk(baseDir);
	return files;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true } as any;
}

export function createSkillTool(getSkills: () => readonly Skill[]): ToolDefinition {
	return {
		name: "skill",
		label: "Load Skill",
		description:
			"Load a specialized skill that provides domain-specific instructions and workflows.\n\n" +
			"When you recognize that a task matches one of the available skills, use this tool " +
			"to load the full skill instructions.\n\n" +
			"The skill will inject detailed instructions, workflows, and access to bundled " +
			"resources (scripts, references, templates) into the conversation context.",

		parameters: Type.Object({
			name: Type.String({
				description: "The name of the skill to load (must match one of the available skills).",
			}),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const name = args.name || "...";
			text.setText(theme.fg("dim", "using ") + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " skill"));
			return text;
		},

		async execute(_toolCallId, params) {
			const loadable = getSkills().filter((s) => !s.disableModelInvocation);
			const skill = loadable.find((s) => s.name === params.name);

			if (!skill) {
				const names = loadable.map((s) => s.name).sort();
				return errorResult(
					names.length > 0
						? `skill "${params.name}" not found.\n\navailable skills: ${names.join(", ")}`
						: `skill "${params.name}" not found: no skills are loaded in this session.`,
				);
			}

			let rawContent: string;
			try {
				rawContent = fs.readFileSync(skill.filePath, "utf-8");
			} catch (err: any) {
				return errorResult(`failed to read skill file ${skill.filePath}: ${err.message}`);
			}

			const parts: string[] = [
				`<loaded_skill name="${skill.name}">`,
				stripFrontmatter(rawContent).trim(),
				"",
				`Base directory for this skill: file://${skill.baseDir}`,
				"Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
			];

			const skillFiles = collectSkillFiles(skill.baseDir);
			if (skillFiles.length > 0) {
				parts.push("", "<skill_files>", ...skillFiles.map((f) => `<file>${f}</file>`), "</skill_files>");
			}

			parts.push("</loaded_skill>");

			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: { header: skill.name },
			} as any;
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
			const renderer = content.text.startsWith("<loaded_skill")
				? boxRendererWindowed(
						() => [textSection(undefined, "skill loaded", true)],
						{ collapsed: {}, expanded: {} },
					)
				: boxRendererWindowed(
						() => [textSection(undefined, content.text)],
						{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
					);
			container.addChild(renderer);
			return container;
		},
	};
}
