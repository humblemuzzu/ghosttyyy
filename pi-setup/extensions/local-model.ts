import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";

const SCRIPT = "/Users/muzammil/Documents/Code stuff/Local models/start-local.sh";
const PID_FILE = "/tmp/llama-server.pid";
const LOG_FILE = "/tmp/llama-server.log";
const PORT = 8080;

const MODELS: Record<string, { name: string; speed: string }> = {
  gemma:      { name: "Gemma 4 26B-A4B MoE",    speed: "~49 tok/s" },
  "qwen-moe": { name: "Qwen3.5 35B-A3B MoE",   speed: "~42 tok/s" },
  "qwen-opus": { name: "Qwen 27B Opus (OLD)",   speed: "~12 tok/s" },
};

const CONTEXTS = ["64k", "128k", "256k"];

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

function runScript(args: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      const output = execSync(`"${SCRIPT}" ${args} 2>&1`, {
        timeout: 120_000,
        encoding: "utf-8",
      });
      resolve({ ok: output.includes("✅"), output });
    } catch (e: any) {
      resolve({ ok: false, output: e.stdout || e.message });
    }
  });
}

export default function (pi: ExtensionAPI) {
  // ── /local command ──────────────────────────────────────────
  pi.registerCommand("local", {
    description: "Start/stop local model server",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "start",  label: "start — Pick model + context interactively" },
        { value: "stop",   label: "stop — Stop the server" },
        { value: "status", label: "status — Check what's running" },
        { value: "logs",   label: "logs — Show server logs" },
        { value: "gemma",      label: "gemma — Gemma 4 MoE (49 tok/s, default)" },
        { value: "qwen-moe",   label: "qwen-moe — Qwen3.5 35B MoE (42 tok/s)" },
        { value: "gemma 64k",  label: "gemma 64k" },
        { value: "gemma 128k", label: "gemma 128k" },
        { value: "gemma 256k", label: "gemma 256k" },
        { value: "qwen-moe 64k",  label: "qwen-moe 64k" },
        { value: "qwen-moe 128k", label: "qwen-moe 128k" },
        { value: "qwen-moe 256k", label: "qwen-moe 256k" },
      ];
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = (args || "").trim().toLowerCase().split(/\s+/);
      const cmd = parts[0] || "";
      const ctxArg = parts[1] || "";

      // ── /local stop ───────────────────────────────────────
      if (cmd === "stop") {
        const { ok, output } = await runScript("stop");
        ctx.ui.notify(output.trim(), ok ? "success" : "warning");
        ctx.ui.setStatus("local-model", "");
        return;
      }

      // ── /local status ─────────────────────────────────────
      if (cmd === "status") {
        const status = isServerRunning();
        if (status.running) {
          const modelInfo = MODELS[Object.keys(MODELS).find(k =>
            status.model?.includes(k.replace("-", ""))
          ) || ""] || { name: status.model, speed: "" };
          ctx.ui.notify(
            `✅ Server running (PID ${status.pid})\n` +
            `   Model: ${status.model}\n` +
            `   Endpoint: http://localhost:${PORT}/v1`,
            "info"
          );
        } else {
          ctx.ui.notify("❌ Server not running.\n\nUse /local start", "warning");
        }
        return;
      }

      // ── /local logs ───────────────────────────────────────
      if (cmd === "logs") {
        try {
          const logs = execSync(`tail -30 ${LOG_FILE} 2>/dev/null`, { encoding: "utf-8" });
          ctx.ui.notify(logs || "No logs yet", "info");
        } catch {
          ctx.ui.notify("No log file found", "warning");
        }
        return;
      }

      // ── /local gemma 128k — direct model+context ──────────
      if (MODELS[cmd]) {
        const context = ctxArg || await ctx.ui.select("Context window:", [
          "64k  — 64K tokens",
          "128k — 128K tokens",
          "256k — 256K tokens (max, default)",
        ]);
        if (!context) return;
        const ctxKey = context.split(" ")[0].trim();
        const m = MODELS[cmd];
        ctx.ui.notify(`🚀 Starting ${m.name} with ${ctxKey} context...`, "info");
        ctx.ui.setStatus("local-model", `⏳ Loading ${m.name}...`);
        const { ok, output } = await runScript(`${cmd} ${ctxKey}`);
        ctx.ui.notify(output.trim(), ok ? "success" : "warning");
        ctx.ui.setStatus("local-model", ok ? `🟢 ${m.name} (${ctxKey})` : "");
        return;
      }

      // ── /local start — full interactive picker ────────────
      if (cmd === "start" || cmd === "") {
        const modelChoice = await ctx.ui.select("Pick a model:", [
          "gemma     — ⚡ Gemma 4 26B-A4B MoE (49 tok/s) — RECOMMENDED",
          "qwen-moe  — ⚡ Qwen3.5 35B-A3B MoE (42 tok/s)",
        ]);
        if (!modelChoice) return;
        const modelKey = modelChoice.split(" ")[0].trim();

        const ctxChoice = await ctx.ui.select("Context window:", [
          "64k  — 64K tokens",
          "128k — 128K tokens",
          "256k — 256K tokens (max, default)",
        ]);
        if (!ctxChoice) return;
        const ctxKey = ctxChoice.split(" ")[0].trim();

        const m = MODELS[modelKey] || { name: modelKey, speed: "" };
        ctx.ui.notify(`🚀 Starting ${m.name} with ${ctxKey} context...`, "info");
        ctx.ui.setStatus("local-model", `⏳ Loading ${m.name}...`);
        const { ok, output } = await runScript(`${modelKey} ${ctxKey}`);
        ctx.ui.notify(output.trim(), ok ? "success" : "warning");
        ctx.ui.setStatus("local-model", ok ? `🟢 ${m.name} (${ctxKey})` : "");
        return;
      }

      ctx.ui.notify(
        "Usage:\n" +
        "  /local                — Interactive model + context picker\n" +
        "  /local gemma 256k    — Start Gemma 4 MoE at 256K\n" +
        "  /local qwen-moe 128k — Start Qwen MoE at 128K\n" +
        "  /local stop           — Stop server\n" +
        "  /local status         — Check server\n" +
        "  /local logs           — Show logs",
        "info"
      );
    },
  });

  // ── Show status on session start ───────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const status = isServerRunning();
    if (status.running) {
      ctx.ui.setStatus("local-model", `🟢 ${status.model || "Local model"} on :${PORT}`);
    }
  });
}
