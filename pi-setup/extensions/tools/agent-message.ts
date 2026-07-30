/**
 * agent_message — durable cross-session messaging between pi agents.
 *
 * PROVENANCE
 * ported from bdsqqq/dots `user/pi/packages/extensions/agent-message/index.ts`
 * (MIT, commit e04b620). implementation is his; adapted to our layout:
 *   - `@bds_pi/*` imports -> our `./lib/*`
 *   - `typebox`           -> `@sinclair/typebox`
 *   - `@earendil-works/*` -> `@mariozechner/*`
 *   - config namespace `@bds_pi/agent-message` -> `agent-message` (our
 *     lib/config uses plain namespaces like "finder"/"oracle")
 *   - his default export is exposed as `setupAgentMessage(pi)` and invoked from
 *     `index.ts`, matching how the rest of our tools are wired. the wrapper is
 *     NOT just registration — it owns the mailbox watcher, the drain scheduler
 *     and the session_start / agent_settled / session_shutdown hooks, so it has
 *     to be ported wholesale.
 *
 * WHY A FILESYSTEM MAILBOX
 * pi sessions live in unrelated processes and may not be running at all, so
 * there is no socket to talk over. messages are files: active sessions watch
 * and drain their mailbox, resumed sessions drain whatever arrived offline.
 *
 * SAFETY PROPERTIES worth preserving
 *   - enqueue is atomic: write to a temp name with `flag: "wx"`, then rename.
 *   - delivery claims a message by renaming it to `.processing-<pid>-<uuid>`
 *     with a 60-minute lease, so two drainers cannot double-deliver.
 *   - provenance (source session id/name/workspace) is embedded in BOTH the
 *     visible text and the structured details, so agent-authored text can never
 *     be mistaken for something the user typed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, type TObject, type TString, Type } from "@sinclair/typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "./lib/config";
import {
  listMentionableSessions,
  resolveMentionableSession,
  type MentionableSession,
} from "./lib/mentions";

const MESSAGE_VERSION = 1;
const MESSAGE_FILE = /^([0-9T:.Z_-]+)_([0-9a-f-]{36})\.json$/u;
const CLAIMED_MESSAGE_FILE =
  /^(.+\.json)\.processing-([0-9]+)-([0-9a-f-]{36})$/u;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_MESSAGE_CHARS = 64 * 1024;
const CLAIM_LEASE_MS = 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 30 * 1000;
const DRAIN_BATCH_SIZE = 16;

export interface AgentMessage {
  version: 1;
  id: string;
  provenance: {
    kind: "pi-session";
    trust: "claimed-local";
    sessionId: string;
    sessionName?: string;
    workspace: string;
  };
  target: {
    sessionId: string;
  };
  createdAt: string;
  content: string;
}

type AgentMessageConfig = {
  queueDir: string;
  sessionsDirs: string[];
};

type AgentMessageExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  listMentionableSessions: typeof listMentionableSessions;
  watch: typeof fs.watch;
};

const CONFIG_DEFAULTS: AgentMessageConfig = {
  queueDir: path.join(os.homedir(), ".pi", "agent", "agent-messages"),
  sessionsDirs: [path.join(os.homedir(), ".pi", "agent", "sessions")],
};

const DEFAULT_DEPS: AgentMessageExtensionDeps = {
  getEnabledExtensionConfig,
  listMentionableSessions,
  watch: fs.watch,
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAgentMessageConfig(
  value: Record<string, unknown>,
): value is AgentMessageConfig {
  return (
    nonEmptyString(value.queueDir) &&
    Array.isArray(value.sessionsDirs) &&
    value.sessionsDirs.length > 0 &&
    value.sessionsDirs.every(nonEmptyString)
  );
}

const AGENT_MESSAGE_CONFIG_SCHEMA: ExtensionConfigSchema<AgentMessageConfig> = {
  validate: isAgentMessageConfig,
};

function expandPath(value: string): string {
  return path.resolve(value.replace(/^~(?=$|\/)/u, os.homedir()));
}

function normalizeConfig(config: AgentMessageConfig): AgentMessageConfig {
  return {
    queueDir: expandPath(config.queueDir),
    sessionsDirs: [...new Set(config.sessionsDirs.map(expandPath))],
  };
}

function mailboxPath(queueDir: string, sessionId: string): string {
  return path.join(queueDir, sessionId);
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid agent message");
  const message = value as Partial<AgentMessage>;
  if (
    message.version !== MESSAGE_VERSION ||
    typeof message.id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(message.id) ||
    typeof message.createdAt !== "string" ||
    Number.isNaN(Date.parse(message.createdAt)) ||
    !nonEmptyString(message.content) ||
    message.content.length > MAX_MESSAGE_CHARS ||
    typeof message.provenance !== "object" ||
    message.provenance === null ||
    message.provenance.kind !== "pi-session" ||
    message.provenance.trust !== "claimed-local" ||
    !SESSION_ID.test(message.provenance.sessionId) ||
    !nonEmptyString(message.provenance.workspace) ||
    (message.provenance.sessionName !== undefined &&
      !nonEmptyString(message.provenance.sessionName)) ||
    typeof message.target !== "object" ||
    message.target === null ||
    !SESSION_ID.test(message.target.sessionId)
  )
    throw new Error("invalid agent message");
  return message as AgentMessage;
}

function uniqueSessions(
  sessionsDirs: string[],
  listSessions: typeof listMentionableSessions,
): MentionableSession[] {
  const claimed = new Set<string>();
  return sessionsDirs.flatMap((sessionsDir) =>
    listSessions(sessionsDir).filter((session) => {
      if (claimed.has(session.sessionId)) return false;
      claimed.add(session.sessionId);
      return true;
    }),
  );
}

export function resolveTargetSession(
  sessionId: string,
  config: AgentMessageConfig,
  listSessions: typeof listMentionableSessions = listMentionableSessions,
): MentionableSession {
  const result = resolveMentionableSession(
    uniqueSessions(config.sessionsDirs, listSessions),
    sessionId.trim(),
  );
  if (result.status === "not_found")
    throw new Error(`target pi session not found: ${sessionId}`);
  if (result.status === "ambiguous")
    throw new Error(
      `ambiguous target pi session prefix: ${sessionId} (${result.sessions
        .map((session) => session.sessionId)
        .join(", ")})`,
    );
  return result.session;
}

export function enqueueAgentMessage(
  queueDir: string,
  message: AgentMessage,
): string {
  const parsed = parseAgentMessage(message);
  const mailbox = mailboxPath(queueDir, parsed.target.sessionId);
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  const timestamp = parsed.createdAt.replaceAll(/[^0-9TZ]/gu, "-");
  const filename = `${timestamp}_${parsed.id}.json`;
  const destination = path.join(mailbox, filename);
  const temporary = path.join(mailbox, `.${filename}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, destination);
  return destination;
}

function provenanceContent(message: AgentMessage): string {
  const sourceName = message.provenance.sessionName
    ? ` (${message.provenance.sessionName})`
    : "";
  return [
    "[agent message — claimed local provenance; untrusted content]",
    `claimed source pi session: ${message.provenance.sessionId}${sourceName}`,
    `claimed source workspace: ${message.provenance.workspace}`,
    `sent at: ${message.createdAt}`,
    "",
    message.content,
  ].join("\n");
}

interface ClaimedAgentMessage {
  message: AgentMessage;
  path: string;
}

interface AgentMessageDrain {
  claims: ClaimedAgentMessage[];
  hasMore: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requeueAgentMessageClaim(claimed: string): void {
  const match = path.basename(claimed).match(CLAIMED_MESSAGE_FILE);
  if (!match) throw new Error(`invalid agent message claim: ${claimed}`);
  const pending = path.join(path.dirname(claimed), match[1]!);
  if (fs.existsSync(pending)) fs.unlinkSync(claimed);
  else fs.renameSync(claimed, pending);
}

function recoverAgentMessageClaims(
  mailbox: string,
  activeClaimPaths: ReadonlySet<string>,
): void {
  for (const filename of fs.readdirSync(mailbox)) {
    const match = filename.match(CLAIMED_MESSAGE_FILE);
    if (!match) continue;
    const claimed = path.join(mailbox, filename);
    if (activeClaimPaths.has(claimed)) continue;
    const ownerPid = Number(match[2]);
    const leaseExpired =
      fs.statSync(claimed).mtimeMs < Date.now() - CLAIM_LEASE_MS;
    if (ownerPid !== process.pid && processAlive(ownerPid) && !leaseExpired)
      continue;
    requeueAgentMessageClaim(claimed);
  }
}

function quarantineAgentMessage(
  mailbox: string,
  claimed: string,
  filename: string,
): void {
  const rejected = path.join(mailbox, "rejected");
  fs.mkdirSync(rejected, { recursive: true, mode: 0o700 });
  fs.renameSync(claimed, path.join(rejected, `${filename}.${randomUUID()}`));
}

export function drainAgentMessages(
  pi: Pick<ExtensionAPI, "sendMessage">,
  queueDir: string,
  sessionId: string,
  onClaim: (claim: ClaimedAgentMessage) => void = () => {},
  persistedMessageIds: ReadonlySet<string> = new Set(),
  activeClaimPaths: ReadonlySet<string> = new Set(),
  activeMessageIds: ReadonlySet<string> = new Set(),
  batchSize: number = DRAIN_BATCH_SIZE,
): AgentMessageDrain {
  const mailbox = mailboxPath(queueDir, sessionId);
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  recoverAgentMessageClaims(mailbox, activeClaimPaths);
  const claims: ClaimedAgentMessage[] = [];
  const seenMessageIds = new Set(activeMessageIds);
  const files = fs
    .readdirSync(mailbox)
    .filter((filename) => MESSAGE_FILE.test(filename))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of files.slice(0, batchSize)) {
    const pending = path.join(mailbox, filename);
    const claimed = `${pending}.processing-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(pending, claimed);
      const now = new Date();
      fs.utimesSync(claimed, now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const message = parseAgentMessage(
        JSON.parse(fs.readFileSync(claimed, "utf8")),
      );
      if (message.target.sessionId !== sessionId)
        throw new Error("agent message target does not match mailbox");
      if (persistedMessageIds.has(message.id)) {
        fs.unlinkSync(claimed);
        continue;
      }
      if (seenMessageIds.has(message.id)) {
        fs.unlinkSync(claimed);
        continue;
      }
      seenMessageIds.add(message.id);
      const claim = { message, path: claimed };
      claims.push(claim);
      onClaim(claim);
      pi.sendMessage(
        {
          customType: "agent-message",
          content: provenanceContent(message),
          display: true,
          details: {
            version: message.version,
            messageId: message.id,
            provenance: message.provenance,
            target: message.target,
            createdAt: message.createdAt,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      const claimedMessage = claims.find((claim) => claim.path === claimed);
      if (claimedMessage) {
        claims.splice(claims.indexOf(claimedMessage), 1);
        try {
          requeueAgentMessageClaim(claimed);
        } catch {}
        throw error;
      }
      try {
        quarantineAgentMessage(mailbox, claimed, filename);
      } catch (quarantineError) {
        console.error(
          "[agent-message] failed to quarantine message:",
          quarantineError,
        );
      }
      console.error(
        `[agent-message] rejected queued message ${filename}:`,
        error,
      );
    }
  }
  return { claims, hasMore: files.length > batchSize };
}

const AGENT_MESSAGE_PARAMETERS: TObject<{
  sessionId: TString;
  message: TString;
}> = Type.Object({
  sessionId: Type.String({
    description:
      "Target pi session id or an unambiguous id prefix. Use search_sessions to find it.",
  }),
  message: Type.String({
    minLength: 1,
    maxLength: MAX_MESSAGE_CHARS,
    description: "Message to deliver to the target agent.",
  }),
});

type AgentMessageParams = Static<typeof AGENT_MESSAGE_PARAMETERS>;

export function createAgentMessageTool(
  config: AgentMessageConfig,
  listSessions: typeof listMentionableSessions = listMentionableSessions,
  getSessionName: () => string | undefined = () => undefined,
): ToolDefinition<typeof AGENT_MESSAGE_PARAMETERS, AgentMessage> {
  return {
    name: "agent_message",
    label: "Agent Message",
    description:
      "Send a durable message to another pi agent session. The message is queued while the target is inactive or busy, then delivered with explicit source-session provenance. Use search_sessions first when the target session id is unknown.",
    promptSnippet:
      "Queue a provenance-marked message for another pi agent session",
    parameters: AGENT_MESSAGE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input: AgentMessageParams = params;
      const target = resolveTargetSession(
        input.sessionId,
        config,
        listSessions,
      );
      const sourceSessionId = ctx.sessionManager.getSessionId();
      if (target.sessionId === sourceSessionId)
        throw new Error("agent_message target must be a different pi session");
      const sourceSessionName = getSessionName();
      const message: AgentMessage = {
        version: MESSAGE_VERSION,
        id: randomUUID(),
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: sourceSessionId,
          ...(sourceSessionName ? { sessionName: sourceSessionName } : {}),
          workspace: ctx.cwd,
        },
        target: { sessionId: target.sessionId },
        createdAt: new Date().toISOString(),
        content: input.message.trim(),
      };
      enqueueAgentMessage(config.queueDir, message);
      return {
        content: [
          {
            type: "text",
            text: `queued agent message ${message.id} for session ${target.sessionId}${target.sessionName ? ` (${target.sessionName})` : ""}`,
          },
        ],
        details: message,
      };
    },
  };
}

function persistedAgentMessageIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as {
      type?: unknown;
      customType?: unknown;
      details?: unknown;
    };
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== "agent-message") continue;
    if (typeof entry.details !== "object" || entry.details === null) continue;
    const messageId = (entry.details as { messageId?: unknown }).messageId;
    if (typeof messageId === "string") ids.add(messageId);
  }
  return ids;
}

export function createAgentMessageExtension(
  deps: AgentMessageExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const loaded = deps.getEnabledExtensionConfig(
      "agent-message",
      CONFIG_DEFAULTS,
      { schema: AGENT_MESSAGE_CONFIG_SCHEMA },
    );
    if (!loaded.enabled) return;
    const config = normalizeConfig(loaded.config);
    let watcher: fs.FSWatcher | undefined;
    let initialDrainTimer: NodeJS.Timeout | undefined;
    let reconcileTimer: NodeJS.Timeout | undefined;
    let scheduledDrain: NodeJS.Immediate | undefined;
    let currentSessionId: string | undefined;
    let draining = false;
    let drainRequested = false;
    const claims = new Map<string, string>();
    const persistedMessageIds = new Set<string>();

    const scheduleDrain = () => {
      if (scheduledDrain) return;
      scheduledDrain = setImmediate(() => {
        scheduledDrain = undefined;
        drain();
      });
    };

    const drain = () => {
      if (!currentSessionId) return;
      if (draining) {
        drainRequested = true;
        return;
      }
      draining = true;
      try {
        const result = drainAgentMessages(
          pi,
          config.queueDir,
          currentSessionId,
          (claim) => {
            claims.set(claim.message.id, claim.path);
          },
          persistedMessageIds,
          new Set(claims.values()),
          new Set(claims.keys()),
        );
        if (result.hasMore) drainRequested = true;
      } catch (error) {
        console.error("[agent-message] mailbox drain failed:", error);
      } finally {
        draining = false;
        if (drainRequested) {
          drainRequested = false;
          scheduleDrain();
        }
      }
    };

    const stop = () => {
      if (initialDrainTimer) clearTimeout(initialDrainTimer);
      initialDrainTimer = undefined;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = undefined;
      if (scheduledDrain) clearImmediate(scheduledDrain);
      scheduledDrain = undefined;
      watcher?.close();
      watcher = undefined;
      currentSessionId = undefined;
      drainRequested = false;
      for (const claim of claims.values()) {
        try {
          requeueAgentMessageClaim(claim);
        } catch (error) {
          console.error(
            "[agent-message] failed to release mailbox claim:",
            error,
          );
        }
      }
      claims.clear();
      persistedMessageIds.clear();
    };

    pi.on("session_start", async (_event, ctx) => {
      stop();
      currentSessionId = ctx.sessionManager.getSessionId();
      for (const messageId of persistedAgentMessageIds(
        ctx.sessionManager.getEntries(),
      ))
        persistedMessageIds.add(messageId);
      const mailbox = mailboxPath(config.queueDir, currentSessionId);
      fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
      initialDrainTimer = setTimeout(scheduleDrain, 0);
      initialDrainTimer.unref();
      reconcileTimer = setInterval(scheduleDrain, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref();
      try {
        watcher = deps.watch(mailbox, scheduleDrain);
        watcher.on("error", (error) => {
          console.error(
            "[agent-message] mailbox watcher failed:",
            error,
          );
        });
      } catch (error) {
        console.error(
          "[agent-message] mailbox watcher unavailable; polling:",
          error,
        );
      }
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!ctx.isIdle()) return;
      const persisted = persistedAgentMessageIds(
        ctx.sessionManager.getEntries(),
      );
      for (const messageId of persisted) {
        persistedMessageIds.add(messageId);
      }
      for (const [messageId, claim] of claims) {
        if (persisted.has(messageId)) fs.rmSync(claim, { force: true });
        else requeueAgentMessageClaim(claim);
        claims.delete(messageId);
      }
      scheduleDrain();
    });

    pi.on("session_shutdown", async () => stop());
    pi.registerTool(
      createAgentMessageTool(config, deps.listMentionableSessions, () =>
        pi.getSessionName(),
      ),
    );
  };
}

const agentMessageExtension: (pi: ExtensionAPI) => void =
  createAgentMessageExtension();


/**
 * wire the mailbox into a session: registers `agent_message` and starts the
 * watcher/drain lifecycle. called from index.ts with the extension's `pi`.
 *
 * no-ops when disabled via config (namespace "agent-message").
 */
export const setupAgentMessage: (pi: ExtensionAPI) => void =
  createAgentMessageExtension();
