/**
 * skill tool — load a skill by name, returning its content for
 * injection into the conversation context.
 *
 * replaces pi's default approach (model uses `read` on the SKILL.md
 * path) with a dedicated tool. the model
 * calls `skill(name: "git")` instead of `read(path: "/.../SKILL.md")`.
 *
 * discovery searches skill directories configured in pi's settings
 * (settings.json `skills` array), the default agentDir/skills/,
 * and project-local .pi/skills/. frontmatter is parsed for name
 * and description. files in the skill directory are listed in
 * <skill_files> for the model to read if needed.
 *
 * does NOT inject MCP or builtin tools from frontmatter — that
 * requires runtime tool registration which is out of scope for
 * this first pass.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { boxRendererWindowed, textSection, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";

const COLLAPSED_EXCERPTS: Excerpt[] = [
	{ focus: "head" as const, context: 3 },
	{ focus: "tail" as const, context: 5 },
];

// --- frontmatter parsing (reimplemented; pi's isn't re-exported) ---

interface Frontmatter {
	name?: string;
	description?: string;
	[key: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized };
	}

	const yamlStr = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	// minimal yaml key:value parsing — skills use simple flat frontmatter
	const frontmatter: Frontmatter = {};
	for (const line of yamlStr.split("\n")) {
		const match = line.match(/^(\w[\w-]*):\s*"?(.+?)"?\s*$/);
		if (match) {
			frontmatter[match[1]] = match[2];
		}
	}

	return { frontmatter, body };
}

// --- skill discovery ---

interface SkillEntry {
	name: string;
	filePath: string;
	baseDir: string;
}

/**
 * resolve agentDir the same way pi does:
 * env PI_CODING_AGENT_DIR > ~/.pi/agent/
 */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return os.homedir() + envDir.slice(1);
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * read pi's settings.json to get additional skill paths.
 * returns the `skills` array if present.
 */
function getSkillPathsFromSettings(): string[] {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	if (!fs.existsSync(settingsPath)) return [];
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (Array.isArray(settings.skills)) {
			return settings.skills.map((p: string) => {
				if (p === "~") return os.homedir();
				if (p.startsWith("~/")) return os.homedir() + p.slice(1);
				return p;
			});
		}
	} catch { /* unreadable */ }
	return [];
}

/**
 * true for real directories AND symlinks that point at directories.
 * `Dirent.isDirectory()` is FALSE for symlinks — without this, symlinked skill
 * dirs (e.g. find-skills / userinterface-wiki in agentDir/skills, or pnpm-style
 * linked packages) get silently skipped. `fs.existsSync(.../SKILL.md)` later
 * follows the link and validates, so accepting symlinks here is safe.
 */
function isDirLike(entry: fs.Dirent): boolean {
	return entry.isDirectory() || entry.isSymbolicLink();
}

/**
 * discover skill directories bundled INSIDE installed pi packages.
 * pi's native skill listing surfaces these (so they show in the `/` menu and
 * the session-start skills block), but they live outside the settings/agent/
 * project skill roots — so without this the `skill` tool can't resolve them
 * by name and `skill({ name: "librarian" })` fails with "skill not found".
 *
 *   npm packages: agentDir/npm/node_modules/<pkg>/skills/       (pkg may be @scope/name)
 *   git packages: agentDir/git/<host>/<org>/<repo>/skills/
 *
 * returns the existing `skills` CONTAINER dirs (each holds <name>/SKILL.md).
 */
function getPackageSkillDirs(): string[] {
	const roots: string[] = [];
	const agentDir = getAgentDir();

	// npm packages — node_modules/<pkg>/skills (handle @scope/name one level deeper)
	const nmDir = path.join(agentDir, "npm", "node_modules");
	if (fs.existsSync(nmDir)) {
		try {
			for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
				if (!isDirLike(entry)) continue;
				if (entry.name.startsWith("@")) {
					const scopeDir = path.join(nmDir, entry.name);
					try {
						for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
							if (isDirLike(sub)) roots.push(path.join(scopeDir, sub.name, "skills"));
						}
					} catch { /* unreadable scope */ }
				} else {
					roots.push(path.join(nmDir, entry.name, "skills"));
				}
			}
		} catch { /* unreadable node_modules */ }
	}

	// git packages — git/<host>/<org>/<repo>/skills (walk a bounded depth)
	const gitDir = path.join(agentDir, "git");
	if (fs.existsSync(gitDir)) walkForSkillDirs(gitDir, roots, 3);

	return roots.filter((d) => fs.existsSync(d));
}

/**
 * bounded recursive walk collecting directories literally named `skills`.
 * depth counts how many more levels below `dir` to descend.
 */
function walkForSkillDirs(dir: string, out: string[], depth: number): void {
	if (depth < 0) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!isDirLike(entry)) continue;
		if (entry.name === "skills") {
			out.push(path.join(dir, entry.name));
			continue;
		}
		if (depth > 0) walkForSkillDirs(path.join(dir, entry.name), out, depth - 1);
	}
}

/**
 * search for a skill by name across all known directories.
 * checks (in precedence order): agentDir/skills/{name}/SKILL.md, settings skill
 * paths, project-local .pi/skills/{name}/SKILL.md, then package-bundled skills
 * (npm/git). user/config skills win over package skills of the same name.
 */
function findSkill(name: string, cwd: string): SkillEntry | null {
	const candidates: string[] = [];

	// 1. default agentDir skills
	candidates.push(path.join(getAgentDir(), "skills", name, "SKILL.md"));

	// 2. settings.json skill paths
	for (const skillDir of getSkillPathsFromSettings()) {
		candidates.push(path.join(skillDir, name, "SKILL.md"));
	}

	// 3. project-local
	candidates.push(path.join(cwd, ".pi", "skills", name, "SKILL.md"));

	// 4. package-bundled skills (npm/git) — checked LAST so user skills win
	for (const skillDir of getPackageSkillDirs()) {
		candidates.push(path.join(skillDir, name, "SKILL.md"));
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return {
				name,
				filePath: candidate,
				baseDir: path.dirname(candidate),
			};
		}
	}

	return null;
}

/**
 * list all known skill names for error messages.
 */
function listAvailableSkills(cwd: string): string[] {
	const names = new Set<string>();
	const dirs: string[] = [
		path.join(getAgentDir(), "skills"),
		...getSkillPathsFromSettings(),
		path.join(cwd, ".pi", "skills"),
		...getPackageSkillDirs(),
	];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!isDirLike(entry)) continue;
				const skillMd = path.join(dir, entry.name, "SKILL.md");
				if (fs.existsSync(skillMd)) names.add(entry.name);
			}
		} catch { /* unreadable */ }
	}

	return Array.from(names).sort();
}

/**
 * collect file paths in the skill directory (excluding SKILL.md),
 * walking subdirectories. used for the <skill_files> block so the
 * model knows what reference files are available.
 */
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

// --- tool factory ---

export function createSkillTool(): ToolDefinition {
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
			arguments: Type.Optional(
				Type.String({
					description: "Optional arguments to pass to the skill.",
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const name = args.name || "...";
			text.setText(theme.fg("dim", "using ") + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " skill"));
			return text;
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const skill = findSkill(params.name, ctx.cwd);

			if (!skill) {
				const available = listAvailableSkills(ctx.cwd);
				const list = available.length > 0
					? `\n\navailable skills: ${available.join(", ")}`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `skill "${params.name}" not found.${list}`,
						},
					],
					isError: true,
				} as any;
			}

			let rawContent: string;
			try {
				rawContent = fs.readFileSync(skill.filePath, "utf-8");
			} catch (err: any) {
				return {
					content: [
						{
							type: "text" as const,
							text: `failed to read skill file: ${err.message}`,
						},
					],
					isError: true,
				} as any;
			}

			const { body } = parseFrontmatter(rawContent);

			// build output in <loaded_skill> format
			const parts: string[] = [
				`<loaded_skill name="${skill.name}">`,
				body,
				"",
				`Base directory for this skill: file://${skill.baseDir}`,
				"Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
			];

			const skillFiles = collectSkillFiles(skill.baseDir);
			if (skillFiles.length > 0) {
				parts.push("");
				parts.push("<skill_files>");
				for (const f of skillFiles) {
					parts.push(`<file>${f}</file>`);
				}
				parts.push("</skill_files>");
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
