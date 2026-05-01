/**
 * mentions extension — @mention resolution for sessions, commits, handoffs,
 * and agent directives (@oracle, @finder, @codereview, @task).
 *
 * data mentions (@session/id, @commit/sha, @handoff/id) inject hidden
 * context. agent mentions (@oracle, @finder, etc.) inject a directive
 * telling the model to call the specified subagent tool.
 *
 * ported from bdsqqq/dots mentions extension, adapted for flat-file setup.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	clearCommitIndexCache,
	clearSessionMentionCache,
	listMentionKinds,
	MentionAwareProvider,
	renderResolvedMentionsText,
	resolveMentions,
	type ResolvedMention,
} from "./tools/lib/mentions/index.js";
// side-effect import — registers @oracle, @finder, @codereview, @task sources
import "./tools/lib/mentions/agent-source.js";

const CUSTOM_TYPE = "mentions:resolved";
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

export default function mentionsExtension(pi: ExtensionAPI): void {
	let activeMentionContext = "";

	const clearActive = () => {
		activeMentionContext = "";
	};

	// resolve mentions on user input
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const mentions = await resolveMentions(event.text, { cwd: ctx.cwd });
		const resolved = mentions.filter(
			(mention): mention is Extract<ResolvedMention, { status: "resolved" }> =>
				mention.status === "resolved",
		);

		activeMentionContext = renderResolvedMentionsText(resolved);
		return { action: "continue" as const };
	});

	// inject resolved mentions as hidden context per turn
	pi.on("context", async (event) => {
		const messages = event.messages.filter(
			(message: any) => message.customType !== CUSTOM_TYPE,
		);

		if (!activeMentionContext) return { messages };

		return {
			messages: [
				...messages,
				{
					role: "custom",
					customType: CUSTOM_TYPE,
					content: activeMentionContext,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	// clear state when agent finishes a turn
	pi.on("agent_end", async () => {
		clearActive();
	});

	// register autocomplete + reset state on each session boot
	pi.on("session_start", async (_event, ctx) => {
		clearActive();
		clearSessionMentionCache();
		clearCommitIndexCache();

		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider(
			(current) =>
				new MentionAwareProvider({
					baseProvider: current,
					cwd: ctx.cwd,
					sessionsDir: SESSIONS_DIR,
				}),
		);
	});

	// /mentions command — verify sources are registered, list available kinds
	pi.registerCommand("mentions", {
		description: "Show registered @mention kinds (debug)",
		handler: async (_args, ctx) => {
			const kinds = listMentionKinds();
			const lines = [
				`registered @mention kinds (${kinds.length}):`,
				...kinds.map((k) => `  @${k}`),
				"",
				"agent kinds (standalone):  @oracle  @finder  @codereview  @task",
				"data kinds (with /value):  @commit/<sha>  @session/<id>  @handoff/<id>",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
