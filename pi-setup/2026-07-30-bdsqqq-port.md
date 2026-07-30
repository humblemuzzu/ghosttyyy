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
| 4a | `apply_patch` ported | done |
| **4b** | **cutover: `edit`/`write` deleted and natives hidden** | **done** |
| **4c** | **`delegate` replaces `Task` (resumable sub-agents)** | **done** |
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

### 3.5 macOS realpath: sync and async DISAGREE about case

`fs.realpathSync("dup.txt")` returns `dup.txt`; `fs.promises.realpath("dup.txt")`
and `fs.realpathSync.native("dup.txt")` return the true on-disk `Dup.txt`.

This caused a **hard hang** in the ported `apply_patch`: his alias guard used
the JS `realpathSync`, so two case-variant paths looked distinct and passed the
check — but pi core's `withFileMutationQueue` keys by the ASYNC realpath, so
both collapsed to one key, and nesting an acquisition of a held key deadlocks
forever. No error, no timeout, just a frozen tool.

**Rule: any path key that must agree with pi core's queue MUST use
`fs.realpathSync.native`.** Not a bug upstream — case-sensitive filesystems
never show it. Regression test: `apply-patch.test.ts` "case-variant aliases are
refused instead of deadlocking".

### 3.6 Models need the patch format SHOWN, not described

Measured with haiku on a one-line edit: the original schema (`input` required,
`additionalProperties: false`, prose-only description) produced **15 consecutive
failed calls and an abandoned task**. The model sent `{path, patch}` with a
plain unified diff, then flailed against terse errors.

After (a) accepting aliases via `lib/params.ts` with `input` Optional, (b) an
example envelope in the description, and (c) errors that explain the difference
between a unified diff and a Codex envelope: **2 calls, task completed**.

Unified diffs are deliberately NOT auto-converted — their hunk headers may be
invented, and silently reinterpreting a patch is how files get corrupted.

### 3.7 UPSTREAM BUG: `Add File` clobbered existing files

His `apply_patch` has no existence guard on the `add` branch, while `delete`
and `update` both guard on `current`. `*** Add File:` on an existing path
replaced the entire file with the patch body — no context matching, reported
only as `M path`. Verified: a 4-line file became 1 line.

Found by our own `code_review` tool during Phase 4a verification. Fixed with a
mirror guard; wholesale replacement must now be spelled Delete File + Add File.
Regression-tested.

### 3.8 Sub-agent verdicts must be verified, not applied

Same verification pass, two sub-agents produced confident but wrong advice:

- **oracle** said `withMutationQueues` (pi's queue) is redundant and advised
  deleting `canonicalMutationPath` with it. Its premise was right (only pi's
  own `edit.js`/`write.js` take that queue, and we shadow them) but the advice
  was wrong twice: `canonicalPaths` also feeds the hierarchy check, the
  **alias/data-loss guard** and the permission check; and Phase 4b DELETES our
  `edit`/`write`, which un-shadows pi's native ones — making the queue more
  necessary, not less.
- **code_review** called the outer `path.resolve(resolveToAbsolute(...))`
  redundant. It is not: `resolveToAbsolute` returns absolute paths unnormalised,
  so `/tmp/a/b/../c` stays as-is and only the outer resolve produces `/tmp/a/c`.
  It is load-bearing for path-traversal safety.

Both were caught by checking the claim against the code before acting. The
critical `Add File` finding from the same review WAS real — so the lesson is
verify each claim independently, not trust or dismiss the tool wholesale.

### 3.9 Provider-gated failures: ALWAYS test BOTH model families

A tool schema change passed every Anthropic test and **broke every OpenAI
session**, because pi-ai gates the check on the provider:

- `constrainedSampling: {type:"grammar"}` requires the schema to have EXACTLY
  ONE required string property (`inferGrammarInputProperty`,
  `pi-ai/dist/api/constrained-sampling.js:38`).
- `resolveGrammarConstrainedSampling` returns early when the provider lacks
  grammar support (**line 68**) — so on Anthropic the schema is never checked.

Making `input` optional (to accept aliases) set `required: []`. Every
`openai-codex/*` request then died with *"Tool apply_patch cannot use grammar
constrained sampling"* before the turn even started, while 153 Claude-based
tests stayed green.

**Rules:**
1. After ANY tool-schema change, smoke-test on an OpenAI model AND an
   Anthropic model. `defaultModel` is currently `openai-codex/gpt-5.6-sol`.
2. A tool with `constrainedSampling` cannot use the `lib/params.ts` optional-
   alias pattern. Grammar sampling is the better deal on OpenAI anyway: it
   forces a syntactically valid envelope at the token level.
3. Guarded by `apply-patch.test.ts` → "schema satisfies pi-ai's
   grammar-sampling contract".

**Cross-provider matrix** (same task: one-line edit via apply_patch, exact file
comparison). Run this after any change to the tool's schema, description or
promptGuidelines:

| model | calls | errors | result |
|---|---|---|---|
| `openai-codex/gpt-5.6-sol` | 1 | none | exact |
| `openai-codex/gpt-5.5` | 1 | none | exact |
| `anthropic/claude-opus-4-8` | 1 | none | exact |
| `deepseek/deepseek-v4-pro` | 1 | none | exact |
| `kimi-code/kimi-for-coding:high` | 2 | 1 rejected hunk, retried | exact |
| `deepseek/deepseek-v4-flash` | 1 | none | **wrong** |

What closed the gap on non-OpenAI providers was `promptGuidelines` + the
parameter description, NOT the schema: grammar sampling only exists on
OpenAI-family providers, so for Anthropic/Kimi/DeepSeek/Sakana that prose is
the entire contract. Naming the single `input` argument explicitly, and saying
"there is no path argument", took claude-opus from 3 calls to 1.

`deepseek-v4-flash` emitted a syntactically VALID envelope that expressed the
wrong intent (an add-only hunk keeping the old line as context, so the file
gained a line instead of changing one). No schema or grammar can catch that —
it is model capability, not tool design. Treat flash-class models as unsuitable
for patching.

The kimi run is the safety property working as designed: a hunk whose context
did not match was refused, and the retry succeeded.

### 3.10 Extensions load once, at session start

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
1. ~~Port `apply_patch` alongside existing `edit`/`write`.~~ **DONE**
2. ~~Verify `undo_edit` still works.~~ **DONE** — and it needed real work:
   - `file-tracker` gained `saveChanges` (plural) and optional
     `beforeExists`/`afterExists`/`beforeMode`/`afterMode`
   - `revertChange` honoured `beforeExists`, which **fixed a pre-existing bug**:
     undoing a file CREATION used to leave an empty file behind. it now removes
     the file. old records without the field fall back to `isNewFile`
     (regression-tested).
   - `mutex` gained `withFileLocks` (plural, sorted acquisition = no deadlock)
3. ~~Verify rendering.~~ **DONE** — one Shiki component PER FILE (the component
   renders `parsePatchFiles(...)[0]` and detects language from a single path,
   so a shared one would show only the first file). Collapsed = last file,
   expanded = all files.
4. ~~delete edit/write, retarget aliases, teach the prompt.~~ **DONE — see §4.1b**

**Status:** 19 behavioural tests in `apply-patch.test.ts` (real temp FS, no
mocks); live-verified with haiku for single-file, multi-file atomic, rollback,
and the alias/deadlock case. 40 tools registered, clean boot.

**Verified in a real session (Phase 4a sign-off):** `apply_patch` used directly
for a 3-file atomic patch (2 updates + 1 create); `undo_edit` correctly REMOVED
the created file and restored the modified one; a spawned `Task` sub-agent
reported its 11 tools and edited files successfully; `finder`, `librarian`,
`code_review` and `oracle` all returned accurate, tool-backed results
(librarian's GitHub data matched his real package.json — it used to
hallucinate). `format_file`/`finder`/`web_search` surviving in the sub-agent
tool list re-confirms the Phase 2 OAuth-filter fix still holds.

Backups exist (`~/pi-port-backup-*`, git history) — user explicitly said we can
restore `edit`/`write` if it feels worse.

### 4.1b The cutover (done) — what it actually required

1. **`edit-file.ts` + `create-file.ts` deleted.** Only `index.ts` imported them;
   `resolveWithVariants` lives in `read.ts`, so nothing else broke.
2. **pi's NATIVE edit/write hidden** — a `session_start` hook in `index.ts`
   drops them from the active set. Deleting our files only UN-shadows the
   built-ins, which have no mutex/tracking/scrubbing. Verified: 38 tools, zero
   natives.
   **Caveat measured:** an explicit `--tools read,edit,write` allowlist
   RESURRECTS the natives (it is applied after our hook). Our spawn path is
   safe because `TOOL_ALIASES` rewrites those names first — keep both layers.
3. **`TOOL_ALIASES`** now maps `edit`/`write`/`edit_file`/`create_file` ->
   `apply_patch`.
4. **`Task`** requests `apply_patch` instead of `edit`/`write`, and
   `sub-agent-render.ts` gained an `apply_patch` case (without it the tree line
   fell through to `default` and printed the whole envelope as raw JSON).
5. **System prompt** teaches `apply_patch` and explicitly forbids mutating files
   via bash. **This mattered:** with the natives hidden but the prompt stale,
   the model silently fell back to `bash` (`sed`/redirection), bypassing undo
   tracking and permissions entirely. Prompt fixed -> both families use
   `apply_patch`.

**Two bugs found during cutover verification** (both silent corruption):

- **fuzzy match rewrote indentation.** Old lines matched via a whitespace-
  insensitive normalizer, but new lines were inserted VERBATIM — so the patch's
  wrong indentation replaced the file's real one. Hit live on
  `claude-opus-4-8`, which grepped instead of reading and produced a hunk one
  space off. `applyPatchChunks` now re-indents replacements to the FILE's
  indentation whenever the match ignored leading whitespace, preserving
  relative indentation inside the hunk. **Upstream's own test asserted the
  buggy behaviour** (`new` de-indented to column 0 out of a function body) and
  was updated with a comment recording the divergence.
- **ambiguous hunks were guessed, not refused.** `seekSequence` returned the
  first match, so a hunk whose context appears twice silently edited the wrong
  occurrence. An unanchored ambiguous hunk is now rejected with a message
  telling the model to add context or an `@@ <anchor>`; anchored and
  extra-context forms still work.

**Post-cutover matrix — 4/4 EXACT:** gpt-5.6-sol, claude-opus-4-8,
deepseek-v4-pro, kimi-for-coding:high. 160 tests, patches 8/8, 38 tools,
zero natives, repo<->live synced.

### 4.2 `delegate` replaces `Task`

Source: `/tmp/dots/user/pi/packages/extensions/delegate/index.ts`. DONE:
`task.ts` deleted, `delegate.ts` registered, all references updated
(system prompt, `@task` mention source, e2e test).

**Session routing** (`lib/pi-spawn.ts`) — the one real prerequisite:
`SpawnSessionConfig` / `SpawnSessionMeta` added, and `piSpawn` now maps
`session` to CLI flags. Default is unchanged (`--no-session`), so finder /
oracle / librarian / code_review stay ephemeral — verified: a finder run adds
**0** session files.

We use pi's native **`--session-id <id>`** (creates on first use, reopens
afterwards) rather than upstream's hand-written linked-session header file
plus `--session <path>`. Fewer moving parts and no session-file format to keep
in sync with pi. Verified directly before building on it: two `-p` calls with
the same id, the second recalled a number from the first.

`leafId` is **rejected**, not ignored: pi's CLI cannot target a branch leaf,
and silently continuing from the wrong one would corrupt the child's history.
Session ids are validated against `^[\w.-]{1,128}$` because pi puts the id
verbatim into the session FILENAME.

**Kept ours, fixed his omission:** upstream passes no model at all, which here
would fall back to settings' `defaultProvider` instead of the model the parent
is actually using. `delegate` passes `parentModel`, so the child inherits the
parent's provider + auth route.

**`prompt` is Optional in the schema** with `requireParam` aliases
(`prompt`/`task`/`instructions`), because pi validates before `execute()`.
Measured: haiku called `delegate({task})` and got a bare "must have required
properties prompt", burning a turn. Safe here ONLY because delegate declares no
`constrainedSampling` — see §3.9 for why apply_patch cannot do this.
`description` is optional too, defaulting to the prompt's first line.

**Verified end-to-end:** delegate ran a sub-agent that edited a file with
`apply_patch` and returned a `continueId`; resuming with that id, the child
recalled the file, the constant and both values **from memory without
re-reading**. Ephemeral sub-agents unaffected. 38 tools, clean boot,
160 tests, patches 8/8, repo<->live synced.

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
  so subagent tools accept aliases. **SUPERSEDED 2026-07-31 — see "Tool contract"
  below: the canonical param is now `Type.String` (required), and `requireParam`
  is a safety net rather than the primary mechanism.**
- **`rm` is blocked** by our own permission rules — use `trash`.

## Tool contract — schema is the contract (2026-07-31)

**Symptom.** In a cold session, asked for two librarians and one oracle, the
model first ran `ls` on `extensions/tools/`, then grepped
`"parameters|Type.Object|Type.String"`, then read `librarian.ts` and `oracle.ts`
— ~8 discovery calls before any work, repeatable in every new session.

**Cause — our spec contradicted itself.** Making the canonical param
`Type.Optional` (so `requireParam` could rescue an aliased call) meant the wire
schema said `required: []` while the param description said `"REQUIRED."`.
Models treat JSON Schema `required` as machine-truth and prose as advisory, so
the contradiction made the entire spec untrustworthy and the model went to the
source. Separately, `librarian`'s description discussed "what repositories you
want to understand" while exposing **no** repository parameter — even though the
seven github tools beside it all take one.

**Fix (5 parts).** (1) The primary param of `librarian`/`oracle`/`delegate`/
`finder`/`code_review` is now genuinely required and `"REQUIRED."` is gone from
every param description, replaced by a positive `(Also accepted: …)` alias list.
(2) `librarian` gained a real `repository: string[]`, folded into the sub-agent
prompt via `normalizeRepositories()` (tolerates a bare string and a
JSON-stringified array — the shape that made pi-tasks unusable). (3) Every
sub-agent description ends with a literal `Example: tool({ … })`. (4) The system
prompt gained a **Trust the tool schemas** block forbidding source-reading to
discover parameters — added last, since it is only true once 1–3 landed.
(5) `tool-contract.test.ts` (34 tests) encodes all of it as invariants.

**Grammar sampling is NOT a blocker here.** pi-ai's "exactly one required string
property" rule (`constrained-sampling.js:38`) only binds tools that **opt in**
via a `constrainedSampling` field — `resolveGrammarConstrainedSampling` returns
early when absent. `apply_patch` opts in; the five sub-agent tools do not, and a
test now asserts they never start. The earlier apply_patch breakage was
opt-in-specific, not a general rule about required params.

**Verified.** 209 tests pass; both an Anthropic (`claude-opus-5`) and an OpenAI
(`gpt-5.6-sol`) model call the tools cleanly; and the original repro now yields
**3 parent tool executions — `librarian`, `librarian`, `oracle`, started on
consecutive lines before any finished (parallel), with 0 discovery calls** and
`repository: ["xai-org/grok-build"]` populated correctly on the first attempt.
