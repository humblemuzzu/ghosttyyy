# Pi Setup — Custom Pi Agent Configuration

Everything needed to reproduce the full pi agent setup on a new Mac.

## Quick Install

```bash
cd pi-setup
chmod +x install.sh
./install.sh
```

The script backs up any existing config before overwriting, then copies everything into place and installs npm dependencies.

## What's Inside

### Extensions (14)
| Extension | What it does |
|---|---|
| `editor/` | Custom box-drawing bordered editor with labels (context %, cost, model, git branch) and enlarged prompt bar |
| `tools/` | Full replacement tool suite — 25 tools (10 built-in replacements + 15 new). See below. |
| `handoff.ts` | Context transfer to new sessions via `piSpawn` sub-agent (replaces compaction entirely) |
| `brain-loader.ts` | Auto-injects brain vault (MEMORY.md, USER.md, project memory) into every session's system prompt |
| `system-prompt.ts` | Injects the full Amp system prompt with runtime template vars |
| `btw.ts` | `/btw` side conversations — async Q&A while agent works |
| `local-model.ts` | `/local start/stop/status/logs` — manages llama-server, injects anti-gaslighting rules for local models |
| `session-name.ts` | Auto-generates session names from first message |
| `session-breakdown.ts` | `/session-breakdown` — visual analytics (sessions/day, cost, tokens, model breakdown) |
| `md-export.ts` | Exports session JSONL to readable markdown |
| `notify.ts` | Desktop notifications when agent finishes (OSC 777) |
| `todos.ts` | File-based todo manager with TUI |
| `command-palette/` | `Ctrl+Shift+P` command palette overlay |
| `tool-harness.ts` | Env-gated tool filtering for sub-agents |

### Custom Tools (25)
The `tools/` extension replaces all 10 built-in pi tools and adds 15 more:

**Replaced built-ins** (with dual-param support for Claude compatibility):
- `bash` — enhanced with mutex, git trailers, permission rules; accepts both `cmd` and `command`
- `read` — compact mode for sub-agents; accepts both `read_range` and `offset/limit`
- `edit` (edit-file) — mutex-locked, file change tracking; accepts both `old_str/new_str` and `edits[{oldText,newText}]`
- `write` (create-file) — same mutex + change tracking
- `find` (glob) — uses `rg --files`; accepts both `filePattern` and `pattern`
- `grep` — custom implementation; accepts both `caseSensitive` and `ignoreCase`
- `ls` — compact limits for sub-agents
- `undo-edit` — uses file change tracker for proper multi-step undo
- `format-file` — post-edit formatting
- `skill` — loadable skill instructions

**New sub-agent tools** (all route through `parentModel` for provider-aware auth):
- `finder` — Claude Haiku code search agent
- `oracle` — Claude Sonnet technical advisor
- `librarian` — Claude Haiku GitHub repo explorer
- `code-review` — two-phase Claude Sonnet review agent
- `Task` — full Opus subprocess for parallel independent work
- `read-web-page` — web page Q&A sub-agent
- `read-session` — past session reader
- `search-sessions` — search session history

**New GitHub tools** (via GitHub API):
- `read_github`, `search_github`, `list_directory_github`, `glob_github`, `list_repositories`, `commit_search`, `diff`

**New web tools**:
- `web_search` — Perplexity/Exa/Gemini web search

### Agent Prompts (9)
| Prompt | Model | Purpose |
|---|---|---|
| `agent.amp.finder.md` | Claude Haiku | Code search — max parallelism, 2-3 turn limit |
| `agent.amp.oracle.md` | Claude Sonnet | Technical advisor — verify before claiming |
| `agent.amp.librarian.md` | Claude Haiku | GitHub repo explorer — cite everything |
| `prompt.amp.code-review-system.md` | Claude Sonnet | Phase 1 of code review: explore and analyze |
| `prompt.amp.code-review-report.md` | — | Phase 2: structured XML review format |
| `prompt.amp.handoff-extraction.md` | — | Context extraction for handoff |
| `prompt.harness-docs.pi.md` | — | Pi-specific harness docs injected into system prompt |
| `prompt.amp.system.md` | — | Full Amp system prompt with template vars |
| `prompt.amp.read-web-page.md` | — | Web page Q&A with citation rules |

### Claude Integration
The `claude-agent-sdk-pi` package (installed globally via npm) provides a custom pi provider called `claude-agent-sdk` that routes LLM calls through Claude Code's authentication (Pro/Max subscription) instead of Anthropic's pay-per-token API.

When using this provider:
- Main agent uses Claude via Claude Code auth
- All sub-agent tools (finder, oracle, librarian, code_review, Task, read_web_page, read_session) automatically inherit the parent's provider via `parentModel` routing
- Handoff extraction uses `piSpawn` (not raw API calls) so it also routes through Claude Code auth
- Switch providers freely — sub-agents always follow whatever the parent session is using

### Themes (2)
- **gruvbox** (active) — warm retro colors
- **nightowl** — dark blue Night Owl

### Skills (17)
`git`, `review`, `spawn`, `tmux`, `dig`, `document`, `write`, `remember`, `coordinate`, `rounds`, `spar`, `report`, `shepherd`, `nexus-fix`, `amp-voice`, `chrome-cdp`, `handoff`

### Settings
- Default provider: `zai` (GLM-5.1)
- Also available: `claude-agent-sdk` (Claude via Claude Code auth), `local-llama` (Gemma 4 26B-A4B / Qwen3.5)
- Theme: gruvbox
- Thinking: high (visible)
- Compaction: disabled (handoff replaces it)
- Steering/follow-up: all
- Quiet startup

### Permissions
- Blocks `git add -A` / `git add .` (forces explicit staging)
- Blocks force push
- Blocks `rm` (use `trash` instead)

### Pi Packages (4 npm)
- `pi-web-access` — web search, fetch, librarian skill, userinterface-wiki skill
- `pi-context` — context_log, context_tag, context_checkout tools
- `pi-token-burden` — token burden analysis
- `claude-agent-sdk-pi` — Claude Code auth provider for using Claude through Pro/Max subscription

## Directory Structure

```
pi-setup/
├── install.sh              # One-command installer
├── settings.json           # Pi settings (provider, model, theme, etc.)
├── keybindings.json        # Custom keybindings
├── models.json             # Model context window overrides
├── permissions.json        # Tool permission rules
├── extensions/             # 14 extension files/dirs
│   ├── editor/             # Custom TUI editor
│   ├── command-palette/    # Ctrl+Shift+P palette
│   ├── tools/              # 25 custom tools + shared lib/
│   ├── handoff.ts
│   ├── brain-loader.ts
│   ├── system-prompt.ts
│   ├── local-model.ts
│   ├── btw.ts
│   ├── session-name.ts
│   ├── session-breakdown.ts
│   ├── md-export.ts
│   ├── notify.ts
│   ├── todos.ts
│   └── tool-harness.ts
├── agents/                 # 9 agent prompt markdown files
├── themes/                 # gruvbox.json, nightowl.json
├── pi-skills/              # handoff skill
├── config-skills/          # 16 skills (~/.config/agents/skills/)
└── README.md               # This file
```

## For the AI on the Other Mac

```bash
cd /path/to/pi-setup
./install.sh
# Then authenticate Claude if using claude-agent-sdk:
claude-agent-sdk-pi auth
```
