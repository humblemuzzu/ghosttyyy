/**
 * turns a sub-agent's message list into a flat, renderable transcript.
 *
 * this is the difference between the inspector and the collapsed tool tree:
 * `getDisplayItems()` in tools/lib/sub-agent-render.ts deliberately drops
 * thinking blocks and tool results because they would bury the summary.
 * inside the inspector we want exactly those.
 *
 * pure: structure only, no colours, no widths, no pi imports. presentation
 * lives in inspector.ts.
 */

import type { Message } from "@mariozechner/pi-ai";

export type TranscriptNode =
	| { kind: "user"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "toolCall"; id: string; name: string; args: Record<string, unknown>; isError?: boolean }
	| { kind: "toolResult"; id: string; name: string; text: string; isError: boolean };

/**
 * CSI/OSC escape remover.
 *
 * stored thinking blocks arrive pre-coloured — pi-tool-display writes a
 * literal "\x1b[38;2;…mThinking:\x1b[39m " prefix into the content. leaving
 * those codes in place would (a) fight the inspector's own theme colours,
 * whose resets the embedded codes cancel, and (b) make wrapping depend on
 * ANSI-aware width at every call site. stripping once here keeps the rest
 * of the pipeline plain text.
 */
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** the label pi-tool-display prepends to thinking content, once decoloured. */
const THINKING_LABEL = /^thinking:\s*/i;

function cleanText(value: unknown): string {
	return typeof value === "string" ? stripAnsi(value) : "";
}

function contentBlocks(message: Message): Record<string, unknown>[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is Record<string, unknown> => block !== null && typeof block === "object",
	);
}

/**
 * map toolCallId -> isError, so a tool call can be shown with its outcome
 * even though that outcome arrives in a later message.
 */
function buildErrorMap(messages: Message[]): Map<string, boolean> {
	const map = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const id = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof id === "string") map.set(id, (message as { isError?: unknown }).isError === true);
	}
	return map;
}

export interface BuildTranscriptOptions {
	/** include tool result bodies. they dominate the transcript when on. */
	includeToolResults?: boolean;
}

export function buildTranscript(
	messages: Message[],
	options: BuildTranscriptOptions = {},
): TranscriptNode[] {
	const errorMap = buildErrorMap(messages);
	const nodes: TranscriptNode[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			for (const block of contentBlocks(message)) {
				if (block.type !== "text") continue;
				const text = cleanText(block.text);
				if (text.trim()) nodes.push({ kind: "user", text });
			}
			continue;
		}

		if (message.role === "assistant") {
			for (const block of contentBlocks(message)) {
				if (block.type === "thinking") {
					const text = cleanText(block.thinking).replace(THINKING_LABEL, "");
					if (text.trim()) nodes.push({ kind: "thinking", text });
				} else if (block.type === "text") {
					const text = cleanText(block.text);
					if (text.trim()) nodes.push({ kind: "text", text });
				} else if (block.type === "toolCall") {
					const id = typeof block.id === "string" ? block.id : "";
					const args =
						block.arguments !== null && typeof block.arguments === "object"
							? (block.arguments as Record<string, unknown>)
							: {};
					nodes.push({
						kind: "toolCall",
						id,
						name: typeof block.name === "string" ? block.name : "tool",
						args,
						isError: errorMap.get(id),
					});
				}
			}
			continue;
		}

		if (message.role === "toolResult" && options.includeToolResults) {
			const id = (message as { toolCallId?: unknown }).toolCallId;
			const text = contentBlocks(message)
				.filter((block) => block.type === "text")
				.map((block) => cleanText(block.text))
				.join("\n");
			if (text.trim()) {
				nodes.push({
					kind: "toolResult",
					id: typeof id === "string" ? id : "",
					name: String((message as { toolName?: unknown }).toolName ?? "tool"),
					text,
					isError: (message as { isError?: unknown }).isError === true,
				});
			}
		}
	}

	return nodes;
}
