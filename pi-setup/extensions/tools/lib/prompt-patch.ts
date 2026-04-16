/**
 * prompt-patch — derives promptSnippet and promptGuidelines from tool descriptions.
 *
 * tools don't need to define promptSnippet/promptGuidelines manually.
 * snippet = first paragraph, guidelines = lines starting with "- ".
 *
 * ported from @bds_pi/prompt-patch by bdsqqq.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export function withPromptPatch(tool: ToolDefinition): ToolDefinition {
	const snippet = (tool.description?.split("\n\n")[0] ?? "").trim();
	const guidelines = (tool.description ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "));

	const patched: ToolDefinition = { ...tool };
	if (!patched.promptSnippet) patched.promptSnippet = snippet;
	if (!patched.promptGuidelines && guidelines.length > 0) {
		patched.promptGuidelines = guidelines;
	}

	return patched;
}
