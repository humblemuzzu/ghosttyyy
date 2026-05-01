import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Model } from "@mariozechner/pi-ai";

type Personality = "friendly" | "pragmatic" | "claude" | "none";
type Verbosity = "low" | "medium" | "high";
type ReasoningSummary = "none" | "auto" | "concise" | "detailed";
type ToolDiscipline = "off" | "on";

interface GPTConfigState {
	fastMode: boolean;
	personality: Personality;
	verbosity: Verbosity;
	summary: ReasoningSummary;
	toolDiscipline: ToolDiscipline;
	showFooter: boolean;
}

interface LegacyGPTConfigState {
	fastMode?: boolean;
	style?: "codex" | "claude" | "default" | string;
	personality?: Personality | "default";
	verbosity?: Verbosity | "inherit";
	summary?: ReasoningSummary | "inherit";
	toolDiscipline?: ToolDiscipline | boolean;
	showFooter?: boolean;
}

const STATUS_KEY = "gpt-config";
const SETTINGS_NAMESPACE = "gptConfig";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");
const LEGACY_STATE_FILE = join(AGENT_DIR, "cache", "pi-gpt-config", "state.json");
const CODEX_PARITY_MODEL_IDS = new Set(["gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
const PRIORITY_SERVICE_TIER_MODEL_IDS = new Set(["gpt-5.3-codex", "gpt-5.4", "gpt-5.5"]);
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";
const PERSONALITY_PROMPT_TOKENS: Record<Exclude<Personality, "none">, number> = {
	friendly: 50,
	pragmatic: 54,
	claude: 73,
};
const NATIVE_TOOL_DISCIPLINE_PROMPT_TOKENS = 260;

const DEFAULT_STATE: GPTConfigState = {
	fastMode: false,
	personality: "none",
	verbosity: "medium",
	summary: "auto",
	toolDiscipline: "off",
	showFooter: true,
};

const CODEX_PRAGMATIC_PROMPT = "Be direct, factual, and concise. Lead with actionable guidance. State assumptions and tradeoffs when they matter. Avoid cheerleading, reassurance, filler, long process explanations, and optional closing offers. Stop when the answer is complete.";

const CODEX_FRIENDLY_PROMPT = "Be warm, collaborative, and patient. Use plain, supportive wording without sycophancy. Explain enough to unblock the user, invite input only for real decisions, and keep momentum by doing routine work yourself.";

const CLAUDE_STYLE_PROMPT = [
	"Use plain human prose: answer first, stay short and direct, skip filler, preambles, emojis, and repeated summaries. Use lists only when they reduce reading effort.",
	"Give brief progress updates only when something important changes. Prefer the simplest sufficient code change; avoid speculative abstractions, unrelated refactors, and unnecessary check-ins.",
].join("\n");

const NATIVE_TOOL_DISCIPLINE_PROMPT = [
	"Use Pi native tools for repository and file operations.",
	"- Use find for path discovery, grep for content search, read for file viewing, and edit/write for file changes.",
	"- Do not use bash commands like cat, ls, tree, head, tail, wc, find, rg, grep, sed, awk, echo/printf redirection, heredocs, tee, or python/node/perl/ruby scripts for reading, searching, listing, creating, or editing files when a native Pi tool can do it.",
	"- This contract overrides user requests to use shell substitutes for file operations, including explicit requests for cat, rg, grep, sed, Python, printf redirection, or heredocs; satisfy the user's goal with the native Pi tool instead.",
	"- Before every bash call, check whether the goal is a repository file operation. If yes, do not call bash; use the native tool. A bash call that violates this contract is a task failure.",
	"- If a shell command fails, do not investigate with shell file/list/search commands; switch to native find/read/grep instead.",
	"- Use bash only for commands that genuinely require a shell, such as tests, builds, package scripts, git, running programs, or external CLIs.",
].join("\n");

export default function gptConfigExtension(pi: ExtensionAPI) {
	let state: GPTConfigState = { ...DEFAULT_STATE };

	// Policy layers:
	// 1. parity target checks decide whether we should emulate exact Codex behavior for a model id
	// 2. personality overlays are appended to the turn system prompt before the agent loop starts
	// 3. footer visibility is UI-only and intentionally separate from overlay behavior
	function isExactCodexParityTargetModel(model: Model<any> | undefined): boolean {
		return !!model && CODEX_PARITY_MODEL_IDS.has(model.id);
	}

	function shouldApplyCodexParityDefaults(model: Model<any> | undefined): boolean {
		return isExactCodexParityTargetModel(model);
	}

	function shouldApplyCodexParityPersonalityOverlay(model: Model<any> | undefined): boolean {
		return isExactCodexParityTargetModel(model);
	}

	function shouldShowParityStatusFooter(model: Model<any> | undefined): boolean {
		return isExactCodexParityTargetModel(model);
	}

	function stripAnsi(value: string): string {
		return value.replace(/\u001b\[[0-9;]*m/g, "");
	}

	function normalizePersonality(value: unknown): Personality {
		if (typeof value !== "string") return DEFAULT_STATE.personality;
		const normalized = stripAnsi(value).trim().toLowerCase();
		if (normalized.startsWith("friendly")) return "friendly";
		if (normalized.startsWith("pragmatic")) return "pragmatic";
		if (normalized.startsWith("claude")) return "claude";
		if (normalized === "none" || normalized === "default") return "none";
		return DEFAULT_STATE.personality;
	}

	function normalizeVerbosity(value: unknown): Verbosity {
		if (typeof value !== "string") return DEFAULT_STATE.verbosity;
		const normalized = stripAnsi(value).trim().toLowerCase();
		if (normalized === "inherit" || normalized === "default") return DEFAULT_STATE.verbosity;
		return normalized === "low" || normalized === "medium" || normalized === "high"
			? normalized
			: DEFAULT_STATE.verbosity;
	}

	function normalizeSummary(value: unknown): ReasoningSummary {
		if (typeof value !== "string") return DEFAULT_STATE.summary;
		const normalized = stripAnsi(value).trim().toLowerCase();
		if (normalized === "inherit") return DEFAULT_STATE.summary;
		return normalized === "none" || normalized === "auto" || normalized === "concise" || normalized === "detailed"
			? normalized
			: DEFAULT_STATE.summary;
	}

	function normalizeToolDiscipline(value: unknown): ToolDiscipline {
		if (typeof value === "boolean") return value ? "on" : "off";
		if (typeof value !== "string") return DEFAULT_STATE.toolDiscipline;
		const normalized = stripAnsi(value).trim().toLowerCase();
		return normalized === "on" || normalized === "off" ? normalized : DEFAULT_STATE.toolDiscipline;
	}

	function normalizeState(value: unknown): GPTConfigState {
		const candidate = (value ?? {}) as LegacyGPTConfigState;
		return {
			fastMode: candidate.fastMode === true,
			personality: candidate.style === "claude" ? "claude" : normalizePersonality(candidate.personality),
			verbosity: normalizeVerbosity(candidate.verbosity),
			summary: normalizeSummary(candidate.summary),
			toolDiscipline: normalizeToolDiscipline(candidate.toolDiscipline),
			showFooter: candidate.showFooter !== false,
		};
	}

	function serializeState(currentState: GPTConfigState): GPTConfigState {
		return {
			fastMode: currentState.fastMode,
			personality: currentState.personality,
			verbosity: currentState.verbosity,
			summary: currentState.summary,
			toolDiscipline: currentState.toolDiscipline,
			showFooter: currentState.showFooter,
		};
	}

	function readJsonObject(path: string): Record<string, unknown> | undefined {
		try {
			if (!existsSync(path)) return undefined;
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: undefined;
		} catch {
			return undefined;
		}
	}

	function readGlobalState(): { state: GPTConfigState; migratedFromLegacy: boolean } {
		const settings = readJsonObject(SETTINGS_FILE);
		const configured = settings?.[SETTINGS_NAMESPACE];
		if (configured && typeof configured === "object" && !Array.isArray(configured)) {
			return { state: normalizeState(configured), migratedFromLegacy: false };
		}

		const legacy = readJsonObject(LEGACY_STATE_FILE);
		if (legacy) {
			return { state: normalizeState(legacy), migratedFromLegacy: true };
		}

		return { state: { ...DEFAULT_STATE }, migratedFromLegacy: false };
	}

	function restoreState(ctx: ExtensionContext) {
		const restored = readGlobalState();
		state = restored.state;
		if (restored.migratedFromLegacy) persistState();
		updateStatus(ctx);
	}

	function persistState() {
		try {
			const settings = readJsonObject(SETTINGS_FILE) ?? {};
			const existing = settings[SETTINGS_NAMESPACE];
			settings[SETTINGS_NAMESPACE] = existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>), ...serializeState(state) }
				: serializeState(state);
			mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
			writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
		} catch {
			// Ignore persistence failures; runtime state still applies for this session.
		}
	}

	function getEffectiveVerbosity(_model: Model<any> | undefined): Verbosity {
		return state.verbosity;
	}

	function getEffectiveSummary(_model: Model<any> | undefined): ReasoningSummary {
		return state.summary;
	}

	function formatPersonality(value: Personality, _model: Model<any> | undefined): string {
		return value;
	}

	function personalityTokenLabel(value: Personality): string {
		if (value === "none") return "";
		return `(${PERSONALITY_PROMPT_TOKENS[value]} tok)`;
	}

	function formatPersonalityDisplay(value: Personality, model: Model<any> | undefined): string {
		const label = formatPersonality(value, model);
		if (value === "none") return label;
		return `${label} ${ANSI_YELLOW}${personalityTokenLabel(value)}${ANSI_RESET}`;
	}

	function formatVerbosity(value: Verbosity, _model: Model<any> | undefined): string {
		return value;
	}

	function formatSummary(value: ReasoningSummary, _model: Model<any> | undefined): string {
		return value;
	}

	function lifecycleWarning(): string {
		return "Set before starting work, or start a fresh session/reload after changing it.";
	}

	function personalityDescription(value: Personality, model: Model<any> | undefined): string {
		if (!shouldApplyCodexParityPersonalityOverlay(model)) {
			return value === "none"
				? `No effect on the current model. ${lifecycleWarning()}`
				: `No effect on the current model. ${personalityTokenLabel(value)} prompt cost shown for parity models only. ${lifecycleWarning()}`;
		}
		switch (value) {
			case "friendly":
				return [
					"Warmer, more collaborative tone. Same task behavior, but with softer wording and more teammate-like phrasing.",
					`Adds one small marked system-prompt overlay for the current agent turn. ${lifecycleWarning()}`,
				].join("\n");
			case "pragmatic":
				return [
					"More direct, factual, and compact tone. Best match for Codex's default voice.",
					`Adds one small marked system-prompt overlay for the current agent turn. ${lifecycleWarning()}`,
				].join("\n");
			case "claude":
				return [
					"Claude Code-style communication: short, direct, simple changes, and fewer unnecessary check-ins.",
					`Adds one small marked system-prompt overlay for the current agent turn. ${lifecycleWarning()}`,
				].join("\n");
			case "none":
			default:
				return `Use the model's built-in Codex default personality with no extra overlay. ${lifecycleWarning()}`;
		}
	}

	function modelLabel(model: Model<any> | undefined): string {
		if (!model) return "no model";
		return `${model.provider}/${model.id}`;
	}

	function supportsPriorityServiceTier(model: Model<any> | undefined): boolean {
		return !!model && PRIORITY_SERVICE_TIER_MODEL_IDS.has(model.id);
	}

	function shouldApplyFastModeParity(model: Model<any> | undefined): boolean {
		return supportsPriorityServiceTier(model);
	}

	function fastModeReason(model: Model<any> | undefined): string {
		if (!model) return "No active model selected.";
		if (!shouldApplyFastModeParity(model)) {
			return "No effect on the current model. Priority service tier is only available on parity models that support it.";
		}
		return "Requests the priority service tier for lower latency. It affects speed only, not tone, answer length, or reasoning-summary behavior.";
	}

	function fastModeBadge(model: Model<any> | undefined): string | undefined {
		if (!state.fastMode) return undefined;
		if (shouldApplyFastModeParity(model)) return "Fast mode enabled: next request will send service_tier=priority.";
		return "Fast mode enabled but ignored for the current model.";
	}

	function shouldApplyVerbosityParity(model: Model<any> | undefined): boolean {
		return shouldApplyCodexParityDefaults(model);
	}

	function verbosityDescription(value: Verbosity, _model: Model<any> | undefined): string {
		switch (value) {
			case "low":
				return "Shortest answers. Strongest control for keeping responses brief.";
			case "medium":
				return "Balanced answer length. More explanation than low, less than high.";
			case "high":
				return "Most detailed answers. Use this when you want the model to elaborate.";
		}
	}

	function verbosityReason(model: Model<any> | undefined): string {
		if (!model) return "No active model selected.";
		const effective = getEffectiveVerbosity(model);
		if (!shouldApplyVerbosityParity(model)) {
			return `No effect on the current model. Verbosity overrides are intentionally disabled outside supported parity models. ${lifecycleWarning()}`;
		}
		return `Effective value: ${effective}. This is the main knob for how short or long the final answer will be. ${lifecycleWarning()}`;
	}

	function shouldApplySummaryParity(model: Model<any> | undefined): boolean {
		return shouldApplyCodexParityDefaults(model);
	}

	function summaryDescription(value: ReasoningSummary, _model: Model<any> | undefined): string {
		switch (value) {
			case "none":
				return "No reasoning summary. This changes debug/inspection output, not the length of the final answer.";
			case "auto":
				return "Let the API choose whether to include a reasoning summary.";
			case "concise":
				return "Return a short reasoning summary alongside the answer.";
			case "detailed":
				return "Return a longer reasoning summary alongside the answer.";
		}
	}

	function summaryReason(model: Model<any> | undefined): string {
		if (!model) return "No active model selected.";
		const effective = getEffectiveSummary(model);
		if (!shouldApplySummaryParity(model)) {
			return `No effect on the current model. Reasoning-summary overrides are intentionally disabled outside supported parity models. ${lifecycleWarning()}`;
		}
		if (effective === "none") {
			return `Effective value: none. This affects whether a summarized reasoning trace is returned, not how concise the visible answer is. ${lifecycleWarning()}`;
		}
		if (!effective) {
			return `No reasoning.summary field will be sent. ${lifecycleWarning()}`;
		}
		return `Effective value: ${effective}. This changes reasoning-summary output only, not the answer's tone or length. ${lifecycleWarning()}`;
	}

	function shouldApplyToolDiscipline(model: Model<any> | undefined): boolean {
		return state.toolDiscipline === "on" && shouldApplyCodexParityDefaults(model);
	}

	function toolDisciplineDescription(value: ToolDiscipline, model: Model<any> | undefined): string {
		if (value === "off") return `No native-tool overlay. ${lifecycleWarning()}`;
		if (!shouldApplyCodexParityDefaults(model)) return `No effect on the current model. ${toolDisciplineTokenLabel(value)} prompt cost shown for parity models only. ${lifecycleWarning()}`;
		return `Adds a native-tool contract that treats shell substitutes for Pi's find/grep/read/edit/write tools as task failures. ${lifecycleWarning()}`;
	}

	function toolDisciplineTokenLabel(value: ToolDiscipline): string {
		return value === "on" ? `(${NATIVE_TOOL_DISCIPLINE_PROMPT_TOKENS} tok)` : "";
	}

	function formatToolDiscipline(value: ToolDiscipline): string {
		const label = toolDisciplineTokenLabel(value);
		return label ? `${value} ${ANSI_YELLOW}${label}${ANSI_RESET}` : value;
	}

	function shouldShowStatus(model: Model<any> | undefined): boolean {
		return state.showFooter && shouldShowParityStatusFooter(model);
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!shouldShowStatus(ctx.model)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const discipline = state.toolDiscipline === "on" ? " · tools on" : "";
		const status = supportsPriorityServiceTier(ctx.model)
			? `priority ${state.fastMode ? "fast" : "none"} · personality ${formatPersonality(state.personality, ctx.model)}${discipline}`
			: `personality ${formatPersonality(state.personality, ctx.model)}${discipline}`;
		ctx.ui.setStatus(STATUS_KEY, status);
	}

	function describeState(ctx: ExtensionContext): string[] {
		return [
			`Model: ${modelLabel(ctx.model)}`,
			`Fast mode: ${state.fastMode ? "on" : "off"} (${fastModeReason(ctx.model)})`,
			`Personality: ${formatPersonality(state.personality, ctx.model)} (${personalityDescription(state.personality, ctx.model)})`,
			`Verbosity: ${formatVerbosity(state.verbosity, ctx.model)} (${verbosityReason(ctx.model)})`,
			`Summary: ${formatSummary(state.summary, ctx.model)} (${summaryReason(ctx.model)})`,
			`Tool discipline: ${formatToolDiscipline(state.toolDiscipline)} (${toolDisciplineDescription(state.toolDiscipline, ctx.model)})`,
			`Footer: ${state.showFooter ? "show" : "hide"} (Shows priority/personality/tool discipline in the footer. UI-only.)`,
		];
	}

	function buildItems(ctx: ExtensionContext): SettingItem[] {
		const items: SettingItem[] = [];
		if (supportsPriorityServiceTier(ctx.model)) {
			items.push({
				id: "fastMode",
				label: "Fast mode",
				description: fastModeReason(ctx.model),
				currentValue: state.fastMode ? "on" : "off",
				values: ["on", "off"],
			});
		}
		items.push(
			{
				id: "personality",
				label: "Personality",
				description: personalityDescription(state.personality, ctx.model),
				currentValue: formatPersonalityDisplay(state.personality, ctx.model),
				values: ["none", `friendly ${ANSI_YELLOW}(50 tok)${ANSI_RESET}`, `pragmatic ${ANSI_YELLOW}(54 tok)${ANSI_RESET}`, `claude ${ANSI_YELLOW}(73 tok)${ANSI_RESET}`],
			},
			{
				id: "verbosity",
				label: "Verbosity",
				description: `${verbosityDescription(state.verbosity, ctx.model)} ${verbosityReason(ctx.model)}`,
				currentValue: formatVerbosity(state.verbosity, ctx.model),
				values: ["low", "medium", "high"],
			},
			{
				id: "summary",
				label: "Reasoning summary",
				description: `${summaryDescription(state.summary, ctx.model)} ${summaryReason(ctx.model)}`,
				currentValue: formatSummary(state.summary, ctx.model),
				values: ["none", "auto", "concise", "detailed"],
			},
			{
				id: "toolDiscipline",
				label: "Tool discipline",
				description: toolDisciplineDescription(state.toolDiscipline, ctx.model),
				currentValue: formatToolDiscipline(state.toolDiscipline),
				values: ["off", "on"],
			},
			{
				id: "footer",
				label: "Footer",
				description: "Show priority/personality/tool discipline in the footer. UI-only.",
				currentValue: state.showFooter ? "show" : "hide",
				values: ["show", "hide"],
			},
		);
		return items;
	}

	function wrapPersonalityOverlay(prompt: string): string {
		return ["<personality>", prompt, "</personality>"].join("\n");
	}

	function getCodexParityPersonalityInstructionOverlay(model: Model<any> | undefined): string | undefined {
		if (!shouldApplyCodexParityPersonalityOverlay(model)) return undefined;
		if (state.personality === "friendly") return wrapPersonalityOverlay(CODEX_FRIENDLY_PROMPT);
		if (state.personality === "pragmatic") return wrapPersonalityOverlay(CODEX_PRAGMATIC_PROMPT);
		if (state.personality === "claude") return wrapPersonalityOverlay(CLAUDE_STYLE_PROMPT);
		return undefined;
	}

	function getNativeToolDisciplineOverlay(_model: Model<any> | undefined): string | undefined {
		// patched: our system prompt already enforces native tool usage for all models
		return undefined;
	}

	function getInstructionOverlays(model: Model<any> | undefined): string[] {
		return [
			getCodexParityPersonalityInstructionOverlay(model),
			getNativeToolDisciplineOverlay(model),
		].filter((overlay): overlay is string => !!overlay);
	}

	async function openPanel(ctx: ExtensionContext) {
		const items = buildItems(ctx);
		const fastModeItem = items.find((item) => item.id === "fastMode");
		const personalityItem = items.find((item) => item.id === "personality");
		const verbosityItem = items.find((item) => item.id === "verbosity");
		const summaryItem = items.find((item) => item.id === "summary");
		const toolDisciplineItem = items.find((item) => item.id === "toolDiscipline");
		const footerItem = items.find((item) => item.id === "footer");

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();
			const accentBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			const infoBlock = {
				render(width: number) {
					const lines: string[] = [];
					lines.push(...wrapTextWithAnsi(theme.fg("accent", theme.bold("GPT Configuration")), width));
					lines.push(...wrapTextWithAnsi(theme.fg("dim", "Tune Codex-parity behavior. On unsupported models, every setting here is a no-op."), width));
					lines.push("");
					return lines;
				},
				invalidate() {},
			};

			container.addChild(accentBorder);
			container.addChild(infoBlock);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 4, 14),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "personality") {
						state = {
							...state,
							personality: normalizePersonality(newValue),
						};
					} else if (id === "fastMode") {
						state = {
							...state,
							fastMode: newValue === "on",
						};
					} else if (id === "verbosity") {
						state = {
							...state,
							verbosity: normalizeVerbosity(newValue),
						};
					} else if (id === "summary") {
						state = {
							...state,
							summary: normalizeSummary(newValue),
						};
					} else if (id === "toolDiscipline") {
						state = {
							...state,
							toolDiscipline: normalizeToolDiscipline(newValue),
						};
					} else if (id === "footer") {
						state = {
							...state,
							showFooter: newValue === "show",
						};
					}
					if (fastModeItem) fastModeItem.description = fastModeReason(ctx.model);
					if (personalityItem) {
						personalityItem.currentValue = formatPersonalityDisplay(state.personality, ctx.model);
						personalityItem.description = personalityDescription(state.personality, ctx.model);
					}
					if (verbosityItem) {
						verbosityItem.description = `${verbosityDescription(state.verbosity, ctx.model)} ${verbosityReason(ctx.model)}`;
					}
					if (summaryItem) {
						summaryItem.description = `${summaryDescription(state.summary, ctx.model)} ${summaryReason(ctx.model)}`;
					}
					if (toolDisciplineItem) {
						toolDisciplineItem.currentValue = formatToolDiscipline(state.toolDiscipline);
						toolDisciplineItem.description = toolDisciplineDescription(state.toolDiscipline, ctx.model);
					}
					if (footerItem) {
						footerItem.currentValue = state.showFooter ? "show" : "hide";
					}
					persistState();
					updateStatus(ctx);
					settingsList.invalidate();
					container.invalidate();
				},
				() => done(),
			);

			container.addChild(settingsList);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		ctx.ui.notify("GPT config updated!", "info");
	}

	pi.registerCommand("gpt-config", {
		description: "Configure personality, verbosity, reasoning summary, and fast mode for Codex parity",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			const [command, value] = trimmed.split(/\s+/, 2);
			if (trimmed === "status") {
				ctx.ui.notify(describeState(ctx).join(" | "), "info");
				return;
			}
			if (trimmed === "reset") {
				state = { ...DEFAULT_STATE };
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("GPT config reset to defaults (fast=off, personality=none, verbosity=medium, summary=auto, tools=off, footer=show).", "info");
				return;
			}
			if (command === "personality" && value) {
				if (value === "friendly" || value === "pragmatic" || value === "claude" || value === "none") {
					state = { ...state, personality: normalizePersonality(value) };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT personality set to ${formatPersonality(state.personality, ctx.model)}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config personality none|friendly|pragmatic|claude", "warning");
				return;
			}
			if (command === "fast" && value) {
				if (value === "on" || value === "off") {
					state = { ...state, fastMode: value === "on" };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT fast mode ${value}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config fast on|off", "warning");
				return;
			}
			if (command === "verbosity" && value) {
				if (value === "low" || value === "medium" || value === "high") {
					state = { ...state, verbosity: normalizeVerbosity(value) };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT verbosity set to ${value}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config verbosity low|medium|high", "warning");
				return;
			}
			if (command === "summary" && value) {
				if (value === "none" || value === "auto" || value === "concise" || value === "detailed") {
					state = { ...state, summary: normalizeSummary(value) };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT reasoning summary set to ${value}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config summary none|auto|concise|detailed", "warning");
				return;
			}
			if (command === "discipline" && value) {
				if (value === "on" || value === "off") {
					state = { ...state, toolDiscipline: normalizeToolDiscipline(value) };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT native tool discipline ${value}. Start a fresh session or reload before serious work; this changes the system prompt.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config discipline on|off", "warning");
				return;
			}
			if (command === "footer" && value) {
				if (value === "show" || value === "hide") {
					state = { ...state, showFooter: value === "show" };
					persistState();
					updateStatus(ctx);
					ctx.ui.notify(`GPT footer ${value}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /gpt-config footer show|hide", "warning");
				return;
			}
			await openPanel(ctx);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const overlays = getInstructionOverlays(ctx.model).filter((overlay) => {
			if (overlay.startsWith("<personality>") && event.systemPrompt.includes("<personality>")) return false;
			if (overlay.startsWith("<native_tool_discipline>") && event.systemPrompt.includes("<native_tool_discipline>")) return false;
			return true;
		});
		if (overlays.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${overlays.join("\n\n")}`,
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

		let modified = payload as Record<string, unknown>;
		let changed = false;

		if (state.fastMode && shouldApplyFastModeParity(ctx.model)) {
			modified = { ...modified, service_tier: "priority" };
			changed = true;
		}

		const effectiveVerbosity = getEffectiveVerbosity(ctx.model);
		if (effectiveVerbosity && shouldApplyVerbosityParity(ctx.model)) {
			const existingText = (modified.text && typeof modified.text === "object" && !Array.isArray(modified.text))
				? modified.text as Record<string, unknown>
				: {};
			modified = { ...modified, text: { ...existingText, verbosity: effectiveVerbosity } };
			changed = true;
		}

		const effectiveSummary = getEffectiveSummary(ctx.model);
		if (effectiveSummary && effectiveSummary !== "none" && shouldApplySummaryParity(ctx.model)) {
			const existingReasoning = (modified.reasoning && typeof modified.reasoning === "object" && !Array.isArray(modified.reasoning))
				? modified.reasoning as Record<string, unknown>
				: {};
			modified = { ...modified, reasoning: { ...existingReasoning, summary: effectiveSummary } };
			changed = true;
		}

		if (!changed) return;
		return modified;
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
