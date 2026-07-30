# bdsqqq port — working plan and handoff

Porting selected pieces of **bdsqqq/dots** into our pi setup, phase by phase.
This file is the source of truth for what is done, what is left, and — most
importantly — the things we already proved that must **not** be re-litigated.

> Read this before touching Phase 4+. Several conclusions here cost hours to
> establish and are not obvious from the code.

**Upstream source:** `https://github.com/bdsqqq/dots` @ `e04b6207ef58454f3a6e0da9b19eb40201605e61` (2026-07-28)
Re-clone with: `git clone --depth 1 https://github.com/bdsqqq/dots.git /tmp/dots`
His pi lives at `/tmp/dots/user/pi/packages/{core,extensions}/`.

---

## 1. Status

| phase | scope | state |
|---|---|---|
| 0 | backups, baseline, settings drift | done |
| 1 | remove `pi-web-access` + `pi-tasks` | done |
| 2 | subagent tool injection + tool-name fixes | done |
| 3 | codex-patch, tool-policy, web_search, agent-message, search_sessions | done |
| **4** | **`apply_patch` replaces `edit`/`write`; `delegate` replaces `Task`** | **next** |
| 5 | `workflow` + `workflow-api` (strip `lookAt`) | pending |
| 6 | optional: `emil-design-eng` skill | pending |

Baseline at the end of Phase 3: **39 tools**, **126 unit tests pass**,
`verify-patches.sh` **8/8**, clean boot, repo↔live in sync.

---

## 2. Non-negotiable constraints

These are user decisions. Do not quietly change them.

1. **NO MODEL CHANGES.** Ours stay: `finder`/`librarian` → `claude-haiku-4-5`,
   `oracle`/`code_review` → `claude-sonnet-4-6`, parent → whatever `/model` says.
   His code frequently hardcodes `openai-codex/gpt-5.6-*`. **Strip every one.**
2. **Preserve our model-resolution block** in `lib/pi-spawn.ts` (~lines 145-170,
   the `isAnthropicParent` conditional). His `pi-spawn` has *no* model logic —
   it would silently drop our Anthropic-inheritance behaviour.
3. **Keep ours, do not port his:** `remember` skill, `git` skill (ours has the
   `wt` worktree section his deleted), `dig` skill, agent prompts
   (finder/oracle/librarian bodies are already byte-identical to his), the
   cross-cutting skill pattern (we have it in `dig` *and* `spar`; he only has
   `dig`), and `read_session` (see §5).
4. **Not being ported at all:** `hark` (needs a private `harkctl` binary that
   does not exist publicly), his `git` extension (it is only `@commit/` mention
   autocomplete — our `mentions.ts` already does more), `agent-memory`,
   `look-at`.
5. **Do not reinstall** `pi-web-access`, `pi-tasks`, `@tomooshi/condensed-milk-pi`.

---

## 3. Critical discoveries (do not re-derive these)

### 3.1 The OAuth tool filter — the big one

`@benvargas/pi-claude-code-use` **strips every tool whose name is not a Claude
Code "core" name** from the Anthropic request payload, whenever the model is
`anthropic` + OAuth. See its `filterAndRemapTools()` rule 6, "unknown flat-named
tool".

Core names that survive: `read, write, edit, bash, grep, glob, skill, task,
websearch, webfetch, todowrite, ...` (note: **`glob` yes, `find` no**;
**`websearch` yes, `web_search` no**).

Consequence: with **zero** tool definitions in the request, Claude emits
`<function_calls>` XML **as plain text** and then fabricates a result. This is
why the librarian invented `build.zig.zon` values for months.

Proven with the package's own debug log:

```bash
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/ccu.log pi --tools read_github ... 
# stage=before: ['read_github', 'Read', 'Bash']
# stage=after:  ['Read', 'Bash']
```

**Fix in place:** `lib/pi-spawn.ts` sets
`PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER: "1"` in the child env — but **only when
we pass an explicit `--tools` allowlist**, so an unrestricted child is not left
ungated at both layers.

**Gotcha:** this only covers tools we spawn. A bare `pi -p "..."` from the shell
still gets stripped. User does not use `pi -p`, so we deliberately did **not**
set it globally. The e2e test harnesses set it themselves.

### 3.2 Subagent tool gating — use native `--tools`, nothing else

pi 0.82+ applies `--tools` to built-in, extension **and** custom tools, and it
filters the **registry** (`agent-session.ts` `_refreshToolRegistry`), so nothing
can leak in later.

Measured, with the probe harness (`port-harness/probe.ts`):

| approach | result |
|---|---|
| no flags | 52 tools (everything) |
| `PI_INCLUDE_TOOLS` + `tool-harness` (old ours, and his) | 7 wanted + **`mcp` and 4 usage tools leaked in** |
| **`--no-tools` + `PI_INCLUDE_TOOLS` (his exact pattern)** | **0 tools — total failure on our pi** |
| **`--tools <explicit list>`** | **exactly the list, zero leak** ✅ |

So: **do not copy his `builtinTools: [] → --no-tools` mapping.** It empties the
registry so `setActiveTools()` cannot restore anything. `tool-harness.ts` was
deleted because native `--tools` fully replaces it.

The leaked `mcp` tool is what made haiku emit `<use_mcp>` markup.

### 3.3 Real tool names ≠ documented names

pi's builtins are `read, find, ls, grep, edit, bash, write`. **There is no
`glob` tool.** Our tools register `find`, `edit`, `write` — not `glob`,
`edit_file`, `create_file`. Wrong names in a tool list are **silently dropped**,
which is why `Task` subagents had no editing tools at all.

`lib/pi-spawn.ts` has `TOOL_ALIASES` (`glob→find`, `edit_file→edit`,
`create_file→write`) as a safety net. **When `apply_patch` lands, retarget
`edit_file`/`create_file` → `apply_patch`.**

### 3.4 Models lie about their own tool schema

During Phase 2 a model repeatedly claimed "I don't have tool X" while the probe
proved X was active. **Never trust a model's self-report.** Use
`port-harness/probe.ts`, which calls `pi.getActiveTools()`.

### 3.5 Extensions load once, at session start

Deploying a file does **not** affect a running session. Every mid-work
"regression" we chased turned out to be a stale in-memory session. Verify in a
fresh `pi -p` process, or restart.

---

## 4. Phase 4 — `apply_patch` + `delegate` (next, highest risk)

### 4.1 `apply_patch` replaces `edit` + `write`

Source: `/tmp/dots/user/pi/packages/extensions/apply-patch/index.ts`.
He deleted `edit-file` and `create-file` entirely; he **kept** `undo-edit`.

Dependencies — all satisfied:
`codex-patch` (already ported to `lib/codex-patch.ts`), `file-tracker`, `fs`,
`mutex`, `tool-policy` (our upgraded `lib/permissions.ts`).

**THE RENDERING QUESTION — already investigated, answer is good news.**

Our colourful diffs come from `renderCall()`/`renderResult()` on the tool
definition, backed by `lib/shiki-diff.ts` (syntax-highlighted via
`@heyhuynhgiabuu/pi-diff`) with `lib/box-format.ts` as fallback.

`renderResult` reads `result.content[0].text` — **a plain unified-diff string** —
plus `result.details.filePath` / `.replaceCount`. It knows nothing about how the
edit was made. So:

1. Port his `apply_patch` **logic** (parse, anti-laziness guard, atomic
   multi-file snapshots, mutex, file-tracker).
2. Make it emit a unified diff in `result.content[0].text`, same shape
   `edit`/`write` emit today.
3. **Attach our existing `renderCall`/`renderResult` + shiki-diff unchanged.**
   Discard his `box-format` rendering.

**Real work item:** `apply_patch` can change **multiple files per call**;
`edit`/`write` handle one. `parseDiffToSections` must emit one section per file.
**Verify the rendering visually BEFORE deleting `edit-file.ts`/`create-file.ts`.**

Also worth keeping from his: `REDACTION_PATTERNS` + `assertNoRedaction()` — it
rejects patches whose *added* lines contain `// ... rest unchanged`,
`[REDACTED]`, etc. It compares before/after counts, so pre-existing placeholders
are allowed and only newly-introduced ones are rejected. `snapshot()` also
refuses symlinks and hard-linked files.

**Cutover order (user approved real testing, not test files):**
1. Port `apply_patch` alongside existing `edit`/`write`.
2. Verify `undo_edit` still works — ours depends on `file-tracker.saveChange`;
   confirm `apply_patch` records changes the same way. **Main integration risk.**
3. Verify rendering visually.
4. Only then delete `edit-file.ts` + `create-file.ts`, flip `TOOL_ALIASES` to
   `apply_patch`, and update the system prompt to teach the patch envelope.

Backups exist (`~/pi-port-backup-*`, git history) — user explicitly said we can
restore `edit`/`write` if it feels worse.

### 4.2 `delegate` replaces `Task`

Source: `/tmp/dots/user/pi/packages/extensions/delegate/index.ts` (557 lines).
**He deleted `task` entirely — `delegate` is the only spawner in his manifest.**

His `CONFIG_DEFAULTS` already uses correct names (`find`, `apply_patch`).
Adds over our `task.ts`: `continueId` session continuation (resumable
subagents), routing metadata in the result, `leafId` (stubbed upstream),
DI/testability, streaming `onUpdate`.

**Requires:** session routing in `pi-spawn` — ours currently hardcodes
`--no-session`. His `resolveSessionRouting()` is the reference. Port that, but
**keep our model block**.

---

## 5. Phase 5 — `workflow` + `workflow-api`

Sources: `/tmp/dots/user/pi/packages/extensions/workflow/` (12 files) and
`core/workflow-api/`.

**Blocker to handle:** `workflow` hard-depends on `look-at`, which the user
excluded. `lookAt` appears as a typed agent recipe in `compiler.ts`,
`process-runner.ts`, `index.ts`, and the api recipes. **Strip the `lookAt`
recipe from all four.**

Needs `proper-lockfile` added to `extensions/tools/package.json`.
User said they will tweak the workflow engine themselves afterwards — land it
last and keep it clearly separated.

---

## 6. Phase 6 — optional

`emil-design-eng` skill (674 lines, single self-contained `SKILL.md`, no
external deps). Genuinely new capability — UI/animation review with a
frequency-gated decision table, real easing curves and duration budgets. Copy to
`pi-setup/config-skills/emil-design-eng/SKILL.md` and deploy to
`~/.config/agents/skills/`.

---

## 7. Verification recipes

Harnesses live in `pi-setup/port-harness/` (rescued from `/tmp`).

```bash
# patch audit — run after ANY change
bash pi-setup/verify-patches.sh

# unit tests (run from the repo dir; needs node_modules there)
cd pi-setup/extensions/tools && bun test bash-output.test.ts github.test.ts \
  lib/interpolate.test.ts lib/output-buffer.test.ts lib/permissions.test.ts \
  lib/codex-patch.test.ts

# e2e github + librarian (real API + real spawns)
cd pi-setup/extensions/tools && PI_E2E=1 bun test github.test.ts

# ground truth: what tools are ACTIVE in a child (never ask the model)
pi -e pi-setup/port-harness/probe.ts --mode json -p --no-session \
   --model claude-haiku-4-5 "ok" 2>&1 >/dev/null | grep PROBE

# per-subagent tool sets (edit CASES in the file to match current configs)
node pi-setup/port-harness/test-subagent-tools.mjs librarian|finder|oracle|task

# did a real tool call happen, or did the model fake it?
pi --mode json -p ... 2>/dev/null | python3 pi-setup/port-harness/tooltest.py

# capture the exact argv a subagent is spawned with
cat > /tmp/pi-wrapper.sh <<'EOF'
#!/bin/bash
printf '[SPAWN-ARGS] %s\n' "$*" >> /tmp/spawn-args.log
exec /opt/homebrew/bin/pi -e /path/to/probe.ts "$@"
EOF
chmod +x /tmp/pi-wrapper.sh   # then set PI_BIN=/tmp/pi-wrapper.sh
```

Always confirm **repo↔live sync** after deploying:
`diff -q pi-setup/extensions/tools/X.ts ~/.pi/agent/extensions/tools/X.ts`

---

## 8. Landmines

- **`pi remove` does not delete leftovers.** After removing a package, check
  both `~/.pi/agent/npm/node_modules` *and* `/opt/homebrew/lib/node_modules`.
- **`install.sh` drifts.** It still listed `pi-web-access`/`pi-tasks` after
  Phase 1 removed them — it would have silently reinstalled them. When removing
  a package, update `install.sh`, `verify-patches.sh`, `AGENTS.md`, both
  READMEs, and `settings.json` (repo **and** live).
- **`settings.json` runtime drift.** pi rewrites `lastChangelogVersion`,
  `hideThinkingBlock`, `defaultModel` at runtime. Sync repo←live *before*
  editing, or `install.sh` will downgrade the user's model. Live has no trailing
  newline; that diff is expected.
- **Porting his extensions:** his wrappers often do more than register a tool
  (mailbox watchers, mention providers, prompt hooks). Read the wrapper before
  discarding it. Conversely, **check for conflicts** — his `search-sessions` and
  `git` extensions register `@session`/`@commit` mention providers that our
  `mentions.ts` already owns.
- **His inline `import.meta.vitest` blocks:** convert to `bun:test` in a
  separate `*.test.ts`. All the scary `rmSync(recursive, force)` calls in his
  sessions code live **inside those test blocks** — production paths are
  read-only.
- **Tool param names:** models guess. We added `lib/params.ts` (`requireParam`)
  so subagent tools accept aliases; canonical param must be `Type.Optional` or
  pi rejects the call before `execute()` can normalise it.
- **`rm` is blocked** by our own permission rules — use `trash`.
