// import-opencode.ts — Pi extension: /import-opencode slash command
// Spawns bun to run the migration worker (bun:sqlite) and reports progress.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

export default function (pi: any) {
  pi.registerCommand("import-opencode", {
    description:
      "Import opencode sessions into pi (one-time migration from opencode's SQLite database)",
    async handler(ctx: any) {
      const home = homedir();
      const bunPath = join(home, ".bun/bin/bun");
      const dbPath = join(home, ".local/share/opencode/opencode.db");

      // Resolve worker path — try __dirname first, fall back to known deploy location
      let workerPath = "";
      try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const localCandidate = join(__dirname, "import-opencode", "migrate.ts");
        if (existsSync(localCandidate)) {
          workerPath = localCandidate;
        }
      } catch {
        // import.meta.url may not work in pi's jiti environment
      }

      if (!workerPath) {
        const fallback = join(
          home,
          ".pi/agent/extensions/import-opencode/migrate.ts",
        );
        if (existsSync(fallback)) {
          workerPath = fallback;
        }
      }

      // --- Preflight checks ---

      if (!existsSync(bunPath)) {
        ctx.ui.notify(
          "❌ Bun not found at " +
            bunPath +
            ". Install bun first: https://bun.sh",
        );
        return;
      }

      if (!existsSync(dbPath)) {
        ctx.ui.notify(
          "❌ opencode database not found at " + dbPath,
        );
        return;
      }

      if (!workerPath) {
        ctx.ui.notify(
          "❌ Migration worker not found. Expected at: " +
            join(home, ".pi/agent/extensions/import-opencode/migrate.ts"),
        );
        return;
      }

      ctx.ui.notify("🔄 Starting opencode → pi session import...");

      try {
        const result = await new Promise<string>((resolve, reject) => {
          const child = spawn(bunPath, ["run", workerPath], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HOME: home },
          });

          let stdout = "";
          let stderr = "";

          child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
          });

          child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });

          child.on("error", (err: Error) => {
            reject(new Error("Failed to spawn bun: " + err.message));
          });

          child.on("close", (code: number) => {
            if (code === 0) {
              // Extract the summary line (last non-empty line of stdout)
              const lines = stdout.trim().split("\n");
              const summary =
                lines[lines.length - 1] || "Import completed.";
              resolve(summary);
            } else {
              reject(
                new Error(
                  stderr.trim() || `bun exited with code ${code}`,
                ),
              );
            }
          });
        });

        ctx.ui.notify("✅ " + result);
      } catch (err: any) {
        ctx.ui.notify(
          "❌ Import failed: " + (err.message || String(err)),
        );
      }
    },
  });
}
