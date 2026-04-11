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

Two approaches for using Claude with Pi:

#### Option 1: `claude-agent-sdk-pi` (prateekmedia — deprecated, replaced by pi-claude-bridge)
The `claude-agent-sdk-pi` package was previously used but caused issues with custom tools and had poor token efficiency. **Do not use this anymore.**

#### Option 2: `pi-claude-bridge` (elidickinson — active)
Installed globally via npm. Provides a `claude-bridge` provider that routes LLM calls through the official Claude Code Agent SDK using Claude Max ($200/mo) OAuth authentication.

**How it works:**
```
Pi sends prompt → pi-claude-bridge → Claude Code Agent SDK (query()) → Claude API
                            ↓
              Pi tools wrapped as MCP server (custom-tools)
                            ↓
              Claude calls tools → MCP bridge → Pi executes → results back to Claude
```

**Models available:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`

**Install:**
```bash
npm install -g pi-claude-bridge
# Then in Pi:
/model claude-sonnet-4-6
```

**Usage with sub-agents:**
- Main agent uses Claude via Claude Code auth
- All sub-agent tools (finder, oracle, librarian, code_review, Task, read_web_page, read_session) automatically inherit the parent's provider via `parentModel` routing
- Handoff extraction uses `piSpawn` (not raw API calls) so it also routes through Claude Code auth
- Switch providers freely — sub-agents always follow whatever the parent session is using

#### pi-claude-bridge Local Modifications (CRITICAL)

**File:** `/opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts`

These changes are **not in the git repo** — they're local patches to the globally installed npm package. If you update pi-claude-bridge (`npm update -g pi-claude-bridge`), these changes will be **overwritten** and must be re-applied manually.

**What we changed and why:**

| Change | Location | Original | Modified | Why |
|--------|----------|----------|----------|-----|
| System prompt | Line ~1341 | `systemPrompt: { type: "preset", preset: "claude_code", append: ... }` | `systemPrompt: systemPromptAppend \|\| ""` | Remove 15-20k token Claude Code system prompt. Pi's own prompt is sent instead via `systemPromptAppend` (AGENTS.md + skills) |
| AskClaude prompt | Line ~1557 | `systemPrompt: skillsBlock ? { type: "preset", preset: "claude_code", excludeDynamicSections: true, append: skillsBlock } : undefined` | `systemPrompt: skillsBlock \|\| undefined` | Same — remove CC preset from askClaude path |

**Impact of these changes:**
- **Before:** 50,334 tokens cacheWrite on first message (CC preset + 34 tool schemas)
- **After:** 32,383 tokens cacheWrite on first message (only 34 tool schemas + Pi prompt)
- **Saved:** ~18k tokens per session (36% reduction)
- **Caching:** Still 100% cache hit on 2nd+ messages
- **Detection:** pi-claude-bridge already scrubs "pi" references from system prompt (replaces with "environment", "~/.pi" → "~/.claude")

**How the system prompt is built (what actually gets sent):**
1. `extractAgentsAppend()` — reads `~/.pi/agent/agents/Amp.md` (your AGENTS.md), sanitizes it (replaces "pi" → "environment", "~/.pi" → "~/.claude")
2. `extractSkillsBlock(context.systemPrompt)` — extracts Pi's skills block from Pi's system prompt
3. Both joined → `systemPromptAppend` → sent as plain string `systemPrompt`
4. No Claude Code preset at all — Pi's own prompt goes through directly

**To re-apply after an update:**
Tell your AI assistant: "pi-claude-bridge was updated, re-apply our system prompt changes." They should:
1. Read the new `/opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts`
2. Find the two `systemPrompt` blocks that use `preset: "claude_code"`
3. Replace the main provider path with: `systemPrompt: systemPromptAppend || ""`
4. Replace the askClaude path with: `systemPrompt: skillsBlock || undefined`
5. Verify no `preset.*claude_code` remains

**Debug mode (for troubleshooting):**
```bash
CLAUDE_BRIDGE_DEBUG=1 pi   # enables logging to ~/.pi/agent/claude-bridge.log
# Check usage: cat ~/.pi/agent/claude-bridge.log | grep 'usage:'
# Delete log: rm ~/.pi/agent/claude-bridge.log
```

### Themes (2)
- **gruvbox** (active) — warm retro colors
- **nightowl** — dark blue Night Owl

### Skills (17)
`git`, `review`, `spawn`, `tmux`, `dig`, `document`, `write`, `remember`, `coordinate`, `rounds`, `spar`, `report`, `shepherd`, `nexus-fix`, `amp-voice`, `chrome-cdp`, `handoff`

### Settings
- Default provider: `zai` (GLM-5.1)
- Also available: `claude-bridge` (Claude via Claude Code Max auth — recommended for Claude usage), `local-llama` (Gemma 4 26B-A4B / Qwen3.5)
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
- `pi-claude-bridge` (v0.1.6) — Claude Code Agent SDK bridge for Claude Max auth. **Has local modifications — see "pi-claude-bridge Local Modifications" section.**

## Directory Structure

```
pi-setup/
├── install.sh              # One-command installer (includes bridge patch step)
├── settings.json           # Pi settings (provider: claude-bridge, model: claude-sonnet-4-6)
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
├── pi-skills/              # handoff, find-skills, userinterface-wiki skills
├── config-skills/          # 16 skills (~/.config/agents/skills/)
├── claude-bridge-patches/  # Modified pi-claude-bridge index.ts + package.json
│   ├── index.ts            # Our patched version with custom system prompt
│   └── package.json        # Version pin (0.1.6)
└── README.md               # This file
```

## Backup

A full backup of the Pi setup (made 2025-04-11) is at:
```
/Users/muzammil/Documents/Code stuff/ghosttyyy/pi-setup-backup-20260411-220941/
```

Contains: extensions/, agents/, themes/, skills/, config-skills/, node_modules/, settings.json, permissions.json, models.json, auth.json, pi-setup/

If anything breaks after changes, restore from this backup.

## For the AI on the Other Mac

```bash
cd /path/to/pi-setup
./install.sh
# Then if using claude-bridge provider:
# 1. Install: npm install -g pi-claude-bridge
# 2. In Pi: /model claude-sonnet-4-6
# 3. Re-apply system prompt patches (see "pi-claude-bridge Local Modifications" above)
```

## Session Log

### 2026-04-11 — pi-claude-bridge Setup & Optimization

**Problem:** `claude-agent-sdk-pi` (prateekmedia) was costing 4x the Max plan, had poor caching, and broke custom tools. Anthropic blocked 3rd party harnesses from using Claude API directly.

**Solution:** Switched to `pi-claude-bridge` (elidickinson) which uses the official Claude Code Agent SDK properly.

**What we did:**
1. Backed up entire Pi setup to `pi-setup-backup-20260411-220941/`
2. Installed `pi-claude-bridge@0.1.6` globally via npm
3. Verified all 14 extensions and 25 custom tools work with the bridge (they do — tools are MCP-bridged, not overridden)
4. **Removed Claude Code system prompt** — replaced `preset: "claude_code"` with custom empty prompt in two locations in `index.ts`
5. Verified MCP auto-loading is suppressed (context7, filesystem, figma etc. don't get sent)
6. Verified Pi's own system prompt goes through with "pi" references scrubbed

**Token savings:**
- First message: 50,334 → 32,383 tokens (saved ~18k, 36% reduction)
- Cache hits: 100% on subsequent messages
- The remaining 32k is 34 MCP tool schemas (~30k) + Pi agent prompt (~2k) — can't reduce further without removing tools

**Key files modified:**
- `/opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts` — two system prompt changes (local, not in git)
- `~/.mcp.json` — cleared context7 (removed MCP we didn't need)
- `broski/.mcp.json` — kept filesystem MCP (Claude Code needs it for broski project)
