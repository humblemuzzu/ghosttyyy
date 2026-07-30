/**
 * unit tests for the transcript builder — no pi deps, instant, free.
 *
 * run: bun test pi-setup/extensions/subagent-inspector/transcript.test.ts
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import { buildTranscript, stripAnsi } from "./transcript";

const msg = (m: unknown) => m as Message;

describe("stripAnsi", () => {
	it("removes SGR colour codes", () => {
		expect(stripAnsi("\u001B[38;2;215;153;33mThinking:\u001B[39m hello")).toBe("Thinking: hello");
	});

	it("removes OSC sequences terminated by BEL or ST", () => {
		expect(stripAnsi("\u001B]8;;https://x\u0007link")).toBe("link");
		expect(stripAnsi("\u001B]0;title\u001B\\rest")).toBe("rest");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain — text ✓")).toBe("plain — text ✓");
	});
});

describe("buildTranscript", () => {
	it("keeps thinking blocks, which the collapsed tree drops", () => {
		const nodes = buildTranscript([
			msg({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me check the loader" },
					{ type: "text", text: "answer" },
				],
			}),
		]);
		expect(nodes).toEqual([
			{ kind: "thinking", text: "let me check the loader" },
			{ kind: "text", text: "answer" },
		]);
	});

	it("strips the pre-coloured Thinking: label written into stored content", () => {
		const nodes = buildTranscript([
			msg({
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "\u001B[38;2;215;153;33mThinking:\u001B[39m \u001B[38;2;168;153;132mreal content",
					},
				],
			}),
		]);
		expect(nodes).toEqual([{ kind: "thinking", text: "real content" }]);
	});

	it("emits tool calls with their arguments", () => {
		const nodes = buildTranscript([
			msg({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "t1", name: "read", arguments: { file_path: "/a/b.ts" } },
				],
			}),
		]);
		expect(nodes).toEqual([
			{ kind: "toolCall", id: "t1", name: "read", args: { file_path: "/a/b.ts" }, isError: undefined },
		]);
	});

	it("back-fills each tool call's outcome from its later result", () => {
		const messages = [
			msg({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "ok", name: "read", arguments: {} },
					{ type: "toolCall", id: "bad", name: "bash", arguments: {} },
					{ type: "toolCall", id: "pending", name: "grep", arguments: {} },
				],
			}),
			msg({ role: "toolResult", toolCallId: "ok", toolName: "read", isError: false, content: [] }),
			msg({ role: "toolResult", toolCallId: "bad", toolName: "bash", isError: true, content: [] }),
		];
		const calls = buildTranscript(messages).filter((n) => n.kind === "toolCall");
		expect(calls.map((c) => (c as { isError?: boolean }).isError)).toEqual([false, true, undefined]);
	});

	it("omits tool results unless asked", () => {
		const messages = [
			msg({
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "file body" }],
			}),
		];
		expect(buildTranscript(messages)).toEqual([]);
		expect(buildTranscript(messages, { includeToolResults: true })).toEqual([
			{ kind: "toolResult", id: "t1", name: "read", text: "file body", isError: false },
		]);
	});

	it("joins multi-block tool result text", () => {
		const nodes = buildTranscript(
			[
				msg({
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					isError: false,
					content: [
						{ type: "text", text: "line one" },
						{ type: "text", text: "line two" },
					],
				}),
			],
			{ includeToolResults: true },
		);
		expect((nodes[0] as { text: string }).text).toBe("line one\nline two");
	});

	it("includes user messages and preserves order", () => {
		const nodes = buildTranscript([
			msg({ role: "user", content: [{ type: "text", text: "the task" }] }),
			msg({ role: "assistant", content: [{ type: "text", text: "the answer" }] }),
		]);
		expect(nodes.map((n) => n.kind)).toEqual(["user", "text"]);
	});

	it("skips empty and whitespace-only blocks", () => {
		const nodes = buildTranscript([
			msg({
				role: "assistant",
				content: [
					{ type: "text", text: "   " },
					{ type: "thinking", thinking: "" },
					{ type: "text", text: "kept" },
				],
			}),
		]);
		expect(nodes).toEqual([{ kind: "text", text: "kept" }]);
	});

	it("tolerates malformed messages", () => {
		expect(() =>
			buildTranscript([
				msg({ role: "assistant" }),
				msg({ role: "assistant", content: "not an array" }),
				msg({ role: "assistant", content: [null, 42, { type: "unknown" }] }),
				msg({ role: "assistant", content: [{ type: "toolCall", arguments: "nope" }] }),
			]),
		).not.toThrow();

		const nodes = buildTranscript([
			msg({ role: "assistant", content: [{ type: "toolCall", arguments: "nope" }] }),
		]);
		expect(nodes).toEqual([{ kind: "toolCall", id: "", name: "tool", args: {}, isError: undefined }]);
	});

	it("returns nothing for an empty transcript", () => {
		expect(buildTranscript([])).toEqual([]);
	});
});
