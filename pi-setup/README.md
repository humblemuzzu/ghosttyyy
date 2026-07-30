# Pi Setup — Custom Pi Agent Configuration

Everything needed to reproduce the full pi ("Amp") agent setup on a new Mac.

> **`AGENTS.md` (repo root) is the authoritative, maintained reference.** It documents every
> patch, provider, migration, and gotcha in depth. This README is a concise overview — when in
> doubt, read `AGENTS.md`.

## Quick Install

```bash
cd pi-setup
chmod +x install.sh
./install.sh
```

The script backs up any existing config before overwriting, copies everything into place,
installs npm deps, re-applies all patches, and runs `verify-patches.sh` at the end.

After **any** pi/package update, re-run the audit first:

```bash
bash pi-setup/verify-patches.sh          # all PASS = good
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check   # exit 0 = good
```

## What's Inside

### Extensions (11 active)

pi auto-discovers every `.ts` in `extensions/` — there is no "present but disabled" state; to
disable one, delete it or move it out of `extensions/`.

| Extension | What it does |
|---|---|
| `editor/` | Custom box-drawing bordered editor with labels (context %, cost, model, git branch), enlarged prompt bar, and inline `[image #N]` clipboard-paste |
| `tools/` | Full replacement tool suite — 24 tools (10 built-in replacements + 14 new). See below. |
| `system-prompt.ts` | Injects the full Amp system prompt with runtime template vars |
| `mentions.ts` | `@mention` resolution (`@session`, `@commit`, `@handoff`) + agent directives (`@oracle`, `@finder`, `@codereview`, `@task`) |
| `session-name.ts` | Auto-generates session names from the first message (Claude Haiku) |
| `session-breakdown.ts` | `/session-breakdown` — visual analytics (sessions/day, cost, tokens, model breakdown) |
| `md-export.ts` | `/md` — exports the current session branch to readable markdown (clipboard or file) |
| `notify.ts` | Desktop notification when the agent finishes (OSC 777) |
| `todos.ts` | `todo` tool + `/todos` — file-based todo manager with TUI |
| `command-palette/` | `Ctrl+Shift+P` command-palette overlay |

`kimi-code-token.mjs` also lives here but is a helper script (OAuth token refresher called by the
`kimi-code` provider), not a loaded extension.

### Custom Tools (24)

The `tools/` extension replaces all 10 built-in pi tools and adds 14 more:

**Replaced built-ins** (with dual-param support for cross-model compatibility):
- `bash` — mutex, git trailers, psst secret injection, output scrubbing; accepts `cmd` and `command`
- `read` — image support + compact mode for sub-agents; accepts `read_range` and `offset/limit`
- `edit` (edit-file) — mutex-locked, file-change tracking; accepts `old_str/new_str` and `edits[{oldText,newText}]`
- `write` (create-file) — auto parent-dir creation + change tracking
- `find` (glob) — glob search; accepts `filePattern` and `pattern`
- `grep` — custom output; accepts `caseSensitive` and `ignoreCase`
- `ls` — compact limits for sub-agents
- `undo_edit` — proper multi-step undo via the change tracker
- `format_file` — post-edit formatting (prettier/biome)
- `skill` — loadable skill instructions

**New sub-agent tools** (provider-aware auth via `pi-spawn`):
- `finder` — Claude Haiku concept-based code search
- `oracle` — Claude Sonnet technical advisor
- `librarian` — Claude Haiku GitHub repo explorer
- `code_review` — two-phase Claude Sonnet review
- `Task` — full subprocess (parent model) for parallel independent work
- `read_web_page` — web page Q&A sub-agent
- `read_session` / `search_sessions` — past-session reader / search

**New GitHub tools** (GitHub API): `read_github`, `search_github`, `list_directory_github`,
`glob_github`, `list_repositories`, `commit_search`, `diff`

**Web search:** provided by the `pi-web-access` package's native `web_search` tool (authenticates
with the `openai-codex` OAuth login). Also adds `/psst*` secret-vault commands + a tool-output
secret-scrub hook.

### Agent Prompts (9)

`prompt.amp.system.md`, `prompt.harness-docs.pi.md`, `agent.amp.finder.md`, `agent.amp.oracle.md`,
`agent.amp.librarian.md`, `prompt.amp.code-review-system.md`, `prompt.amp.code-review-report.md`,
`prompt.amp.read-web-page.md`, `prompt.amp.handoff-extraction.md` (kept for reference; the handoff
extension was removed).

### Claude Integration

Claude Max is used via pi's **native `anthropic` provider** + the `@benvargas/pi-claude-code-use`
package, which rewrites provider API payloads for Claude Code-style subscription (OAuth) use — no
custom bridge/provider needed.

```bash
/login anthropic
/model anthropic/claude-opus-4-8
```

`pi-claude-bridge` (the old Claude Code Agent SDK bridge) is installed globally as a **legacy
fallback only** — not in the active `packages`. See `AGENTS.md` → "pi-claude-bridge".

### Providers / Models

| Provider | Access |
|---|---|
| `anthropic` (default, `claude-opus-4-8`) | Claude Max OAuth via pi-claude-code-use (1M context override) |
| `deepseek` (`deepseek-v4-pro/flash`) | `$DEEPSEEK_API_KEY`, 1M context |
| `kimi-code` (`kimi-for-coding`, K2.7) | Kimi Code subscription OAuth (`kimi-code-token.mjs`) |
| `sakana` (`fugu`, `fugu-ultra`) | `$SAKANA_API_KEY`, $20/mo, OpenAI Responses API |
| `openai-codex`, `kimi-coding` | pi built-in providers |

### Themes (2)
- **gruvbox** (active) — warm retro colors
- **nightowl** — dark blue Night Owl

### Skills (21 config-level)
`amp-voice`, `chrome-cdp`, `coordinate`, `dig`, `document`, `git`, `nexus-fix`, `remember`,
`report`, `review`, `rounds`, `shepherd`, `spar`, `spawn`, `tmux`, `write`
5 external skills adapted for pi (author-prefixed): `s-improve` (shadcn — audit→plans),
`c-sqr` (cursor — strict quality review), `mat-cr2axis` / `mat-design` / `mat-tdd` (matt pocock).
Mnemonic: `s-` shadcn, `c-` cursor, `mat-` matt.
(`find-skills` + `userinterface-wiki` are pi-package-managed symlinks, auto-created on install.)

### Settings
- Default provider/model: `anthropic` / `claude-opus-4-8`
- Theme: gruvbox · Thinking: high · Compaction: **enabled** (pi's native LLM compaction)
- Steering/follow-up: all · Quiet startup

### Permissions
- Blocks `git add -A` / `git add .` (forces explicit staging)
- Blocks force push
- Blocks `rm` (use `trash` instead)

### Pi Packages (10, active)
`pi-web-access`, `pi-context`, `pi-token-burden`, `@benvargas/pi-claude-code-use`,
`@marckrenn/pi-sub-bar`, `pi-autoresearch`, `pi-tool-display` (config'd)
(patched), `pi-codex-goal`, `pi-mcp-adapter`. See `AGENTS.md` → "Packages (npm)" for versions,
purposes, and which are patched.

## Directory Structure

```
pi-setup/
├── install.sh                  # One-command installer (deploys + re-applies patches)
├── settings.json               # Pi settings (provider: anthropic, model: claude-opus-4-8)
├── keybindings.json            # Custom keybindings
├── models.json                 # Custom providers + context-window overrides
├── permissions.json            # Tool permission rules
├── mcp.json                    # pi-mcp-adapter global MCP servers (astro, paper)
├── pi-sub-bar-settings.json    # sub-bar widget layout
├── pi-sub-core-settings.json   # sub-core provider/refresh config
├── verify-patches.sh           # Read-only audit of every patch/config
├── extensions/                 # 11 extensions + tools/ suite
│   ├── editor/                 # Custom TUI editor
│   ├── command-palette/        # Ctrl+Shift+P palette
│   ├── tools/                  # 24 custom tools + shared lib/
│   ├── pi-tool-display/        # config.json (all tool overrides false — required)
│   ├── system-prompt.ts  mentions.ts  session-name.ts  session-breakdown.ts
│   ├── md-export.ts  notify.ts  todos.ts  tool-harness.ts
│   └── kimi-code-token.mjs     # Kimi Code OAuth helper (not an extension)
├── agents/                     # 9 agent prompt markdown files
├── themes/                     # gruvbox.json, nightowl.json
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 21 skills (→ ~/.config/agents/skills/)
├── claude-bridge-patches/      # Patched pi-claude-bridge (legacy fallback, inactive)
├── pi-core-patches/            # resource-loader + session-pinning + pi-tui width patches
└── README.md                   # This file
```

## If Anything Breaks

1. `bash pi-setup/verify-patches.sh` — each FAIL prints its exact fix command.
2. Read `AGENTS.md` — it has the full record of every patch, provider, and migration, plus
   rollback notes. Check there first.
