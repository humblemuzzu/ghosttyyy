/**
 * system-prompt — injects interpolated prompt.amp.system.md into the agent's system prompt.
 *
 * muzz's built-in system prompt only provides date + cwd. this extension appends
 * the full amp system prompt with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses the undocumented before_agent_start return value { systemPrompt } to modify
 * the system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} is populated by reading the
 * appropriate harness docs file (prompt.harness-docs.<harness>.md).
 *
 * SUB-AGENTS TAKE A DIFFERENT PATH. a child pi process loads these same
 * extensions, so this hook runs there too — and the parent prompt describes a
 * ~40-tool surface the child does not have. see tools/lib/sub-agent-prompt.ts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readAgentPrompt } from "./tools/lib/pi-spawn";
import { interpolatePromptVars } from "./tools/lib/interpolate";
import {
	buildSubAgentPrompt,
	parseToolList,
	SUB_AGENT_TOOLS_ENV,
} from "./tools/lib/sub-agent-prompt";

/** harness configuration. TODO: make this configurable via settings or env. */
const HARNESS = "pi";
const IDENTITY = "Amp";

export default function (pi: ExtensionAPI) {
	const body = readAgentPrompt("prompt.amp.system.md");
	if (!body) return;

	// load harness docs based on harness name
	const harnessDocs = readAgentPrompt(`prompt.harness-docs.${HARNESS}.md`) || "";

	pi.on("before_agent_start", async (event, ctx) => {
		/*
		 * SUB-AGENT PATH.
		 *
		 * piSpawn sets SUB_AGENT_TOOLS_ENV from the SAME array it turns into
		 * `--tools`, so the prompt can never name a tool this child lacks. each
		 * agent brings its own list — finder 4, oracle 8, code_review 8,
		 * librarian 7, delegate 12, chad 15, read_web_page/read_session 1 — and a
		 * grandchild (delegate spawning finder) gets its own, because every
		 * piSpawn call sets the variable fresh for that spawn.
		 *
		 * the parent template is skipped entirely rather than patched with a
		 * correction line: a child reading "apply_patch — every file
		 * modification" and "your dedicated sub-agents are exactly six tools"
		 * has already been misled by the time any footnote arrives.
		 */
		const childTools = process.env[SUB_AGENT_TOOLS_ENV]?.trim();
		if (childTools && parseToolList(childTools).length > 0) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildSubAgentPrompt(IDENTITY, childTools)}`,
			};
		}

		// PARENT PATH — unchanged.
		const interpolated = interpolatePromptVars(body, ctx.cwd, {
			sessionId: ctx.sessionManager.getSessionId(),
			identity: IDENTITY,
			harness: HARNESS,
			harnessDocsSection: harnessDocs,
		});

		if (!interpolated.trim()) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + interpolated,
		};
	});
}
