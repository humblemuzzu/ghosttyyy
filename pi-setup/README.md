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

### Extensions (12 active)

pi auto-discovers every `.ts` in `extensions/` — there is no "present but disabled" state; to
disable one, delete it or move it out of `extensions/`.

| Extension | What it does |
|---|---|
| `editor/` | Custom box-drawing bordered editor with labels (context %, cost, model, git branch), enlarged prompt bar, and inline `[image #N]` clipboard-paste |
| `tools/` | Full replacement tool suite — 28 tools. See below. |
| `system-prompt.ts` | Injects the full Amp system prompt with runtime template vars (parent sessions); a sub-agent instead gets a short generated prompt naming exactly its own `--tools` allowlist |
| `mentions.ts` | `@mention` resolution (`@session`, `@commit`, `@handoff`) + agent directives (`@oracle`, `@finder`, `@codereview`, `@task` → `delegate`) |
| `session-name.ts` | Auto-generates session names from the first message (Claude Haiku) |
| `session-breakdown.ts` | `/session-breakdown` — visual analytics (sessions/day, cost, tokens, model breakdown) |
| `md-export.ts` | `/md` — exports the current session branch to readable markdown (clipboard or file) |
| `notify.ts` | Desktop notification when the agent finishes (OSC 777) |
| `command-palette/` | `Ctrl+Shift+P` command-palette overlay |
| `subagent-inspector/` | `Ctrl+Shift+A` / `/subagents` — drill into a sub-agent's live transcript |
| `local-model.ts` | `/local` — start/stop the llama.cpp router |

`kimi-code-token.mjs` also lives here but is a helper script (OAuth token refresher called by the
`kimi-code` provider), not a loaded extension.

### Custom Tools (28)

The `tools/` extension replaces pi's built-ins and adds new tools:

**Replaced built-ins**: `read`, `ls`, `grep`, `find` (registers as `find`), `bash` — all with
mutex locking, secret scrubbing, permission rules, and sub-agent compact modes.
`apply_patch` is the ONLY file-mutation tool (write/edit/batch/envelope lanes, undo tracking) —
it replaced `edit`/`write`, and pi's natives are hidden at session start.
`format_file`, `skill`, `undo_edit` / `redo_edit` round out the replacements.

**Dedicated sub-agents** (provider-aware auth via `pi-spawn`):
- `finder` — Claude Sonnet concept-based code search (read-only)
- `oracle` — Claude Opus technical advisor
- `librarian` — Claude Sonnet GitHub repo explorer
- `code_review` — two-phase Claude Sonnet review
- `delegate` — full resumable sub-agent (parent model) for parallel independent work
- `read_web_page` — web page reader + optional Q&A child
- `read_session` / `search_sessions` — past-session reader / search
- `screenshot`, `web_search` (Parallel AI), `agent_message`, `redo_edit`

**New GitHub tools** (GitHub API): `read_github`, `search_github`, `list_directory_github`,
`glob_github`, `list_repositories`, `commit_search`, `diff`

**Web search:** our self-contained Parallel AI `web_search` tool (the `pi-web-access` package
was removed 2026-07-30 — its `web_search` was dead on every provider). Also adds `/psst*`
secret-vault commands + a tool-output secret-scrub hook.

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
/model anthropic/claude-opus-5
```

### Providers / Models

| Provider | Access |
|---|---|
| `xai` (default, `grok-4.5`) | Grok OAuth (`/login xai`); `grok-4.6` also in favorites |
| `anthropic` (`claude-fable-5-1`, `claude-opus-5`) | Claude Max OAuth via pi-claude-code-use (`claude-fable-5-1` ships in pi 0.85.0's catalog; `claude-opus-4-6/4-7/4-8` have 1M context overrides) |
| `deepseek` (`deepseek-v4-pro/flash`) | `$DEEPSEEK_API_KEY`, 1M context |
| `kimi-code` (`kimi-for-coding`, K2.7) | Kimi Code subscription OAuth (`kimi-code-token.mjs`) |
| `sakana` (`fugu`, `fugu-ultra`) | `$SAKANA_API_KEY`, $20/mo, OpenAI Responses API |
| `openai-codex`, `kimi-coding` | pi built-in providers |
| `llama-local` (`LFM2.5-2.6B`) | local llama.cpp router, managed via `/local` |

### Themes (2)
- **gruvbox** (active) — warm retro colors
- **nightowl** — dark blue Night Owl

### Skills (24 config-level)
`amp-voice`, `chrome-cdp`, `coordinate`, `dataforseo`, `design-port`, `dig`, `document`, `git`,
`nexus-fix`, `remember`, `report`, `review`, `rounds`, `shepherd`, `spar`, `spawn`, `tmux`, `write`
5 external skills adapted for pi (author-prefixed): `s-improve` (shadcn — audit→plans),
`c-sqr` (cursor — strict quality review), `mat-cr2axis` / `mat-design` / `mat-tdd` (matt pocock).
Mnemonic: `s-` shadcn, `c-` cursor, `mat-` matt.
(`find-skills` + `userinterface-wiki` are pi-package-managed symlinks, auto-created on install;
3 `autoresearch-*` from pi-autoresearch — 29 total.)

### Settings
- Default provider/model: `xai` / `grok-4.5` (thinking high)
- Theme: gruvbox · Thinking: high · Compaction: **enabled** (pi's native LLM compaction)
- Steering/follow-up: all · Quiet startup

### Permissions
- Blocks `git add -A` / `git add .` (forces explicit staging)
- Blocks force push
- Blocks `rm` (use `trash` instead)

### Pi Packages (7, active)
`pi-token-burden`, `@benvargas/pi-claude-code-use`, `@marckrenn/pi-sub-bar`,
`pi-autoresearch`, `pi-tool-display` (config'd), `pi-codex-goal`, `pi-mcp-adapter`.
See `AGENTS.md` → "Packages (npm)" for versions, purposes, and which are patched.
(`pi-context`, `todos.ts`, `pi-web-access`, `pi-tasks`, `@tomooshi/condensed-milk-pi`,
`@sting8k/pi-vcc`, `pi-computer-use`, `pi-gpt-config`, `pi-ask` were removed — do not reinstall.)

## Directory Structure

```
pi-setup/
├── install.sh                  # One-command installer (deploys + re-applies patches)
├── settings.json               # Pi settings (provider: xai, model: grok-4.5)
├── keybindings.json            # Custom keybindings
├── models.json                 # Custom providers + context-window overrides
├── permissions.json            # Tool permission rules
├── mcp.json                    # pi-mcp-adapter global MCP servers (astro, paper)
├── pi-sub-bar-settings.json    # sub-bar widget layout
├── pi-sub-core-settings.json   # sub-core provider/refresh config
├── verify-patches.sh           # Read-only audit of every patch/config
├── extensions/                 # extensions + tools/ suite
│   ├── editor/                 # Custom TUI editor
│   ├── command-palette/        # Ctrl+Shift+P palette
│   ├── subagent-inspector/     # Ctrl+Shift+A sub-agent transcript inspector
│   ├── tools/                  # 29 custom tools + shared lib/
│   ├── pi-tool-display/        # config.json (all tool overrides false — required)
│   ├── system-prompt.ts  mentions.ts  session-name.ts  session-breakdown.ts
│   ├── md-export.ts  notify.ts  local-model.ts
│   └── kimi-code-token.mjs     # Kimi Code OAuth helper (not an extension)
├── agents/                     # 9 agent prompt markdown files
├── themes/                     # gruvbox.json, nightowl.json
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 24 skills (→ ~/.config/agents/skills/)
├── pi-core-patches/            # resource-loader + session-pinning + pi-tui width patches
└── README.md                   # This file
```

## If Anything Breaks

1. `bash pi-setup/verify-patches.sh` — each FAIL prints its exact fix command.
2. Read `AGENTS.md` — it has the full record of every patch, provider, and migration, plus
   rollback notes. Check there first.
