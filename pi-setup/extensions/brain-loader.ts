/**
 * brain-loader — auto-injects brain vault context into every pi session.
 *
 * On every session start:
 * 1. Reads ~/Documents/brain/MEMORY.md (global durable facts)
 * 2. Reads ~/Documents/brain/USER.md (about the user)
 * 3. Detects project from cwd → reads brain/projects/<project>.md if it exists
 * 4. Injects the end-of-session protocol
 *
 * No project files are touched. Works across all workspaces.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";

const BRAIN_DIR = resolve(homedir(), "Documents/brain");

function readBrainFile(relativePath: string): string {
  const fullPath = resolve(BRAIN_DIR, relativePath);
  if (existsSync(fullPath)) {
    try {
      return readFileSync(fullPath, "utf-8");
    } catch {
      return "";
    }
  }
  return "";
}

function getProjectName(cwd: string): string {
  // Derive a project identifier from the workspace path
  // /Users/you/projects/myapp → myapp
  // /Users/you/work/some project → some-project
  return basename(cwd).toLowerCase().replace(/\s+/g, "-");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const parts: string[] = [];

    // 1. Global memory
    const memory = readBrainFile("MEMORY.md");
    if (memory) {
      parts.push("# Brain — Global Memory\n" + memory);
    }

    // 2. User profile
    const user = readBrainFile("USER.md");
    if (user) {
      parts.push(user);
    }

    // 3. Project-specific memory (auto-detected from cwd)
    const projectName = getProjectName(ctx.cwd);
    const projectMemory = readBrainFile(`projects/${projectName}.md`);
    if (projectMemory) {
      parts.push("# Brain — Project Memory: " + projectName + "\n" + projectMemory);
    }

    // 4. End-of-session protocol
    parts.push(`# Brain — Update Protocol

When the user says "update brain", "save", or the session is ending:
1. Add durable facts to ~/Documents/brain/MEMORY.md (§-delimited, max ~4000 chars, curate when full)
2. Append to ~/Documents/brain/log/${new Date().toISOString().slice(0, 10)}.md (3-5 lines)
3. If user corrected you → add [FIX] entry to MEMORY.md (permanent, never removed)
4. If deep research → create/update ~/Documents/brain/knowledge/<topic>/<article>.md
5. If project-specific → update ~/Documents/brain/projects/${projectName}.md`);

    if (parts.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n"),
    };
  });
}
