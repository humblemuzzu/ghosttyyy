# AGENTS.md — Pi Setup Reference

> This file is read by pi and other coding agents at session start.
> It describes the full setup so agents understand the architecture,
> know what not to touch, and can safely apply upstream updates.

## Architecture Overview

This repo serves two purposes:
1. **Ghostty terminal config** — themes, fonts, scripts (see README.md)
2. **Portable pi (coding agent) setup** — full backup of all extensions, tools, skills, themes, config, and an installer

The pi setup lives in `pi-setup/` and is deployed to `~/.pi/agent/` via `pi-setup/install.sh`.

### Migration Log

**See `pi-setup/2026-05-17-migration-log.md`** for the full record of the v0.74.0 migration, architecture decisions, CrofAI fixes, context management switch, and package cleanup. If anything breaks, check there first.

### Provider Chain

```
pi CLI (v0.74.0) — @earendil-works/pi-coding-agent
  └─ anthropic provider (native) + pi-claude-code-use (OAuth rewrite for Claude Max)
       └─ Claude API
```

Primary provider is `anthropic` with Claude Opus 4-6 via Claude Max subscription. `pi-claude-code-use` intercepts OAuth payloads for subscription-based access.

**Legacy fallback:** `pi-claude-bridge` (installed but not active in packages) wraps the Claude Code Agent SDK as a custom provider.

### System Prompt Assembly

The system prompt is assembled in layers:

1. **`system-prompt.ts`** — loads `agents/prompt.amp.system.md` template, interpolates variables (`{identity}`, `{harness}`, `{date}`, `{cwd}`, `{roots}`, `{os}`, `{repo}`, `{sessionId}`, `{ls}`, `{harness_docs_section}`)
2. **`tool-harness.ts`** — env-gated tool filtering based on active workspace
3. **`brain-loader.ts`** — (disabled) injects `~/Documents/brain/MEMORY.md`, `USER.md`, project memory, and update protocol

---

## pi-claude-bridge: Custom Build (inactive)

**Upstream:** https://github.com/elidickinson/pi-claude-bridge (v0.2.0)
**Our patched version:** `pi-setup/claude-bridge-patches/index.ts`
**Status:** Installed globally but removed from settings.json packages. Legacy fallback.

### Patch Summary

Two `systemPrompt` modifications — remove `preset: "claude_code"` so Claude Code doesn't load its own system prompt. Search for `preset: "claude_code"` in upstream and replace with our versions:

```typescript
// Main provider: systemPrompt: systemPromptAppend || ""
// AskClaude tool: systemPrompt: skillsBlock || undefined
```

### Re-apply after npm update

```bash
cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts
```

---

## condensed-milk-pi: Patched Build

**Upstream:** https://github.com/tomooshi/condensed-milk-pi (v1.9.0)
**Our patched version:** `pi-setup/condensed-milk-patches/` (index.ts + filters/context-compress.ts)

### What We Changed From Upstream

Two patches to fix compatibility with our custom bash tool:

**1. Bash output prefix strip (`index.ts`, tool_result handler):**

Our custom `bash.ts` prepends `$ <command>\n\n` to every output (e.g., `$ git status\n\nOn branch main...`). Upstream condensed-milk's `detectFormat()` reads the first line to detect git status format — it sees `$ git status` instead of `On branch main`, misclassifies it as v2 format, and reports "on unknown: clean" for dirty repos. **This is data loss — the agent gets wrong git state.**

```typescript
// Added after ANSI strip, before dispatch:
if (stdout.startsWith("$ ")) {
  const sep = stdout.indexOf("\n\n");
  if (sep !== -1) stdout = stdout.slice(sep + 2);
}
```

This also fixes JSON output compression (blocked by `$` prefix) and ls phantom entries.

**2. `cmd` parameter support (`index.ts` + `filters/context-compress.ts`):**

Our bash tool accepts both `cmd` (primary in schema) and `command` (alias). Upstream only reads `event.input.command`. When models use `cmd`, condensed-milk skips compression entirely.

```typescript
// index.ts — tool_result handler:
const command = (event.input as { command?: string; cmd?: string })?.command
  ?? (event.input as { cmd?: string })?.cmd;

// context-compress.ts — toolCallIndex builder:
const rawCmd = typeof args.command === "string" ? args.command
  : typeof args.cmd === "string" ? args.cmd : undefined;

// context-compress.ts — extractCommand:
const fromDetails = msg?.details?.command ?? msg?.input?.command ?? msg?.input?.cmd;
```

### Re-apply after npm update

```bash
cp pi-setup/condensed-milk-patches/index.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/index.ts
cp pi-setup/condensed-milk-patches/filters/context-compress.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/filters/context-compress.ts
```

**Never skip the prefix strip.** Without it, `git status` compression returns wrong data to the agent.

---

## pi-tool-display: Configuration Required

**Upstream:** https://github.com/MasuRii/pi-tool-display (v0.3.5)
**Config file:** `~/.pi/agent/extensions/pi-tool-display/config.json`
**Backed up:** `pi-setup/extensions/pi-tool-display/config.json`

### Why Config Is Required

pi-tool-display registers tool overrides for `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`. These **conflict** with our custom tool implementations in `extensions/tools/`. pi-tool-display's overrides bootstrap from pi's DEFAULT tools (not ours), so they would **replace** our mutex locking, secret scrubbing, git trailers, image support, etc.

**ALL tool overrides must be set to `false`.** This gives us only:
- ✅ Thinking labels (streaming "Thinking:" prefix)
- ✅ Native user message box with markdown rendering
- ✅ `/tool-display` settings command
- ❌ No tool rendering overrides (our custom tools handle their own rendering)

### Config Contents

```json
{
  "registerToolOverrides": {
    "read": false, "grep": false, "find": false,
    "ls": false, "bash": false, "edit": false, "write": false
  },
  "enableNativeUserMessageBox": true
}
```

### After npm Update

The config file is NOT in the npm package — it's in `~/.pi/agent/extensions/pi-tool-display/config.json`. npm updates don't touch it. But if you delete and reinstall, recreate the config:

```bash
mkdir -p ~/.pi/agent/extensions/pi-tool-display
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json
```

**If you see tool conflict errors on startup**, the config is missing or all overrides are `true`. Fix by recreating the config file.

---

## pi-vcc: Removed

**Previously:** `@sting8k/pi-vcc` (v0.3.12) — algorithmic compaction engine.
**Status:** Uninstalled. Using pi's native LLM-based compaction instead.

**Note:** `handoff.ts` had a `session_before_compact` hook that returned `{ cancel: true }` for all compaction except VCC. This blocked pi's native compaction entirely. `handoff.ts` has been moved to `extensions-disabled/` — pi auto-discovers all `.ts` files in `extensions/`, so simply removing it from `settings.json` was NOT enough to disable it.

---

## pi-gpt-config: Patched Build

**Upstream:** https://github.com/edxeth/pi-gpt-config (v1.0.0)
**Our patched version:** `pi-setup/gpt-config-patches/index.ts`

Adds `/gpt-config` command for GPT models only (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`). No-op on Claude/DeepSeek/local.

### Patch Summary

Removed `getNativeToolDisciplineOverlay` — always returns `undefined`. Our system prompt already enforces native tool usage for all models, so the 260-token tool discipline overlay is redundant.

### Re-apply after pi update (git pull)

```bash
cp pi-setup/gpt-config-patches/index.ts ~/.pi/agent/git/github.com/edxeth/pi-gpt-config/index.ts
```

---

## Pi Core: Extension Tool Conflict Suppression Patch

**File:** `dist/core/resource-loader.js` in `@earendil-works/pi-coding-agent`
**Patch stored:** `pi-setup/pi-core-patches/resource-loader.js`

### The Problem

When a user extension registers a tool with the same name as a package tool (e.g., our `web_search` vs pi-web-access's `web_search`), pi's `detectExtensionConflicts()` pushes the conflict to the errors array. Pi treats these as fatal startup errors, blocking launch — even though the code comment says "Keep all extensions loaded. Conflicts are reported as diagnostics."

User extensions load BEFORE packages, so `getAllRegisteredTools()` (first-wins) already gives user extensions precedence. The conflict diagnostic is the only problem.

### The Fix

Suppressed the conflict-to-error push. `detectExtensionConflicts()` still runs (for internal bookkeeping) but no longer pushes to `extensionsResult.errors`:

```javascript
// Before:
const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
for (const conflict of conflicts) {
    extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
}
// After:
this.detectExtensionConflicts(extensionsResult.extensions);
```

### Re-apply after pi update

```bash
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
```

---

## Subagent Model Resolution (pi-spawn.ts patch)

**File:** `extensions/tools/lib/pi-spawn.ts`

### The Problem

The original code always used the parent model for subagents:
```typescript
const resolvedModel = config.parentModel ?? config.model;
```
This meant finder/oracle/librarian/code-review always inherited the parent model (e.g., `zai/glm-5.1`) instead of their designated Claude models.

### The Fix

Conditional resolution based on parent provider:
- **Parent is Anthropic** (provider `anthropic` or `claude-bridge`, or model name contains `claude`) → use designated model (`claude-haiku-4-5`, `claude-sonnet-4-6`)
- **Parent is non-Anthropic** (ZAI, local-llama, etc.) → inherit parent model (can't use Claude without separate API access)

This means subagents use cheap Claude models when you're on Claude, but don't break when you're on ZAI/local.

---

## Handoff Prompt Fix (handoff.ts patch)

**File:** `extensions/handoff.ts`

Changed `pi.sendUserMessage(prompt)` → `ctx.ui.setEditorText(prompt)` in `executeHandoff()`. The handoff prompt now appears in the editor box for review before sending, instead of being auto-submitted behind the scenes.

---

## Agent Mention Directives (@oracle, @finder, @codereview, @task)

**Files:** `extensions/tools/lib/mentions/agent-source.ts` (new), plus modifications to `types.ts`, `sources.ts`, `parse.ts`, `render.ts`, `provider.ts`, `index.ts`, and `extensions/mentions.ts`.

### What It Does

Extends pi's existing @mention system to support agent tool routing. When the user types `@oracle review this auth flow`, a hidden directive is injected into the context telling the model to call the `oracle` tool — not Task, not do it itself.

### How It Works

1. **Parse** — standalone regex `(?<![\w/])@(oracle|finder|codereview|task)(?=[\s.,;:!?)\]}]|$)` matches `@oracle` without requiring `/value` (unlike `@commit/sha`)
2. **Resolve** — `agent-source.ts` maps each kind to its tool name (e.g. `codereview` → `code_review`, `task` → `Task`)
3. **Render** — produces `AGENT DIRECTIVE: Call the \`oracle\` tool for this request. The user explicitly tagged @oracle. Do not substitute another tool.`
4. **Inject** — `mentions.ts` injects the directive as a hidden `display: false` custom message in the `context` hook

### Agent ↔ Tool Mapping

| Mention | Tool | Description |
|---------|------|-------------|
| `@oracle` | `oracle` | Expert advisor — architecture, planning, hard bugs |
| `@finder` | `finder` | Codebase search by concept or behavior |
| `@codereview` | `code_review` | Code review with diff analysis |
| `@task` | `Task` | Full subagent for independent parallel work |

### Autocomplete

Agent kinds appear in autocomplete when typing `@`. They complete with a trailing space (`@oracle `) instead of a trailing slash (`@commit/`). This is controlled by the `standalone: true` flag on `MentionSource`.

### Key Design Decisions

- **Standalone flag** — `MentionSource.standalone?: boolean` differentiates valueless mentions from data mentions. The parser builds two separate regexes (data with `/value`, standalone without).
- **Side-effect import** — `agent-source.ts` has no named exports; it registers sources at module load. `mentions.ts` uses an explicit `import "./tools/lib/mentions/agent-source.js"` to guarantee evaluation.
- **No text stripping** — the `@oracle` stays in the user's message text. The directive reinforces it; the model sees both.
- **Structural discrimination in render** — `"agent" in mention` distinguishes agent results from commit/session results without importing a kind list.

### What NOT to Do

- **Don't remove the side-effect import in `mentions.ts`** — the barrel `export *` in `index.ts` doesn't guarantee evaluation of modules with no named exports. The explicit import is required.
- **Don't add a `/value` to agent mentions** — they're standalone. `@oracle/foo` won't parse and won't trigger a directive.

---

## Packages (npm)

| Package | Version | Purpose | Patched? |
|---------|---------|---------|----------|
| `@mariozechner/pi-coding-agent` | 0.71.0 | The pi agent itself (installed via homebrew npm) | No |
| `@benvargas/pi-claude-code-use` | 1.0.4 | Patches Anthropic OAuth payloads for Claude Max subscription use (primary Claude method) | No |
| `pi-web-access` | 0.10.6 | Web access: read pages, search, GitHub API, librarian skill | No |
| `pi-context` | 1.1.3 | Context management: context_log, context_tag, context_checkout | No |
| `pi-token-burden` | 0.6.3 | Token usage tracking and display | No |
| `@marckrenn/pi-sub-bar` | 1.5.0 | Usage widget — shows provider quotas in status bar | No (CrofAI/Kimi now built-in) |
| `pi-autoresearch` | latest | Autonomous experiment loop for optimization targets (GitHub install) | No |
| `pi-tool-display` | 0.4.0 | Compact tool rendering, thinking labels, user message box | **Config** |
| `@tomooshi/condensed-milk-pi` | 1.9.0 | Bash output compression + context-level stale result masking | **Yes** |
| `pi-gpt-config` | 1.1.0 | GPT Codex-parity: personality, verbosity, fast mode (GitHub install) | **Yes** |
| `pi-ask` | latest | Structured ask_user tool with TUI — single/multi select, notes, review (GitHub install) | No |
| `pi-codex-goal` | 0.1.12 | Codex-style `/goal` — autonomous multi-turn objectives with completion audit | No |

**Active in settings.json:** `pi-web-access`, `pi-context`, `pi-token-burden`, `@benvargas/pi-claude-code-use`, `@marckrenn/pi-sub-bar`, `pi-autoresearch`, `pi-tool-display`, `@tomooshi/condensed-milk-pi`, `pi-gpt-config`, `pi-ask`, `pi-codex-goal`

**Claude Max usage:** `/login anthropic` → `/model anthropic/claude-opus-4-6`. pi-claude-code-use intercepts OAuth requests and rewrites payloads for Claude Code-style subscription use. No custom provider needed — uses pi's native anthropic provider.

**Installed but inactive:** `pi-claude-bridge` (0.3.1, legacy fallback, patched), `pi-computer-use` (0.2.1, macOS GUI), `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`

---

## Extensions (14 active, 3 disabled)

All live in `~/.pi/agent/extensions/`, backed up in `pi-setup/extensions/`.

| Extension | File | Purpose |
|-----------|------|---------|
| System Prompt | `system-prompt.ts` | Loads `prompt.amp.system.md` template with variable interpolation |
| Tool Harness | `tool-harness.ts` | Env-gated tool filtering per workspace |
| Mentions | `mentions.ts` | @mention resolution (sessions, commits) + agent directives (@oracle, @finder, @codereview, @task) |
| Session Name | `session-name.ts` | Auto session naming |
| Session Breakdown | `session-breakdown.ts` | `/session-breakdown` analytics command |
| BTW | `btw.ts` | `/btw` side conversations |
| Notify | `notify.ts` | Desktop notifications via OSC 777 |
| Todos | `todos.ts` | File-based todo manager with TUI |
| Local Model | `local-model.ts` | `/local start|stop|status|logs` for llama-server |
| OpenCode Zen | `opencode-zen.ts` | Curated models.dev catalog provider with free/paid tiers |
| CrofAI | `crof.ts` | Budget OSS model provider (quantized DeepSeek/GLM/Qwen/Kimi) |
| Command Palette | `command-palette/` | Ctrl+Shift+P overlay |
| Editor | `editor/` | Custom box-drawing editor |
| Tools | `tools/` | 25 custom tools (see below) |

**Disabled (moved to `extensions-disabled/` — files in `extensions/` are auto-discovered and always loaded):**

| Extension | File | Purpose |
|-----------|------|---------|
| Handoff | `handoff.ts` | LLM-driven context transfer — **blocks pi native compaction via `session_before_compact` cancel hook** |
| Brain Loader | `brain-loader.ts` | Injects MEMORY.md, USER.md, project memory into system prompt |
| MD Export | `md-export.ts` | Session JSONL → markdown export |

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
| **code-review** | `code-review.ts` | Code review with diff analysis |
| **web-search** | `web-search.ts` | Web search via OpenAI Codex Responses API (overrides pi-web-access, works from any model) |
| **github** | `github.ts` | GitHub operations (repos, diffs, commits, search) |

**Disabled (file exists, not registered):**

| Tool | File | Reason |
|------|------|--------|
| **look-at** | `look-at.ts` | Cheap model produces low-quality image analysis |

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
| `config.ts` | Shared config reader with schema validation, deep merge, project-local opt-in (ported from @bds_pi/config) |
| `prompt-patch.ts` | Auto-derive promptSnippet/promptGuidelines from tool descriptions (ported from @bds_pi/prompt-patch) |
| `fs.ts` | Path resolution and directory walking utilities (ported from @bds_pi/fs) |
| `mentions/` | @mention system — parse, resolve, render, agent directives, session/commit indexing, autocomplete provider (ported from @bds_pi/mentions) |

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
| `anthropic` | `claude-opus-4-6`, `claude-opus-4-7` (1M context override) | Direct Anthropic API + OAuth (Claude Max via pi-claude-code-use) |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` | 1M context, thinking mode, OpenAI-compatible API |
| `local-llama` | Qwen3.6 35B-A3B MoE, Gemma 4 E2B | llama-server on localhost:8080 |
| `nvidia` | GLM-5.1, DeepSeek V4 Pro | NVIDIA NIM API (requires NVIDIA_API_KEY) |

### Sub-agent Models
- **finder**: `claude-haiku-4-5` (cheapest, fast parallel search)
- **librarian**: `claude-haiku-4-5` (cheapest, GitHub API exploration)
- **oracle**: `claude-sonnet-4-6` (strong reasoning for architecture/review)
- **handoff extraction**: `claude-haiku-4-5` (cheap context transfer)

### Active Settings

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-6",
  "defaultThinkingLevel": "high",
  "theme": "gruvbox",
  "compaction": { "enabled": true }
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
├── pi-sub-bar-settings.json    # @marckrenn/pi-sub-bar widget layout
├── pi-sub-core-settings.json   # pi-sub-core provider/refresh config
├── pi-vcc-config.json          # @sting8k/pi-vcc compaction config
├── README.md                   # Setup docs + session log
├── claude-bridge-patches/
│   ├── index.ts                # Patched pi-claude-bridge (our custom build)
│   └── package.json            # Version tracking
├── condensed-milk-patches/
│   ├── index.ts                # Patched condensed-milk ($ prefix strip + cmd support)
│   ├── package.json            # Version tracking
│   └── filters/
│       └── context-compress.ts # Patched context masking (cmd param support)
├── agents/                     # 10 agent prompt templates
│   ├── prompt.amp.system.md    # Main system prompt template
│   ├── prompt.harness-docs.pi.md  # pi-specific docs
│   └── ...
├── themes/                     # 2 pi TUI themes
│   ├── gruvbox.json
│   └── nightowl.json
├── extensions-disabled/         # Disabled extensions (moved out of extensions/ to prevent auto-discovery)
├── gpt-config-patches/         # Patched pi-gpt-config (tool discipline removed)
├── pi-skills/                  # 1 pi-level skill (handoff; find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 16 config-level skills
└── extensions/
    ├── tools/                  # 25 custom tools + lib/ (config, prompt-patch, fs, mentions)
    ├── pi-tool-display/
    │   └── config.json         # All tool overrides disabled (required for compatibility)
    ├── mentions.ts             # @mention resolution + agent directives extension
    └── *.ts                    # 16 other extensions (15 active + 2 disabled)
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

1. **pi itself updated** (`@earendil-works/pi-coding-agent`): Check if any internal APIs changed that our extensions depend on. Look at the [changelog](https://github.com/earendil-works/pi). Our extensions override built-in tools — if the tool API changed, update our tool files accordingly. The `@mariozechner/*` backward-compat aliases are currently preserved but will eventually be removed — when that happens, rename imports in all 46 `.ts` files (see log.md for the sed command). **Must re-apply `resource-loader.js` patch** — without it, our `web_search` override conflicts with pi-web-access and pi refuses to start.

2. **condensed-milk-pi updated**: npm update overwrites our patched `index.ts` and `filters/context-compress.ts`. **Must re-apply patches** — without the `$ ` prefix strip, git status compression returns wrong data. See "condensed-milk-pi: Patched Build" above.

3. **pi-sub-bar updated**: CrofAI + Kimi providers are now built-in as of v1.5.0. No patches needed.

4. **pi-gpt-config updated** (git): `pi install` may overwrite our patched `index.ts`. Re-apply — our patches remove the redundant tool discipline overlay and set claude personality as default.

5. **pi-tool-display updated**: Config file at `~/.pi/agent/extensions/pi-tool-display/config.json` is NOT touched by npm updates. But if you delete and reinstall, **recreate the config** with all tool overrides set to `false`. Without it, pi-tool-display overwrites our custom tools.

6. **Other packages** (pi-web-access, pi-context, pi-token-burden, pi-codex-goal, pi-ask, pi-autoresearch): Generally safe to update. No patches on these. Check if they register tools or skills that conflict with ours.

### Quick re-patch after any update

```bash
# pi core — suppress tool conflict errors (needed for web_search override)
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js

# condensed-milk (CRITICAL — data loss without it)
cp pi-setup/condensed-milk-patches/index.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/index.ts
cp pi-setup/condensed-milk-patches/filters/context-compress.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/filters/context-compress.ts

# pi-sub-bar — no patches needed (CrofAI + Kimi now built-in as of v1.5.0)

# pi-gpt-config (tool discipline removed + claude personality default)
cp pi-setup/gpt-config-patches/index.ts ~/.pi/agent/git/github.com/edxeth/pi-gpt-config/index.ts

# pi-tool-display config (verify exists, recreate if missing)
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json

# pi-claude-bridge (only if reactivating — currently inactive)
# cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts
```

### What NOT to Do

- **Don't edit files directly in `/opt/homebrew/lib/node_modules/`** — they'll be wiped on the next npm update. Always edit in the repo (`pi-setup/`) and deploy via `install.sh` or manual `cp`.
- **Don't run `install.sh` without checking what changed** — it backs up existing files but overwrites them. If you've made live tweaks you want to keep, back them up first.
- **Don't remove the condensed-milk `$ ` prefix strip** — without it, git status reports "clean" on dirty repos. The agent makes wrong git decisions.
- **Don't set pi-tool-display overrides to `true`** — it replaces our custom tools with pi defaults, losing mutex locking, secret scrubbing, git trailers, image support.
- **Don't add `claude-agent-sdk-pi` back to packages** — it's the legacy bridge and conflicts with `pi-claude-bridge`.
- **Check `pi-setup/2026-05-17-migration-log.md`** if anything breaks — it has the full record of every change made, every decision, and rollback instructions.
