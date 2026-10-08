/**
 * search_sessions — find session branches by keyword, file, or date.
 *
 * a pi session is a tree, so the unit is a branch (one root-to-leaf path), not
 * a whole file. glob → optional ripgrep pre-filter → parse JSONL → enumerate
 * branches → filter → sort. the rg pre-filter is required: the sessions dir is
 * too large to parse every file per query. never writes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "./lib/prompt-patch";
// clearConfigCache / setGlobalSettingsPath were only used by his extension
// wrapper and its inline tests, both of which we dropped.
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "./lib/config";
import { type BoxSection, type Excerpt, boxRendererWindowed } from "./lib/box-format";
import { PI_SESSIONS_DIR, SUB_AGENT_SESSION_DIR } from "./lib/pi-spawn";
import { Type } from "@sinclair/typebox";
import {
  enumerateBranches,
  listSessionFiles,
  parseSessionFile,
  type BranchResult,
  type MentionableSession,
} from "./lib/mentions";


type SearchSessionsExtConfig = {
  maxResults: number;
  sessionsDir?: string;
  sessionsDirs?: string[];
  rgTimeoutMs: number;
};

type SearchSessionsExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const MAX_SESSION_PROJECTIONS = 2_000;
const MAX_SESSION_PROJECTION_BYTES = 64 * 1024;
const MAX_SESSION_PROJECTION_TOTAL_BYTES = 64 * 1024 * 1024;

function sessionProjectionDir(): string {
  const data =
    process.env.PI_MEMORY_DATA_DIR ??
    path.join(os.homedir(), ".local", "share", "pi-memory");
  return path.join(data, "pi-sessions");
}

async function loadProjectedSessionMentions(): Promise<MentionableSession[]> {
  const root = sessionProjectionDir();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: MentionableSession[] = [];
  let totalBytes = 0;
  for (const entry of entries.slice(0, MAX_SESSION_PROJECTIONS)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (
        stat.size > MAX_SESSION_PROJECTION_BYTES ||
        totalBytes + stat.size > MAX_SESSION_PROJECTION_TOTAL_BYTES
      )
        continue;
      totalBytes += stat.size;
      const text = await fs.promises.readFile(filePath, "utf8");
      const sessionId = entry.name.slice(0, -3);
      const workspace = text.match(/^workspace:\s*(.+)$/mu)?.[1]?.trim() ?? "";
      const sessionName =
        text.match(/^## branch [^\n]*? — (.+)$/mu)?.[1]?.trim() ?? "";
      const firstUserMessage =
        text
          .match(/^### user\s*\n+([^\n]+)/mu)?.[1]
          ?.trim()
          .slice(0, 500) ?? "";
      sessions.push({
        sessionId,
        sessionName,
        workspace,
        filePath,
        startedAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        firstUserMessage,
        searchableText: [
          sessionId,
          sessionName,
          workspace,
          firstUserMessage,
        ].join("\n"),
        branchCount: text.match(/^## branch /gmu)?.length ?? 1,
      });
    } catch {}
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const CONFIG_DEFAULTS: SearchSessionsExtConfig = {
  maxResults: 50,
  /*
   * both roots: your own sessions, and the sub-agent sessions that delegate
   * keeps out of `/resume`. searching is a targeted act (you asked for a
   * keyword), unlike browsing, so covering delegate work here is useful
   * rather than noisy — and it is the only way to find what a sub-agent did.
   */
  sessionsDirs: [
    PI_SESSIONS_DIR,
    SUB_AGENT_SESSION_DIR,
  ],
  rgTimeoutMs: 10000,
};

function isSearchSessionsConfig(
  value: Record<string, unknown>,
): value is SearchSessionsExtConfig {
  return (
    typeof value.maxResults === "number" &&
    Number.isInteger(value.maxResults) &&
    value.maxResults >= 1 &&
    (value.sessionsDir === undefined ||
      (typeof value.sessionsDir === "string" &&
        value.sessionsDir.trim().length > 0)) &&
    (value.sessionsDirs === undefined ||
      (Array.isArray(value.sessionsDirs) &&
        value.sessionsDirs.length > 0 &&
        value.sessionsDirs.every(
          (sessionsDir) =>
            typeof sessionsDir === "string" && sessionsDir.trim().length > 0,
        ))) &&
    (value.sessionsDir !== undefined || value.sessionsDirs !== undefined) &&
    typeof value.rgTimeoutMs === "number" &&
    Number.isInteger(value.rgTimeoutMs) &&
    value.rgTimeoutMs >= 1
  );
}

const SEARCH_SESSIONS_CONFIG_SCHEMA: ExtensionConfigSchema<SearchSessionsExtConfig> =
  {
    validate: isSearchSessionsConfig,
  };

const DEFAULT_EXTENSION_DEPS: SearchSessionsExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function resolveSessionsDirs(config: SearchSessionsExtConfig): string[] {
  const configured = config.sessionsDir
    ? [config.sessionsDir]
    : (config.sessionsDirs ?? CONFIG_DEFAULTS.sessionsDirs!);
  return [
    ...new Set(
      configured.map((sessionsDir) =>
        path.resolve(sessionsDir.replace(/^~(?=$|\/)/, os.homedir())),
      ),
    ),
  ];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const claimed = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (claimed.has(identity)) return false;
    claimed.add(identity);
    return true;
  });
}

function claimCanonicalSessionFiles(sessionFiles: string[]): string[] {
  const claimed = new Set<string>();
  return sessionFiles.filter((sessionFile) => {
    try {
      const fd = fs.openSync(sessionFile, "r");
      const buffer = Buffer.alloc(64 * 1024);
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const firstLine = buffer.subarray(0, bytesRead).toString().split("\n")[0];
      if (!firstLine) return true;
      const header = JSON.parse(firstLine);
      if (header.type !== "session" || typeof header.id !== "string")
        return true;
      if (claimed.has(header.id)) return false;
      claimed.add(header.id);
    } catch {
      return true;
    }
    return true;
  });
}

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

// --- search filtering ---

function matchesKeyword(branch: BranchResult, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  if (branch.sessionName.toLowerCase().includes(lower)) return true;
  if (branch.searchableText.toLowerCase().includes(lower)) return true;
  return false;
}

function matchesFile(branch: BranchResult, fileQuery: string): boolean {
  const lower = fileQuery.toLowerCase();
  return branch.filesTouched.some((f) => f.toLowerCase().includes(lower));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDate(dateStr: string): Date | null {
  // support ISO dates and relative (7d, 2w)
  const relMatch = dateStr.trim().match(/^(\d+)([dw])$/);
  if (relMatch && relMatch[1] && relMatch[2]) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === "d") now.setDate(now.getDate() - n);
    else if (unit === "w") now.setDate(now.getDate() - n * 7);
    return now;
  }
  if (!ISO_DATE.test(dateStr.trim())) return null;
  const d = new Date(dateStr.trim());
  return isNaN(d.getTime()) ? null : d;
}

function matchesDateRange(
  branch: BranchResult,
  after: Date | null,
  before: Date | null,
): boolean {
  if (after && new Date(branch.timestampEnd) < after) return false;
  if (before && new Date(branch.timestampStart) > before) return false;
  return true;
}

// --- rg pre-filter ---

function rgFilterFiles(
  keyword: string,
  sessionsDir: string,
  timeoutMs: number,
): Set<string> | null {
  try {
    const result = execSync(
      `rg -l -i ${JSON.stringify(keyword)} ${JSON.stringify(sessionsDir)}`,
      { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs },
    )
      .toString()
      .trim();
    if (!result) return new Set();
    return new Set(result.split("\n").filter(Boolean));
  } catch {
    // rg not found or no matches — fall back to no filtering
    return null;
  }
}

// --- format results ---

function formatBranchResults(
  branches: BranchResult[],
  total = branches.length,
): {
  text: string;
  headerLineIndices: number[];
} {
  if (branches.length === 0)
    return { text: "(no matching sessions found)", headerLineIndices: [] };

  const lines: string[] = [];
  const headerLineIndices: number[] = [];

  const half = Math.floor(branches.length / 2);
  lines.push(
    total > branches.length
      ? `found ${total} matching branches; showing the ${half} newest and ${branches.length - half} oldest ` +
          `(${total - branches.length} in between omitted — narrow with keyword, file, after or before):`
      : `found ${total} matching branch${total !== 1 ? "es" : ""}:`,
  );
  lines.push("");

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    if (!b) continue;
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    headerLineIndices.push(lines.length);
    lines.push(`### ${i + 1}. ${b.sessionName || "(unnamed)"}`);
    lines.push(`session: ${b.sessionId} / branch: ${b.leafId}`);
    if (b.parentSessionPath) {
      // extract session id from path (filename without extension)
      const parentId =
        b.parentSessionPath
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "")
          ?.split("_")[1] || b.parentSessionPath;
      lines.push(`forked from: ${parentId}`);
    }
    lines.push(`${dateStr} ${timeStr} — ${b.messageCount} messages`);
    if (b.models.length > 0) lines.push(`models: ${b.models.join(", ")}`);
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push(
        `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
      );
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push(`> ${preview}`);
    }

    if (i < branches.length - 1) lines.push("");
  }

  return { text: lines.join("\n"), headerLineIndices };
}

/** convert branch results to BoxSections for box-format rendering */
function branchesToSections(branches: BranchResult[]): BoxSection[] {
  return branches.map((b, i) => {
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const lines: { text: string; highlight?: boolean }[] = [];
    lines.push({
      text: `session: ${b.sessionId} / branch: ${b.leafId}`,
      highlight: true,
    });
    if (b.parentSessionPath) {
      const parentId =
        b.parentSessionPath
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "")
          ?.split("_")[1] || b.parentSessionPath;
      lines.push({ text: `forked from: ${parentId}`, highlight: true });
    }
    lines.push({
      text: `${dateStr} ${timeStr} — ${b.messageCount} messages`,
      highlight: true,
    });
    if (b.models.length > 0)
      lines.push({ text: `models: ${b.models.join(", ")}`, highlight: true });
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push({
        text: `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
        highlight: true,
      });
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push({ text: `> ${preview}`, highlight: false });
    }

    return {
      header: b.sessionName || `session ${i + 1}`,
      blocks: [{ lines }],
    };
  });
}

// --- tool ---

interface SearchSessionsParams {
  keyword?: string;
  file?: string;
  after?: string;
  before?: string;
  workspace?: string;
  all_workspaces?: boolean;
}

export function createSearchSessionsTool(
  config: SearchSessionsExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<any> {
  const sessionsDirs = resolveSessionsDirs(config);
  return {
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "Search pi session history by keyword, file path, or date range.\n\n" +
      "Sessions are trees with branches. Each branch (root-to-leaf path) is a " +
      "separate search result with its own files-touched set and message chain.\n\n" +
      "Scoped to current workspace by default. Use `all_workspaces: true` to search everywhere.\n\n" +
      "Use `read_session` to extract detailed content from a specific session.\n\n" +
      "WHEN TO USE:\n" +
      '- "Find the session where I worked on X"\n' +
      '- "What session touched this file?"\n' +
      '- "Show recent sessions"\n' +
      "- Looking up prior context from past conversations\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Current session context (already available)\n" +
      "- Git history (use git log)",

    parameters: Type.Object({
      keyword: Type.Optional(
        Type.String({
          description:
            "Text to search for in session names, user messages, and assistant responses.",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            "File path (partial match) to find sessions that touched this file.",
        }),
      ),
      after: Type.Optional(
        Type.String({
          description:
            "Only return sessions after this date. ISO date (2026-02-20) or relative (7d, 2w).",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description:
            "Only return sessions before this date. ISO date or relative.",
        }),
      ),
      workspace: Type.Optional(
        Type.String({
          description:
            "Filter by workspace path (partial match against session cwd). Defaults to current workspace.",
        }),
      ),
      all_workspaces: Type.Optional(
        Type.Boolean({
          description:
            "Search across all workspaces instead of just the current one.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as SearchSessionsParams;
      const dates: Record<"after" | "before", Date | null> = { after: null, before: null };
      for (const key of ["after", "before"] as const) {
        const raw = p[key];
        if (!raw) continue;
        dates[key] = parseDate(raw);
        if (!dates[key]) {
          return {
            content: [{
              type: "text" as const,
              text: `invalid ${key} date ${JSON.stringify(raw)}: use an ISO date (2026-02-20, 2026-02-20T14:30) or a relative age (7d, 2w).`,
            }],
            isError: true,
          } as any;
        }
      }
      const existingDirs = sessionsDirs.filter((sessionsDir) =>
        fs.existsSync(sessionsDir),
      );
      if (existingDirs.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "(no sessions directory found)" },
          ],
        } as any;
      }

      // 1. glob all session files
      let sessionFiles: string[] = [];
      try {
        sessionFiles = [
          ...new Set(
            existingDirs.flatMap((sessionsDir) =>
              listSessionFiles(sessionsDir),
            ),
          ),
        ];
        sessionFiles = claimCanonicalSessionFiles(sessionFiles);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "(could not read sessions directory)",
            },
          ],
          isError: true,
        } as any;
      }

      if (sessionFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: "(no sessions found)" }],
        } as any;
      }

      // 2. rg pre-filter if keyword set
      if (p.keyword) {
        const matchesByDir = existingDirs.map((sessionsDir) =>
          rgFilterFiles(p.keyword!, sessionsDir, config.rgTimeoutMs),
        );
        if (matchesByDir.every((matches) => matches !== null)) {
          const matches = new Set(
            matchesByDir.flatMap((result) => [...result!]),
          );
          sessionFiles = sessionFiles.filter((f) => matches.has(f));
        }
      }

      // 3. cheap date pre-filter. `after` is about the LAST activity, which the
      // filename (session start) cannot tell, so it uses the file's mtime.
      if (dates.after || dates.before) {
        sessionFiles = sessionFiles.filter((f) => {
          if (dates.after) {
            try {
              if (fs.statSync(f).mtimeMs < dates.after.getTime()) return false;
            } catch {}
          }
          if (dates.before) {
            // format: 2026-02-20T14-50-17-926Z_uuid.jsonl
            const tsMatch = path.basename(f).match(/^(\d{4}-\d{2}-\d{2})T/);
            if (tsMatch?.[1] && new Date(tsMatch[1]) > dates.before) return false;
          }
          return true;
        });
      }

      // 4. parse and enumerate branches
      const allBranches: BranchResult[] = [];

      // workspace filter: default to current cwd unless all_workspaces is set
      const workspaceFilter = p.all_workspaces
        ? undefined
        : p.workspace || ctx.cwd;

      for (const file of sessionFiles) {
        const { header, entries, sessionName } = parseSessionFile(file);
        if (!header) continue;

        // workspace filter
        if (
          workspaceFilter &&
          !header.cwd.toLowerCase().includes(workspaceFilter.toLowerCase())
        ) {
          continue;
        }

        const branches = enumerateBranches(header, entries, sessionName, file);
        allBranches.push(...branches);
      }
      const uniqueBranches = uniqueBy(
        allBranches,
        (branch) => `${branch.sessionId}\0${branch.leafId}`,
      );

      // 5. filter branches
      let filtered = uniqueBranches;

      if (p.keyword) {
        filtered = filtered.filter((b) => matchesKeyword(b, p.keyword!));
      }
      if (p.file) {
        filtered = filtered.filter((b) => matchesFile(b, p.file!));
      }
      if (p.after || p.before) {
        filtered = filtered.filter((b) =>
          matchesDateRange(b, dates.after, dates.before),
        );
      }

      // 6. sort by most recent leaf timestamp
      filtered.sort(
        (a, b) =>
          new Date(b.timestampEnd).getTime() -
          new Date(a.timestampEnd).getTime(),
      );

      // 7. format with head+tail truncation
      const shown =
        filtered.length > config.maxResults
          ? [
              ...filtered.slice(0, Math.floor(config.maxResults / 2)),
              ...filtered.slice(-Math.floor(config.maxResults / 2)),
            ]
          : filtered;
      const truncated =
        filtered.length > config.maxResults
          ? filtered.length - shown.length
          : 0;

      const { text: output } = formatBranchResults(shown, filtered.length);
      const resultSections = branchesToSections(shown);

      return {
        content: [{ type: "text" as const, text: output }],
        details: { resultSections, truncated },
      } as any;
    },

    renderCall(args: any, theme: any) {
      const parts: string[] = [];
      if (args.keyword) parts.push(args.keyword);
      if (args.file) parts.push(`file:${args.file}`);
      if (args.after) parts.push(`after:${args.after}`);
      if (args.before) parts.push(`before:${args.before}`);
      if (args.workspace) parts.push(`ws:${args.workspace}`);
      const preview = parts.join(" ") || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("search_sessions ")) +
          theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length)
        return new Text(result.content?.[0]?.text ?? "(no output)", 0, 0);

      const truncated: number = result.details?.truncated ?? 0;
      const notices =
        truncated > 0 ? [`${truncated} sessions omitted`] : undefined;

      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        notices,
        expanded,
      );
    },
  };
}

