/**
 * unit tests for AgentRegistry — no pi deps, instant, free.
 *
 * run: bun test pi-setup/extensions/subagent-inspector/registry.test.ts
 */

import { describe, expect, it } from "bun:test";
import { AgentRegistry, deriveLabel, MAX_ENTRIES } from "./registry";

function details(payload: Record<string, unknown>) {
	return { content: [{ type: "text", text: "" }], details: payload };
}

function fixedClock(start = 1_000): () => number {
	let t = start;
	return () => (t += 1000);
}

describe("deriveLabel", () => {
	it("prefers description over other params", () => {
		expect(deriveLabel({ description: "short title", task: "long task" })).toBe("short title");
	});

	it("falls back through each tool's canonical param", () => {
		expect(deriveLabel({ task: "oracle task" })).toBe("oracle task");
		expect(deriveLabel({ query: "finder query" })).toBe("finder query");
		expect(deriveLabel({ diff_description: "review this" })).toBe("review this");
		expect(deriveLabel({ prompt: "delegate prompt" })).toBe("delegate prompt");
	});

	it("uses the first non-empty line", () => {
		expect(deriveLabel({ task: "\n\n  real line  \nsecond" })).toBe("real line");
	});

	it("truncates very long labels", () => {
		const label = deriveLabel({ task: "x".repeat(500) });
		expect(label.length).toBe(120);
		expect(label.endsWith("…")).toBe(true);
	});

	it("survives missing or malformed args", () => {
		expect(deriveLabel(undefined)).toBe("");
		expect(deriveLabel(null)).toBe("");
		expect(deriveLabel("nope")).toBe("");
		expect(deriveLabel({})).toBe("");
		expect(deriveLabel({ task: "   " })).toBe("");
	});
});

describe("AgentRegistry", () => {
	it("tracks only sub-agent tools", () => {
		const registry = new AgentRegistry();
		registry.handleStart({ toolCallId: "a", toolName: "bash", args: { cmd: "ls" } });
		registry.handleStart({ toolCallId: "b", toolName: "oracle", args: { task: "think" } });
		expect(registry.size).toBe(1);
		expect(registry.list()[0].toolName).toBe("oracle");
	});

	it("records a running entry on start", () => {
		const registry = new AgentRegistry(fixedClock());
		registry.handleStart({ toolCallId: "a", toolName: "finder", args: { query: "where is X" } });
		const entry = registry.get("a");
		expect(entry?.status).toBe("running");
		expect(entry?.label).toBe("where is X");
		expect(entry?.messages).toEqual([]);
		expect(entry?.endedAt).toBeUndefined();
	});

	it("applies streamed details on update", () => {
		const registry = new AgentRegistry();
		registry.handleStart({ toolCallId: "a", toolName: "oracle", args: { task: "t" } });
		registry.handleUpdate({
			toolCallId: "a",
			toolName: "oracle",
			partialResult: details({
				messages: [{ role: "assistant", content: [] }],
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 },
				model: "claude-sonnet-5",
			}),
		});
		const entry = registry.get("a");
		expect(entry?.messages.length).toBe(1);
		expect(entry?.usage?.input).toBe(10);
		expect(entry?.usage?.cost).toBe(0.5);
		expect(entry?.model).toBe("claude-sonnet-5");
		expect(entry?.status).toBe("running");
	});

	it("never overwrites a known value with undefined", () => {
		const registry = new AgentRegistry();
		registry.handleStart({ toolCallId: "a", toolName: "oracle", args: {} });
		registry.handleUpdate({
			toolCallId: "a",
			toolName: "oracle",
			partialResult: details({ model: "m1", messages: [{ role: "user", content: [] }] }),
		});
		registry.handleUpdate({ toolCallId: "a", toolName: "oracle", partialResult: details({}) });
		expect(registry.get("a")?.model).toBe("m1");
		expect(registry.get("a")?.messages.length).toBe(1);
	});

	it("marks success on a clean end", () => {
		const registry = new AgentRegistry(fixedClock());
		registry.handleStart({ toolCallId: "a", toolName: "delegate", args: { prompt: "p" } });
		registry.handleEnd({
			toolCallId: "a",
			toolName: "delegate",
			result: details({ exitCode: 0, stopReason: "end_turn" }),
			isError: false,
		});
		const entry = registry.get("a");
		expect(entry?.status).toBe("done");
		expect(entry?.endedAt).toBeGreaterThan(entry!.startedAt);
	});

	it("marks error from the event flag, stop reason, or exit code", () => {
		const registry = new AgentRegistry();

		registry.handleStart({ toolCallId: "a", toolName: "oracle", args: {} });
		registry.handleEnd({ toolCallId: "a", toolName: "oracle", result: details({}), isError: true });
		expect(registry.get("a")?.status).toBe("error");

		registry.handleStart({ toolCallId: "b", toolName: "oracle", args: {} });
		registry.handleEnd({
			toolCallId: "b",
			toolName: "oracle",
			result: details({ stopReason: "aborted" }),
			isError: false,
		});
		expect(registry.get("b")?.status).toBe("error");

		registry.handleStart({ toolCallId: "c", toolName: "oracle", args: {} });
		registry.handleEnd({
			toolCallId: "c",
			toolName: "oracle",
			result: details({ exitCode: 1 }),
			isError: false,
		});
		expect(registry.get("c")?.status).toBe("error");
	});

	it("adopts an update with no preceding start", () => {
		const registry = new AgentRegistry();
		registry.handleUpdate({
			toolCallId: "orphan",
			toolName: "librarian",
			args: { query: "q" },
			partialResult: details({ messages: [] }),
		});
		expect(registry.get("orphan")?.status).toBe("running");
		expect(registry.get("orphan")?.toolName).toBe("librarian");
	});

	it("tolerates malformed payloads", () => {
		const registry = new AgentRegistry();
		registry.handleStart({ toolCallId: "a", toolName: "oracle", args: {} });
		expect(() => {
			registry.handleUpdate({ toolCallId: "a", toolName: "oracle", partialResult: undefined });
			registry.handleUpdate({ toolCallId: "a", toolName: "oracle", partialResult: "junk" });
			registry.handleUpdate({ toolCallId: "a", toolName: "oracle", partialResult: { details: null } });
			registry.handleUpdate({
				toolCallId: "a",
				toolName: "oracle",
				partialResult: details({ messages: "not an array", usage: 42 }),
			});
		}).not.toThrow();
		expect(registry.get("a")?.messages).toEqual([]);
	});

	it("preserves start order and evicts the oldest past the cap", () => {
		const registry = new AgentRegistry();
		for (let i = 0; i < MAX_ENTRIES + 5; i++) {
			registry.handleStart({ toolCallId: `id-${i}`, toolName: "finder", args: { query: `q${i}` } });
		}
		const list = registry.list();
		expect(list.length).toBe(MAX_ENTRIES);
		expect(list[0].toolCallId).toBe("id-5");
		expect(list[list.length - 1].toolCallId).toBe(`id-${MAX_ENTRIES + 4}`);
	});

	it("notifies on every mutation", () => {
		const registry = new AgentRegistry();
		let calls = 0;
		registry.onChange = () => {
			calls++;
		};
		registry.handleStart({ toolCallId: "a", toolName: "oracle", args: {} });
		registry.handleUpdate({ toolCallId: "a", toolName: "oracle", partialResult: details({}) });
		registry.handleEnd({ toolCallId: "a", toolName: "oracle", result: details({}), isError: false });
		registry.handleStart({ toolCallId: "b", toolName: "bash", args: {} }); // ignored
		expect(calls).toBe(3);
	});
});
