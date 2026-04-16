# AGENTS.md — Pi Setup Reference

> This file is read by pi and other coding agents at session start.
> It describes the full setup so agents understand the architecture,
> know what not to touch, and can safely apply upstream updates.

## Architecture Overview

This repo serves two purposes:
1. **Ghostty terminal config** — themes, fonts, scripts (see README.md)
2. **Portable pi (coding agent) setup** — full backup of all extensions, tools, skills, themes, config, and an installer

The pi setup lives in `pi-setup/` and is deployed to `~/.pi/agent/` via `pi-setup/install.sh`.

### Provider Chain

```
pi CLI (v0.67.1)
  └─ pi-claude-bridge (custom provider, registered as "claude-bridge")
       └─ @anthropic-ai/claude-agent-sdk (spawns Claude Code CLI subprocess)
            └─ Claude API
```

pi-claude-bridge is a third-party extension by Eli Dickinson that wraps the Claude Code Agent SDK. It registers a custom provider called `"claude-bridge"` that routes pi's LLM calls through Claude Code. Tools are exposed via an MCP server — Claude Code thinks it's calling MCP tools, but those tools are actually pi's native tools executed locally.

### System Prompt Assembly

The system prompt is assembled in layers:

1. **`brain-loader.ts`** — injects `~/Documents/brain/MEMORY.md`, `USER.md`, project memory, and update protocol
2. **`system-prompt.ts`** — loads `agents/prompt.amp.system.md` template, interpolates variables (`{identity}`, `{harness}`, `{date}`, `{cwd}`, `{roots}`, `{os}`, `{repo}`, `{sessionId}`, `{ls}`, `{harness_docs_section}`)
3. **`tool-harness.ts`** — env-gated tool filtering based on active workspace

---

## pi-claude-bridge: Custom Build

**Upstream:** https://github.com/elidickinson/pi-claude-bridge (v0.2.0)
**Our patched version:** `pi-setup/claude-bridge-patches/index.ts` (2063 lines)

### What We Changed From Upstream

Two system prompt modifications — both remove `preset: "claude_code"` so Claude Code doesn't load its own system prompt:

**1. Main provider (streamClaudeAgentSdk):**
```typescript
// Upstream:
systemPrompt: {
    type: "preset", preset: "claude_code",
    append: systemPromptAppend ? systemPromptAppend : undefined,
},
// Ours:
systemPrompt: systemPromptAppend || "",
```

**2. AskClaude tool:**
```typescript
// Upstream:
systemPrompt: skillsBlock
    ? { type: "preset", preset: "claude_code", append: skillsBlock }
    : undefined,
// Ours:
systemPrompt: skillsBlock || undefined,
```

### How to Re-Apply Patches After npm Update

When `npm update` or `pi update` overwrites the bridge file:

```bash
# The installed bridge lives here:
# /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts

# Re-apply our patches:
cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts

# Or run the full installer:
bash pi-setup/install.sh
```

### How to Merge Upstream Changes

When pi-claude-bridge gets updated upstream:

1. Clone latest: `git clone --depth 1 https://github.com/elidickinson/pi-claude-bridge.git /tmp/bridge-latest`
2. Copy to repo: `cp /tmp/bridge-latest/index.ts pi-setup/claude-bridge-patches/index.ts`
3. Re-apply the two `systemPrompt` patches described above (search for `preset: "claude_code"` and replace)
4. Update `pi-setup/claude-bridge-patches/package.json` version if it changed
5. Install: `cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts`
6. Commit the updated patched version
7. Clean up: `rm -rf /tmp/bridge-latest`

**Never skip step 3.** Without the patches, the bridge sends Claude Code's full system prompt, and the session management fixes may not work correctly with our setup.

### Key Upstream Fixes Included

The latest upstream (as of our patched version) includes these critical fixes:

- **`QueryContext` class (v0.2.0):** Replaces 12+ mutable `let` variables with a proper class and context stack. Fixes `deferredUserMessages` not being isolated across reentrant queries (subagent could consume parent's deferred steers). Adding new per-query state is now 1 property instead of 6 edit sites.
- **Stale cursor after tool-using first turn (issue #4, v0.2.0):** `latestCursor` now correctly advances past all tool_result blocks after the first turn uses tools.
- **Session resume on symlinked paths / CLAUDE_CONFIG_DIR (v0.2.0):** cc-session-io 0.3.1 resolves symlinks (realpathSync + NFC) and honors `CLAUDE_CONFIG_DIR`, matching how Claude Code resolves session paths. Fixes "No conversation found" on macOS symlinked dirs.
- **MCP handler context capture (v0.2.0):** Handlers now close over captured QueryContext, ensuring they operate on the correct query's state even across pushContext/popContext calls. Abort handler captures context at the correct point after push.
- **`repairToolPairing` moved to cc-session-io (v0.2.0):** Orphaned tool_use/tool_result pair repair is now in cc-session-io, shared with index.ts.
- **`latestCursor` (issue #4):** Module-level cursor tracking that prevents stale closures from breaking session resume after tool-using turns
- **`deleteSession` + `createSession`:** Session rebuild path that preserves sessionId while wiping corrupt session files
- **Post-abort UUID rotation:** Fresh sessionId after abort to avoid race conditions with killed subprocess writes
- **CLI debug capture:** `makeCliDebugOptions()` forwards CC CLI stderr and debug logs when `CLAUDE_BRIDGE_DEBUG=1`
- **Steer message handling:** Deferred user messages during tool execution are replayed as continuation queries
- **`ACTIVE_STREAM_SIMPLE_KEY` guard:** Prevents reentrant queries (subagents) from clobbering the parent's `streamSimple` registration

---

## Packages (npm)

| Package | Version | Purpose |
|---------|---------|---------|
| `@mariozechner/pi-coding-agent` | 0.67.3 | The pi agent itself (installed via homebrew npm) |
| `pi-claude-bridge` | 0.2.0 | Custom provider wrapping Claude Code Agent SDK |
| `pi-web-access` | 0.10.6 | Web access: read pages, search, GitHub API, librarian skill |
| `pi-context` | 1.1.3 | Context management: context_log, context_tag, context_checkout |
| `pi-token-burden` | 0.5.0 | Token usage tracking and display |
| `@marckrenn/pi-sub-bar` | 1.5.0 | Usage widget — shows provider quotas in status bar |
| `pi-autoresearch` | latest | Autonomous experiment loop for optimization targets (GitHub install) |

**Active in settings.json:** `pi-web-access`, `pi-context`, `pi-token-burden`, `pi-claude-bridge`, `@marckrenn/pi-sub-bar`, `pi-autoresearch`

**Installed but inactive:** `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`, `claude-agent-sdk-pi` (legacy, no longer in packages list)

---

## Extensions (14)

All live in `~/.pi/agent/extensions/`, backed up in `pi-setup/extensions/`.

| Extension | File | Purpose |
|-----------|------|---------|
| Brain Loader | `brain-loader.ts` | Injects MEMORY.md, USER.md, project memory into system prompt |
| System Prompt | `system-prompt.ts` | Loads `prompt.amp.system.md` template with variable interpolation |
| Tool Harness | `tool-harness.ts` | Env-gated tool filtering per workspace |
| Handoff | `handoff.ts` | LLM-driven context transfer with provenance tracking (replaces compaction) |
| Session Name | `session-name.ts` | Auto session naming |
| Session Breakdown | `session-breakdown.ts` | `/session-breakdown` analytics command |
| BTW | `btw.ts` | `/btw` side conversations |
| Notify | `notify.ts` | Desktop notifications via OSC 777 |
| Todos | `todos.ts` | File-based todo manager with TUI |
| Local Model | `local-model.ts` | `/local start|stop|status|logs` for llama-server |
| MD Export | `md-export.ts` | Session JSONL → markdown export |
| Command Palette | `command-palette/` | Ctrl+Shift+P overlay |
| Editor | `editor/` | Custom box-drawing editor |
| Tools | `tools/` | 25 custom tools (see below) |

---

## Custom Tools (25)

All live in `~/.pi/agent/extensions/tools/`, backed up in `pi-setup/extensions/tools/`.

### Tool Replacements (override pi built-ins)

These replace pi's default tool implementations with customized versions:

| Tool | File | Customization |
|------|------|---------------|
| **bash** | `bash.ts` | Git trailer injection, mutex locking for git commands, psst secret injection into subprocess env, output scrubbing |
| **read** | `read.ts` | Image viewing support |
| **edit-file** | `edit-file.ts` | Mutex locking to prevent concurrent edits |
| **create-file** | `create-file.ts` | Auto parent directory creation |
| **format-file** | `format-file.ts` | Prettier/biome formatting |
| **grep** | `grep.ts` | Custom output formatting |
| **glob** | `glob.ts` | Custom result handling |
| **ls** | `ls.ts` | Delegates to read tool |
| **undo-edit** | `undo-edit.ts` | Edit reversal with diff display |
| **skill** | `skill.ts` | Skill loading |

### New Tools (not in default pi)

| Tool | File | Purpose |
|------|------|---------|
| **finder** | `finder.ts` | Concept-based search subagent (haiku) — chain 3+ searches or search by concept |
| **oracle** | `oracle.ts` | Architecture review, hard multi-file bugs, complex planning (sonnet, read+bash) |
| **task** | `task.ts` | Spawns full subagent (same model as parent) for parallel independent work |
| **librarian** | `librarian.ts` | External repository exploration via GitHub API |
| **read-web-page** | `read-web-page.ts` | Web page reader using cheerio |
| **read-session** | `read-session.ts` | Read past pi session history |
| **search-sessions** | `search-sessions.ts` | Search session history by keyword, file, date |
| **web-search** | `web-search.ts` | Web search via Perplexity/Exa/Gemini |
| **code-review** | `code-review.ts` | Code review with diff analysis |
| **look-at** | `look-at.ts` | Image viewing for local files |
| **github** | `github.ts` | GitHub operations (repos, diffs, commits, search) |

### Tool Libraries (`tools/lib/`)

Shared code used by multiple tools:

| Library | Purpose |
|---------|---------|
| `agents-md.ts` | AGENTS.md/CLAUDE.md reading |
| `box-format.ts` | Box-drawing formatting |
| `file-tracker.ts` | File change tracking |
| `github.ts` | Shared GitHub API helpers |
| `html-to-md.ts` | HTML to markdown conversion |
| `interpolate.ts` | Template variable interpolation |
| `pi-spawn.ts` | Sub-agent spawning |
| `psst.ts` | Secret management (psst vault integration) |
| `show-renderer.ts` | TUI rendering for tool output |
| `show.ts` | Show/hide tool output panels |
| `sub-agent-render.ts` | Subagent output rendering |
| `tool-cost.ts` | Token cost calculation |
| `tui.ts` | TUI component helpers |
| `mutex.ts` | File-based mutex locking |
| `permissions.ts` | Permission evaluation |
| `output-buffer.ts` | Buffered output handling |

---

## Skills (19)

### Config-level (`~/.config/agents/skills/`) — 16 skills

`amp-voice`, `chrome-cdp`, `coordinate`, `dig`, `document`, `git`, `nexus-fix`, `remember`, `report`, `review`, `rounds`, `shepherd`, `spar`, `spawn`, `tmux`, `write`

### Pi-level (`~/.pi/agent/skills/`) — 1 skill

`handoff` (find-skills and userinterface-wiki are pi-package-managed symlinks, auto-created on install)

---

## Models

### Providers (in models.json)

| Provider | Models | Purpose |
|----------|--------|---------|
| `anthropic` | `claude-opus-4-6` (1M context override) | Direct Anthropic API |
| `claude-bridge` | `claude-opus-4`, `claude-sonnet-4`, etc. | Via pi-claude-bridge → Claude Code Agent SDK |
| `local-llama` | Gemma 4 26B-A4B MoE, Qwen3.5 35B-A3B MoE | llama-server on localhost:8080 |
| `zai` | `glm-5.1` | Current default provider/model |

### Active Settings

```json
{
  "defaultProvider": "zai",
  "defaultModel": "glm-5.1",
  "defaultThinkingLevel": "medium",
  "theme": "gruvbox",
  "compaction": { "enabled": false }
}
```

---

## File Layout

```
pi-setup/
├── install.sh                  # Full installer (backs up, then deploys)
├── settings.json               # Pi settings (packages, extensions, theme)
├── models.json                 # Model overrides + custom providers
├── keybindings.json            # Model cycling keys
├── permissions.json            # Git/rm safety rules
├── README.md                   # Setup docs + session log
├── claude-bridge-patches/
│   ├── index.ts                # Patched pi-claude-bridge (our custom build)
│   └── package.json            # Version tracking
├── agents/                     # 10 agent prompt templates
│   ├── prompt.amp.system.md    # Main system prompt template
│   ├── prompt.harness-docs.pi.md  # pi-specific docs
│   └── ...
├── themes/                     # 2 pi TUI themes
│   ├── gruvbox.json
│   └── nightowl.json
├── pi-skills/                  # 3 pi-level skills
├── config-skills/              # 16 config-level skills (symlinked)
└── extensions/
    ├── tools/                  # 25 custom tools + lib/
    └── *.ts                    # 13 other extensions
```

---

## Agent Prompt Templates (`agents/`)

| File | Purpose |
|------|---------|
| `prompt.amp.system.md` | Main system prompt — identity, behavior rules, tool selection, code defaults, communication |
| `prompt.harness-docs.pi.md` | Pi-specific SDK docs injected into system prompt |
| `agent.amp.finder.md` | Finder subagent: concept-based code search |
| `agent.amp.librarian.md` | Librarian subagent: external repo exploration |
| `agent.amp.oracle.md` | Oracle subagent: architecture review, hard bugs |
| `prompt.amp.handoff-extraction.md` | Handoff extraction prompt |
| `prompt.amp.code-review-system.md` | Code review system prompt |
| `prompt.amp.code-review-report.md` | Code review report format |
| `prompt.amp.look-at.md` | Image viewing prompt |
| `prompt.amp.read-web-page.md` | Web page reading prompt |

---

## Update Workflow

When pi or any package gets updated:

1. **pi itself updated** (`@mariozechner/pi-coding-agent`): Check if any internal APIs changed that our extensions depend on. Look at the [changelog](https://github.com/badlogic/pi-mono). Our extensions override built-in tools — if the tool API changed, update our tool files accordingly.

2. **pi-claude-bridge updated**: The npm update overwrites our patched `index.ts`. Re-apply the two system prompt patches (see "How to Merge Upstream Changes" above). Check if upstream added new fixes we want.

3. **Other packages** (pi-web-access, pi-context, pi-token-burden): Generally safe to update. Check if they register tools or skills that conflict with ours.

### What NOT to Do

- **Don't edit files directly in `/opt/homebrew/lib/node_modules/`** — they'll be wiped on the next npm update. Always edit in the repo (`pi-setup/`) and deploy via `install.sh` or manual `cp`.
- **Don't run `install.sh` without checking what changed** — it backs up existing files but overwrites them. If you've made live tweaks you want to keep, back them up first.
- **Don't remove the `systemPrompt` patches from the bridge** — without them, Claude Code loads its full system prompt which causes issues with our tool bridge.
- **Don't add `claude-agent-sdk-pi` back to packages** — it's the legacy bridge and conflicts with `pi-claude-bridge`.
- **Don't enable compaction** — we use handoff instead (`compaction.enabled: false`).
