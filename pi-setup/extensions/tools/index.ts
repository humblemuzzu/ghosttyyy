/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (apply_patch)
 * - file change tracking for undo_edit (disk-persisted, branch-aware)
 *
 * file changes persist to ~/.pi/file-changes/{sessionId}/ as JSON files
 * keyed by tool call ID. branch awareness comes from the conversation
 * tree — tool call IDs in assistant messages are inherently branch-scoped.
 *
 * PI_READ_COMPACT=1 switches read/ls to tighter limits for sub-agents.
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadTool, NORMAL_LIMITS, COMPACT_LIMITS } from "./read";
import { createLsTool } from "./ls";
import { createApplyPatchTool } from "./apply-patch";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool } from "./bash";
import { createRedoEditTool, createUndoEditTool } from "./undo-edit";
import { createFormatFileTool } from "./format-file";
import { createSkillTool } from "./skill";
import { createScreenshotTool } from "./screenshot";
import { createFinderTool } from "./finder";
import { createOracleTool } from "./oracle";
import { createDelegateTool } from "./delegate";
import { createChadTool } from "./chad";
import { createLibrarianTool } from "./librarian";
import { createCodeReviewTool } from "./code-review";
import { createReadWebPageTool } from "./read-web-page";
import { createConfiguredWebSearchTool } from "./web-search";
import { setupAgentMessage } from "./agent-message";
import { createSearchSessionsTool } from "./search-sessions";
import { createReadSessionTool } from "./read-session";
import { readAgentPrompt } from "./lib/pi-spawn";
import {
	createReadGithubTool,
	createSearchGithubTool,
	createListDirectoryGithubTool,
	createListRepositoriesTool,
	createGlobGithubTool,
	createCommitSearchTool,
	createDiffTool,
} from "./github";
import {
	loadSecrets,
	scrubOutput,
	scrubAll,
	setActiveTags,
	getActiveTags,
	invalidateCache,
	type SecretEntry,
} from "./lib/psst";
import { Vault } from "psst-cli";

export { withFileLock } from "./lib/mutex";
export { saveChange, loadChanges, revertChange, findLatestChange, simpleDiff } from "./lib/file-tracker";

export default function (pi: ExtensionAPI) {
	const limits = process.env.PI_READ_COMPACT ? COMPACT_LIMITS : NORMAL_LIMITS;

	pi.registerTool(createReadTool(limits));
	pi.registerTool(createLsTool(limits));
	// apply_patch is the ONLY file-mutation tool. it replaced edit-file.ts and
	// create-file.ts, which handled one file per call with no cross-file
	// atomicity and — on the `edits` array path — no ambiguous-match guard.
	pi.registerTool(createApplyPatchTool());
	pi.registerTool(createGrepTool());
	pi.registerTool(createGlobTool());
	pi.registerTool(createBashTool());
	pi.registerTool(createUndoEditTool());
	// redo is only safe because it refuses when the file moved on since the
	// undo; see the invalidation check in undo-edit.ts.
	pi.registerTool(createRedoEditTool());
	pi.registerTool(createFormatFileTool());
	pi.registerTool(createSkillTool());
	// screenshot owns the ONLY sanctioned path from screen pixels to a vision
	// model. permissions.json rejects `screencapture`/`sips -Z` in bash so this
	// cannot be routed around by hand — see lib/vision.ts for why that matters.
	pi.registerTool(createScreenshotTool());
	pi.registerTool(createFinderTool({
		systemPrompt: readAgentPrompt("agent.amp.finder.md"),
	}));
	pi.registerTool(createOracleTool({
		systemPrompt: readAgentPrompt("agent.amp.oracle.md"),
	}));
	// delegate replaced task.ts: same spawn, plus resumable children via
	// continueId. Task always ran --no-session, so every child was a dead end.
	pi.registerTool(createDelegateTool());
	// chad is delegate's read-only counterpart, pinned to deepseek-v4-flash so a
	// swarm of them is affordable. it cannot change anything: no apply_patch, and
	// its bash runs under the read-only policy in lib/read-only-bash.ts.
	pi.registerTool(createChadTool({
		systemPrompt: readAgentPrompt("agent.amp.chad.md"),
	}));
	pi.registerTool(createLibrarianTool({
		systemPrompt: readAgentPrompt("agent.amp.librarian.md"),
	}));
	pi.registerTool(createCodeReviewTool({
		systemPrompt: readAgentPrompt("prompt.amp.code-review-system.md"),
		reportFormat: readAgentPrompt("prompt.amp.code-review-report.md"),
	}));
	pi.registerTool(createReadWebPageTool({
		systemPrompt: readAgentPrompt("prompt.amp.read-web-page.md"),
	}));
	// web_search resolves its own config and may be disabled there, in which case
	// we register nothing rather than advertising a tool that cannot run.
	const webSearchTool = createConfiguredWebSearchTool();
	if (webSearchTool) pi.registerTool(webSearchTool);

	pi.registerTool(createSearchSessionsTool());
	pi.registerTool(createReadSessionTool());

	// agent_message owns more than a tool registration: it starts the mailbox
	// watcher and the session_start / agent_settled / session_shutdown drain
	// hooks, so it takes `pi` directly. no-ops if disabled via config.
	setupAgentMessage(pi);

	// github tools — used by librarian sub-agent, also available to main agent
	pi.registerTool(createReadGithubTool());
	pi.registerTool(createSearchGithubTool());
	pi.registerTool(createListDirectoryGithubTool());
	pi.registerTool(createListRepositoriesTool());
	pi.registerTool(createGlobGithubTool());
	pi.registerTool(createCommitSearchTool());
	pi.registerTool(createDiffTool());

	// ── psst secret management hooks ──────────────────────────

	// scrub ALL sensitive values from tool output — vault secrets, auth.json tokens, env var keys
	pi.on("tool_result", async (event) => {
		const allText = event.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");

		// quick check — if no content, skip
		if (!allText) return;

		// load vault secrets for named redaction
		const vaultSecrets = await loadSecrets();

		// if no vault secrets, check if there are any auth/env values to scrub
		// (always scrub comprehensively — even if vault is empty)
		const scrubbed = await Promise.all(event.content.map(async (c: any) =>
			c.type === "text"
				? { ...c, text: await scrubAll(c.text) }
				: c,
		));

		return { content: scrubbed };
	});

	// inject secret names into system prompt so the agent knows what's available
	pi.on("before_agent_start", async (event) => {
		const secrets = await loadSecrets();
		if (secrets.length === 0) return;

		const names = secrets.map((s: SecretEntry) => s.name).join(", ");
		const tagNote = getActiveTags().length > 0
			? ` (filtered by tags: ${getActiveTags().join(", ")})`
			: "";
		const instruction = [
			"\n## psst — Secret Management",
			`Available secrets (injected as env vars in bash)${tagNote}: ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");

		return { systemPrompt: event.systemPrompt + instruction };
	});

	// /psst — list loaded secret names (never values)
	pi.registerCommand("psst", {
		description: "Show psst vault secret names and tags",
		handler: async (_args, ctx) => {
			const secrets = await loadSecrets();
			if (secrets.length === 0) {
				const hint = getActiveTags().length > 0
					? `No secrets matching tags: ${getActiveTags().join(", ")}`
					: "No psst secrets found. Run 'psst set <NAME>' to add secrets.";
				ctx.ui.notify(hint, "info");
				return;
			}

			const tagNote = getActiveTags().length > 0
				? ` (filtered by: ${getActiveTags().join(", ")})`
				: "";
			const formatLine = (s: SecretEntry) => {
				const tagStr = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
				return `  • ${s.name}${tagStr}`;
			};
			const list = secrets.map(formatLine).join("\n");
			ctx.ui.notify(`Vault secrets${tagNote}:\n${list}`, "info");
		},
	});

	// /psst-set — add or update a secret in the vault
	pi.registerCommand("psst-set", {
		description: "Set a secret: /psst-set NAME [value] [tag1,tag2,...]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let name = parts[0];
			let value = parts[1];
			let tagsRaw = parts[2];

			if (!name) {
				name = (await ctx.ui.input("Secret name (e.g. API_KEY):")) ?? "";
				if (!name) return ctx.ui.notify("Cancelled", "info");
			}

			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				return ctx.ui.notify(`Invalid name: ${name}. Must match [A-Z][A-Z0-9_]*`, "error");
			}

			if (!value) {
				value = (await ctx.ui.input(`Value for ${name}:`)) ?? "";
				if (!value) return ctx.ui.notify("Cancelled", "info");
			}

			if (tagsRaw === undefined) {
				tagsRaw = (await ctx.ui.input("Tags (comma-separated, optional):")) ?? "";
			}

			const tags = tagsRaw.split(",").map((t: string) => t.trim()).filter(Boolean);

			try {
				// resolve vault — try local first, then global
				const vaultPath = Vault.findVaultPath({ global: false })
					?? Vault.findVaultPath({ global: true });
				if (!vaultPath) {
					return ctx.ui.notify("No vault found. Run 'psst init' or 'psst init --global' first.", "error");
				}

				const vault = new Vault(vaultPath);
				const unlocked = await vault.unlock();
				if (!unlocked) {
					vault.close();
					return ctx.ui.notify("Vault is locked — unlock keychain or set PSST_PASSWORD", "error");
				}

				await vault.setSecret(name, value, tags.length > 0 ? tags : undefined);
				vault.close();

				invalidateCache();

				const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
				ctx.ui.notify(`Secret ${name} saved${tagSuffix}`, "success");
			} catch (e: any) {
				ctx.ui.notify(`Failed to set secret: ${e.message}`, "error");
			}
		},
	});

	// /psst-tag — filter which secrets are loaded by tag
	pi.registerCommand("psst-tag", {
		description: "Filter secrets by tag: /psst-tag [tag1,tag2] (no args = clear filter)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			if (!raw) {
				setActiveTags([]);
				invalidateCache();
				ctx.ui.notify("psst: tag filter cleared — all vault secrets available", "info");
				return;
			}

			const tags = raw.split(",").map((t: string) => t.trim()).filter(Boolean);
			setActiveTags(tags);
			invalidateCache();

			const matched = await loadSecrets();
			ctx.ui.notify(
				`psst: filtering by [${tags.join(", ")}] — ${matched.length} secret(s) match`,
				matched.length > 0 ? "success" : "info",
			);
		},
	});

	/*
	 * hide pi's NATIVE edit/write.
	 *
	 * we used to register our own `edit` and `write`, which shadowed the
	 * built-ins by name. deleting edit-file.ts / create-file.ts therefore does
	 * not remove those tools — it UN-shadows pi's originals, which have none of
	 * our mutex locking, undo tracking, secret scrubbing or permission checks.
	 * so the built-ins have to be dropped from the active set explicitly.
	 *
	 * also hidden: pi-sub-core's usage tools (`get_current_usage`,
	 * `get_all_usage`, `sub_get_usage`, `sub_get_all_usage`). they are read-only
	 * quota snapshots the agent has no reason to call — the same data is always
	 * visible in the status bar (pi-sub-bar) — and a model that calls them
	 * burns a turn and API latency for nothing. keeping them out of the active
	 * set keeps them out of the tool list the model sees.
	 *
	 * done at session_start rather than at registration because the active set
	 * is assembled after every extension has registered.
	 */
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const filtered = active.filter(
			(name) =>
				name !== "edit" &&
				name !== "write" &&
				name !== "get_current_usage" &&
				name !== "get_all_usage" &&
				name !== "sub_get_usage" &&
				name !== "sub_get_all_usage",
		);
		// only touch the set if something actually showed up; setActiveTools on
		// an unchanged list is a pointless write that other extensions may react to.
		if (filtered.length !== active.length) {
			pi.setActiveTools(filtered);
		}
	});
}
