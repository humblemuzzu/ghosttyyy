#!/usr/bin/env bun
// import-opencode-sessions.ts — Import opencode sessions into pi's JSONL format.
// Usage: bun run pi-setup/tools/import-opencode-sessions.ts [--db <path>] [--dry-run]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
const dbPath =
  dbIdx !== -1 && args[dbIdx + 1]
    ? args[dbIdx + 1]
    : join(homedir(), ".local/share/opencode/opencode.db");
const sessionsRoot = join(homedir(), ".pi/agent/sessions");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuidV4(): string {
  return crypto.randomUUID();
}

/** Convert an absolute cwd path to pi's directory slug.
 *  /Users/muzammil/Documents/Code stuff/ghosttyyy
 *  → --Users-muzammil-Documents-Code stuff-ghosttyyy-- */
function cwdToSlug(cwd: string): string {
  const stripped = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  const dashed = stripped.replaceAll("/", "-");
  return `--${dashed}--`;
}

/** Format epoch ms → pi filename timestamp (ISO with :-. replaced by -). */
function toFileTimestamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

/** Format epoch ms → ISO string. */
function toISO(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Map opencode finish reason → pi stopReason. */
function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "stop":
      return "endTurn";
    case "tool-calls":
    case "tool-call":
    case "tool_use":
      return "toolUse";
    case "length":
    case "max_tokens":
      return "maxTokens";
    default:
      return "endTurn";
  }
}

/** Map opencode provider to pi API type string. */
function mapApi(provider: string | null | undefined): string {
  switch (provider) {
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "openai":
    case "opencode":
    case "lmstudio":
    case "local-llama":
    case "local":
    default:
      return "openai-completions";
  }
}

// ---------------------------------------------------------------------------
// Types for opencode DB rows
// ---------------------------------------------------------------------------

interface OcSession {
  id: string;
  directory: string;
  title: string | null;
  time_created: number;
  time_archived: number | null;
}

interface OcMessage {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OcPart {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface OcMessageData {
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
  finish?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

interface OcPartData {
  type: string;
  text?: string;
  callID?: string;
  tool?: string;
  synthetic?: boolean;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
}

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

type JEntry = Record<string, unknown>;

function sessionHeader(
  uuid: string,
  ts: string,
  cwd: string,
): JEntry {
  return { type: "session", version: 3, id: uuid, timestamp: ts, cwd };
}

function modelChange(
  id: string,
  parentId: string | null,
  ts: string,
  provider: string,
  modelId: string,
): JEntry {
  return { type: "model_change", id, parentId, timestamp: ts, provider, modelId };
}

function sessionInfo(
  id: string,
  parentId: string,
  ts: string,
  name: string,
): JEntry {
  return { type: "session_info", id, parentId, timestamp: ts, name };
}

function userMessage(
  id: string,
  parentId: string,
  ts: string,
  text: string,
  epochMs: number,
): JEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: epochMs,
    },
  };
}

function assistantMessage(
  id: string,
  parentId: string,
  ts: string,
  content: unknown[],
  meta: OcMessageData,
  epochMs: number,
): JEntry {
  const tokens = meta.tokens ?? {};
  const cache = tokens.cache ?? {};
  const inputTokens = tokens.input ?? 0;
  const outputTokens = tokens.output ?? 0;
  const cacheRead = cache.read ?? 0;
  const cacheWrite = cache.write ?? 0;
  const totalTokens = tokens.total ?? inputTokens + outputTokens + cacheRead + cacheWrite;

  return {
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role: "assistant",
      content,
      api: mapApi(meta.providerID),
      provider: meta.providerID ?? "unknown",
      model: meta.modelID ?? "unknown",
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: meta.cost ?? 0,
        },
      },
      stopReason: mapStopReason(meta.finish),
      timestamp: epochMs,
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string,
  ts: string,
  toolCallId: string,
  toolName: string,
  output: string,
  isError: boolean,
  input: Record<string, unknown>,
  epochMs: number,
): JEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: output }],
      details: input,
      isError,
      timestamp: epochMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convertSession(
  session: OcSession,
  messages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
): string[] | null {
  // Skip empty sessions (no messages at all)
  if (messages.length === 0) return null;

  const cwd = session.directory || "/";
  const sessionUuid = uuidV4();
  const sessionTs = toISO(session.time_created);
  const lines: string[] = [];

  // Track the first model we encounter for the model_change entry
  let firstProvider: string | null = null;
  let firstModel: string | null = null;

  // Scan messages for first model info
  for (const msg of messages) {
    const data: OcMessageData = JSON.parse(msg.data);
    if (data.providerID && data.modelID) {
      firstProvider = data.providerID;
      firstModel = data.modelID;
      break;
    }
  }

  // 1. Session header
  lines.push(JSON.stringify(sessionHeader(sessionUuid, sessionTs, cwd)));

  // 2. Model change
  let lastId: string | null = null;
  if (firstProvider && firstModel) {
    const mcId = hexId();
    lines.push(
      JSON.stringify(modelChange(mcId, null, sessionTs, firstProvider, firstModel)),
    );
    lastId = mcId;
  }

  // 3. Session info with name
  const name = session.title
    ? `[opencode] ${session.title}`
    : `[opencode] Session ${new Date(session.time_created).toISOString().slice(0, 10)}`;
  const siId = hexId();
  lines.push(
    JSON.stringify(
      sessionInfo(siId, lastId ?? hexId(), sessionTs, name),
    ),
  );
  lastId = siId;

  // 4. Process messages in chronological order
  for (const msg of messages) {
    const data: OcMessageData = JSON.parse(msg.data);
    const parts = partsByMsg.get(msg.id) ?? [];
    const msgTs = toISO(msg.time_created);
    const msgEpoch = msg.time_created;

    if (data.role === "user") {
      // Collect text parts for user message
      let userText = "";
      for (const p of parts) {
        const pd: OcPartData = JSON.parse(p.data);
        if (pd.type === "text" && pd.text) {
          if (userText) userText += "\n";
          userText += pd.text;
        }
      }
      if (!userText) userText = "(empty message)";

      const umId = hexId();
      lines.push(
        JSON.stringify(userMessage(umId, lastId!, msgTs, userText, msgEpoch)),
      );
      lastId = umId;
    } else if (data.role === "assistant") {
      // Build assistant content array and collect deferred tool results
      const content: unknown[] = [];
      const deferredToolResults: {
        callId: string;
        toolName: string;
        output: string;
        isError: boolean;
        input: Record<string, unknown>;
        epochMs: number;
      }[] = [];

      for (const p of parts) {
        const pd: OcPartData = JSON.parse(p.data);

        switch (pd.type) {
          case "text":
            if (pd.text && !pd.synthetic) {
              content.push({ type: "text", text: pd.text });
            }
            break;

          case "reasoning":
            if (pd.text) {
              content.push({ type: "thinking", text: pd.text });
            }
            break;

          case "tool":
            if (pd.callID && pd.tool && pd.state) {
              // Add toolCall to assistant content
              content.push({
                type: "toolCall",
                id: pd.callID,
                name: pd.tool,
                arguments: pd.state.input ?? {},
              });
              // Queue the tool result for after this assistant message
              const toolEpoch = pd.state.time?.end ?? p.time_created;
              deferredToolResults.push({
                callId: pd.callID,
                toolName: pd.tool,
                output: pd.state.output ?? "",
                isError: pd.state.status === "error",
                input: (pd.state.input ?? {}) as Record<string, unknown>,
                epochMs: toolEpoch,
              });
            }
            break;

          // Skip types that don't map to pi format
          case "step-start":
          case "step-finish":
          case "file":
          case "patch":
          case "compaction":
          case "agent":
          case "subtask":
          case "snapshot":
          case "retry":
            break;

          default:
            break;
        }
      }

      // If assistant has no content at all, add a placeholder
      if (content.length === 0 && deferredToolResults.length === 0) {
        content.push({ type: "text", text: "(no content)" });
      }

      const completedTs = data.time?.completed
        ? toISO(data.time.completed)
        : msgTs;
      const completedEpoch = data.time?.completed ?? msgEpoch;

      const amId = hexId();
      lines.push(
        JSON.stringify(
          assistantMessage(amId, lastId!, completedTs, content, data, completedEpoch),
        ),
      );
      lastId = amId;

      // Emit tool result entries
      for (const tr of deferredToolResults) {
        const trId = hexId();
        const trTs = toISO(tr.epochMs);
        lines.push(
          JSON.stringify(
            toolResultEntry(
              trId,
              lastId!,
              trTs,
              tr.callId,
              tr.toolName,
              tr.output,
              tr.isError,
              tr.input,
              tr.epochMs,
            ),
          ),
        );
        lastId = trId;
      }
    }
  }

  // If we only have header + model_change + session_info (no actual messages converted)
  // that means every message was empty — skip
  const nonHeaderLines = lines.length - (firstProvider ? 3 : 2);
  if (nonHeaderLines === 0) return null;

  return lines;
}

// ---------------------------------------------------------------------------
// Idempotency: check if an equivalent file already exists
// ---------------------------------------------------------------------------

function sessionAlreadyImported(
  targetDir: string,
  sessionTitle: string,
  timeCreated: number,
): boolean {
  if (!existsSync(targetDir)) return false;

  // The filename encodes the creation timestamp. If a file with the same
  // timestamp prefix exists, we consider it already imported.
  const tsPrefix = toFileTimestamp(timeCreated).slice(0, 19); // YYYY-MM-DDTHH-MM-SS

  try {
    const files = readdirSync(targetDir);
    for (const f of files) {
      if (f.startsWith(tsPrefix) && f.endsWith(".jsonl")) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("opencode → pi Session Importer");
  console.log("================================");
  console.log(`Database: ${dbPath}`);
  console.log(`Target:   ${sessionsRoot}/`);
  if (dryRun) console.log("Mode:     DRY RUN (no files written)");
  console.log();

  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // Open DB read-only. Use immutable flag to avoid WAL lock issues when
  // opencode might be running concurrently.
  const db = new Database(dbPath, { readonly: true });

  // Enable WAL mode reading (doesn't modify anything on readonly)
  try {
    db.exec("PRAGMA journal_mode=WAL");
  } catch {
    // readonly DB may reject PRAGMA writes — that's fine
  }

  // Fetch all non-archived sessions
  const sessions: OcSession[] = db
    .query(
      `SELECT id, directory, title, time_created, time_archived
       FROM session
       WHERE time_archived IS NULL OR time_archived = 0
       ORDER BY time_created ASC`,
    )
    .all() as OcSession[];

  console.log(`Found ${sessions.length} sessions to process.\n`);

  let imported = 0;
  let skippedEmpty = 0;
  let skippedDuplicate = 0;
  let errors = 0;

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const idx = `[${i + 1}/${sessions.length}]`;
    const displayTitle = session.title || "(untitled)";

    try {
      const slug = cwdToSlug(session.directory || "/tmp");
      const targetDir = join(sessionsRoot, slug);

      // Idempotency check
      if (sessionAlreadyImported(targetDir, displayTitle, session.time_created)) {
        skippedDuplicate++;
        continue;
      }

      // Fetch messages for this session
      const messages: OcMessage[] = db
        .query(
          `SELECT id, session_id, time_created, data
           FROM message
           WHERE session_id = ?
           ORDER BY time_created ASC`,
        )
        .all(session.id) as OcMessage[];

      // Fetch all parts for these messages in one query
      const partsByMsg = new Map<string, OcPart[]>();
      if (messages.length > 0) {
        const allParts: OcPart[] = db
          .query(
            `SELECT id, message_id, time_created, data
             FROM part
             WHERE session_id = ?
             ORDER BY time_created ASC`,
          )
          .all(session.id) as OcPart[];

        for (const part of allParts) {
          const existing = partsByMsg.get(part.message_id);
          if (existing) {
            existing.push(part);
          } else {
            partsByMsg.set(part.message_id, [part]);
          }
        }
      }

      const lines = convertSession(session, messages, partsByMsg);
      if (!lines) {
        skippedEmpty++;
        continue;
      }

      // Write the JSONL file
      if (!dryRun) {
        mkdirSync(targetDir, { recursive: true });
      }

      const filename = `${toFileTimestamp(session.time_created)}_${uuidV4()}.jsonl`;
      const filepath = join(targetDir, filename);

      if (!dryRun) {
        writeFileSync(filepath, lines.join("\n") + "\n");
      }

      console.log(`${idx} "${displayTitle}" → ${slug}/`);
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${idx} ERROR "${displayTitle}": ${msg}`);
      errors++;
    }
  }

  db.close();

  console.log();
  console.log(
    `Done! Imported: ${imported}, Skipped (empty): ${skippedEmpty}, ` +
      `Skipped (duplicate): ${skippedDuplicate}, Errors: ${errors}`,
  );
}

main();
