import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = "/Users/muzammil/Documents/Code stuff/Local models/start-local.sh";
const PID_FILE = "/tmp/llama-server.pid";
const LOG_FILE = "/tmp/llama-server.log";
const PORT = 8080;

const MODELS: Record<string, { name: string; speed: string; id: string }> = {
	gemma: { name: "Gemma 4 26B-A4B MoE", speed: "49 tok/s", id: "gemma-moe-local" },
	"qwen-moe": { name: "Qwen3.5 35B-A3B MoE", speed: "42 tok/s", id: "qwen-moe-local" },
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
			timeout: 120_000,
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
		if (status.model === m.id || status.model?.includes(key.replace("-", ""))) return key;
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
	// ── /local command ──────────────────────────────────────────
	pi.registerCommand("local", {
		description: "Manage local model server",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "start", label: "start — Pick model + context + thinking interactively" },
				{ value: "stop", label: "stop — Stop the server" },
				{ value: "status", label: "status — Check what's running" },
				{ value: "logs", label: "logs — Show recent server logs" },
				{ value: "gemma", label: "gemma — Gemma 4 MoE (49 tok/s)" },
				{ value: "gemma think", label: "gemma think — Gemma 4 MoE with thinking" },
				{ value: "qwen-moe", label: "qwen-moe — Qwen3.5 MoE (42 tok/s) — better for coding" },
				{ value: "qwen-moe think", label: "qwen-moe think — Qwen3.5 MoE with thinking" },
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

			// ── /local stop ───────────────────────────────────
			if (cmd === "stop") {
				const { ok, output } = stopServer();
				ctx.ui.notify(output.trim(), ok ? "success" : "warning");
				ctx.ui.setStatus("local-model", "");
				currentModel = "";
				return;
			}

			// ── /local status ─────────────────────────────────
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
					ctx.ui.notify("❌ Server not running\n\nUse /local start or /local gemma", "warning");
				}
				return;
			}

			// ── /local logs ───────────────────────────────────
			if (cmd === "logs") {
				try {
					const logs = execSync(`tail -30 ${LOG_FILE} 2>/dev/null`, { encoding: "utf-8" });
					ctx.ui.notify(logs || "No logs yet", "info");
				} catch {
					ctx.ui.notify("No log file found", "warning");
				}
				return;
			}

			// ── /local gemma [128k] [think] — direct start ───
			if (MODELS[cmd]) {
				const context =
					ctxArg ||
					(await ctx.ui.select("Context window:", ["64k — 64K tokens", "128k — 128K tokens", "256k — 256K tokens (default)"]));
				if (!context) return;
				const ctxKey = context.split(" ")[0].trim();
				return await doStart(cmd, ctxKey, thinking, ctx);
			}

			// ── /local start — interactive ────────────────────
			if (cmd === "start" || cmd === "") {
				const modelChoice = await ctx.ui.select("Pick a model:", [
					"gemma     — ⚡ Gemma 4 26B-A4B MoE (49 tok/s)",
					"qwen-moe  — ⚡ Qwen3.5 35B-A3B MoE (42 tok/s) — better for coding agents",
				]);
				if (!modelChoice) return;
				const modelKey = modelChoice.split(" ")[0].trim();

				const ctxChoice = await ctx.ui.select("Context window:", [
					"64k — 64K tokens",
					"128k — 128K tokens",
					"256k — 256K tokens (default)",
				]);
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
					"  /local                    — Interactive picker\n" +
					"  /local gemma              — Gemma 4 MoE, 256k, no thinking\n" +
					"  /local qwen-moe think     — Qwen MoE, 256k, thinking on\n" +
					"  /local gemma 128k think   — Gemma, 128K, thinking on\n" +
					"  /local stop               — Stop server\n" +
					"  /local status             — Check server\n" +
					"  /local logs               — Show logs",
				"info",
			);
		},
	});

	// ── /think toggle ────────────────────────────────────────────
	pi.registerCommand("think", {
		description: "Toggle thinking mode (restarts server)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "on", label: "on — Enable thinking (step-by-step reasoning)" },
				{ value: "off", label: "off — Disable thinking (fast, direct)" },
			];
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const target = args?.trim().toLowerCase();

			if (!currentModel) {
				// try to detect
				const detected = detectCurrentModel();
				if (detected) {
					currentModel = detected;
					currentCtx = currentCtx || "256k";
				} else {
					ctx.ui.notify("No local server running. Use /local start first.", "warning");
					return;
				}
			}

			let newThinking: string;
			if (target === "on" || target === "off") {
				newThinking = target;
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
		},
	});

	// ── Shared start logic (auto-stops existing server) ─────────
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
			// Brief pause for port to free
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
		// Only inject when using a local model
		const model = ctx.model;
		if (!model || model.provider !== "local-llama") return;

		// Tell the model who it actually is
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
			ctx.ui.setStatus("local-model", detected ? statusLabel(detected, currentCtx || "256k", currentThinking) : `🟢 ${status.model || "Local model"} on :${PORT}`);
		}
	});
}
