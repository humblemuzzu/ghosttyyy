import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = "/Users/muzammil/Documents/Code stuff/Local models/start-local.sh";
const PID_FILE = "/tmp/llama-server.pid";
const LOG_FILE = "/tmp/llama-server.log";
const PORT = 8080;

const MODELS: Record<string, { name: string; speed: string; id: string; contexts: string[] }> = {
	qwen36: {
		name: "Qwen3.6-35B-A3B Uncensored MoE",
		speed: "~50 tok/s",
		id: "qwen36-moe-local",
		contexts: ["32k", "64k", "128k", "256k"],
	},
	"gemma-e2b": {
		name: "Gemma 4 E2B",
		speed: "~69 tok/s",
		id: "gemma-e2b-local",
		contexts: ["32k", "64k", "128k"],
	},
};

const MODEL_ALIASES: Record<string, string> = {
	qwen: "qwen36",
	"qwen3.6": "qwen36",
	default: "qwen36",
	e2b: "gemma-e2b",
	gemma: "gemma-e2b",
	small: "gemma-e2b",
};

// ── Anti-gaslighting prompt for local models ─────────────────
const LOCAL_MODEL_RULES = `
## Local Model Rules (CRITICAL)

You are running as a local model. Follow these rules strictly:

1. **NEVER say you're "executing", "starting", "working on it", or "doing it now" without ACTUALLY calling a tool.** Every action requires a tool call. Words alone do nothing.
2. **When a tool call fails, READ the error message.** Do NOT retry the exact same call. Figure out what went wrong — wrong path? wrong filename? missing file? — and fix it.
3. **If you fail the same tool call twice, STOP and explain what's going wrong.** Do not loop.
4. **Before editing a file, verify it exists** with the read tool. Do not guess filenames.
5. **Be direct.** Don't narrate what you're about to do. Just do it with tool calls.
6. **One thing at a time.** Complete each step before moving to the next.
`;

function resolveModel(key: string): string | undefined {
	if (MODELS[key]) return key;
	return MODEL_ALIASES[key];
}

function isServerRunning(): { running: boolean; pid?: number; model?: string } {
	try {
		if (!existsSync(PID_FILE)) return { running: false };
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
		execSync(`kill -0 ${pid} 2>/dev/null`);
		let model: string | undefined;
		try {
			const resp = execSync(`curl -sf http://localhost:${PORT}/v1/models`, { timeout: 2000 }).toString();
			const data = JSON.parse(resp);
			model = data?.data?.[0]?.id;
		} catch {}
		return { running: true, pid, model };
	} catch {
		return { running: false };
	}
}

function stopServer(): { ok: boolean; output: string } {
	try {
		const output = execSync(`"${SCRIPT}" stop 2>&1`, { timeout: 10_000, encoding: "utf-8" });
		return { ok: true, output };
	} catch (e: any) {
		return { ok: false, output: e.stdout || e.message };
	}
}

function startServer(model: string, ctx: string, thinking: string): { ok: boolean; output: string } {
	try {
		const thinkArg = thinking === "on" ? "think" : "";
		const output = execSync(`"${SCRIPT}" ${model} ${ctx} ${thinkArg} 2>&1`, {
			timeout: 180_000,
			encoding: "utf-8",
		});
		return { ok: output.includes("✅"), output };
	} catch (e: any) {
		return { ok: false, output: e.stdout || e.message };
	}
}

// Track current state
let currentModel = "";
let currentCtx = "";
let currentThinking = "off";

function detectCurrentModel(): string | undefined {
	const status = isServerRunning();
	if (!status.running || !status.model) return undefined;
	for (const [key, m] of Object.entries(MODELS)) {
		if (status.model === m.id) return key;
	}
	return undefined;
}

function statusLabel(model: string, ctx: string, thinking: string): string {
	const m = MODELS[model];
	if (!m) return "";
	const thinkIcon = thinking === "on" ? " 🧠" : "";
	return `🟢 ${m.name} · ${ctx} · ${m.speed}${thinkIcon}`;
}

export default function (pi: ExtensionAPI) {
	// ── /llm command ──────────────────────────────────────────
	pi.registerCommand("llm", {
		description: "Manage local LLM server (start/stop/status/think)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "start", label: "start — Interactive picker" },
				{ value: "stop", label: "stop — Stop the server" },
				{ value: "status", label: "status — Check what's running" },
				{ value: "logs", label: "logs — Show recent server logs" },
				{ value: "think", label: "think — Toggle thinking mode" },
				{ value: "think on", label: "think on — Enable thinking" },
				{ value: "think off", label: "think off — Disable thinking" },
				{ value: "qwen36", label: "qwen36 — Qwen3.6 Uncensored MoE (~50 tok/s)" },
				{ value: "qwen36 think", label: "qwen36 think — Qwen3.6 with thinking" },
				{ value: "gemma-e2b", label: "gemma-e2b — Gemma 4 E2B (~69 tok/s, tiny/fast)" },
			];
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const parts = (args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);

			// Parse thinking flag from any position
			let thinking = "off";
			const cleaned: string[] = [];
			for (const p of parts) {
				if (p === "think" || p === "thinking") thinking = "on";
				else if (p === "nothink" || p === "fast") thinking = "off";
				else cleaned.push(p);
			}
			const cmd = cleaned[0] || "";
			const ctxArg = cleaned[1] || "";

			// ── /llm stop ───────────────────────────────────
			if (cmd === "stop") {
				const { ok, output } = stopServer();
				ctx.ui.notify(output.trim(), ok ? "success" : "warning");
				ctx.ui.setStatus("local-model", "");
				currentModel = "";
				return;
			}

			// ── /llm status ─────────────────────────────────
			if (cmd === "status") {
				const status = isServerRunning();
				if (status.running) {
					const detected = detectCurrentModel();
					const m = detected ? MODELS[detected] : undefined;
					const thinkStr = currentThinking === "on" ? "ON 🧠" : "OFF";
					ctx.ui.notify(
						`✅ Server running (PID ${status.pid})\n` +
							`   Model: ${m?.name || status.model}\n` +
							`   Context: ${currentCtx || "unknown"}\n` +
							`   Thinking: ${thinkStr}\n` +
							`   Endpoint: http://localhost:${PORT}/v1`,
						"info",
					);
				} else {
					ctx.ui.notify("❌ Server not running\n\nUse /llm start or /llm qwen36", "warning");
				}
				return;
			}

			// ── /llm logs ───────────────────────────────────
			if (cmd === "logs") {
				try {
					const logs = execSync(`tail -30 ${LOG_FILE} 2>/dev/null`, { encoding: "utf-8" });
					ctx.ui.notify(logs || "No logs yet", "info");
				} catch {
					ctx.ui.notify("No log file found", "warning");
				}
				return;
			}

			// ── /llm think [on|off] — toggle thinking ───────
			if (cmd === "think") {
				if (!currentModel) {
					const detected = detectCurrentModel();
					if (detected) {
						currentModel = detected;
						currentCtx = currentCtx || "256k";
					} else {
						ctx.ui.notify("No local server running. Use /llm start first.", "warning");
						return;
					}
				}

				// If "think" was parsed as the thinking flag, it's already on
				// But we also need to handle "/llm think on" and "/llm think off"
				let newThinking: string;
				if (ctxArg === "on") {
					newThinking = "on";
				} else if (ctxArg === "off") {
					newThinking = "off";
				} else {
					// toggle
					newThinking = currentThinking === "on" ? "off" : "on";
				}

				if (newThinking === currentThinking) {
					ctx.ui.notify(`Thinking is already ${currentThinking}`, "info");
					return;
				}

				ctx.ui.notify(`Switching thinking ${newThinking === "on" ? "ON 🧠" : "OFF ⚡"}...`, "info");
				return await doStart(currentModel, currentCtx, newThinking, ctx);
			}

			// ── /llm <model> [ctx] [think] — direct start ───
			const resolved = resolveModel(cmd);
			if (resolved) {
				const m = MODELS[resolved];
				let context = ctxArg;
				if (!context) {
					const defaultCtx = m.contexts[m.contexts.length - 1]; // largest available
					const options = m.contexts.map((c) => {
						const isDefault = c === defaultCtx;
						return `${c}${isDefault ? " (default)" : ""}`;
					});
					const choice = await ctx.ui.select("Context window:", options);
					if (!choice) return;
					context = choice.split(" ")[0].trim();
				}
				return await doStart(resolved, context, thinking, ctx);
			}

			// ── /llm start — interactive ────────────────────
			if (cmd === "start" || cmd === "") {
				const modelChoice = await ctx.ui.select("Pick a model:", [
					"qwen36    — ⚡ Qwen3.6-35B-A3B Uncensored MoE (~50 tok/s) — best for coding",
					"gemma-e2b — ⚡ Gemma 4 E2B (~69 tok/s, tiny/fast, vision+audio)",
				]);
				if (!modelChoice) return;
				const modelKey = resolveModel(modelChoice.split(" ")[0].trim()) || "qwen36";
				const m = MODELS[modelKey];

				const defaultCtx = m.contexts[m.contexts.length - 1];
				const ctxOptions = m.contexts.map((c) => `${c}${c === defaultCtx ? " (default)" : ""}`);
				const ctxChoice = await ctx.ui.select("Context window:", ctxOptions);
				if (!ctxChoice) return;
				const ctxKey = ctxChoice.split(" ")[0].trim();

				const thinkChoice = await ctx.ui.select("Thinking mode:", [
					"off — Fast, direct answers (default, best for coding)",
					"on  — Step-by-step reasoning (for hard problems)",
				]);
				if (!thinkChoice) return;
				const thinkKey = thinkChoice.startsWith("on") ? "on" : "off";

				return await doStart(modelKey, ctxKey, thinkKey, ctx);
			}

			ctx.ui.notify(
				"Usage:\n" +
					"  /llm                       — Interactive picker\n" +
					"  /llm qwen36                — Qwen3.6 Uncensored, 256k, no thinking\n" +
					"  /llm qwen36 128k think     — Qwen3.6, 128K, thinking on\n" +
					"  /llm gemma-e2b             — Gemma E2B, 128k\n" +
					"  /llm think                 — Toggle thinking (restarts server)\n" +
					"  /llm think on/off          — Set thinking mode\n" +
					"  /llm stop                  — Stop server\n" +
					"  /llm status                — Check server\n" +
					"  /llm logs                  — Show logs",
				"info",
			);
		},
	});

	// ── Keep /local as alias ─────────────────────────────────────
	pi.registerCommand("local", {
		description: "Alias for /llm",
		handler: async (args, ctx) => {
			const commands = pi.getCommands();
			const llmCmd = commands.find((c) => c.name === "llm");
			if (llmCmd) {
				// Just delegate — re-trigger the handler
				ctx.ui.notify("Use /llm instead of /local", "info");
			}
		},
	});

	// ── Shared start logic ────────────────────────────────────────
	async function doStart(model: string, context: string, thinking: string, ctx: any) {
		const m = MODELS[model];
		if (!m) {
			ctx.ui.notify(`Unknown model: ${model}`, "warning");
			return;
		}

		// Auto-stop if already running
		const status = isServerRunning();
		if (status.running) {
			ctx.ui.setStatus("local-model", "⏳ Stopping current server...");
			stopServer();
			execSync("sleep 1");
		}

		const thinkLabel = thinking === "on" ? " + thinking 🧠" : "";
		ctx.ui.notify(`🚀 Starting ${m.name} · ${context}${thinkLabel}`, "info");
		ctx.ui.setStatus("local-model", `⏳ Loading ${m.name}...`);

		const result = startServer(model, context, thinking);
		if (result.ok) {
			currentModel = model;
			currentCtx = context;
			currentThinking = thinking;
			ctx.ui.setStatus("local-model", statusLabel(model, context, thinking));
			ctx.ui.notify(`✅ ${m.name} ready · ${context}${thinkLabel}\n\n📡 http://localhost:${PORT}/v1`, "success");
		} else {
			ctx.ui.setStatus("local-model", "");
			ctx.ui.notify(`❌ Failed to start\n\n${result.output.slice(-500)}`, "warning");
		}
	}

	// ── Inject identity + anti-gaslighting rules for local models ──
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== "local-llama") return;

		const detected = detectCurrentModel();
		const m = detected ? MODELS[detected] : undefined;
		const thinkStr = currentThinking === "on" ? "ON" : "OFF";
		const identity = m
			? `\n## Your Identity\nYou are running as **${m.name}** (${m.speed}). Thinking mode: ${thinkStr}. Do NOT claim to be a different model.\n`
			: "";

		return {
			systemPrompt: event.systemPrompt + identity + LOCAL_MODEL_RULES,
		};
	});

	// ── Show status on session start ────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const status = isServerRunning();
		if (status.running) {
			const detected = detectCurrentModel();
			if (detected) {
				currentModel = detected;
				currentCtx = currentCtx || "256k";
			}
			ctx.ui.setStatus(
				"local-model",
				detected ? statusLabel(detected, currentCtx || "256k", currentThinking) : `🟢 ${status.model || "Local model"} on :${PORT}`,
			);
		}
	});
}
