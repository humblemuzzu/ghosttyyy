# 2026-05-17 — Pi v0.74.0 Migration + Architecture Decisions

> Reference log for this setup. If anything breaks after today, check here first.
> Covers: version upgrade, namespace migration, CrofAI fixes, context management switch, package cleanup, goal system.

---

## 1. Research Phase

### Pi Repository Investigation (5 subagents)

- **Repo location:** `github.com/badlogic/pi-mono` → renamed to `github.com/earendil-works/pi`
- **Cloned and read the full codebase** — all source files, not just docs
- **Analyzed all active branches:** `bigrefactor` (merged), `earendil` (merged), `better-autocomplete` (open), `shrinkwrap-that-shit` (open), `simpler-proxy` (open)
- **Read last 100 commits** — timeline of the AgentHarness refactor (Apr 30 – May 16)
- **Audited all 46 files** importing from `@mariozechner/*` — mapped 90 API surface points
- **Verified exact API diff** between v0.71.0 and v0.74.0 by reading `.d.ts` declarations

### Key Findings

1. **The "BigRefactor"** — Pi is splitting into 3 layers:
   - `@earendil-works/pi-ai` — LLM provider abstraction
   - `@earendil-works/pi-agent-core` — new AgentHarness (session, tools, hooks, compaction)
   - `@earendil-works/pi-coding-agent` — ExtensionHost, TUI, commands, SDK
   - The harness owns: agent loop, session persistence, compaction, resource loading, turn state snapshotting
   - Extensions stay an app-level concern (coding-agent still owns `ExtensionHost`)

2. **Tools are NOT being removed.** Mario's tweet about `pi -nbt` ("no builtin tools") is an existing optional flag (since v0.70.0). It disables built-in tools but keeps extension tools active. Our custom tools work regardless.

3. **Only ONE breaking change v0.73.1 → v0.74.0:** `compat.reasoningEffortMap` removed, replaced by model-level `thinkingLevelMap`. Affected our `crof.ts` extension.

4. **Namespace rename:** `@mariozechner/*` → `@earendil-works/*`. Backward-compat aliases preserved in v0.74.0's extension loader (10 entries in `VIRTUAL_MODULES` and `getAliases()`). Our `@mariozechner` imports still resolve.

5. **Upcoming (not yet shipped):** Typed hook system replacing `pi.on()` with `api.on(HookType, handler, cleanup)`. Reducers for event chaining. Extension context facades. Will require migration when it lands (v0.75.0+).

---

## 2. Migration: v0.73.1 → v0.74.0

### Steps Performed

1. **Backup:** `~/.pi/agent/` → `~/.pi/agent-backup-20260517`
2. **Fixed crof.ts breaking change** BEFORE updating pi:
   - Removed `reasoningEffortMap` from `CROF_COMPAT` object
   - Created new `CROF_THINKING_LEVEL_MAP` constant at module scope
   - Added `thinkingLevelMap: CROF_THINKING_LEVEL_MAP` to all 21 model definitions (20 fallback + 1 in `buildModelsFromApi`)
3. **Updated pi:**
   - `npm uninstall -g @mariozechner/pi-coding-agent`
   - `npm install -g @earendil-works/pi-coding-agent@0.74.0`
   - Cleaned empty `@mariozechner/` directory
4. **Re-applied all patches** (npm update wipes them):
   - condensed-milk: `$ ` prefix strip + `cmd` param support (2 files)
   - pi-sub-bar: CrofAI + Kimi providers (7 files)
   - pi-gpt-config: tool discipline removed (1 file)
   - pi-claude-bridge: system prompt patches (1 file, inactive)
   - pi-tool-display: config with all overrides false (verified exists)
5. **Verified backward-compat aliases** — confirmed `@mariozechner/*` maps to `@earendil-works/*` in `loader.js`
6. **Updated repo settings.json** — synced `lastChangelogVersion` to 0.73.1, added `gptConfig` block
7. **Updated install.sh** — changed package name reference from `@mariozechner` to `@earendil-works`

### Verification (3 subagents)

- 15/15 extensions, 25/25 tools, 33/33 lib files — all present and non-empty
- All 90 API surface points confirmed present in v0.74.0 type declarations
- `reasoningEffortMap` confirmed deleted, `thinkingLevelMap` confirmed present
- All 5 patches verified applied
- Repo ↔ live match confirmed (packages, extensions, compaction)

---

## 3. CrofAI Extension Overhaul

CrofAI changed their API significantly since the extension was written. Found and fixed 4 issues:

| Fix | Problem | Solution |
|-----|---------|----------|
| **Pricing format** | API switched from per-token (`0.00000028`) to per-M-token (`0.28`). Our code multiplied by 1M → showed $280,000 instead of $0.28 | Auto-detect: `isPerToken = rawPrompt > 0 && rawPrompt < 0.001`. Handles both formats. |
| **`off` thinking level** | Mapped to `null` (don't send param). CrofAI uses `"none"` to disable reasoning. Model defaulted to some thinking level. | Changed `off: null` → `off: "none"` per CrofAI docs |
| **`reasoning_effort` field** | New API field. Models like kimi-k2.5 and gemma-4-31b-it have `reasoning_effort: true` but not `custom_reasoning`. We only checked `custom_reasoning`. | Added `reasoning_effort?: boolean` to `CrofModel` interface. Changed reasoning check to `!!m.custom_reasoning \|\| !!m.reasoning_effort` |
| **`thinkingLevelMap` placement** | v0.74.0 removed `compat.reasoningEffortMap`. Need model-level field. | Created `CROF_THINKING_LEVEL_MAP`, added to all 21 model objects |

**Stale fallback note:** Hardcoded fallback models (used when API unreachable) are from 2026-04-28. Missing 2 models (mimo-v2.5-pro), wrong pricing on many, removed model (qwen3.5-9b-chat), free tier gone. Low priority — dynamic fetch handles normal operation.

---

## 4. Context Management Decision

### Decision: Compaction ON, Handoff OFF

**What changed:**
- `compaction.enabled`: `false` → `true`
- `handoff.ts`: removed from extensions list (file stays on disk)
- Handoff skill: moved to `~/.pi/agent/skills/handoff.disabled/`
- System prompt (`prompt.harness-docs.pi.md`): replaced handoff description with compaction description

**Why:**
- Goal system (`pi-codex-goal`) needs auto-continuation across turns. When context fills, compaction preserves goal state via `session_compact` hook. Handoff creates a new session = goal lost.
- Pi's native compaction (LLM-based) handles context automatically. No manual intervention needed.
- Handoff can be re-enabled anytime by adding `"~/.pi/agent/extensions/handoff.ts"` back to extensions and setting `compaction.enabled: false`.

**What still works:**
- `/pi-vcc` command still works if VCC is re-added later
- Handoff file on disk, can be re-enabled
- `@handoff/id` mentions will return no results (safe, no crash)
- Editor label events from handoff just never fire (safe)

---

## 5. Goal System: pi-codex-goal

### Evaluation Process (3 subagents)

**Read OpenAI Codex source** — 1,778 lines of Rust, full architecture: SQLite persistence, `<goal_context>` user-role injection, continuation/budget-limit/objective-updated prompt templates, token/time accounting, completion audit.

**Evaluated 5 community packages:**

| Package | Score | Key Strengths | Key Weaknesses |
|---------|-------|---------------|----------------|
| `@capyup/pi-goal` | 9.5/10 | Multi-goal, independent auditor, sisyphus mode, disk persistence | Uses `setActiveTools()` — conflicts with tool-harness.ts |
| `pi-codex-goal` (fitchmultz) | 8/10 | Clean, minimal, no conflicts, proper compaction hooks | No drafting flow, no auditor |
| `pi-goals` (transcendr) | 8.5/10 | Queue system, templates, churn monitoring | Uses `setActiveTools()`, 36 files |
| `pi-goal` (miclivs) | 7.5/10 | Minimal (468 lines), Codex-faithful | Session-only persistence |
| `@ramarivera/pi-goal` | 7/10 | Per-model cost tracking | pino dependency, single file |

### Decision: pi-codex-goal

**Reason:** Zero conflict risk with our 25 custom tools, handoff, mentions, system-prompt, editor. No `setActiveTools()` calls (avoids tool-harness conflict). Proper `session_compact` hook for compaction survival. Closest to Codex's design — simple, single goal, auto-continuation, strict completion audit.

**Usage:**
```
/goal Build JWT auth with refresh tokens
/goal pause
/goal resume
/goal clear
/goal          # show status
```

---

## 6. Package Cleanup

### Removed from packages list:
- `@sting8k/pi-vcc` — not needed with native compaction enabled. Can re-add if needed.
- `pi-computer-use` — not actively used. Can re-add if needed.

### Added to packages list:
- `pi-codex-goal` — Codex-style autonomous goal system

### Updated packages:
- `@sting8k/pi-vcc`: 0.3.12 → 0.3.13 (before removal)
- `pi-token-burden`: 0.6.3 → 0.6.4

### pi-gpt-config patch update:
- Changed `DEFAULT_STATE.personality` from `"none"` to `"claude"` — Claude personality is now the default

---

## 7. Final State

### Pi Version
- **Package:** `@earendil-works/pi-coding-agent@0.74.0`
- **Binary:** `/opt/homebrew/bin/pi`
- **Backward compat:** `@mariozechner/*` aliases active (10 entries in loader)

### Settings
- **Compaction:** enabled (native LLM-based)
- **Theme:** gruvbox
- **Provider:** anthropic / claude-opus-4-6
- **Thinking:** high

### 14 Active Extensions
editor, session-name, tool-harness, system-prompt, tools (25), command-palette, session-breakdown, btw, notify, todos, local-model, mentions, opencode-zen, crof

### 11 Active Packages
pi-web-access, pi-context, pi-token-burden, @benvargas/pi-claude-code-use, @marckrenn/pi-sub-bar, pi-autoresearch, pi-tool-display, @tomooshi/condensed-milk-pi, pi-gpt-config, pi-ask, pi-codex-goal

### 4 Patched Packages (re-apply after npm update)
```bash
# condensed-milk (CRITICAL — data loss without it)
cp pi-setup/condensed-milk-patches/index.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/index.ts
cp pi-setup/condensed-milk-patches/filters/context-compress.ts /opt/homebrew/lib/node_modules/@tomooshi/condensed-milk-pi/filters/context-compress.ts

# pi-sub-bar (CrofAI + Kimi providers)
# Run install.sh sub-bar section or manually copy 7 files

# pi-gpt-config (tool discipline removed + claude personality default)
cp pi-setup/gpt-config-patches/index.ts ~/.pi/agent/git/github.com/edxeth/pi-gpt-config/index.ts

# pi-tool-display config (verify exists, recreate if missing)
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json
```

### Disabled (on disk, not loaded)
- `handoff.ts` — extension file at `~/.pi/agent/extensions/`
- `handoff` skill — at `~/.pi/agent/skills/handoff.disabled/`
- `brain-loader.ts`, `md-export.ts` — extension files
- `pi-vcc` — npm installed, not in packages
- `pi-computer-use` — git installed, not in packages
- `pi-claude-bridge` — npm installed, not in packages

---

## 8. What to Watch For

### Next pi update (v0.75.0+)
- **Hook system migration:** `pi.on("event", handler)` → `api.on(HookType, handler, cleanup)`. Will require updating all 14 extensions.
- **`@mariozechner` alias deprecation:** Eventually the backward-compat aliases will be removed. Will need to rename imports in 46 files. Automated: `find . -name "*.ts" -exec sed -i '' 's/@mariozechner\/pi-coding-agent/@earendil-works\/pi-coding-agent/g' {} +`
- **ExecutionEnv abstraction:** If tools start requiring `ExecutionEnv` instead of direct `node:fs`/`child_process`, custom tools that bypass pi's bash will need adaptation.

### If compaction causes issues
- Re-enable handoff: add `"~/.pi/agent/extensions/handoff.ts"` to extensions, set `compaction.enabled: false`, rename `handoff.disabled` back to `handoff` in skills
- Or add VCC back: add `"npm:@sting8k/pi-vcc"` to packages, set `overrideDefaultCompaction: true` in `pi-vcc-config.json`

### If CrofAI changes their API again
- Check pricing format (per-token vs per-M detection handles both)
- Check for new model fields beyond `custom_reasoning` and `reasoning_effort`
- Clear cache: `rm ~/.pi/cache/crof-models.json`
