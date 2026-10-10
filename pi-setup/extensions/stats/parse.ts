import path from "node:path";

/**
 * One session file reduced to day-keyed buckets; any date range is a filter
 * on the key prefix.
 *
 * Counting rules:
 * - main-session spend comes from assistant `usage`;
 * - sub-agent spend comes from the parent toolResult `details.usage`, which
 *   matches the child's own session file and also covers agents that never
 *   persist one; nested runs inside `details.messages` are separate runs;
 * - a fork copies its parent's entries with their original timestamps, so
 *   entries older than the fork header are skipped while the parent exists.
 */

export const U = {
	turns: 0,
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	reasoning: 5,
	cost: 6,
	costInput: 7,
	costOutput: 8,
	costCacheRead: 9,
	costCacheWrite: 10,
	durationMs: 11,
	timedOutput: 12,
	errors: 13,
	aborted: 14,
	busts: 15,
	bustCost: 16,
	idleBusts: 17,
} as const;
export const U_LEN = 18;

export const A = { runs: 0, cost: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, turns: 6, failures: 7, durationMs: 8 } as const;
export const A_LEN = 9;

export const T = { calls: 0, errors: 1, durationMs: 2, timed: 3 } as const;
export const T_LEN = 4;

export const AGENT_TOOLS = new Set(["Task", "delegate", "chad", "oracle", "finder", "code_review", "librarian"]);

const IDLE_GAP_MS = 10 * 60_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_TTL_1H_MS = 60 * 60_000;
const BUST_MIN_CONTEXT = 20_000;
const UNKNOWN_MODEL = "unknown/unknown";

interface PrevTurn {
	ms: number;
	context: number;
	model: string;
	ttlMs: number;
}

export interface ParseState {
	model?: string;
	/** Model of the latest assistant turn: the caller of the tool results that follow it. */
	lastModel?: string;
	thinking?: string;
	lastMs?: number;
	prevTurn?: PrevTurn;
	afterCompaction?: boolean;
	headerSeen?: boolean;
}

export type BustEvent = [ms: number, model: string, context: number, cacheWriteCost: number, gapMs: number, idle: boolean];
export type Compaction = [ms: number, tokensBefore: number, model: string];

export interface FileRecord {
	path: string;
	size: number;
	mtimeMs: number;
	offset: number;
	id: string;
	cwd: string;
	name?: string;
	/** First line of the first prompt, for sessions that never got a name. */
	title?: string;
	startMs: number;
	/** Entries before this instant are copies of the fork's parent. */
	skipBeforeMs?: number;
	state: ParseState;
	usage: Record<string, number[]>;
	/** `day\thour\tprovider` → [turns, cost]. */
	hours: Record<string, number[]>;
	/** `day\tscope\tprovider\ttool`; agent-scope keys have no provider. */
	tools: Record<string, number[]>;
	agents: Record<string, number[]>;
	prompts: Record<string, number[]>;
	/** bash, edits and fanout are keyed `day\tprovider\tvalue`. */
	bash: Record<string, number>;
	edits: Record<string, number>;
	fanout: Record<string, number>;
	compactions: Compaction[];
	/** `day\tmodel` → context size (input + cache read + cache write) of each main turn. */
	contexts: Record<string, number[]>;
	busts: BustEvent[];
	goals: Record<string, [string, number, number]>;
	spans: Array<[number, number]>;
}

export function emptyRecord(filePath: string): FileRecord {
	return {
		path: filePath,
		size: 0,
		mtimeMs: 0,
		offset: 0,
		id: "",
		cwd: "",
		startMs: 0,
		state: {},
		usage: {},
		hours: {},
		tools: {},
		agents: {},
		prompts: {},
		bash: {},
		edits: {},
		fanout: {},
		compactions: [],
		contexts: {},
		busts: [],
		goals: {},
		spans: [],
	};
}

export function dayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function num(v: unknown): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
	return Number.isFinite(n) ? n : 0;
}

function msOf(entry: any): number {
	const t = entry?.timestamp;
	const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
	return Number.isFinite(ms) ? ms : NaN;
}

function bump(map: Record<string, number[]>, key: string, len: number, values: Array<[number, number]>): void {
	let row = map[key];
	if (!row) {
		row = new Array(len).fill(0);
		map[key] = row;
	}
	for (const [i, v] of values) row[i] += v;
}

function count(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

const WRAPPERS = new Set(["sudo", "time", "env", "command", "exec", "nohup", "caffeinate", "do", "then", "else", "{", "("]);
const SKIP_SEGMENTS = new Set([
	"cd", "export", "source", "set", "pushd", "popd", "true", ":", "echo", "printf",
	"for", "while", "until", "if", "elif", "case", "done", "fi", "esac", "}", ")",
]);
const WITH_SUBCOMMAND = new Set([
	"git", "bun", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "docker", "gh", "brew",
	"uv", "pip", "make", "kubectl", "wrangler", "flutter", "dart", "swift", "xcodebuild", "pi",
]);

/** "cd x && FOO=1 bun test --watch | tee" → "bun test". */
export function commandWord(cmd: string): string | undefined {
	for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
		const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
		while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || WRAPPERS.has(tokens[0]))) tokens.shift();
		if (!tokens.length) continue;
		const word = path.basename(tokens[0]);
		if (!word || SKIP_SEGMENTS.has(word)) continue;
		const sub = tokens[1];
		if (WITH_SUBCOMMAND.has(word) && sub && /^[a-z][\w:.-]*$/.test(sub)) return `${word} ${sub}`;
		return word;
	}
	return undefined;
}

export function editedPaths(tool: string, args: any): string[] {
	if (!args || typeof args !== "object") return [];
	if (tool === "apply_patch") {
		const out: string[] = [];
		if (typeof args.path === "string") out.push(args.path);
		if (Array.isArray(args.ops)) for (const op of args.ops) if (typeof op?.path === "string") out.push(op.path);
		if (typeof args.input === "string") {
			for (const m of args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
		}
		return out;
	}
	if (tool === "edit" || tool === "write" || tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
		const p = args.path ?? args.file_path;
		return typeof p === "string" ? [p] : [];
	}
	return [];
}

/** A bare model id, without the provider prefix sub-agent configs carry. */
export function agentModel(model: unknown): string {
	if (typeof model !== "string" || !model) return "unknown";
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

export function providerOf(model: string): string {
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(0, slash);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function touch(rec: FileRecord, ms: number): void {
	const last = rec.state.lastMs;
	const spans = rec.spans;
	const open = spans[spans.length - 1];
	if (open && last !== undefined && ms - last <= IDLE_GAP_MS && ms >= open[0]) {
		open[1] = Math.max(open[1], ms);
	} else {
		spans.push([ms, ms]);
	}
	rec.state.lastMs = Math.max(last ?? ms, ms);
}

function addAgentRun(rec: FileRecord, day: string, agent: string, details: any, failed: boolean, durationMs: number, runs = 1): void {
	const u = details.usage ?? {};
	bump(rec.agents, `${day}\t${agent}\t${agentModel(details.model)}`, A_LEN, [
		[A.runs, runs],
		[A.cost, num(u.cost ?? details.cost)],
		[A.input, num(u.input)],
		[A.output, num(u.output)],
		[A.cacheRead, num(u.cacheRead)],
		[A.cacheWrite, num(u.cacheWrite)],
		[A.turns, num(u.turns)],
		[A.failures, failed ? 1 : 0],
		[A.durationMs, durationMs],
	]);
}

function isAgentDetails(details: any): boolean {
	return !!details && typeof details === "object" && !!details.usage && ("agent" in details || "exitCode" in details);
}

function agentFailed(msg: any, details: any): boolean {
	return !!msg.isError || (typeof details.exitCode === "number" && details.exitCode !== 0) || details.stopReason === "error" || details.stopReason === "aborted";
}

/** A child transcript inside `details.messages`: its tool calls count as agent tool use, its sub-agents as runs. */
function walkChild(rec: FileRecord, day: string, messages: unknown[], depth: number): void {
	if (depth > 4) return;
	for (const cm of messages as any[]) {
		if (cm?.role !== "toolResult" || typeof cm.toolName !== "string") continue;
		const dur = num(cm.durationMs);
		bump(rec.tools, `${day}\tagent\t\t${cm.toolName}`, T_LEN, [
			[T.calls, 1],
			[T.errors, cm.isError ? 1 : 0],
			[T.durationMs, dur],
			[T.timed, dur > 0 ? 1 : 0],
		]);
		const d = cm.details;
		if (isAgentDetails(d)) {
			addAgentRun(rec, day, cm.toolName, d, agentFailed(cm, d), dur);
			if (Array.isArray(d.messages)) walkChild(rec, day, d.messages, depth + 1);
		}
	}
}

function onAssistant(rec: FileRecord, msg: any, ms: number, counted: boolean): void {
	const st = rec.state;
	const model = msg.model ? `${msg.provider ?? st.model?.split("/")[0] ?? "unknown"}/${msg.model}` : (st.model ?? UNKNOWN_MODEL);
	const provider = providerOf(model);
	const u = msg.usage ?? {};
	const input = num(u.input);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const context = input + cacheRead + cacheWrite;
	const prev = st.prevTurn;

	const bust =
		!!prev &&
		!st.afterCompaction &&
		prev.model === model &&
		prev.context >= BUST_MIN_CONTEXT &&
		context > 0 &&
		cacheWrite >= 0.5 * context &&
		cacheRead < 0.5 * prev.context;
	const idle = bust && ms - prev!.ms > prev!.ttlMs;

	if (context > 0) st.prevTurn = { ms, context, model, ttlMs: num(u.cacheWrite1h) > 0 ? CACHE_TTL_1H_MS : CACHE_TTL_MS };
	st.afterCompaction = false;
	st.lastModel = model;
	if (!counted) return;

	const day = dayKey(ms);
	const cost = u.cost;
	const total = typeof cost === "object" && cost ? num(cost.total) : num(cost);
	const duration = num(msg.durationMs);
	const output = num(u.output);
	const thinking = msg.thinkingLevel ?? st.thinking ?? "unknown";
	bump(rec.usage, `${day}\t${model}\t${thinking}`, U_LEN, [
		[U.turns, 1],
		[U.input, input],
		[U.output, output],
		[U.cacheRead, cacheRead],
		[U.cacheWrite, cacheWrite],
		[U.reasoning, num(u.reasoning)],
		[U.cost, total],
		[U.costInput, num(cost?.input)],
		[U.costOutput, num(cost?.output)],
		[U.costCacheRead, num(cost?.cacheRead)],
		[U.costCacheWrite, num(cost?.cacheWrite)],
		[U.durationMs, duration],
		[U.timedOutput, duration > 0 ? output : 0],
		[U.errors, msg.stopReason === "error" ? 1 : 0],
		[U.aborted, msg.stopReason === "aborted" ? 1 : 0],
		[U.busts, bust ? 1 : 0],
		[U.bustCost, bust ? num(cost?.cacheWrite) : 0],
		[U.idleBusts, idle ? 1 : 0],
	]);
	if (context > 0) (rec.contexts[`${day}\t${model}`] ??= []).push(context);
	if (bust) rec.busts.push([ms, model, context, num(cost?.cacheWrite), ms - prev!.ms, idle]);
	bump(rec.hours, `${day}\t${new Date(ms).getHours()}\t${provider}`, 2, [
		[0, 1],
		[1, total],
	]);

	let agents = 0;
	if (Array.isArray(msg.content)) {
		for (const c of msg.content) {
			if (c?.type !== "toolCall" || typeof c.name !== "string") continue;
			if (AGENT_TOOLS.has(c.name)) agents++;
			if (c.name === "bash") {
				const word = commandWord(String(c.arguments?.cmd ?? c.arguments?.command ?? ""));
				if (word) count(rec.bash, `${day}\t${provider}\t${word}`);
			}
			for (const p of editedPaths(c.name, c.arguments)) {
				count(rec.edits, `${day}\t${provider}\t${path.isAbsolute(p) ? p : path.join(rec.cwd, p)}`);
			}
		}
	}
	if (agents > 0) count(rec.fanout, `${day}\t${provider}\t${agents}`);
	touch(rec, ms);
}

function onToolResult(rec: FileRecord, msg: any, ms: number): void {
	const day = dayKey(ms);
	const tool = typeof msg.toolName === "string" ? msg.toolName : "unknown";
	const dur = num(msg.durationMs);
	bump(rec.tools, `${day}\tmain\t${providerOf(rec.state.lastModel ?? rec.state.model ?? UNKNOWN_MODEL)}\t${tool}`, T_LEN, [
		[T.calls, 1],
		[T.errors, msg.isError ? 1 : 0],
		[T.durationMs, dur],
		[T.timed, dur > 0 ? 1 : 0],
	]);
	const d = msg.details;
	if (isAgentDetails(d)) {
		addAgentRun(rec, day, tool, d, agentFailed(msg, d), dur);
		if (Array.isArray(d.messages)) walkChild(rec, day, d.messages, 1);
	} else if (msg.usage && typeof msg.usage === "object") {
		addAgentRun(rec, day, tool, { usage: { ...msg.usage, cost: msg.usage.cost?.total ?? msg.usage.cost } }, false, 0, 0);
	}
	touch(rec, ms);
}

/**
 * Feed one JSONL line. `parentExists` decides whether a fork's copied
 * prefix is a duplicate (parent still on disk) or the only surviving copy.
 */
export function ingestLine(rec: FileRecord, line: string, parentExists: (p: string) => boolean): void {
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry || typeof entry !== "object") return;
	const st = rec.state;

	if (entry.type === "session") {
		if (st.headerSeen) return;
		st.headerSeen = true;
		rec.id = String(entry.id ?? "");
		rec.cwd = String(entry.cwd ?? "");
		rec.startMs = msOf(entry) || 0;
		if (typeof entry.parentSession === "string" && parentExists(entry.parentSession)) rec.skipBeforeMs = rec.startMs;
		return;
	}

	const ms = msOf(entry);
	if (!Number.isFinite(ms)) return;
	const counted = rec.skipBeforeMs === undefined || ms >= rec.skipBeforeMs;

	switch (entry.type) {
		case "model_change":
			if (entry.provider && entry.modelId) st.model = `${entry.provider}/${entry.modelId}`;
			return;
		case "thinking_level_change":
			if (typeof entry.thinkingLevel === "string") st.thinking = entry.thinkingLevel;
			return;
		case "session_info":
			if (typeof entry.name === "string" && entry.name.trim()) rec.name = entry.name.trim();
			return;
		case "compaction":
			st.afterCompaction = true;
			if (counted) rec.compactions.push([ms, num(entry.tokensBefore), st.lastModel ?? st.model ?? UNKNOWN_MODEL]);
			return;
		case "custom": {
			const goal = entry.customType === "pi-codex-goal" ? entry.data?.goal : undefined;
			if (counted && goal?.goalId) rec.goals[goal.goalId] = [String(goal.status ?? "active"), num(goal.usage?.activeSeconds), ms];
			return;
		}
		case "message":
			break;
		default:
			return;
	}

	const msg = entry.message;
	if (!msg || typeof msg !== "object") return;
	if (msg.role === "assistant") {
		onAssistant(rec, msg, ms, counted);
	} else if (!counted) {
		return;
	} else if (msg.role === "toolResult") {
		onToolResult(rec, msg, ms);
	} else if (msg.role === "user") {
		const text = messageText(msg.content);
		bump(rec.prompts, dayKey(ms), 2, [
			[0, 1],
			[1, text.length],
		]);
		if (!rec.title) rec.title = text.trim().split("\n")[0]?.slice(0, 120) || undefined;
		touch(rec, ms);
	}
}
