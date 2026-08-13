/**
 * the system prompt a SUB-AGENT gets, and the env var that carries its tool list.
 *
 * WHY THIS EXISTS
 *
 * a sub-agent is a fresh `pi` process that loads the SAME extensions as the
 * parent, so `system-prompt.ts` runs inside it too. until this module existed
 * that hook appended the parent's full tool prompt — 11,705 bytes describing
 * ~40 tools, measured — to a child whose registry had been filtered by
 * `--tools` down to between 1 and 12 tools.
 *
 * the child then read instructions that were false for it: "apply_patch —
 * every file modification", "your dedicated sub-agents are exactly six
 * tools". measured consequence: a code_review child spent two calls probing
 * `search_sessions` and `skill` before concluding they were absent.
 *
 * the fix is to hand the child the one thing neither pi's base prompt nor its
 * own agent prompt can know: which tools THIS child was actually given.
 * `piSpawn` already computes that list to build `--tools`, so the prompt and
 * the registry are fed by the same array and cannot disagree.
 *
 * this lives in lib/ rather than inline in system-prompt.ts for two reasons:
 * the writer (pi-spawn) and the reader (system-prompt) share ONE env-var name
 * instead of two string literals that can drift, and the prompt builder stays
 * a pure function the test suite can pin.
 */

/**
 * env var `piSpawn` sets on a child, carrying its merged `--tools` allowlist.
 *
 * absent in a normal (parent) session, which is exactly how system-prompt.ts
 * tells the two apart. if it is ever missing on a child, that child simply
 * gets the old behaviour — the failure mode is the previous status quo, not a
 * broken session.
 */
export const SUB_AGENT_TOOLS_ENV = "PI_SUBAGENT_TOOLS";

/** split the env value into tool names, dropping blanks and stray whitespace. */
export function parseToolList(csv: string): string[] {
	return csv
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
}

/**
 * build the sub-agent system prompt.
 *
 * deliberately short. the child already receives pi's base prompt, and then
 * its own agent prompt (`agent.amp.finder.md` and friends) via
 * `--append-system-prompt`. this block adds only what those cannot carry:
 *
 *   - the tools this particular child holds, named exactly
 *   - the working rules, because `delegate` is the one sub-agent with no agent
 *     prompt of its own and would otherwise lose them
 */
export function buildSubAgentPrompt(identity: string, toolCsv: string): string {
	const tools = parseToolList(toolCsv);
	// grammar matters here: read_web_page and read_session children get exactly
	// one tool, and "These 1 are the only tools" reads like a bug.
	const countLine =
		tools.length === 1
			? "That is the only tool registered in this session. Nothing else exists"
			: `Those ${tools.length} are the only tools registered in this session. Nothing else exists`;

	return [
		`# ${identity} — sub-agent`,
		"",
		"You are a sub-agent spawned by the main agent to complete one task. You share",
		"none of its conversation context — your task message is everything you know",
		"about the goal.",
		"",
		"## Your tools in this session",
		"",
		...tools.map((tool) => `- \`${tool}\``),
		"",
		countLine,
		"here — do not attempt to call any other tool, the call will fail.",
		"",
		"## How to work",
		"",
		"- **Read first.** Open the relevant files before changing or concluding anything.",
		"- **Verify.** After an edit: imports resolve, signatures match callers, tests pass.",
		"- **Match the surrounding style** — naming, indentation, error handling.",
		"- **Fix root causes, not symptoms.** Explicit over clever, readable over terse.",
		"- Your final message is the entire answer returned to the main agent — make it",
		"  self-contained.",
	].join("\n");
}
