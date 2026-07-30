/**
 * registry of sub-agent runs observed in the current session.
 *
 * WHY EVENTS AND NOT A SHARED MODULE
 * pi loads every extension file with its own jiti instance and
 * `moduleCache: false` (dist/core/extensions/loader.js). a module-level Map
 * in tools/lib/ is therefore NOT the same Map when imported from another
 * extension — it would silently read empty, with no error. the
 * `tool_execution_*` events cross that boundary and carry the tool's full
 * `details` payload, so they are the only correct source here.
 *
 * pure and side-effect free: no pi imports, no TUI, unit-testable.
 */

import { resolveParam } from "../tools/lib/params";
import type { AgentEntry, AgentStatus, AgentUsage } from "./types";

/** tools whose runs are worth inspecting. anything else is ignored. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set([
	"oracle",
	"finder",
	"librarian",
	"code_review",
	"delegate",
]);

/**
 * label candidates in priority order.
 *
 * each sub-agent tool names its main argument differently (see
 * tools/lib/params.ts). `description` comes first because delegate sets it
 * as an explicit short title; the rest are the canonical names of the
 * other four tools.
 */
const LABEL_PARAMS = [
	"description",
	"task",
	"query",
	"prompt",
	"diff_description",
	"question",
	"instructions",
] as const;

/** retain at most this many runs, oldest evicted first. */
export const MAX_ENTRIES = 50;

const MAX_LABEL_LENGTH = 120;

export function deriveLabel(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const raw = resolveParam(args as Record<string, unknown>, LABEL_PARAMS);
	if (!raw) return "";
	const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
	const trimmed = firstLine.trim();
	return trimmed.length > MAX_LABEL_LENGTH
		? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`
		: trimmed;
}

/** the `details` object our sub-agent tools attach to every result. */
interface SubAgentDetails {
	messages?: unknown;
	usage?: unknown;
	model?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	exitCode?: unknown;
}

function extractDetails(payload: unknown): SubAgentDetails | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const details = (payload as { details?: unknown }).details;
	if (details === null || typeof details !== "object") return undefined;
	return details as SubAgentDetails;
}

function asUsage(value: unknown): AgentUsage | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const u = value as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		cost: num(u.cost),
		contextTokens: typeof u.contextTokens === "number" ? u.contextTokens : undefined,
		turns: typeof u.turns === "number" ? u.turns : undefined,
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** copy details onto an entry. never overwrites a known value with undefined. */
function applyDetails(entry: AgentEntry, details: SubAgentDetails | undefined): void {
	if (!details) return;
	if (Array.isArray(details.messages)) entry.messages = details.messages as AgentEntry["messages"];
	const usage = asUsage(details.usage);
	if (usage) entry.usage = usage;
	entry.model = asString(details.model) ?? entry.model;
	entry.stopReason = asString(details.stopReason) ?? entry.stopReason;
	entry.errorMessage = asString(details.errorMessage) ?? entry.errorMessage;
}

function finalStatus(details: SubAgentDetails | undefined, isError: boolean): AgentStatus {
	if (isError) return "error";
	const stop = asString(details?.stopReason);
	if (stop === "error" || stop === "aborted") return "error";
	if (typeof details?.exitCode === "number" && details.exitCode > 0) return "error";
	return "done";
}

export interface StartEventLike {
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface UpdateEventLike {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
}

export interface EndEventLike {
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
}

/**
 * tracks sub-agent runs for the current session, in start order.
 *
 * `onChange` fires on every mutation so the UI can request a re-render;
 * it is intentionally a plain callback rather than an event emitter to
 * keep this module free of runtime dependencies.
 */
export class AgentRegistry {
	private readonly entries = new Map<string, AgentEntry>();

	onChange?: () => void;

	/** clock injection keeps tests deterministic. */
	constructor(private readonly now: () => number = Date.now) {}

	static tracks(toolName: string): boolean {
		return AGENT_TOOLS.has(toolName);
	}

	handleStart(event: StartEventLike): void {
		if (!AgentRegistry.tracks(event.toolName)) return;
		this.entries.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			label: deriveLabel(event.args),
			status: "running",
			startedAt: this.now(),
			messages: [],
		});
		this.evict();
		this.onChange?.();
	}

	handleUpdate(event: UpdateEventLike): void {
		if (!AgentRegistry.tracks(event.toolName)) return;
		const entry = this.entries.get(event.toolCallId) ?? this.adopt(event);
		applyDetails(entry, extractDetails(event.partialResult));
		this.onChange?.();
	}

	handleEnd(event: EndEventLike): void {
		if (!AgentRegistry.tracks(event.toolName)) return;
		const entry = this.entries.get(event.toolCallId) ?? this.adopt(event);
		const details = extractDetails(event.result);
		applyDetails(entry, details);
		entry.status = finalStatus(details, event.isError === true);
		entry.endedAt = this.now();
		this.onChange?.();
	}

	/** runs in start order, oldest first. */
	list(): AgentEntry[] {
		return [...this.entries.values()];
	}

	get(toolCallId: string): AgentEntry | undefined {
		return this.entries.get(toolCallId);
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * an update or end without a preceding start (extension loaded mid-run,
	 * or an evicted entry) still deserves a row rather than being dropped.
	 */
	private adopt(event: { toolCallId: string; toolName: string; args?: unknown }): AgentEntry {
		const entry: AgentEntry = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			label: deriveLabel(event.args),
			status: "running",
			startedAt: this.now(),
			messages: [],
		};
		this.entries.set(event.toolCallId, entry);
		this.evict();
		return entry;
	}

	private evict(): void {
		while (this.entries.size > MAX_ENTRIES) {
			const oldest = this.entries.keys().next();
			if (oldest.done) return;
			this.entries.delete(oldest.value);
		}
	}
}
