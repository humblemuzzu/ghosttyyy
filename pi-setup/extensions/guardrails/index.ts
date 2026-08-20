/**
 * guardrails — keeps the behaviour rules in force for a whole session.
 *
 * Two mechanisms, because rules in a file are not enough:
 *
 *   INJECT  agents/rules.amp.md is appended before EVERY model call, not once
 *           at the top of the session. A system prompt measurably stops
 *           governing behaviour after roughly eight turns, and long coding
 *           sessions run far past that. Re-sending the rules costs ~150 tokens
 *           a turn and is the only thing that survives the drift.
 *   REFUSE  an apply_patch call that is mostly commentary is blocked outright,
 *           with the reason handed back as a tool error. Prompt wording has
 *           been reported to lose to the model's comment habit even when the
 *           rule is mandatory, so the one rule we can enforce mechanically is
 *           not left to persuasion.
 *
 * Both are off with PI_GUARDRAILS_OFF=1.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readAgentPrompt } from "../tools/lib/pi-spawn";
import { DEFAULT_THRESHOLDS, judge, type Thresholds } from "./comment-gate";

const CUSTOM_TYPE = "guardrails:rules";
const GATED_TOOL = "apply_patch";

function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function thresholds(): Thresholds {
	return {
		maxRun: envNum("PI_GUARDRAILS_MAX_COMMENT_RUN", DEFAULT_THRESHOLDS.maxRun),
		maxRatio: envNum("PI_GUARDRAILS_MAX_COMMENT_RATIO", DEFAULT_THRESHOLDS.maxRatio),
		minComments: envNum("PI_GUARDRAILS_MIN_COMMENTS", DEFAULT_THRESHOLDS.minComments),
	};
}

function resolveRules(): string {
	return readAgentPrompt("rules.amp.md").trim();
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
	if (process.env.PI_GUARDRAILS_OFF === "1") return;

	pi.on("context", async (event) => {
		/*
		 * Previous injections are stripped before the current one is added.
		 * The handler receives a deep copy of the whole conversation, so
		 * without this the block accumulates once per turn.
		 */
		const messages = event.messages.filter(
			(message: { customType?: string }) => message.customType !== CUSTOM_TYPE,
		);

		// Read per call, not once at load: a boot-time constant means every rules
		// edit needs a restart, and a stale block is indistinguishable from one
		// the model ignored.
		const rules = resolveRules();
		if (!rules) return { messages };

		return {
			messages: [
				...messages,
				{
					role: "custom",
					customType: CUSTOM_TYPE,
					content: rules,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== GATED_TOOL) return;

		/*
		 * Any failure here means the gate could not decide, and a gate that
		 * cannot decide must let the edit through. Blocking real work on a
		 * parser bug is how a guardrail gets switched off for good.
		 */
		try {
			const verdict = judge(event.input as Record<string, unknown>, thresholds());
			if (verdict.blocked) return { block: true, reason: verdict.reason };
		} catch {
			return;
		}
	});
}
