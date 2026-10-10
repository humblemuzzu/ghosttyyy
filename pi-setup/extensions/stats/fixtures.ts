import { emptyRecord, type FileRecord, ingestLine } from "./parse";

export const MIN = 60_000;

let seq = 0;
const id = () => (++seq).toString(16).padStart(8, "0");
const iso = (ms: number) => new Date(ms).toISOString();

export function header(sessionId: string, cwd: string, ms: number, parentSession?: string): string {
	return JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: iso(ms), cwd, ...(parentSession ? { parentSession } : {}) });
}

export function entry(type: string, ms: number, fields: Record<string, unknown>): string {
	return JSON.stringify({ type, id: id(), parentId: null, timestamp: iso(ms), ...fields });
}

export function user(ms: number, text: string): string {
	return entry("message", ms, { message: { role: "user", content: [{ type: "text", text }], timestamp: ms } });
}

export interface TurnSpec {
	model?: string;
	provider?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	costInput?: number;
	costCacheRead?: number;
	costCacheWrite?: number;
	durationMs?: number;
	stopReason?: string;
	thinkingLevel?: string;
	calls?: Array<{ name: string; arguments?: unknown }>;
}

export function assistant(ms: number, t: TurnSpec = {}): string {
	return entry("message", ms, {
		message: {
			role: "assistant",
			provider: t.provider ?? "anthropic",
			model: t.model ?? "claude-opus-5-5",
			stopReason: t.stopReason ?? "toolUse",
			thinkingLevel: t.thinkingLevel,
			durationMs: t.durationMs,
			timestamp: ms,
			content: (t.calls ?? []).map((c, i) => ({ type: "toolCall", id: `call${i}`, name: c.name, arguments: c.arguments ?? {} })),
			usage: {
				input: t.input ?? 0,
				output: t.output ?? 0,
				cacheRead: t.cacheRead ?? 0,
				cacheWrite: t.cacheWrite ?? 0,
				totalTokens: 0,
				cost: { input: t.costInput ?? 0, output: 0, cacheRead: t.costCacheRead ?? 0, cacheWrite: t.costCacheWrite ?? 0, total: t.cost ?? 0 },
			},
		},
	});
}

export function toolResult(ms: number, toolName: string, extra: Record<string, unknown> = {}): string {
	return entry("message", ms, { message: { role: "toolResult", toolCallId: "call0", toolName, content: [], isError: false, timestamp: ms, ...extra } });
}

export function agentDetails(agent: string, cost: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { agent, task: "t", exitCode: 0, messages: [], model: "deepseek/deepseek-flash", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, cost, turns: 4, contextTokens: 0 }, ...extra };
}

export function record(lines: string[], file = "/sessions/a.jsonl", parentExists = () => true): FileRecord {
	const rec = emptyRecord(file);
	for (const l of lines) ingestLine(rec, l, parentExists);
	return rec;
}
