# AGENTS.md — Pi Setup Reference

Read by pi and other coding agents at session start. Facts and rules only.

This repo is two things: Ghostty terminal config (themes, fonts, scripts — see
README.md) and a portable pi setup in `pi-setup/`, deployed to `~/.pi/agent/`
by `pi-setup/install.sh`.

## Rules for editing this file

**This is a reference, NOT a logbook.** It is loaded into every session's context,
so every line costs tokens on every turn, forever. It was 2749 lines on
2026-08-15 and was cut to ~600. Keep it there.

Before adding anything, it must pass all four:

1. **A future agent needs it to avoid breaking something.** Not "this is
   interesting", not "this was hard to find out".
2. **It is not discoverable from the code.** File lists, tool inventories,
   function names and anything `ls`/`grep` answers in one call do not go here.
3. **It is a rule or a fact, not a story.** One or two lines. No "the problem" /
   "the fix" / "verified" / "round three" structure, no dates, no test counts,
   no measurement tables, no reproduction steps.
4. **It has no better home.** Per-incident detail goes in `pi-setup/*.md` (see
   the last section) and per-update detail goes in `pi-setup/pi-migrations.md`.
   Neither belongs in a code comment: see the comment rule in the system prompt.

**Never append a changelog entry here.** git already records what changed and
when — `git log -p AGENTS.md`. If a session discovers something worth keeping,
write the one-line rule and delete whatever it supersedes; the file should not
grow monotonically. Prefer replacing a section over adding one next to it.

If you catch this file drifting past ~700 lines, trim it back rather than
continuing to add.

---

## Provider chain

```
pi CLI (v0.84.2) — @earendil-works/pi-coding-agent
  ├─ anthropic (native) + pi-claude-code-use    → Claude Max OAuth   [DEFAULT]
  ├─ kimi-code (custom) + kimi-code-token.mjs   → Kimi Code sub
  ├─ deepseek, sakana, openai-codex             → API keys in ~/.zshrc
  └─ llama-local                                → llama.cpp, /local
```

Default: `anthropic` / `claude-opus-5`, thinking `high`, theme gruvbox,
`compaction.enabled: true`.

**`PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` is REQUIRED** (set in `~/.zshrc`).
Without it, `pi-claude-code-use`'s `filterAndRemapTools()` silently drops every
tool that isn't one of Claude Code's own 17 — 38 tools become 4, with no error.
Gate is `provider === "anthropic" && isUsingOAuth`, so it hits the TUI too.

**When changing the default provider, also update `pi-sub-core-settings.json`**
— its `defaultProvider` is what the status bar reports, and a provider left
`enabled: false` there returns `{}` regardless.

### System prompt assembly

1. `extensions/system-prompt.ts` — **parent sessions only**: loads
   `agents/prompt.amp.system.md`, interpolates `{identity} {harness} {date}
   {cwd} {roots} {os} {repo} {sessionId} {ls} {harness_docs_section}`.
2. `tools/lib/sub-agent-prompt.ts` — **sub-agents**: a short generated prompt
   naming exactly that child's tools. Driven by `PI_SUBAGENT_TOOLS`, which
   `pi-spawn.ts` sets from the same array it builds `--tools` from, so prompt
   and registry cannot disagree. Missing var → falls back to old behaviour.
3. `tools/lib/pi-spawn.ts` — per-agent `--tools` allowlists.

---

## Patches and configs that must survive updates

Run this after **any** `pi update`, `pi install`, or package update:

```bash
bash pi-setup/verify-patches.sh     # read-only audit; each FAIL prints its fix
```

| What | Where | Why |
|---|---|---|
| `resource-loader.js` | pi core `dist/core/` | suppresses extension tool-conflict boot errors (safety net) |
| `session-selector.js` + `keybindings.js` | pi core | session pinning, `Ctrl+B` in `/resume`. Pins in `~/.pi/agent/pinned-sessions.json` (user data, never wiped) |
| **pi-tui width patch** | **every** installed pi-tui copy | conservative grapheme widths. Without it the TUI smears on Indic/exotic unicode. **Every package bundles its own pi-tui**, so any install brings a fresh unpatched copy |
| pi-sub grok provider | `@marckrenn/pi-sub-*` | wiped by every `pi install` / `pi update --extensions` |
| pi-tool-display `config.json` | `~/.pi/agent/extensions/pi-tool-display/` | all tool overrides `false` — otherwise it replaces our custom tools |
| pi-mcp-adapter settings | `~/.pi/agent/mcp.json` | `scriptMode: false`, skills `[]` |

### Quick re-patch

```bash
PI=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent
cp pi-setup/pi-core-patches/resource-loader.js  $PI/dist/core/resource-loader.js
cp pi-setup/pi-core-patches/session-selector.js $PI/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js      $PI/dist/core/keybindings.js

node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs           # all copies
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check   # audit

cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json

# grok provider: 5 files from pi-setup/pi-sub-patches/ into
# ~/.pi/agent/npm/node_modules/@marckrenn/{pi-sub-shared,pi-sub-core,pi-sub-bar}
# — exact destinations are in install.sh
```

`install.sh` applies all of these and runs `verify-patches.sh` last.

### pi-tool-display config (required)

```json
{ "registerToolOverrides": { "read": false, "grep": false, "find": false,
  "ls": false, "bash": false, "edit": false, "write": false },
  "enableNativeUserMessageBox": true }
```

Its overrides bootstrap from pi's DEFAULT tools, so any `true` clobbers our
mutex locking, secret scrubbing, git trailers and image support. Missing config
→ tool conflict errors at startup. Not in the npm package, so updates don't
touch it; recreate it after a delete-and-reinstall.

### pi-mcp-adapter config (required)

`settings.scriptMode: false` in `mcp.json` (mcpScript executes arbitrary JS and
`permissions.json` doesn't cover it) and `{ "source": "npm:pi-mcp-adapter",
"skills": [] }` in `settings.json` (the `mcp-scripting` skill would teach a tool
that doesn't exist). **The object form is load-bearing** — the string form
silently restores the skill. After any update: tool list must contain `mcp` and
not `mcpScript`; skills must not contain `mcp-scripting`.

---

## Packages (npm)

| Package | Ver | Purpose | Patched |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | 0.84.2 | pi itself | 3 core patches |
| `@benvargas/pi-claude-code-use` | **1.0.5 (held)** | Claude Max OAuth payload shim | no |
| `pi-token-burden` | 0.6.5 | token usage display | no |
| `@marckrenn/pi-sub-bar` | 1.5.0 | quota widget | **grok patch** |
| `pi-autoresearch` | 1.6.2 | experiment loop (git install) | no |
| `pi-tool-display` | 0.5.0 | thinking labels, user msg box | **config** |
| `pi-codex-goal` | 0.2.0 | `/goal` | no |
| `pi-mcp-adapter` | 2.25.0 | one `mcp` proxy tool, lazy servers | **config** |

**pi-claude-code-use held at 1.0.5** deliberately; 2.x's only new ≥0.84 feature
needs registered MCP aliases, which we never have.

**`pi-autoresearch` shortcut is pinned to `ctrl+shift+r`** in
`pi-setup/extensions/pi-autoresearch.json` — pi-tui 0.84.2 took `ctrl+shift+f`
for fullscreen transcript search. Fix belongs in that config, never in the
package (git-installed, wiped on update).

### Removed — do not reinstall

`pi-context` (agent checkpoint/timeline/compact spam; built-in `/compact`
covers real need), `todos.ts` (file-based todo tool + TUI, unused), `pi-web-access`
(web_search 100% dead), `pi-tasks` (array params arrived JSON-stringified, every
gated tool unreachable), `@tomooshi/condensed-milk-pi` (**reported failed git
commands as successes**; `verify-patches.sh` fails loudly if a copy reappears),
plus `@sting8k/pi-vcc`, `pi-computer-use`, `pi-gpt-config`, `pi-ask`, `pi-grok-cli`,
`pi-claude-bridge`, `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`.

### One install, no duplicates

pi loads packages from **exactly one** place: `~/.pi/agent/npm/node_modules`
(plus `~/.pi/agent/git/<host>/<org>/<repo>` for git sources). Always install with
`pi install npm:<name>`.

**Never `npm install -g` a pi package.** It doesn't become inactive, it becomes
unloadable — and it can hijack a pinned version (the global fallback path
satisfies any unpinned package) and brings an unpatched pi-tui copy.

**`npm ls -g` lies here** (node is nvm, pi is homebrew) — read real versions out of
`~/.pi/agent/npm/node_modules/*/package.json`, nowhere else.
`extensions/tools/node_modules` is gitignored **deployment source**: `install.sh`
copies it into the loaded path, so the width patcher scans the repo too.

---

## MCP servers

Global config: `~/.pi/agent/mcp.json` (backed up as `pi-setup/mcp.json`).
Lazy — nothing connects until a tool is called.

| Server | Notes |
|---|---|
| `chrome-devtools` | **stdio**, `npx chrome-devtools-mcp` (Google). 29 tools: perf tracing + DevTools Insights (LCP/CLS/INP), Lighthouse, network, console, heap snapshots, Puppeteer automation |
| `astro` | `127.0.0.1:8089/mcp`, `auth: false`. Runs inside the Astro Mac app; enable in Settings → MCP Server |
| `paper` | `127.0.0.1:29979/mcp`, `auth: false`. Runs inside Paper Desktop; **read+write** on the open file |
| 16 × `cloudflare*` | remote HTTP, `protocolVersion: "auto"`. See `pi-setup/2026-08-13-cloudflare-mcp.md` |

**chrome-devtools flags are load-bearing.** `--isolated` (throwaway profile — the
default one is persistent, locked to one browser at a time, and readable by the
agent), `--no-usage-statistics` + `--no-performance-crux` (both ON by default;
they send telemetry to Google and trace URLs to the CrUX API). **Its arg parser
is not strict** — a misspelled flag is silently ignored, so verify a flag took
effect by whether its startup notice disappears. Version is pinned, not
`@latest`: a lazy spawn re-resolves from the registry on every cold start.
File-writing tools are confined to the OS temp dir (the adapter negotiates no
MCP roots); `--allowUnrestrictedPaths` lifts that.

**`auth` must be `"oauth"`, never `true`.** `true` is not a legal value and fails
*silently*: it disables both OAuth and bearer, and the server connects
unauthenticated → 401.

First connect: `/mcp-auth <key>`, or headless
`mcp({ action: "auth-start", server })` → approve → `auth-complete` with the
`redirectUrl`. Tokens live in the macOS Keychain.

2.25.0 changed result rendering: `settings.toolResultRendering: "boxed"` restores
the old boxed row, `collapsedResultLines` (1–3) controls collapsed height.

Add servers in `~/.pi/agent/mcp.json` (global) or a project `.mcp.json`: stdio
uses `command`/`args`, HTTP uses `url` + optional `headers`/`auth`.

---

## Extensions (13, all in `extensions/`)

pi auto-discovers every `.ts` here — there is **no** disabled state. To disable,
delete or move out. From a subdirectory pi loads **only `index.ts`**, which is
why tests can live beside an extension without being loaded.

| Extension | Purpose |
|---|---|
| `system-prompt.ts` | parent template / sub-agent generated prompt |
| `mentions.ts` | @mentions + agent directives |
| `session-name.ts` | auto session naming (haiku, deliberately) |
| `session-breakdown.ts` | `/session-breakdown` |
| `notify.ts` | OSC 777 desktop notifications |
| `md-export.ts` | `/md` session → markdown |
| `command-palette/` | Ctrl+Shift+P |
| `editor/` | custom box-drawing editor, labels, clipboard image paste |
| `deepseek-peak/` | `/deepseek` + peak/off-peak clock in the editor border |
| `subagent-inspector/` | Ctrl+Shift+A / `/subagents` — sub-agent transcripts |
| `local-model.ts` | `/local` llama.cpp router |
| `guardrails/` | re-injects `agents/rules.amp.md` per turn + blocks comment-heavy edits |
| `tools/` | 29 custom tools |

`kimi-code-token.mjs` also lives here but is a helper script, not an extension.

### guardrails — behaviour rules the model cannot forget or ignore

A system prompt stops governing behaviour after roughly eight turns, and
Anthropic's own tracker has an open bug for Claude ignoring mandatory
anti-comment rules. So the rules live in two places that survive that:

- **`context` hook** re-appends `agents/rules.amp.md` before **every** model
  call, stripping its own prior copy first (it is a deep copy per turn, so
  without the strip the block accumulates). Edit the rules in that .md, never
  in the extension.
- **`tool_call` hook** blocks `apply_patch` when a change adds a comment run
  over 12 lines **or** more than 0.5 comment lines per line of code. Two
  triggers because one misses the other: a ratio check cannot see a 30-line
  header in a long file, and a run check cannot see a comment on every third
  line. Only real source extensions are gated — `#` is a heading in markdown.
  **The gate fails open on any error**; a guardrail that blocks real work gets
  switched off, and a missed essay costs one rewrite.

`PI_GUARDRAILS_OFF=1` disables both. `PI_GUARDRAILS_MAX_COMMENT_RUN`,
`_MAX_COMMENT_RATIO`, `_MIN_COMMENTS` retune the gate.

**Do not re-add a why-essay comment rule anywhere.** `document/SKILL.md`,
`AGENTS.md` and `prompt.amp.system.md` used to disagree about comments while
the skill shipped a 6-line JSDoc as its worked example; the example won every
time. They now agree, and the agreement is the point.

### Extension rules learned the hard way

- **Extensions do not share modules.** pi loads each with its own jiti instance
  and `moduleCache: false` — a module-level Map imported from another extension
  reads *empty*, silently. Cross-extension state goes over `pi.on(...)` events.
- **Any timer that outlives a session must be cleared on `session_shutdown`**,
  and anything a timer calls must be in a `try`/`catch`. After session
  replacement the extension ctx is stale and every `pi.*` call throws — inside a
  timer that's an uncaughtException, which pi answers with `process.exit(1)`.
  This killed a session once (`deepseek-peak`). Component-scoped timers that
  touch only local state are exempt; a timer calling `invalidate()`/
  `requestRender()` is **not**.
- **Clipboard paste** uses `getImageBinary()` + `Buffer.toString("base64")`, never
  `getImageBase64()` (drops `=` padding → Anthropic 400). `[image #N]` tokens
  expand to inline image blocks at submit; if `@mariozechner/clipboard` fails to
  resolve, pi's default path-insert transparently takes over.

---

## Custom tools (29)

29 = 28 `pi.registerTool` calls + `agent_message`. `web_search` is conditional
(skipped when its config disables it), so a session shows 26–27.

### Replacements (override pi built-ins)

| Tool | File | Customization |
|---|---|---|
| `bash` | `bash.ts` | git trailers, mutex on git, psst secret injection, output scrubbing, **required `timeout`**, idle kill |
| `read` | `read.ts` | images fitted to the vision budget via `image-fit.ts` |
| `apply_patch` | `apply-patch.ts` | **the only file-mutation tool**, 4 call shapes, atomic batches, locking, undo tracking |
| `format_file` | `format-file.ts` | prettier/biome |
| `grep` / `find` / `ls` | `grep.ts` / `glob.ts` / `ls.ts` | custom output (registers as `find`; there is no `glob` tool) |
| `undo_edit` / `redo_edit` | `undo-edit.ts` | per-tool-call by default, `scope: "file"` opts out |
| `skill` | `skill.ts` | also discovers package/git skill dirs; `isDirLike()` for symlinks |

### New tools

| Tool | File | Purpose |
|---|---|---|
| `screenshot` | `screenshot.ts` | display / window / region / URL, inside the vision budget |
| `finder` | `finder.ts` | concept search sub-agent |
| `oracle` | `oracle.ts` | architecture, hard bugs, verdicts |
| `delegate` | `delegate.ts` | resumable peer sub-agent (`continueId`) |
| `chad` | `chad.ts` | read-only research, pinned deepseek, built to swarm |
| `librarian` | `librarian.ts` | external repos via GitHub API |
| `agent_message` | `agent-message.ts` | inter-session mailbox (`setupAgentMessage(pi)`) |
| `web_search` | `web-search.ts` | Parallel AI Search |
| `read_web_page` | `read-web-page.ts` | cheerio → markdown |
| `read_session` / `search_sessions` | `read-session.ts` / `search-sessions.ts` | session history |
| `code_review` | `code-review.ts` | diff review |
| 7 × github | `github.ts` | `read_github`, `search_github`, `list_directory_github`, `list_repositories`, `glob_github`, `commit_search`, `diff` — **there is no tool named `github`** |

### apply_patch — four lanes, one engine

| lane | shape |
|---|---|
| write | `{ path, content }` |
| edit | `{ path, old_string, new_string, replace_all? }` |
| batch | `{ ops: [ … ] }` — all-or-nothing |
| envelope | `{ input: "*** Begin Patch …" }` |

Every lane goes through the same permission → mutex → lock → snapshot → apply →
commit-or-rollback path, so a new lane can't bypass a guard. Rules:

- **Every schema field is optional and must stay that way** — pi validates
  arguments before `execute()`, so a required field walls off the other lanes.
- **`constrainedSampling` was REMOVED, not disabled.** pi-ai needs exactly one
  required string property and **throws** otherwise, killing the turn on OpenAI
  models. Guarded in both directions by `apply-patch.test.ts`.
- `normalizeCall()` **refuses** anything that reads as two lanes. Key aliases are
  accepted; operations are never inferred across lanes. `edits` is an ops key and
  a top-level `path` is inherited (pi's native edit shape / Claude MultiEdit).
- A key that *means* patch (`diff`) is never rescued as content; only `input` is,
  and only when it doesn't look like a patch.
- Move refuses to clobber an existing destination; a rename rewrites no bytes.
- Indentation: a shift is only applied if replaying it on the OLD lines
  reproduces what's on disk. Tab/space mixing is refused, not guessed.
- Undo/redo refuse when a **later still-applied change** touches the path, and
  when the file drifted outside the tool (`matchesRecordedState`, `force: true`
  overrides and reports what it discarded). Ordering comes from position in
  `activeIds`, **never `Date.now()`** (ms resolution reads two calls as
  concurrent). Redo takes the *oldest* undone step, not the newest.
- Moves record `movePartnerUri` at apply time, so undo reverts both halves.
- `PI_APPLY_PATCH_METRICS=1` appends `{lane, files}` to
  `~/.pi/apply-patch-lanes.jsonl` (off by default).

### bash — nothing runs unbounded

Four layers:

| | mechanism | bounds |
|---|---|---|
| L0 | description discourages piping to `tail`/`head`/`grep` | streaming visibility |
| L1 | **`timeout` required**, schema-bounded 1–600s | declared budget |
| L2 | idle kill: no output **AND** no CPU for 300s | a corpse that asked for 10 min |
| L3 | `piSpawn` stall watchdog: no child stdout for 900s | non-bash children |

Overrides: `PI_BASH_MAX_TIMEOUT_SEC`, `PI_BASH_IDLE_KILL_SEC` (0 disables),
`PI_SPAWN_STALL_SEC`, `PI_BASH_CPU_LIVENESS`.

- **CPU liveness can only keep a command alive, never kill it.** Sampling failure
  returns `undefined` → degrades to stdout-only, i.e. the previous behaviour.
- **L2 measures silence, not duration.** Most long calls are real work. The idle
  timer runs from t=0, not armed after first output — pipes block-buffer, so an
  armed-later timer would never fire on the case it exists for.
- Liveness is stamped on **raw** chunk arrival, before sanitization.
- Machine-sleep guard is checked **first** and wins outright (macOS suspends
  timers on lid close). `watchdog.ts` is pure because both callers live inside
  `setInterval` closures over live processes.
- Killing ≠ released: `FORCE_RELEASE_MS` (10s) resolves the promise even when a
  grandchild holds stdout open. Every kill path arms it. The child is **not**
  spawned `detached` — that would orphan sub-agents on Ctrl+C.
- Stall message says **relaunch, never resume**: a child killed mid-tool-call
  leaves a `tool_use` with no `tool_result`, and replaying that is a provider 400.
- 900s is derived from pi's own timeouts (HTTP idle 300 + retry 60 + backoff 8 +
  our idle 300 ≈ 360 worst case, ×2.5). Re-check those before shrinking it.

`renderCall` shows up to 3 command lines collapsed, all on `ctrl+o`; `\r` is split
on, not left in. Timing: `startedAt` in `renderCall`, `endedAt` gated on
`!isPartial`, 1s ticker while partial (unref'd, try/catch, stops rather than
retries, self-clears at `maxTimeoutSec()` + slack).

### chad — read-only, pinned, swarmable

`pinModel: true` + `--thinking high` pins `deepseek/deepseek-v4-flash` whatever
the parent runs. The model **is** the tool: cheap 1M context is what makes eight
at once reasonable, so inheriting the parent would silently destroy it. Note
DeepSeek peak pricing (see `/deepseek`) makes a peak-hour swarm ~4.7× more
expensive on output.

`readOnlyBash: true` sets `PI_BASH_READ_ONLY=1`; `lib/read-only-bash.ts` is an
**allowlist** (~60 read commands, git gated per-subcommand, quote-aware scanner
for separators, `$( )`, backticks, redirection). A denylist on a shell is
unwinnable; an allowlist fails closed and names what it refused.

- **A command name is not a capability.** `WRITE_FLAGS` / `POSITIONAL_OUTPUT`
  cover `sort -o`, `base64 -o`, `tree -o`, `yq -i`, `uniq IN OUT`, `xxd IN OUT`,
  `rg --pre`, `fd -x`, `sed` `w`/`e`, `man -P`, `git symbolic-ref HEAD <ref>`,
  `git reflog delete/expire`. **`awk`/`gawk`/`mawk` are removed outright**
  (`system()`). Anything added must be checked for output/exec flags.
- **Command substitution is live inside double quotes**, inert inside single —
  the two are tracked differently. `>/dev/null` and `2>&1` are allowed.
  `bareIsRead` is per git subcommand (bare `git stash` pushes).
- Accepted hole, stated: any allowed binary talked into writing by a flag form
  not yet listed. This is a guardrail on our own agent, not a sandbox.

**Tool surface:** 15 — read, grep, find, ls, bash, skill, web_search,
read_web_page + the 7 github tools. No `apply_patch`/`format_file`/`undo_edit`
(the point), no `screenshot` (deepseek is text-only; images become
`(tool image omitted)`), no `oracle`/`finder`/`librarian` (a child inherits
deepseek, so it'd be deepseek talking to itself), **no `chad`/`delegate`** — a
swarm that spawns swarms is a fork bomb (8 → 64 → 512). **The spawn graph is
acyclic and pinned by `tool-contract.test.ts`:** the only agent→agent edge is
`delegate → finder`, depth ≤ 2.

### chad vs oracle

`oracle` returns a **verdict** (one recommendation + trade-offs), explores
deliberately shallow, and has unrestricted bash. `chad` returns **evidence**
(cited, verified-vs-inferred, gaps), explores exhaustively, and can write
nothing. Finding out → swarm chads; deciding → oracle; both → chads first, their
findings into oracle's `context`. On a non-anthropic parent oracle inherits the
parent model, so its advantage disappears and chad is the more predictable one.

### screenshot / vision budget

`lib/vision.ts` is a behaviour-identical port of caliper's `src/vision.ts`; the
same algorithm exists in ClaudeImageResizer's `ImageBudget.swift`. **Change a
constant in all three and re-run `lib/vision.test.ts`.**

- Claude's budget is **two** limits: 1568px padded edge AND 1568 visual tokens
  (`ceil(w/28) × ceil(h/28)`). The token limit binds first for most screenshots,
  which is why `sips -Z` is wrong — the API then resamples a second time.
- **`fitImageFile` is the only path from pixels to a vision model.** `screenshot`
  and `read` both funnel through it. The `asis` path never decodes. **`sips` is a
  codec, never a resizer** — all geometry is decided by `planView`.
- `high` is the default tier and nothing decides it — swept 851 shapes, high was
  never smaller. Only an explicit `tier:"standard"` opts down. `resolveTier()`
  clamps it to **2000px** (`MANY_IMAGE_MAX_EDGE`): past 20 images per request the
  per-image ceiling drops to 2000 and a tool cannot see how many images are
  already in the conversation. `TIERS` keeps spec values.
- `MAX_IMAGES_PER_CALL = 12`; over that it truncates **from the top** and says so.
  **Chromium returns BLANK past 16384px** without erroring —
  `MAX_RENDERABLE_HEIGHT` clips and reports `clipped`.
- 0x0 and truncated PNGs pass a header read and **kill the whole request** —
  both throw `UnusableImageError` before `planView`. Truncation = missing IEND,
  PNG only. `read.ts`'s raw-bytes fallback must skip this class.
- Sub-agent screenshots reach the caller: `collectSubAgentImages` pulls the **2
  most recent** images out of oracle/delegate/code_review results.
- Area-average downscale, not Lanczos — UI is all hard edges. Bounds are clamped;
  an out-of-bounds read silently stores 0 (a black pixel, no error).
- macOS: every tab is its own `NSWindow`; use `CGWindowListCopyWindowInfo` option
  `0`, never `1`; off-Space capture works ~9/10 times so **try and explain**,
  never pre-refuse; Screen Recording must be granted to the terminal running pi.
  Every absolute claim made here about window behaviour has so far been wrong —
  state the observation, let the capture attempt be the authority.
- `permissions.json` blocks the capture binary in bash but deliberately does
  **not** match `sips` (three false positives from merely writing about it).
- Not verified: multi-display, `activate` (never run live).

### Tool libraries (`tools/lib/`)

30 shared modules; names are self-describing (`ls extensions/tools/lib`). Two
worth knowing: `mutex.ts` is a module-level Map, so it does **not** span
processes — concurrent `delegate`s can collide on the same file; `proc-cpu.ts`
returns `undefined` on any failure by design.

---

## TUI width — the invariant

**Clamp with the same function pi-tui asserts with** (`visibleWidth` /
`truncateToWidth` from pi-tui). pi-tui throws `Rendered line N exceeds terminal
width` as an uncaughtException, which kills the process; a private width measure
that disagrees will eventually crash pi. `lib/box-format.ts` `normalizeForDisplay()`
is the render chokepoint for all box-rendering tools (display only — model-visible
text is never modified).

Two distinct failure modes:

1. **Undercount → smear.** pi-tui measures grapheme clusters, terminals advance
   per spacing codepoint. The width patch makes `graphemeWidth()` conservative:
   it may overcount, never undercount. Re-apply on every install.
2. **Control char in a single-line sink → smear.** A `\n` is width-0 to every
   check and still moves the cursor a row. Editor border labels
   (`flattenLabelText`), widget rows (`flattenSegmentText`) and any truncated
   summary must flatten. Multi-row output from `renderCall` is fine — `Text`
   wraps and the TUI counts the rows.

If it returns: `apply-pi-tui-width-patch.mjs --check` first (an update restored a
stock copy), then `pi-setup/render-repro/`, then hunt for a component embedding
control chars into a single-line string.

---

## Models

| Provider | Models |
|---|---|
| `anthropic` | `claude-opus-5`, `claude-opus-4-8/4-7/4-6` (1M ctx override) |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` (1M ctx) |
| `kimi-code` | `kimi-for-coding` (K2.7, 262K) |
| `openai-codex` | `gpt-5.5`, `gpt-5.6-sol` |
| `sakana` | `fugu`, `fugu-ultra` (1M, text+image) |
| `llama-local` | `LFM2.5-2.6B` Q6_K, 64K active |

### Sub-agent models

`lib/pi-spawn.ts` resolves: **anthropic-ish parent → designated model; anything
else → inherit the parent** (a kimi session can't use Claude).

| agent | model |
|---|---|
| finder, librarian, code_review | `claude-sonnet-5` |
| oracle | `claude-opus-4-6` |
| read_session, read_web_page | `claude-sonnet-5` |
| **delegate** | *none — inherits `parentModel`.* A peer must match you. Do not add a `MODEL` const |
| **chad** | `deepseek/deepseek-v4-flash` **pinned**, provider-qualified (`pinModel` skips `qualifyModel`) |
| session-name | haiku, deliberately (one line, every session) |

### Sakana (config-only, `models.json`)

`https://api.sakana.ai/v1`, `api: openai-responses`, Bearer `$SAKANA_API_KEY`.
pi hardcodes `store: false` and never sends `previous_response_id`, matching
Sakana's stateless API. **The trap:** with effort unset pi sends `effort: "none"`,
which Sakana rejects — hence `thinkingLevelMap` maps `off: null` and every other
level to `high`/`xhigh`. `maxTokens` 32768 is a flagged guess. If reasoning 4xx's
on `encrypted_content`, fall back to `openai-completions`.

### Local models

**llama.cpp must be >= b10270.** b8680 has two silent `lfm2` tool-call parser
bugs: `\n` in an argument arrives as literal backslash-n (kills every multi-line
argument), and `[f(a), f(b)]` parses as one mangled call producing valid JSON.
Check `llama-server --version` first if local tool calling goes strange.

`/local [start|stop|restart|unload|status|logs]`. No auto-start, deliberate.
`before_agent_start` returns `undefined` unless `ctx.model?.provider ===
"llama-local"` — **do not widen this**; every other model keeps the default
prompt byte-identical.

Gotchas: it's `ctx.hasUI`, not `ctx.canPrompt` (which is `undefined`, i.e. falsy
inside a real TUI); a model must be in `enabledModels` or `/model` can't see it;
`toLocaleString()` follows the system locale (en-IN) — always pass `"en-US"`.
Measured (M4 Pro): 81–89 tok/s, 3.2s cold start, 18.5k-token prompt ≈ 17.7s
prefill per fresh `pi -p`. Loops for 8–10 min returning nothing on self-directed
work — always timeout it.

---

## Skills

**29 loadable by name**: 24 in `~/.config/agents/skills/` + `find-skills` +
`userinterface-wiki` + 3 `autoresearch-*`.
`mcp-scripting` is deliberately suppressed.

Six are external ports with author prefixes — **`s-` shadcn, `c-` cursor,
`mat-` matt pocock, `dm-` dmmulroy**. Claude-Code/Cursor machinery was mapped to
pi tools or cut (no worktree isolation for pi sub-agents). `code-review` was
renamed `mat-cr2axis` to avoid clashing with the `code_review` **tool**. As
adapted, **every subagent they spawn is read-only**.

`skill.ts` also discovers package skills (`~/.pi/agent/npm/node_modules/<pkg>/
skills/`, `~/.pi/agent/git/.../skills/`); user/config skills win on name
collision. `pi-skills/` in the repo is empty — those two are package-managed
symlinks.

---

## Agent mention directives

`@oracle @finder @codereview @task @chad` → hidden `display: false` directive
injected in the `context` hook telling the model to call that tool.
`codereview` → `code_review`, `task` → `delegate`.

- `MentionSource.standalone: true` marks valueless mentions; the parser builds
  two regexes (data mentions need `/value`, standalone don't). They autocomplete
  with a trailing space.
- **Don't remove the explicit `import "./tools/lib/mentions/agent-source.js"`**
  in `mentions.ts` — the barrel `export *` doesn't guarantee evaluation of a
  module with no named exports, and the sources register on load.
- Don't add `/value` to agent mentions; the `@oracle` text is not stripped.

---

## File layout

```
pi-setup/
├── install.sh              # backs up, deploys, patches, then runs verify-patches.sh
├── verify-patches.sh       # read-only audit — run after every update
├── settings.json           # packages, extensions, theme, enabledModels
├── models.json             # model overrides + custom providers
├── keybindings.json  permissions.json  mcp.json
├── pi-sub-bar-settings.json  pi-sub-core-settings.json
├── pi-core-patches/        # 3 core patches + apply-pi-tui-width-patch.mjs
├── pi-sub-patches/         # grok provider (5 files)
├── claude-bridge-patches/  # legacy, uninstalled
├── render-repro/           # TUI smear harness (tmux + Ghostty + DSR)
├── port-harness/           # screenshot / permission / tier verification
├── agents/                 # 10 prompt templates
├── themes/  config-skills/  pi-skills/
└── extensions/             # all 12 extensions incl. tools/ (29 tools + lib/)
```

---

## Update workflow

1. **`bash pi-setup/verify-patches.sh`** — always first.
2. **Also grep our own CLI call sites.** An import-level audit cannot see a
   change in how pi interprets the **arguments we pass it**, and `pi-spawn.ts`
   shells out with `--model --provider --tools --mode`. pi 0.84.0 #7327 changed
   bare `--model` resolution and silently killed **every** sub-agent with an
   error that reads like an auth failure. Whenever a release mentions model
   resolution, provider selection, tool filtering or CLI arguments: open
   `pi-spawn.ts`, then actually call one sub-agent before declaring it clean.
3. **pi core update** → re-apply the 3 core patches + the width patch. Check the
   changelog for tool-API changes (we override built-ins). The `@mariozechner/*`
   compat aliases will eventually be removed — then rename imports everywhere.
4. **Any `pi install` / package update** → re-run the width patcher (every
   package bundles a fresh unpatched pi-tui).
5. **pi-sub-* update** → re-apply the grok patch. Valid upstream providers are
   `anthropic copilot gemini antigravity codex kiro zai` + our `grok`; there is
   **no `kimi`, no `crofai`**. A provider named in `pi-sub-core-settings.json`
   with no factory breaks usage refresh (`PROVIDER_FACTORIES[name] is not a
   function` in `providers{}`, `reading 'enabled'` in `providerOrder[]`) — only
   at refresh time, so boot looks clean.
6. **pi-tool-display** → verify `config.json` still exists. The rest
   (pi-token-burden, pi-codex-goal, pi-autoresearch, pi-mcp-adapter)
   are unpatched; check only for new tool/skill name collisions.

Per-version record: `pi-setup/pi-migrations.md`. Read it before `pi update`.

## What NOT to do

- **Don't edit `/opt/homebrew/lib/node_modules/` directly** — wiped on update.
  Edit in `pi-setup/`, deploy with `install.sh`.
- **Don't `npm install -g` a pi package.** Use `pi install npm:<name>`.
- **Don't set pi-tool-display overrides to `true`.**
- **Don't reinstall condensed-milk-pi**, and don't add `claude-agent-sdk-pi` back.
- **Don't run `install.sh` without checking what changed** — it overwrites live
  tweaks (after backing them up).
- **Don't simplify the pi-mcp-adapter package entry to the string form.**
- **Don't use `--no-tools`** for sub-agents (see the port log).

## Where the detail lives

Narrative, postmortems, measurements and per-incident detail belong in these,
never in the body of this file:

- `pi-setup/2026-05-17-migration-log.md` — v0.74.0 migration, architecture, cleanup
- `pi-setup/2026-07-30-bdsqqq-port.md` — sub-agent wiring, OAuth tool-filter trap,
  apply_patch lanes, delegate. **Read before touching tools/subagents.**
- `pi-setup/2026-08-13-cloudflare-mcp.md` — the 16 Cloudflare servers, auth flow
- `pi-setup/pi-migrations.md` — per-update record: which patch drifted, how it was
  re-derived. **Read before `pi update`.**
- `pi-setup/README.md` — setup docs + session log
- `git log -p AGENTS.md` — the long-form version of everything above (trimmed 2026-08-15)
