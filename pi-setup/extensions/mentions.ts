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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	renderResolvedMentionsText,
	resolveMentions,
	clearSessionMentionCache,
	clearCommitIndexCache,
	type ResolvedMention,
} from "./tools/lib/mentions/index.js";
// side-effect import — registers @oracle, @finder, @codereview, @task sources
import "./tools/lib/mentions/agent-source.js";

const CUSTOM_TYPE = "mentions:resolved";

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

	// clear state and caches on new session
	pi.on("session_start", async () => {
		clearActive();
		clearSessionMentionCache();
		clearCommitIndexCache();
	});
}
