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

### bdsqqq Port — COMPLETE (read before changing tools/subagents)

**See `pi-setup/2026-07-30-bdsqqq-port.md`.** Port of selected pieces from
[bdsqqq/dots](https://github.com/bdsqqq/dots). All phases are done (subagent tool
injection fixed, `web_search` replaced with Parallel AI, `agent_message` added,
`search_sessions` rebuilt on a branch model, condensed-milk removed; Phase 4:
`apply_patch` lanes replaced `edit`/`write`, `delegate` replaced `Task`).

That file records **why** several things are the way they are — in particular the
`pi-claude-code-use` OAuth tool filter that silently strips every custom tool from
sub-agent requests, and why `--no-tools` must never be used. Do not re-derive it.
Verification harnesses live in `pi-setup/port-harness/`.

### Provider Chain

```
pi CLI (v0.84.2) — @earendil-works/pi-coding-agent
  ├─ kimi-code provider (custom local config) + Kimi Code OAuth token helper
  │    └─ https://api.kimi.com/coding/v1 — Kimi Code subscription access
  └─ anthropic provider (native) + pi-claude-code-use (API payload shim for Claude Max OAuth use)
       └─ Claude API
```

Current default provider is `anthropic` with **`claude-opus-5`** (set in settings.json, and listed in `enabledModels` so it appears in `/model`). `kimi-code`/`kimi-for-coding` (K2.7 Code) remains available via Kimi Code subscription OAuth, and `openai-codex` with `gpt-5.5`/`gpt-5.6-sol` is also available. Switch the default any time with `/model`.

**When you change the default provider, also update `pi-sub-core-settings.json`:**
its `defaultProvider` is what the status bar / usage refresh reports on, and a provider
left at `enabled: false` there returns `{}` no matter what. Anthropic is now
`enabled: "auto"` + `fetchStatus: true`, which surfaces real Claude Max quota
(5-hour and weekly windows) in the status bar and in both usage tools.

**REQUIRED for Anthropic: `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1`** (set in
`~/.zshrc`). `pi-claude-code-use` rewrites every anthropic+OAuth request to look
like Claude Code, and its `filterAndRemapTools()` **silently drops any tool whose
name is not one of Claude Code's own 17** — removing `finder`, `oracle`,
`delegate`, `librarian`, `code_review`, the seven github tools and more. 38 tools
become 4 (`Read`/`Bash`/`Grep`/`Skill`), with no error anywhere.

This is **not** headless-only: the gate is `provider === "anthropic" &&
isUsingOAuth`, with no mode check, so a normal TUI session is affected too. It
stayed hidden for months only because the default model was `openai-codex`.
Without the flag, a fresh session will tell you it cannot call your sub-agents.
See `pi-setup/2026-07-30-bdsqqq-port.md` §3.1.

**Legacy fallback:** `pi-claude-bridge` wraps the Claude Code Agent SDK as a custom provider. **Uninstalled from this machine 2026-08-14** (it was 411 MB sitting in a directory pi never loads from — see "One Install, No Duplicates"). Its patched source is still in `pi-setup/claude-bridge-patches/`; reinstall commands are in `install.sh`.

### System Prompt Assembly

The system prompt is assembled in layers:

1. **`system-prompt.ts`** — **parent sessions only**: loads `agents/prompt.amp.system.md` template, interpolates variables (`{identity}`, `{harness}`, `{date}`, `{cwd}`, `{roots}`, `{os}`, `{repo}`, `{sessionId}`, `{ls}`, `{harness_docs_section}`)
2. **`tools/lib/sub-agent-prompt.ts`** — **sub-agent sessions**: a child gets a short generated prompt naming exactly its own tools instead of the parent template. See "Sub-agent Prompts" below
3. **`tools/lib/pi-spawn.ts`** — sub-agent tool surfaces: per-agent `--tools` allowlists merged from each tool's `BUILTIN_TOOLS`/`EXTENSION_TOOLS` consts (replaced the old `tool-harness.ts` env-gated filtering)

---

## pi-tool-display: Configuration Required

**Upstream:** https://github.com/MasuRii/pi-tool-display (v0.4.1)
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

## pi-mcp-adapter: Configuration Required

Two upstream defaults are deliberately **turned off**, both added in 2.18–2.19:

| Default | Our setting | Why |
|---|---|---|
| `mcpScript` tool registered | `settings.scriptMode: false` in `mcp.json` | It executes arbitrary JavaScript in a worker and adds a second permanent tool — this package was chosen precisely because it costs *one* ~200-token proxy tool, and `permissions.json` does not cover a JS execution surface. |
| `mcp-scripting` skill shipped | `{ "source": "npm:pi-mcp-adapter", "skills": [] }` in `settings.json` | With `scriptMode: false` the skill would teach a tool that does not exist. |

The object form is load-bearing and was verified against 0.84.1's (re-verified
live on 0.84.2 / adapter 2.25.0) `collectPackageResources`: with `autoload` unset, `skills: []` filters skills to
none while `extensions` (undefined) still loads from the package's pi manifest —
so the `mcp` tool still registers. **Do not "simplify" it back to the string
form**; that silently restores the skill.

Verify after any update: the tool list must contain `mcp` and **not**
`mcpScript`; the skill list must not contain `mcp-scripting`.

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

Auto-applied by `pi-setup/install.sh` (pi core patches block). To apply manually:

```bash
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
```

---

## Pi Core: Session Pinning Patch

**Files:**
- `dist/modes/interactive/components/session-selector.js`
- `dist/core/keybindings.js`

**Patches stored:** `pi-setup/pi-core-patches/session-selector.js`, `pi-setup/pi-core-patches/keybindings.js`

### What It Does

Adds the ability to **pin sessions to the top** of the `/resume` picker. Pins persist across pi updates' data (stored separately from the patched code) in `~/.pi/agent/pinned-sessions.json` — a JSON array of canonical session file paths.

- **`Ctrl+B`** in the `/resume` picker toggles pin/unpin on the selected session
- Pinned sessions float to the **top** of the list (in every sort mode and scope), flattened to depth 0, marked with a 📌 prefix
- A `pin` hint appears in the picker's hint line
- Pinning is non-destructive and global: the pin file references session paths, so a pinned session from another project shows in "All" scope

The native **rename** (`Ctrl+R`) was already built into pi — this patch only adds pinning.

### How It Works

**`keybindings.js`** — registered `app.session.pin` (default `ctrl+b`) in the `KEYBINDINGS` defaults map and added a `pinSession` alias. `ctrl+b` was chosen because `ctrl+g` (external editor), `ctrl+t` (thinking toggle), `ctrl+r/d/n/p/s` (session actions) are all taken.

**`session-selector.js`** — all additions are marked with `// LOCAL PATCH` comments:
1. **Imports** — added `mkdirSync/readFileSync/writeFileSync`, `dirname/join`, and `getAgentDir` from `../../../config.js`
2. **Pin-file helpers** (module-level) — `getPinFilePath()`, `readPinnedPaths()`, `writePinnedPaths()`, `isPinnedPath()`, `togglePinnedPath()`, and `applyPinning()` (reorders the flattened display list so pinned entries come first at depth 0)
3. **`SessionList.pinnedSet`** field + **`filterSessions()`** re-reads pins and calls `applyPinning()` after the normal sort
4. **Render loop** — pinned nodes render a `📌 ` prefix instead of the tree prefix
5. **`handleInput()`** — `app.session.pin` match toggles the pin, re-filters, and re-renders
6. **`SessionSelectorComponent`** — wires `onTogglePin` to `requestRender()`; header hint adds `pin`

### Re-apply after pi update

**`install.sh` now auto-applies all pi-core patches** (resource-loader + session-selector + keybindings) in its "pi core patches" block. Re-running `pi-setup/install.sh` after a pi update restores them. To apply manually without the full installer:

```bash
cp pi-setup/pi-core-patches/session-selector.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js
```

**Note:** The pin data file (`~/.pi/agent/pinned-sessions.json`) is user data, not code — npm updates never touch it. Only the two `.js` files above get overwritten on update and need re-applying.

**If the upstream selector changed significantly**, re-derive the patch by re-applying the `// LOCAL PATCH` blocks onto the fresh `session-selector.js` rather than blindly overwriting (the surrounding code may have shifted).

---

## TUI Width Desync Fix (pi-tui core patch + box-format normalizeForDisplay)

**Files:** `pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs` (THE root fix — patches EVERY installed pi-tui copy), `extensions/tools/lib/box-format.ts` (tool-output guard), `extensions/tools/bash.ts`, `extensions/tools/lib/sub-agent-render.ts`, `read-web-page.ts`, `code-review.ts`, `read-session.ts`
**Harness:** `pi-setup/render-repro/` (tmux + Ghostty repro, DSR cursor verification, regression tests)

### The Bug (fixed 2026-07-04, after multiple prior attempts)

Heavy tool output containing certain Unicode smeared the whole TUI — stale
duplicate tool boxes, content leaking below the editor, scattered spinner
frames. Only a terminal resize (SIGWINCH full redraw) recovered. Prior
attempts (commits `3b91aef`, `d7ca016`, `d5ae498`) fixed ANSI escape
leakage and render churn but the smear kept coming back on heavy streams.

**Root cause:** pi-tui measures text in grapheme clusters; real terminals
advance the cursor per spacing codepoint for complex scripts. Example: the
Devanagari conjunct `क्त्र` is ONE cluster — pi-tui width 1, Ghostty/tmux
render 3 columns. pi-tui's `Box.applyBg` pads every tool line to *exactly*
terminal width using its own measure, so one undercounted cluster makes the
line wider than the terminal → hard-wrap → the terminal scrolls a row
pi-tui doesn't know about → every subsequent differential write lands on
the wrong row. Heavy streaming = hundreds of full-width lines = one exotic
grapheme is enough. Reproduced and bisected empirically in tmux
(`pi-setup/render-repro/`).

Disagreeing classes found: Indic conjuncts (virama-joined), text-presentation
pictographs (EP without Emoji_Presentation, e.g. 🖐 ☹ — terminals disagree
with *each other*), skin-tone modifiers after non-modifier-base chars, and
codepoints unassigned in Node's ICU tables.

### The Fix — two layers

**Layer 1 (THE root fix): pi-tui width patch on ALL copies** —
`pi-core-patches/apply-pi-tui-width-patch.mjs`, an idempotent textual patcher.

Three rounds to get here:
- Round 1 guarded our tool renderers only → smear returned via pi core's OWN
  components (assistant `Markdown`, editor, footer) — proven with a DSR
  cursor-verified harness in a real Ghostty window.
- Round 2 patched pi core's pi-tui copy → smear STILL returned because
  **pi-tui exists in 15 copies**: every globally-installed package bundles its
  own (`pi-tool-display` — user-message box + thinking labels, `pi-sub-bar` —
  footer widget, `pi-token-burden`, `pi-claude-code-use`, …, plus
  `~/.pi/agent/npm/node_modules/@earendil-works/pi-tui` used by npm packages).
  Components from an unpatched copy render into the same screen with the old
  width math — one bad line anywhere smears everything.
- Round 3: the apply script `find`s every `*/pi-tui/dist/utils.js` under
  `/opt/homebrew/lib/node_modules` and `~/.pi/agent`, and applies the patch
  textually (anchor-based, version-tolerant 0.55→0.80, loud failure if
  upstream changed, `--check` mode to audit).

The patch makes `graphemeWidth()` **conservative — it can overcount but never
undercount** the real terminal's cursor advance. Undercounts hard-wrap and
desync; overcounts just pad a column short (invisible). Changes (all marked
`// LOCAL PATCH`):
1. `clusterAdvance(segment)` — per-codepoint advance sum: Mn/Me/Cf/ignorable/
   control → 0, **Mc (spacing marks, Indic matras) → 1** (Ghostty gives them a
   cell: हिंदी = 4 cols, DSR-measured; tmux gives 0 — counting 1 is exact in
   Ghostty, benign overcount in tmux), hangul V/T jamo → 0, lone surrogates → 1,
   text-presentation pictographs (🖐 ⚠ ☹) → max(EAW, 2).
2. `graphemeWidth` returns `max(original heuristic, clusterAdvance(segment))`;
   the all-marks early return routes through `clusterAdvance` too (standalone
   matras render 1 col). RGI emoji / flags keep their early-return 2
   (terminals render those 2 consistently — measured).

**Layer 1b (separate mechanism — control chars in single-line sinks):**
the custom editor's border labels and status widget row are ONE terminal line
each. `describeToolCall` in `extensions/editor/index.ts` used
`hint.split("/").pop()` on bash `cmd` — for a multiline script that returned
an UNBOUNDED tail including `\n`s, embedded into the border/status line. A
`\n` is width-0 to every width check but moves the real cursor a row → same
smear, different mechanism (this is why the smear survived the width fixes:
any heredoc/`python3 -c` script with a "/" in its tail triggered it —
`crazy-math.py` did, `python3 /tmp/tui-torture.py` didn't because its tail
was a short basename). Fixed at three layers: `describeToolCall` (first line
+ basename-only-for-paths + 24-char cap), `LabeledEditor.setLabel` sink guard
(`flattenLabelText` — collapses `\r\n\t\v\f` + C0/DEL, preserves ANSI), and
`widget-row.ts` `joinGroup` sink guard (`flattenSegmentText`).

**Layer 2 (defense in depth): `normalizeForDisplay()` in `box-format.ts`** —
display-only, at the render chokepoint of all box-rendering tools: strips stray
control chars, expands tabs, and replaces any grapheme cluster whose pi-tui
width disagrees with the modeled terminal advance with `�`. It derives from
pi-tui's live (patched) tables via the `visibleWidth` import, so with Layer 1
applied it replaces almost nothing — it exists to catch classes Layer 1 might
miss after a pi update. Model-visible tool result text is NEVER modified.
Applied at: `expandBlock`, headers, notices, `renderCallLine`, bash
`renderCall`, sub-agent tree renders, and raw fallback paths of
read-web-page/code-review/read-session.

Also fixed in the same pass: `bash.ts` uses per-stream `StringDecoder`s so
UTF-8 multibyte chars split across stdout/stderr chunk boundaries no longer
corrupt into `U+FFFD` in the model-visible output.

### Verified (2026-07-04)

- DSR cursor-drift harness (`harness2.mjs`), 150 frames/phase: **0 desyncs**
  in Ghostty AND tmux across ASCII-heavy, markdown-code, markdown+unicode,
  and combined phases (before the pi-tui patch: markdown+unicode desynced in
  BOTH terminals).
- Ghostty per-token DSR width measurement (`dsr-widths.mjs`): **0 undercounts**
  remaining (5 benign overcounts: क्त्र 3v2, 🖐⚠☹ 2v1, বাংলা 5v4).
- tmux visual capture phases: all MATCH; fuzz: 0 fatal undercounts / 3386
  clusters; 46/46 bun tests; pi boots clean.

### After ANY pi/package update (IMPORTANT)

`pi update --self`, npm package updates, and `pi install` ALL restore stock
pi-tui copies (each package bundles one). Re-apply via `install.sh` or:

```bash
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs          # patch all copies
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check  # audit
```

The script is idempotent and anchor-based; if upstream `graphemeWidth`
changed shape it reports `no-*-anchor` and exits non-zero — then update the
anchors in the script and re-run the harness suite.

### If the smear ever returns

**First check whether it is the OTHER width bug — the one that CRASHES rather
than smears.** On 2026-08-04 pi died with `Rendered line 2822 exceeds terminal
width (140 > 125)` at `pi-tui/dist/tui.js` `doRender`. That was **not** the
pi-tui patch and **not** a smear: `box-format.ts` defined its own
`visibleWidth` counting **one column per codepoint**, so a Japanese
`web_search` result title was clamped to "122 columns" and rendered at 140
(18 East-Asian Wide chars × 2). pi-tui asserts every line fits and throws an
uncaughtException, which kills the process — that assertion has existed since
pi-tui **0.6.2 (2025-11-12)**; what changed was `web_search` (added 2026-07-30)
becoming the first tool to put **arbitrary web-page titles** in a box header.
Stock unpatched pi-tui measures that line at 140 too, so our width patch was
never implicated.

Fixed by deleting the private measure and using pi-tui's `truncateToWidth` /
`visibleWidth` — **the invariant is that we must clamp with the same function
pi-tui asserts with.** Also clamped the `╰────` footer (a *constant* is still 5
columns and boxes render into narrower nested contexts) and made
`renderCallLine` honour its `width`. Guarded by `lib/box-format.test.ts`: 480
tests over ~28 scripts (CJK, Devanagari, Bengali, Tamil, Thai, Vietnamese,
Arabic, Hebrew, emoji ZWJ/skin-tone/flags, zero-width, tabs, ANSI) × 12 widths,
asserting `visibleWidth(line) <= width` for every emitted line. Verified the
suite actually catches it: reintroducing the old measure fails 26 tests,
starting with "the string that crashed pi @ width 125".

The same file also flattens `\r\n\v\f\u2028\u2029` in headers and notices —
a newline in a single-line sink is width-0, passes every width check, and still
advances a row nobody counted (that one smears rather than crashes).

1. Re-run `pi-setup/render-repro/` (see its README): DSR phases in Ghostty +
   tmux must show 0 desyncs, visual phases MATCH, `find-bad-clusters.mjs`
   must report `bad: 0` (fatal undercounts only).
2. First suspect: an update restored a stock pi-tui copy — run
   `node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs --check`
   (a NEWLY INSTALLED package brings a fresh unpatched copy too).
3. Measure the actual terminal with `dsr-widths.mjs` inside Ghostty — if a new
   char class undercounts, extend `clusterAdvance` (and keep it conservative:
   when in doubt, count MORE, never less).
4. If widths are all clean, suspect the OTHER mechanism: a component embedding
   `\n`/control chars into a single-line string (border label, widget row,
   truncated summary). `\n` is width-0 to every check but moves the real
   cursor. Grep the offending fragment from the smear screenshot to find the
   source component; flatten at its sink like `flattenLabelText`.

---

## Sub-agent Prompts (why children don't get the parent prompt)

**Files:** `extensions/tools/lib/sub-agent-prompt.ts` (+ its test), `extensions/system-prompt.ts`, `extensions/tools/lib/pi-spawn.ts`.

### The problem

A sub-agent is a fresh `pi` process that **loads the same extensions as the
parent** — so `system-prompt.ts` runs inside it too. It used to append the
parent's full tool prompt (**11,705 bytes describing ~40 tools**, measured) to a
child whose registry `--tools` had filtered down to between **1 and 12** tools.

The child then read instructions that were false for it — "apply_patch — every
file modification", "your dedicated sub-agents are exactly five tools". Measured
consequence: a `code_review` child spent two calls probing `search_sessions` and
`skill` before concluding they were absent.

A child's prompt has three layers; only the third was wrong:

1. pi's own base prompt
2. its agent prompt (`agent.amp.finder.md` …) via `--append-system-prompt` — correct
3. ~~the parent's full prompt~~ → now a generated block naming its real tools

### The mechanism

`piSpawn` already computes each child's merged, alias-resolved allowlist to build
`--tools`. It now also exports that **same array** as `PI_SUBAGENT_TOOLS`, and
`system-prompt.ts` branches on it. One array feeds both the registry filter and
the prompt text, so **they cannot disagree**.

Every agent brings its own list automatically — finder 4, oracle 8, code_review
8, librarian 7, delegate 12, `read_web_page`/`read_session` 1 — and a grandchild
(delegate spawning finder) gets its own, because each `piSpawn` call sets the
variable fresh for that spawn.

### Things that look arbitrary and are not

- **The parent template is skipped, not patched with a correction line.** A child
  that has read "apply_patch — every file modification" has already been misled
  by the time a footnote arrives.
- **The block carries the working rules** (read first, verify, root causes)
  because `delegate` is the one sub-agent with **no agent prompt of its own** and
  would otherwise lose them entirely.
- **The env var name is one exported constant**, imported by both the writer
  (`pi-spawn`) and the reader (`system-prompt`) — two string literals could drift,
  and the failure would be silent.
- **A missing env var falls back to the old behaviour.** The failure mode is the
  previous status quo, never a broken session.
- **Grammar is branched for the one-tool case** — `read_web_page`/`read_session`
  children get exactly one tool, and "These 1 are the only tools" reads like a bug.

### Side effect worth knowing

It **removes ~11 KB (~2,700 tokens) from every sub-agent spawn**. The fix is
cheaper as well as correct.

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
- **Parent is Anthropic** (provider `anthropic` or `claude-bridge`, or model name contains `claude`) → use the designated model (`claude-sonnet-5`, `claude-opus-4-6` — see "Sub-agent Models")
- **Parent is non-Anthropic** (deepseek, kimi-code, sakana, llama-local, openai-codex, etc.) → inherit parent model (can't use Claude without separate API access)

This means subagents use Claude models when you're on Claude, but don't break when you're on a non-Anthropic provider.

---

## Clipboard Image Paste Placeholder (editor.ts feature)

**File:** `extensions/editor/index.ts`

### The Problem

pi core's `handleClipboardImagePaste()` (in `interactive-mode.js`) writes the pasted clipboard image to a temp file and inserts the **raw path** (`/var/folders/.../pi-clipboard-<uuid>.png`) into the editor as literal text. That long path is what you stare at while composing, and the model only gets it as text (it has to `read` the path to see the image).

### The Fix (opencode-style placeholder, zero core patches)

Our `LabeledEditor` now sets its own `onPasteImage`. Core's editor-swap only wires the default handler when ours is unset (`if (!customEditor.onPasteImage)`), so ours wins with no core changes. On paste:

1. Read the clipboard image's **raw bytes** via `@mariozechner/clipboard`'s `getImageBinary()` and base64-encode them with `Buffer.toString("base64")`. **Do not use `getImageBase64()`** — it omits the trailing `=` padding, so any image whose byte length isn't a multiple of 3 yields unpadded base64 that Anthropic rejects with `invalid base64 data` (400). The `Buffer` path matches pi core's own read-tool image handling and is always correctly padded.
2. Insert a short token `[image #N]` into the editor (N increments per paste; resets after each submit).
3. Register the base64 in a module-level `pastedImages` map keyed by the token.

A `pi.on("input", …)` hook then expands tokens at submit: for each `[image #N]` found in the text it pushes an inline `{ type: "image", data, mimeType }` content block (returned via `{ action: "transform", text, images }`), so vision models receive the image **directly** — no temp file, no `read` round-trip. The token text stays in the message for a readable transcript. Multiple pastes stack as `[image #1] [image #2] …`.

### Clipboard module resolution

`@mariozechner/clipboard` is **not** a jiti-aliased package (jiti only aliases `@mariozechner/pi-*`), and the `~/.pi/agent/node_modules/@mariozechner/*` symlinks are stale. `loadClipboard()` resolves it with `require.resolve(..., { paths })` anchored at the **running pi binary's** `node_modules` (clipboard is pi's own dep, always present), then `extensions/tools/node_modules` and known global npm roots. If resolution fails, `onPasteImage` is left unset and pi's default path-insert behavior transparently takes over — **no regression**.

### After pi update

Nothing to re-apply — this is an extension, deployed by `install.sh` (`cp -R extensions`). Survives pi npm updates. The only dependency is `@mariozechner/clipboard`, which ships inside pi's own `node_modules` and is also installed under `extensions/tools` by `install.sh`'s `npm install`.

---

## DeepSeek Peak/Off-Peak Clock (`extensions/deepseek-peak/`)

**Added 2026-08-13.** Files: `deepseek-peak/index.ts` (extension), `peak.ts`
(pure logic), `peak.test.ts` (44 tests), plus a three-line change to
`editor/index.ts` (see "Repaint" below).

### What it shows

The bottom-left slot of the editor's border — the prompt bar — carries the
local wall clock, then the current DeepSeek pricing phase and the time until
it flips:

```
╰─7:02 · ◇ ds off-peak · 11h 41m left ────────────────────── ~/…/ghosttyyy (main)─╯
╰─7:02 · ◆ ds PEAK 2× · 41m left ─────────────────────────── ~/…/ghosttyyy (main)─╯
╰─7:02 · ds flat · 3d 2h ────────────────────── ~/…/ghosttyyy (main)─╯
```

`/deepseek` prints the full report: current UTC + local time, phase, countdown,
the peak windows converted to the local timezone, and the rate card.
`/deepseek off` / `on` hides and restores both labels.

### The clock

**12-hour, no leading zero, no AM/PM** — `7:02`. Intl has no "12-hour without
meridiem" option, so the meridiem is *stripped* rather than never requested
(`hour12: false` would give `19:02` — a different clock, not the same one with
less text). Modern ICU separates the time from AM/PM with **U+202F**, a narrow
no-break space, not an ASCII space, so the strip must not assume ASCII.

**It is deliberately UNCOLOURED, which is what makes it off-white.** Plain text
lands on the terminal's own default foreground (`#ebdbb2` in this Ghostty
gruvbox theme) and follows the terminal if the theme changes. Every theme
colour reachable here is either loud (`accent`/`warning`/`error`) or grey
(`muted` `#a89984`, `dim` `#7c6f64`), and **`fg("text")` throws** — both themes
map `text` to `""`, and `Theme.fg` rejects a falsy ansi string with "Unknown
theme color". This is only safe because the preceding border chrome ends in
`\x1b[39m` (`Theme.fg` resets the foreground), so the clock inherits nothing.
Verified from the emitted bytes rather than by eye:
`╰─<ESC>[39m7:06 · <ESC>[38;2;168;153;132mds flat…`.

It is a **separate label** from the pricing phase, because the editor already
joins same-side labels with " · " and the two need different colours. Order
comes from Map insertion order, so `paint()` emits the clock first. `/deepseek
off` therefore has to remove **both** keys — removing only the pricing label
would leave a clock behind that no longer ticks.

### The schedule, and why it needs no API

From **16:00 UTC, 2026-08-16**, DeepSeek charges **2× during 01:00–04:00 and
06:00–10:00 UTC**; every other hour is off-peak. Announced by @deepseek_ai;
corroborated independently — those windows are Beijing (UTC+8) 09:00–12:00 and
14:00–18:00, i.e. Chinese office hours, which is why the boundaries land on
exact hours and the half-open `[start, end)` reading is safe.

In IST (UTC+5:30) that is **06:30–09:30 and 11:30–15:30** — 7 peak hours a day,
17 off-peak, and the whole evening is cheap.

**No time API, deliberately.** The windows are defined in UTC and every machine
already knows UTC exactly — `Date.getUTCHours()`, no timezone database, no DST,
no leap-second concern, no network, no cache, no failure mode. A time service
would add a round-trip to learn something the process already holds, and the
only thing it could fix — a wrong system clock — is already wrong for every
other program on the machine. The **local** rendering in `/deepseek` does use
`Intl` with an explicit `"en-US"` locale (the system locale is `en-IN`, which
formats differently) and the runtime's own timezone rather than a hardcoded
+5:30, so it stays correct if the laptop moves.

### Things that look arbitrary and are not

- **Before the effective date it says "flat", not "off-peak".** Reporting
  off-peak now would assert a discount that does not exist yet — the V3/R1
  16:30–00:30 discount was retired 2026-07-24 and never applied to V4.
- **Peak turns red only when the active model IS deepseek**, orange otherwise.
  The colour is an alarm about the turn you are about to spend, not decoration.
- **The label is emitted over the editor's public event bus**
  (`editor:set-label`), never by importing the editor. pi loads each extension
  with its own jiti instance and `moduleCache: false`, so a shared module-level
  object is *not* shared — it reads empty, silently.
- **Each label re-emits every poll but only repaints when its TEXT changed.**
  At minute granularity that is one repaint per minute; repainting every tick
  would fight the editor's own render loop for nothing visible. The poll is 5s
  rather than 60s so the minute is never more than 5s late — the other 11 ticks
  are no-ops.
- **Pre-launch reads `ds flat · 3d 2h`, with no "new rates in" wording.** The
  countdown already says it.
- **`peak.test.ts` lives inside the extension directory and is inert.** pi's
  `resolveExtensionEntries` loads *only* `index.ts` from a subdirectory
  (verified in `dist/core/extensions/loader.js:473`) — a bare `deepseek-peak.ts`
  plus `deepseek-peak.test.ts` at the top level would have loaded the test file
  as an extension.

### Repaint — the one editor change

`editor:set-label` set the label but never called `requestRender()`, so a
time-based label sat stale until the next keystroke. `setLabel`/`removeLabel`
now return whether anything actually changed, `LabeledEditor.requestRepaint()`
is public, and the two event handlers repaint on a real change only. Existing
internal callers ignore the return value and are unaffected.

### It killed pi once — a timer must be torn down at `session_shutdown`

**Fixed 2026-08-13, same evening it shipped.** A session died with:

```
pi exiting due to uncaughtException:
Error: This extension ctx is stale after session replacement or reload …
    at paint (~/.pi/agent/extensions/deepseek-peak/index.ts)
    at Timeout._onTimeout (…)
```

**Mechanism, reproduced end-to-end.** `/new`, `/resume`, `/fork`, session
import and `/reload` all call `AgentSession.dispose()` (or `reload()`), which
emits `session_shutdown` and then **invalidates the extension runtime** — every
later call through that `pi` object throws (`assertActive`,
`dist/core/extensions/loader.js`). The replacement session re-runs each
extension factory with a fresh runtime, so the NEW instance is fine. But the OLD
closure's `setInterval` is owned by nothing, keeps its captured `pi`, and the
next tick that actually calls `pi.events.emit` throws **inside a timer
callback** — an uncaughtException, which pi answers with `process.exit(1)`.

**Why it looked like sleep broke it, and why it looked random.** `paint()`
returns early while the label TEXT is unchanged, so the doomed tick is the first
one after the clock rolls a minute — up to 60s after the `/new`, with nothing on
screen connecting the two. macOS sleep suspends timers, so a replacement done
just before closing the lid detonates **on wake**. Confirmed by reproduction in
tmux: pi survived `/new` for 9s, then died at the minute boundary with a
byte-identical stack.

**Fix (both layers, `deepseek-peak/index.ts`).** `pi.on("session_shutdown")`
clears the timer and drops `ctxRef` — that event is emitted *before*
invalidation, which is the only legal window. `paintSafely()` then wraps every
paint: a throw out of a timer is fatal, so it is caught, and since a stale
runtime never recovers it stops the poll instead of retrying. Silently — a
`console.error` during a TUI render scribbles the screen, and the new session's
own instance is already painting.

**The general rule for this repo:** an extension timer that outlives a session
must be cleared on `session_shutdown`, and anything a timer calls must be inside
a `try`/`catch`. `tools/agent-message.ts` already did this (`pi.on("session_shutdown",
async () => stop())`); it was the only other process-lifetime interval that
touches a `pi.*` runtime API. The two component-scoped intervals — the editor's
spinner and `session-breakdown`'s progress ticker — only touch local component
state, so they cannot reach `assertActive`.

Guarded by `deepseek-peak/index.test.ts` (5 tests against a stub `pi` whose
`events.emit` can be made stale exactly like the real runtime). Verified by
sabotage: removing the handler and the catch fails 4 of the 5. Verified live:
`/new` twice, `/deepseek off`/`on` across a replacement, alive across three
minute boundaries with the clock still ticking and an empty stderr.

### Verified (2026-08-13)

51 unit tests, including: every hour of the day against the published table,
both half-open boundaries to the second, the 15h overnight wrap, a full-day
walk asserting the flips land on exactly `[1, 4, 6, 10]`, the IST/Beijing/UTC
conversions, and every hour asserting the clock matches `/^\d{1,2}:\d{2}$/` with
no meridiem and no U+202F left behind. Live in a real pi under tmux: all three
phases rendered correctly, countdowns matched the wall clock to the minute
(13:19 UTC → 01:00 = `11h 41m`), the pricing label ticked 41m → 39m and the
clock rolled 7:06 → 7:08 against `date`, **both with no input**, proving the
repaint path. `/deepseek off` cleared both labels and `on` restored them in
order. The post-effective-date states were checked by backdating the *deployed*
copy only, then restoring it from the repo and diffing.

---

## Agent Mention Directives (@oracle, @finder, @codereview, @task, @chad)

**Files:** `extensions/tools/lib/mentions/agent-source.ts` (new), plus modifications to `types.ts`, `sources.ts`, `parse.ts`, `render.ts`, `provider.ts`, `index.ts`, and `extensions/mentions.ts`.

### What It Does

Extends pi's existing @mention system to support agent tool routing. When the user types `@oracle review this auth flow`, a hidden directive is injected into the context telling the model to call the `oracle` tool — not delegate, not do it itself.

### How It Works

1. **Parse** — standalone regex `(?<![\w/])@(oracle|finder|codereview|task)(?=[\s.,;:!?)\]}]|$)` matches `@oracle` without requiring `/value` (unlike `@commit/sha`)
2. **Resolve** — `agent-source.ts` maps each kind to its tool name (e.g. `codereview` → `code_review`, `task` → `delegate`)
3. **Render** — produces `AGENT DIRECTIVE: Call the \`oracle\` tool for this request. The user explicitly tagged @oracle. Do not substitute another tool.`
4. **Inject** — `mentions.ts` injects the directive as a hidden `display: false` custom message in the `context` hook

### Agent ↔ Tool Mapping

| Mention | Tool | Description |
|---------|------|-------------|
| `@oracle` | `oracle` | Expert advisor — architecture, planning, hard bugs |
| `@finder` | `finder` | Codebase search by concept or behavior |
| `@codereview` | `code_review` | Code review with diff analysis |
| `@task` | `delegate` | Full subagent for independent parallel work (resumable) |
| `@chad` | `chad` | Read-only deep research subagent — cheap enough to swarm |

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

## pi-mcp-adapter: On-Demand MCP Gateway

**Upstream:** https://github.com/nicobailon/pi-mcp-adapter (v2.10.0, MIT)
**Status:** Active in `settings.json` packages. **No patches.** Installed via `pi install npm:pi-mcp-adapter` → `~/.pi/agent/npm/node_modules/pi-mcp-adapter`.

### Why It Was Chosen (and why it's safe)

Built on Mario Zechner's "you don't need MCP" philosophy — MCP tool definitions are verbose (10k+ tokens per server) and you pay that whether you use them or not. This adapter exposes **one proxy tool** (`mcp`, ~200 tokens) instead of dumping every server's tools into context. The model discovers tools on demand via `mcp({ search })` → `mcp({ tool, args })`. Servers are **lazy** — no process spawns until a tool is actually called.

**It does NOT conflict with our setup:**
- Registers exactly **one tool named `mcp`** + commands `/mcp`, `/mcp-auth` + flag `--mcp-config`. No name collision with any of our 25 custom tools or commands.
- **Does NOT override pi built-ins** (`read`/`bash`/`edit`/etc.) — unlike pi-tool-display. Purely additive, so it cannot clobber our custom tools' mutex locking / secret scrubbing / git trailers.
- Uses only the public `ExtensionAPI` (`registerTool`/`registerCommand`/`registerFlag`/`on`). **No core patching.**
- Compatible with our pi 0.80.10 (devDep `pi-coding-agent ^0.79.1`, runtime `pi-ai`/`pi-tui ^0.74.0`).

### Behavior: "invoke MCP only when wanted"

- **With no config file present, it's inert** — just the proxy tool in the list, no servers, no overhead.
- The model only calls `mcp` when relevant; servers connect on first tool call; `directTools` (promoting MCP tools to first-class entries) is strictly opt-in.
- Set `disableProxyTool: true` to hide even the proxy once direct tools are cached.

### Config Files (precedence)

1. `~/.config/mcp/mcp.json` (user-global shared)
2. `<agent dir>/mcp.json` (`~/.pi/agent/mcp.json` — Pi global override)
3. `.mcp.json` (project-local shared)
4. `.pi/mcp.json` (Pi project override)

### Configured Servers

**Global (pi-only, all folders):** `~/.pi/agent/mcp.json` → backed up as `pi-setup/mcp.json`, deployed by `install.sh`.

| Server | Transport | Config | Notes |
|--------|-----------|--------|-------|
| `astro` | HTTP (`url`) | `http://127.0.0.1:8089/mcp`, `auth: false` | [Astro](https://tryastro.app/docs/mcp/) ASO tool. **Local HTTP server that runs inside the Astro Mac app** — must be enabled in Astro → Settings → MCP Server (default port 8089). `auth: false` because Astro is localhost-only with no token; this stops the adapter from probing OAuth. Lazy (default): pi only connects when an `astro` tool is actually called, so the Astro app must be open + MCP enabled at call time. 60 req/min limit. Tools: `list_apps`, `search_rankings`, `get_app_keywords`, `get_app_ratings`, `extract_competitors_keywords`, `add_app`, `add_keywords`, `set_keyword_note`, `set_keyword_tag`, `manage_tag`, `search_app_store`, `get_keyword_suggestions`. |
| `paper` | HTTP (`url`) | `http://127.0.0.1:29979/mcp`, `auth: false` | [Paper](https://paper.design/docs/mcp) design tool. **Local HTTP server that runs inside the Paper Desktop app** (macOS/Windows) — auto-starts in the background when you open a file in the app (fixed port 29979). `auth: false` because Paper is localhost-only with no token; this stops the adapter from probing OAuth. Lazy (default): pi only connects when a `paper` tool is actually called, so the Paper app must be open with a file loaded at call time. **Read+write** — the agent can create/modify shapes and content in the *currently open* design file (unlike read-only astro/Figma), so grant write permissions deliberately. Context = the currently open Paper file. Useful for design→code, syncing design tokens (e.g. from Figma), or pulling real content (e.g. from Notion) into designs. Inert (no error, adapter is lazy) if the Paper app isn't installed/running. |
| `cloudflare` + 15 product servers | HTTP (`url`) | see "Cloudflare MCP servers" below | All remote. `auth: "oauth"` (never `true`!) + `protocolVersion: "auto"` for authenticated ones; `auth: false` for the public ones. |

### Cloudflare MCP servers (added 2026-08-13)

[Cloudflare's managed MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).
All are **remote Streamable HTTP** endpoints, all use `protocolVersion: "auto"` — they are stateless MCP SDK v2
Workers (`createMcpHandler`), which is exactly the case the adapter's README cites for `"auto"`
(modern 2026-07-28 `server/discover` negotiation with conservative legacy fallback).
Authenticated servers use **Cloudflare OAuth** (authorization-code + PKCE, dynamic client registration,
loopback callback, tokens in the macOS Keychain) **or** an optional static `Authorization: Bearer` API token.
Lazy (default): nothing connects until a `cloudflare-*` tool is actually called.

**`auth` must be `"oauth"`, never `true`.** `auth: true` is NOT a legal value in pi-mcp-adapter
(valid: `"oauth"`, `"bearer"`, `false`, or omitted) and it fails **silently**: `supportsOAuth()`
(`mcp-auth-flow.ts`) falls through to `definition.auth === undefined`, so `true` disables both OAuth
and bearer and the server connects unauthenticated → 401. This bit us on first setup — the deployed
entry had `"auth": true`. See `pi-setup/2026-08-13-cloudflare-mcp.md`.

| Key | URL | What it is | Auth |
|-----|-----|-----------|------|
| `cloudflare` | `https://mcp.cloudflare.com/mcp` | **Cloudflare API** — Code Mode: `search()` + `execute()` over the whole API (~2,500 endpoints, ~1,000 tokens) + `docs` (dev docs search). Agent writes JS against a typed OpenAPI spec, executed in a Dynamic Worker sandbox with outbound restricted to api.cloudflare.com | OAuth (scope picker: Read only default / Full access / per-resource) |
| `cloudflare-docs` | `https://docs.mcp.cloudflare.com/mcp` | Developer docs search (AutoRAG) | public |
| `cloudflare-blog` | `https://blog.mcp.cloudflare.com/mcp` | Blog search/read | public |
| `cloudflare-stack` | `https://stack.mcp.cloudflare.com/mcp` | Docs search over a curated stack (Cloudflare/Hono/Vite/Astro…) | public |
| `cloudflare-agents-docs` | `https://agents.cloudflare.com/mcp` | Agents SDK docs search | public |
| `cloudflare-bindings` | `https://bindings.mcp.cloudflare.com/mcp` | Workers platform primitives: KV, R2, D1, Hyperdrive, Workers (+ get code) | OAuth |
| `cloudflare-builds` | `https://builds.mcp.cloudflare.com/mcp` | Workers Builds insights/management, build logs | OAuth |
| `cloudflare-observability` | `https://observability.mcp.cloudflare.com/mcp` | Workers logs/metrics debugging (heavy — keep queries concise per Cloudflare's own troubleshooting note) | OAuth |
| `cloudflare-containers` | `https://containers.mcp.cloudflare.com/mcp` | Ephemeral (~10 min) sandboxed dev containers (Node/Python) | OAuth |
| `cloudflare-browser` | `https://browser.mcp.cloudflare.com/mcp` | Browser Run: fetch → HTML/Markdown/screenshot/PDF, CSS-selector scraping, async crawls | OAuth |
| `cloudflare-logpush` | `https://logs.mcp.cloudflare.com/mcp` | Logpush job health summaries | OAuth |
| `cloudflare-ai-gateway` | `https://ai-gateway.mcp.cloudflare.com/mcp` | AI Gateway logs, prompt/response bodies, usage | OAuth |
| `cloudflare-auditlogs` | `https://auditlogs.mcp.cloudflare.com/mcp` | Account change-history queries + reports | OAuth |
| `cloudflare-dns-analytics` | `https://dns-analytics.mcp.cloudflare.com/mcp` | DNS performance optimization/debugging | OAuth |
| `cloudflare-dex` | `https://dex.mcp.cloudflare.com/mcp` | Digital Experience Monitoring (device/network/app perf, remote PCAP) | OAuth |
| `cloudflare-casb` | `https://casb.mcp.cloudflare.com/mcp` | Cloudflare One CASB — SaaS security misconfiguration findings | OAuth |

Deliberately **not** added: `radar`, `autorag` (AI Search), `graphql` — deprecated by Cloudflare
(their READMEs direct new users to the unified `mcp.cloudflare.com/mcp` Code Mode server, which covers
GraphQL analytics via `execute`); and `demo-day` (a demo server).

**First connect (one-time per server):** run `/mcp-auth <key>` in the TUI (walks the whole browser flow),
or headless: `mcp({ action: "auth-start", server: "cloudflare" })` → approve in the browser →
`mcp({ action: "auth-complete", server: "cloudflare", args: { redirectUrl } })`. Tokens are stored in
the macOS Keychain under `pi-mcp-adapter.oauth`, refreshed transparently (1 h access / 30 d refresh).
The main server's consent screen has a scope picker (Read only is the default preset).

**Bearer alternative (CI/CD):** any authenticated server also accepts a Cloudflare API token
(user or account; `cfat_`/`cfut_` prefixes) as a static header —
`{ "url": "https://bindings.mcp.cloudflare.com/mcp", "headers": { "Authorization": "Bearer <token>" } }`.
**Custom headers disable implicit OAuth auto-detect**, so that shape must set `auth: "oauth"` explicitly
if you want both. Multi-account: add a `cf-account-id` header to pin the account.

To add more servers: edit `~/.pi/agent/mcp.json` (global) or a project `.mcp.json`. stdio servers use `command`/`args`; HTTP servers use `url` (+ optional `headers`/`auth`).

```json
{ "mcpServers": {
  "astro": { "url": "http://127.0.0.1:8089/mcp", "auth": false },
  "paper": { "url": "http://127.0.0.1:29979/mcp", "auth": false },
  "cloudflare": { "url": "https://mcp.cloudflare.com/mcp", "auth": "oauth", "protocolVersion": "auto" },
  "cloudflare-docs": { "url": "https://docs.mcp.cloudflare.com/mcp", "auth": false, "protocolVersion": "auto" }
} }
```

### After pi/package update

No patches to re-apply. `pi update --extensions` may bump it — safe (unpatched). Backed up as the `npm:pi-mcp-adapter` entry in `pi-setup/settings.json` (package) + `pi-setup/mcp.json` (server config); `install.sh` re-adds both on deploy.

**2.25.0 changed the default result rendering.** MCP tool results now render as
compact self-rendered rows instead of the boxed row; set
`settings.toolResultRendering: "boxed"` in `mcp.json` to get the old one back,
and `settings.collapsedResultLines` (1–3) to control how much shows collapsed.
This does **not** reopen the TUI smear class — the compact renderer measures
with pi-tui's own `truncateToWidth`/`visibleWidth`, which is the invariant that
section requires. 2.25 also adds `settings.notifyOnStartupConnect` to silence
startup connection notices.

---

## One Install, No Duplicates (cleanup 2026-08-14)

**There is exactly ONE place pi loads packages from, and it is not a global npm
root.** `getManagedNpmInstallPath` (`dist/core/package-manager.js:1710-1719`)
returns `join(agentDir, "npm", "node_modules", name)` — i.e.
`~/.pi/agent/npm/node_modules`. That is what `pi install npm:<name>` writes and
what `pi update --extension` updates.

| Location | What it is | Rule |
|---|---|---|
| `~/.pi/agent/npm/node_modules` | **the** package store (all 8 active packages) | the only one pi reads |
| `~/.pi/agent/git/<host>/<org>/<repo>` | git-sourced packages (`pi-autoresearch`) | keep |
| `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` | **the pi binary itself** | keep; `/opt/homebrew/bin/pi` points at its `dist/cli.js` |
| `~/.pi/agent/extensions/tools/node_modules` | our tools' real deps (playwright-core, cheerio, pngjs, psst-cli, clipboard, pi-diff) | keep |
| any other global npm root | **duplicates** | never install pi packages there |

### Never `npm install -g` a pi package

It does not become "installed but inactive" — it becomes **unloadable**, plus:

1. **It can hijack a package version.** `getNpmInstallPath`
   (`package-manager.js:1728-1735`) falls back to
   `join(npm root -g, name)` when a package is **missing** from the managed
   store. Our `packages` entries pin no versions, so any version there
   satisfies. Before this cleanup the nvm root held
   `@benvargas/pi-claude-code-use@2.2.0` — precisely the version we hold back at
   1.0.5 — waiting for one missing managed copy to be loaded instead.
2. **It brings an UNPATCHED pi-tui copy.** Every pi package bundles its own; the
   width patch has to cover all of them.

Install with `pi install npm:<name>`, always.

### `npm ls -g` LIES here — read versions from the agent dir

`node`/`npm` come from nvm, so `npm root -g` resolves to
`~/.nvm/versions/node/<v>/lib/node_modules`, while the pi *binary* lives under
homebrew. A bare `npm ls -g` therefore reports a **third** set of versions that
pi does not use. To read what is actually loaded:

```bash
for d in ~/.pi/agent/npm/node_modules/*/ ~/.pi/agent/npm/node_modules/@*/*/; do
  [ -f "$d/package.json" ] && node -e "const p=require('$d/package.json');console.log(p.name+'@'+p.version)"
done
```

### What the cleanup removed

~3.0 GB of copies pi could not load, across both global roots: 11 stale pi
packages from `/opt/homebrew/lib/node_modules` (some fossils — `pi-context@1.1.4`
vs the live 2.1.2), 7 from the nvm root, and **5 dangling symlinks** in
`~/.pi/agent/node_modules/` pointing at the pre-rename
`@mariozechner/pi-coding-agent` path (the whole directory is gone; pi never
constructs that path).

**pi-tui copies went from 24 to 4** — and 8 of the removed ones were genuinely
**unpatched**, while `verify-patches.sh` reported "ALL copies patched", because
`apply-pi-tui-width-patch.mjs` only searched homebrew and `~/.pi/agent`. It now
also scans `npm root -g` and the running pi's own root, so a stray global
install shows up as a FAIL instead of hiding. Verified by planting a fake
unpatched copy in the nvm root and confirming the script flags it (exit 1).

Nothing that is used was touched: root C, the git package, `extensions/tools`,
all 13 extensions and 29 tools, the pi binary, and unrelated global CLIs
(`psst`, `wrangler`, `auggie`, `mgrep`, `ccusage`, `netlify-cli`, …) are intact.

### Stale backups — also removed (~5.1 GB, same pass)

Eight backup directories from earlier migrations
(`~/.pi-backup-20260423-204604` 2.2 GB, `~/.pi/agent-backup-20260517` 2.6 GB,
`~/pi-cleanup-backup-20260723_154255`, `~/pi-port-backup-*`, four
`~/pi-update-backup-*`), plus `~/.pi/agent/extensions-disabled/` (5 files, all
recoverable from git — and pi has **no** disabled-extension state, so the
directory never did anything), a Feb `agent/backups/20260227_090600/settings.json`,
and one stale md-export output.

**Each was proved redundant before deletion, not assumed:** the two big backups'
sessions were diffed against the live store by filename — 2,235 and 619 sessions,
**zero unique to either**. Every extension inside them was confirmed present in
git history. `~/.pi/agent/pi-sessions-extracted/` was kept as a directory because
`md-export.ts:584` uses it as its fallback output dir.

**The repo + git is the backup.** Dated copies of the agent dir are not — they
rot, they duplicate sessions, and they hide unpatched pi-tui copies.

### The repo's `extensions/tools/node_modules` is the DEPLOYMENT SOURCE

It is gitignored build output, but `install.sh` does
`cp -R "$SCRIPT_DIR/extensions" "$PI_AGENT/extensions"` (`:102`) — so its three
pi-tui copies land in the **loaded** path. install.sh re-patches afterwards
(`npm install` at `:107`, width patch at `:250`), so ordering saves it — but
anyone deploying with a manual `cp -R` would install unpatched copies.
`apply-pi-tui-width-patch.mjs` therefore also scans **its own repo checkout**, so
the source is patched rather than healed after the fact. 7 copies now: 4 loaded,
3 deployment-source, all patched.

---

## Packages (npm)

| Package | Version | Purpose | Patched? |
|---------|---------|---------|----------|
| `@earendil-works/pi-coding-agent` | 0.84.2 | The pi agent itself (installed via homebrew npm) | **3 core patches** |
| `@benvargas/pi-claude-code-use` | 1.0.5 | API payload shim for Claude Max OAuth use (system prompt + tool-name compatibility) (primary Claude method) | No |
| `pi-context` | 2.1.2 | Context management: context_checkpoint, context_timeline, context_compact | No |
| `pi-token-burden` | 0.6.5 | Token usage tracking and display | No |
| `@marckrenn/pi-sub-bar` | 1.5.0 | Usage widget — shows provider quotas in status bar | **Local patch**: grok provider (`pi-setup/pi-sub-patches/`) |
| `pi-autoresearch` | 1.6.2 | Autonomous experiment loop for optimization targets (GitHub install) | No |
| `pi-tool-display` | 0.5.0 | Compact tool rendering, thinking labels, user message box | **Config** |
| `pi-codex-goal` | 0.2.0 | Codex-style `/goal` — autonomous multi-turn objectives with completion audit | No |
| `pi-mcp-adapter` | 2.25.0 | On-demand MCP gateway — single `mcp` proxy tool (~200 tokens), lazy server connect | No (**config**: see below) |

**Active in settings.json (8):** `pi-context`, `pi-token-burden`, `@benvargas/pi-claude-code-use`, `@marckrenn/pi-sub-bar`, `pi-autoresearch`, `pi-tool-display`, `pi-codex-goal`, `pi-mcp-adapter`

**pi-claude-code-use is deliberately held at 1.0.5** (2.1.0 exists). Verified safe
on 0.84.1: it touches exactly one registry API (`isUsingOAuth`, unchanged), and
2.x's only new ≥0.84 feature needs registered MCP aliases, which we never have.
See `pi-setup/pi-migrations.md`.

**Removed packages — do not reinstall.** Reasons in `pi-setup/pi-migrations.md`
and the bdsqqq port log; the short version:

| Package | Removed | Why |
|---|---|---|
| `pi-web-access` | 2026-07-30 | `web_search` was 100% dead (every provider key rejected/rate-limited) and `source_check` silently degraded because it consumes it. Replaced by our self-contained Parallel AI `web_search`. |
| `pi-tasks` | 2026-07-30 | Array parameters arrived JSON-stringified and were rejected, so `task_plan` always failed and every tool gated behind it was unreachable. |
| `@tomooshi/condensed-milk-pi` | 2026-07-30 | Reported **failed** git commands as successes (a permission-rejected `git add -A` became `ok (1 files staged)`) and masked 60% of prior tool results at 30% context use. Needed three local patches to stay usable. `verify-patches.sh` fails loudly if a copy reappears. |
| `@sting8k/pi-vcc` | — | Algorithmic compaction; replaced by pi's native `compaction.enabled`. |
| `pi-computer-use` | 2026-07-23 | Installed-but-inactive, so its `computer-use` skill loaded while its GUI tools never registered — a dead skill in the list. |
| `pi-gpt-config`, `pi-ask`, `pi-grok-cli` | 2026-07-23 | Unused. |

**Kimi Code usage:** `/model kimi-code/kimi-for-coding:high`. Uses `~/.kimi-code/credentials/kimi-code.json` and `pi-setup/extensions/kimi-code-token.mjs` to refresh Kimi Code subscription OAuth tokens.

**Claude Max usage:** `/login anthropic` → `/model anthropic/claude-opus-5`. pi-claude-code-use intercepts provider API requests (after OAuth) and rewrites payloads for Claude Code-style subscription use. No custom provider needed — uses pi's native anthropic provider.

**`pi-autoresearch` shortcut is pinned to `ctrl+shift+r`** in
`pi-setup/extensions/pi-autoresearch.json` (deployed by `install.sh`'s
`cp -R extensions`). **pi-tui 0.84.2 took `ctrl+shift+f`** for the new
fullscreen transcript search, and autoresearch's default dashboard shortcut is
exactly that — so every startup printed an `Extension shortcut conflict` and the
extension won, making the new built-in search unreachable. The fix is the
package's own config (`shortcuts.ts:17` reads
`<agentDir>/extensions/pi-autoresearch.json`), **not** a patch to the package —
it is a git-installed package and a patch would be wiped on update. `null`
disables the shortcut entirely. `ctrl+shift+r` was chosen after checking pi core,
pi-tui, all 8 packages and our own extensions: taken are `ctrl+shift+f`/`+g`/
`+up`/`+down` (pi-tui), `ctrl+shift+p` (command palette), `ctrl+shift+a`
(subagent inspector).

**Formerly "installed but inactive" — now REMOVED (2026-08-14):** `pi-claude-bridge`
(0.4.0, patched), `lsp-pi`, `pi-powerline-footer`, `pi-anycopy`. That label was
wrong: they were installed in a **global npm root, which pi never loads packages
from**, so they were not "inactive" — they were unloadable. Re-enabling one was
never a config change; it always required `pi install npm:<name>`, which puts it
in `~/.pi/agent/npm/node_modules` like everything else. See "One Install, No
Duplicates".

**Per-version migration record:** `pi-setup/pi-migrations.md` — one entry per pi
update, recording which patched core file drifted and how the patch was
re-derived. Read it before running `pi update`.

---

## Subagent Inspector (`extensions/subagent-inspector/`)

Ctrl+Shift+A (or `/subagents`) opens an overlay listing every sub-agent run in the
session. Enter opens one: its **thinking**, tool calls and tool results, scrollable.
`←`/`→` switch between runs, `f` toggles trimmed/full tool results, Esc backs out
one level then closes. Works while an agent is still running and after it finished.

**Read-only by design.** It observes what the sub-agent tools already report; it
never resumes a child, never writes to a running process, and writes nothing to disk.

### Why it needs no session files

The parent session JSONL already stores each sub-agent's *entire* transcript in the
tool result's `details.messages` — thinking blocks included (measured: librarian 114
messages / 57 thinking, oracle 64/7, delegate 193/49). So history survives for all
five agent tools even though only `delegate` persists its own session.

### Why the registry is fed by events, not a shared module

pi loads every extension file with its own jiti instance and `moduleCache: false`
(`dist/core/extensions/loader.js`). A module-level `Map` in `tools/lib/` is therefore
**not the same Map** when imported from another extension — it reads empty, silently,
with no error. `registry.ts` is fed by `pi.on("tool_execution_start"/"update"/"end")`,
which cross the boundary carrying the tool's full `details` payload. Do not "simplify"
this into a shared module.

### Layout

| File | Purpose |
|------|---------|
| `index.ts` | extension entry — events, shortcut, `/subagents`, overlay |
| `registry.ts` | tracks runs from tool events (pure, tested) |
| `transcript.ts` | `Message[]` → transcript nodes incl. thinking (pure, tested) |
| `inspector.ts` | the overlay component — list + scrollable detail |
| `types.ts` | shared types |
| `registry.test.ts`, `transcript.test.ts` | 28 unit tests, no pi deps |

`inspector.ts` imports `@mariozechner/*`, which only resolve through pi's jiti
aliases — so it is not unit-testable under bare `bun test`. It is covered instead by
a render harness (real session data, 5 widths × 2 themes × every scroll position,
asserting no line exceeds the width) and by pty tests driving a real pi.

**Rendering contract:** the detail view is built from pi's own `Markdown`/`Text`/
`TruncatedText` components inside a `Container`, so a sub-agent's transcript looks
like the parent agent's transcript rather than a dialog. Source text is passed
through `normalizeForDisplay()` first, and every emitted row is truncated to the
render width and then padded back out to it: each view emits exactly
terminal-height × full-width rows so the overlay fully occludes the conversation
instead of interleaving with it. One over-wide row re-opens the TUI smear class
documented above. `getMarkdownTheme()` throws before `initTheme()`, so it is
wrapped — a throw inside `render()` would take the TUI down.

**No core patches.** Pure extension API (`pi.on`, `registerShortcut`,
`registerCommand`, `ctx.ui.custom`). Deployed by `install.sh`'s `cp -R extensions`.
Mouse click-to-open is *not* possible: pi never enables mouse tracking and no pi-tui
component knows its screen position (see the research notes in the port log).

---

## Extensions (13 active)

All live in `~/.pi/agent/extensions/`, backed up in `pi-setup/extensions/`.

| Extension | File | Purpose |
|-----------|------|---------|
| System Prompt | `system-prompt.ts` | Loads `prompt.amp.system.md` for parent sessions; sub-agents get a generated prompt listing only their own `--tools` allowlist (see "Sub-agent Prompts") |
| Mentions | `mentions.ts` | @mention resolution (sessions, commits) + agent directives (@oracle, @finder, @codereview, @task, @chad) |
| Session Name | `session-name.ts` | Auto session naming |
| Session Breakdown | `session-breakdown.ts` | `/session-breakdown` analytics command |
| Notify | `notify.ts` | Desktop notifications via OSC 777 |
| Todos | `todos.ts` | File-based todo manager with TUI |
| MD Export | `md-export.ts` | `/md` — session JSONL → markdown export (clipboard or file) |
| Command Palette | `command-palette/` | Ctrl+Shift+P overlay |
| Editor | `editor/` | Custom box-drawing editor |
| DeepSeek Peak | `deepseek-peak/` | `/deepseek` + live peak/off-peak pricing clock in the editor's bottom-left border |
| Subagent Inspector | `subagent-inspector/` | Ctrl+Shift+A / `/subagents` — drill into a sub-agent's live transcript |
| Tools | `tools/` | 29 custom tools (see below) |
| Local Model | `local-model.ts` | `/local` — start/stop the llama.cpp router; injects local-model rules ONLY for `llama-local` |

**Note:** pi auto-discovers every `.ts` file in `extensions/` — there is no "present but disabled" state. To disable an extension, delete it or move it out of `extensions/`. `kimi-code-token.mjs` also lives here but is a helper script (called by the `kimi-code` provider), not a loaded extension. The 2026-07-23 cleanup deleted the former disabled extensions (handoff, brain-loader, opencode-zen, commandcode, pi-vcc-config) and `btw.ts` / `crof.ts` / `import-opencode.ts` entirely — recover from git if ever needed. (`local-model.ts` was later rebuilt as the `/local` command — see Local Models.)

---

## Custom Tools (29)

**Count note (corrected 2026-08-05):** this section said "24" for a long time while
`index.ts` registered more. `github.ts` alone registers **seven** tools, not one, and
`agent_message` registers via `setupAgentMessage(pi)` rather than a `registerTool` line.
The real figure is **29** (28 `pi.registerTool` calls + `agent_message`), of which
`web_search` is conditional — it is skipped entirely when its config disables it, so a
given session shows 26 or 27.

All live in `~/.pi/agent/extensions/tools/`, backed up in `pi-setup/extensions/tools/`.

### Tool Replacements (override pi built-ins)

These replace pi's default tool implementations with customized versions:

| Tool | File | Customization |
|------|------|---------------|
| **bash** | `bash.ts` | Git trailer injection, mutex locking for git commands, psst secret injection into subprocess env, output scrubbing. **`timeout` is REQUIRED (1–600s) and a command silent for 300s is killed regardless of it** — see "Command Time Bounds". Multi-line commands render in full on `ctrl+o` — see "The bash call header" |
| **read** | `read.ts` | Image viewing, fitted to the vision budget via `lib/image-fit.ts` (falls back to raw bytes on any failure) |
| **apply_patch** | `apply-patch.ts` | The ONLY file-mutation tool. **Four call shapes, one engine** (see below): `{path, content}`, `{path, old_string, new_string}`, `{ops:[…]}`, `{input: envelope}`. Multi-file atomic batching, mutex locking, undo tracking. Replaced `edit-file.ts` + `create-file.ts` in `6296fef`; pi's native `edit`/`write` are hidden at `session_start` |
| **format_file** | `format-file.ts` | Prettier/biome formatting |
| **grep** | `grep.ts` | Custom output formatting |
| **find** | `glob.ts` | Custom result handling (registers as `find`, shadowing pi's built-in — there is no tool named `glob`) |
| **ls** | `ls.ts` | Delegates to read tool |
| **undo_edit** | `undo-edit.ts` | Edit reversal with diff display. Reverts the WHOLE tool call by default (`scope: "file"` for one path); a move is undone as one operation. Refuses when a file was changed outside the tool, since those bytes are recorded nowhere (`force: true` overrides, and says what it discarded) |
| **redo_edit** | `undo-edit.ts` | Re-applies an undone change. Refuses when a newer tool change touched the path, and (like undo) when the file was changed outside the tool — `force: true` overrides and says what it discarded |
| **skill** | `skill.ts` | Skill loading |

### New Tools (not in default pi)

> **apply_patch's four lanes — read before changing its schema.**
> See the section "apply_patch: strict on disk, loose on the wire" below.


| Tool | File | Purpose |
|------|------|---------|
| **screenshot** | `screenshot.ts` | macOS capture (display / window / region) that returns an image already inside Claude's vision budget. See "Screenshot & Vision Budget" below |
| **finder** | `finder.ts` | Concept-based search subagent — chain 3+ searches or search by concept |
| **oracle** | `oracle.ts` | Architecture review, hard multi-file bugs, complex planning (read/grep/find/ls + bash + screenshot, web_search, read_web_page) |
| **delegate** | `delegate.ts` | Spawns a resumable subagent (same model as parent) for parallel independent work. Replaced `task.ts` in `e4c8786` — `continueId` makes children resumable, which Task never was |
| **chad** | `chad.ts` | Read-only deep research subagent, **pinned** to `deepseek/deepseek-v4-flash` at thinking `high` whatever the parent runs. Cheap enough to launch in swarms. No mutation tool at all, and its bash runs under `lib/read-only-bash.ts`. See "chad" below |
| **librarian** | `librarian.ts` | External repository exploration via GitHub API |
| **agent_message** | `agent-message.ts` | Inter-agent mailbox messaging. Registered via `setupAgentMessage(pi)`, not a plain `registerTool` |
| **web_search** | `web-search.ts` | Parallel AI Search API. **Conditionally registered** — if its config disables it, nothing is registered rather than advertising a tool that cannot run |
| **read_web_page** | `read-web-page.ts` | Web page reader using cheerio |
| **read_session** | `read-session.ts` | Read past pi session history |
| **search_sessions** | `search-sessions.ts` | Search session history by keyword, file, date |
| **code_review** | `code-review.ts` | Code review with diff analysis |
| **read_github**, **search_github**, **list_directory_github**, **list_repositories**, **glob_github**, **commit_search**, **diff** | `github.ts` | **Seven** tools, not one — there is no tool named `github` |

**Web search:** `pi-web-access` was removed 2026-07-30 (see Packages). Phase 3 landed the
self-contained Parallel AI `web_search` (`web-search.ts`), so the gap that note used to
describe is closed. Page reading is covered by our own `read_web_page` tool.

### chad — read-only research, pinned to deepseek, built to swarm

**Added 2026-08-13.** Files: `chad.ts`, `lib/read-only-bash.ts`, `agents/agent.amp.chad.md`,
`chad.test.ts`, `lib/read-only-bash.test.ts`, `lib/pi-spawn.test.ts` (new), plus
`pinModel`/`thinkingLevel`/`readOnlyBash` on `PiSpawnConfig`.

`chad` is `delegate`'s read-only counterpart. One question per call, five or
eight calls in one message, each returning a report instead of a pile of file
contents. Verified in `pi-agent-core/dist/agent-loop.js` (`executeToolCallsParallel`):
tool calls from one assistant message really do run under a single `Promise.all`,
so a swarm is concurrent rather than a queue.

#### The model is the tool, so it is pinned

`piSpawn` overwrites `config.model` with the parent's model whenever the parent
provider is not anthropic — that rule exists because finder/oracle/librarian name
claude models a kimi or sakana session cannot serve. Applied to chad it is
backwards: deepseek-v4-flash is self-sufficient on its own key, and it is
**why the tool exists** ($0.14/$0.28 per M, 1M context — roughly 35× cheaper
input than opus, which is what makes eight at once reasonable). A chad launched
from a kimi session would silently become a kimi agent: same output shape, wrong
agent, no error anywhere.

**Those figures change on 2026-08-16 at 16:00 UTC.** The new V4 card is
$0.22/$0.66 per M off-peak and **$0.44/$1.32 during peak** (01:00–04:00 and
06:00–10:00 UTC = 06:30–09:30 and 11:30–15:30 IST) — so a peak-hour swarm costs
**~4.7× more output** than the number above. The tool is still much cheaper than
opus and the pin is still right; but "cheap enough to swarm" is now
time-dependent. `/deepseek` (see the DeepSeek Peak/Off-Peak Clock section)
answers which side of that line the clock is on.

Hence `pinModel: true` — an explicit flag, not the tempting alternative of
"just don't pass `parentModel`". Absence is not testable and not readable; the
next person adding `parentModel` "for consistency" breaks it silently. The
sabotage check makes the difference concrete: with the pin disabled, the
anthropic-parent test still **passes** (because `qualifyModel` leaves a slashed
id alone) and only the non-anthropic test fails. Absence would have looked
correct in exactly the case it isn't.

`thinkingLevel` is its own `--thinking` flag rather than a `model:high` suffix,
so the pin doesn't live inside a string. pi applies `--thinking` after every
other source (`main.js` `buildSessionOptions`), so it always wins.

#### Read-only is enforced, not requested

Removing `apply_patch` is **half** a constraint — bash writes. `readOnlyBash: true`
sets `PI_BASH_READ_ONLY=1`, and the child's own `bash.ts` both advertises the
policy in its description and enforces it in `execute()`.

`lib/read-only-bash.ts` is an **allowlist**, deliberately. A denylist on a shell
is unwinnable (`python3 -c`, `perl -pi`, `ed`, `dd`, `tee`, `find -exec`,
heredocs, and every binary nobody thought of), and `permissions.json` already
records five separate bypasses of a naive `rm *` glob. An allowlist fails closed:
an unlisted command is refused *and named*, so a gap shows up as a refusal rather
than as a write. ~60 read commands, git gated per-subcommand, plus a quote-aware
scanner for separators, `$( )`, backticks and redirection.

**The name of a command is not a capability, and believing otherwise cost two
rounds of fixes.** The first version allowlisted by name and stopped there.
Attacking it found eight commands on the list that write files or run other
commands through their own flags — `sort -o`, `base64 -o`, `tree -o`, `yq -i`,
`uniq IN OUT`, `xxd IN OUT`, `rg --pre`, `fd -x` — plus `sed`'s `w FILE` script
command and `awk`'s `system()`. **`awk`, `gawk` and `mawk` were removed
outright**: guarding an interpreter's redirects while leaving `system()` open is
a guard that only looks like one, and excluding `perl -e` while allowing
`awk 'BEGIN{system(...)}'` was incoherent. Hence `WRITE_FLAGS` and
`POSITIONAL_OUTPUT` — anything added to the allowlist must be checked for an
output flag, an exec flag, and a positional output operand.

**`code_review` then found the one that mattered most, which I had missed:
command substitution inside DOUBLE quotes.** The scanner's quote branch ran
before its `$(`/backtick detection, so `echo "$(rm f)"` was invisible — and bash
does **not** suppress substitution inside `"`, only inside `'`. That needed no
special flag, so every allowlisted command taking a quoted argument was a way
through: a worse hole than all eight flag vectors combined. It also found
`man -P CMD` (man's pager is **not** tty-gated, unlike git's, so it fires with
stdout piped — verified), `git symbolic-ref HEAD <ref>` (two bare operands
repoint HEAD, which the flag checks cannot see) and `git reflog delete/expire`
(prunes the history a human would recover from).

Every one of those twelve was **verified by running it** — the harness executes
each command outside the guard and asserts the file really appeared, so the
tests assert against the shell rather than against my belief about the shell.
The fixes preserve the false-positive direction too: single-quoted `$( )`,
`git symbolic-ref HEAD` and bare `git reflog` all still pass.

Details that look fussy and are not:

- **Quote tracking runs in both directions.** `grep "a > b" f` must not read as a
  redirect, or the guard gets switched off and then guards nothing. But an
  UNQUOTED `rg x->y .` **is** refused, and that is correct: bash itself parses it
  as a redirect into `y`. And `"` is not `'`: substitution is live inside double
  quotes and inert inside single ones, so the two are treated differently.
- **`>/dev/null` and `2>&1` are allowed.** Every real command line uses them, and
  neither stores anything. `>&file` is a write and is refused.
- **`bareIsRead` is per git subcommand, not a default.** Bare `git remote` lists
  remotes; bare `git stash` PUSHES and changes the working tree.
- **`git diff --output=<file>` writes a file**, so `--output` is refused on every
  git subcommand including the read ones.
- **A flag's VALUE is not an operand.** `xxd -l 64 f` is one file and a length;
  counting `64` as a second file would refuse an ordinary read, and a guard that
  fires on harmless things is one you learn to force without reading.
- **Accepted holes, stated rather than hidden:** any allowed binary talked into
  writing by a flag form not yet listed — the same class as the twelve above, so
  the list is a living one. This is a guardrail on our own agent, not a sandbox
  — the same disclaimer `lib/permissions.ts` carries. A real boundary would be
  `sandbox-exec` with `deny file-write*`, which is a different change with
  different risks and has **not** been tested on this macOS version.

#### Tool surface, and why each exclusion

15 tools: `read grep find ls bash skill web_search read_web_page` + the seven
github tools.

- **No `apply_patch`/`format_file`/`undo_edit`** — the point.
- **No `screenshot`** — deepseek is `input: ["text"]`, and pi-ai's
  `transform-messages.js` `downgradeUnsupportedImages()` swaps images for
  `(tool image omitted)`. It would be a tool that can never return anything the
  agent can read.
- **No `oracle`/`finder`/`librarian`** — a child of a chad inherits deepseek (the
  same inheritance rule above), so a nested oracle is deepseek talking to itself
  at process-spawn cost. The **seven github tools are included directly** for
  that reason: nesting a librarian would spawn a whole process to reach tools
  chad can call itself, and schema weight on a $0.14/M model is fractions of a
  cent.
- **No `chad`/`delegate`** — a swarm that spawns swarms is a fork bomb.

`collectSubAgentImages` is also deliberately **not** used. A chad that opens a
PNG sees a placeholder, but the pixels would still reach the *parent*, which can
see them — an expensive image arriving with no comment on it, because the agent
that fetched it was blind.

#### The sub-agent spawn graph is acyclic, and now pinned

Measured across all six allowlists, there is exactly **one** agent→agent edge:

```
delegate ──> finder ──> (nothing)
oracle, code_review, librarian, chad ──> (nothing)
```

No cycles, max nesting two levels below the parent. (`read_web_page` with a
`prompt` and `read_session` also spawn a child, but it gets exactly one tool, so
it terminates.)

**A cycle here would not merely recurse, it would multiply.** chad is built to be
launched eight at a time; a chad that could spawn chads is 64 processes at depth
2 and 512 at depth 3, each with its own context and its own bill, while the
parent sees one tool call sitting there. That is why `chad`'s allowlist excludes
both `chad` and `delegate`.

Until now that property was guaranteed by nothing but six hand-written constants
— one name added to one array breaks it, and the damage shows up as a stalled
session rather than an error. `tool-contract.test.ts` now asserts: no agent
appears in its own allowlist, no cycle is reachable from any agent, depth ≤ 2,
and the edge set is exactly `["delegate -> finder"]`. That last one is stated
literally so a change to the graph's shape has to be acknowledged rather than
silently satisfying the generic checks. Verified by sabotage: adding `chad` and
`delegate` to chad's own list fails all four.

#### chad vs oracle — the boundary is drawn in both directions, deliberately

They overlap on "go look at the code", and the first version of the docs drew the
boundary on **one side only**: chad's description said "architecture judgement →
use oracle", while oracle's still advertised *"finding difficult bugs across many
files"*, which reads exactly like a chad job. An asymmetric hint is worse than
none — it routes to whichever description the model happened to weigh, and the
failure is invisible because both tools return something plausible.

The distinction is not the model. It is what you get back, and the two agent
prompts give **opposite instructions on the same axis**:

| | `oracle` | `chad` |
|---|---|---|
| deliverable | a verdict — one recommendation + trade-offs + effort | evidence — cited, with verified/inferred split and Gaps |
| exploration | *"use tools only when they materially improve accuracy"* — deliberately shallow | 8+ parallel calls every turn, exhaustive when completeness is implied |
| bash | unrestricted (can run your build) | allowlist, writes refused |
| shape of use | one question, one strong answer | many questions at once |

So: hard part is *finding out* → swarm chads. Hard part is *deciding* → oracle.
Both → chads first, then their findings into oracle's `context`, which is cheaper
and better than making the oracle excavate when it is instructed not to.

`tool-contract.test.ts` pins the symmetry: each description must name the other,
and each must state what it returns.

**Honest caveat, recorded because it is easy to forget:** on a NON-anthropic
parent, `oracle` inherits the parent model (see the sub-agent model table), so
its opus advantage disappears and the two converge toward prompt-and-tools only.
chad is then the more predictable of the pair, because it is the one that is
pinned.

#### Other decisions worth not re-litigating

- **A `scope` parameter was designed and then cut.** It existed to divide
  write-ownership between concurrent agents. Nothing writes, so it would have
  been a required field that did nothing. (The hazard it addressed is real for
  `delegate`: `lib/mutex.ts` is a module-level Map, so it does not span
  processes. Read-only sidesteps it entirely rather than solving it.)
- **`DEEPSEEK_API_KEY` is preflighted** before spawning. In a swarm, eight
  children each taking ~10s to die on the same missing key is eight confusing
  errors instead of one clear one, and the pi-side message reads like a model
  failure.
- **Sessions persist to `SUB_AGENT_SESSION_DIR`** like delegate, so a chad is
  resumable via `continueId` without cluttering `/resume`.

#### Verified

`lib/read-only-bash.test.ts` — 177 tests: every bypass form `permissions.json`
was historically beaten by (`echo hi;rm f`, `for f in *; do rm $f; done`,
`find . -exec rm {} +`, `xargs rm < list`, `$(rm f)`, backticks, `{ rm f; }`),
all twelve vectors found by attacking it and by review, both redirection
directions, `sed -i`/`w`/`e` spellings, git read-vs-write across 60 command
forms, and the quoted false positives that would make the guard unusable.

`lib/pi-spawn.test.ts` — **new**, and the first test of what the child is
actually launched with. It runs the real `piSpawn` against a stub `pi` that
records its argv, because AGENTS.md's own update workflow says an import-level
audit cannot see a change in the flags we pass (that is how pi 0.84 #7327 took
out every sub-agent while unit tests stayed green).

Live end-to-end, from a deliberately **kimi-code** parent (the case the pin
exists for): model on the wire came back `deepseek-v4-flash`, 11 turns, $0.027,
106s, correct report format, and it declined to run a concurrency harness
*because* the session was read-only. Two of its citations were spot-checked
against the files and were exact.

Full suite: **1453 pass / 0 fail**.

### apply_patch: strict on disk, loose on the wire

**Changed 2026-08-12.** Files: `apply-patch.ts`, `lib/codex-patch.ts`,
`lib/sub-agent-render.ts`, `apply-patch-lanes.test.ts` (new, 299 cases),
`agents/prompt.amp.system.md`.

#### The problem it fixes

`apply_patch` took exactly one required string: OpenAI's **V4A envelope**. That
format is not neutral — OpenAI's own guide says the model "has been extensively
trained" on it and Codex's says "use our exact implementation as the model has
been trained to excel at this diff format". Warp's writeup states the split
plainly: *"many LLMs are trained on string-replacement-based editing tools;
GPT-family models have been trained with V4A."* Our lark grammar is a copy of
`codex-rs/.../tool_apply_patch.lark`.

So the setup ran **every** file change through a competitor's post-training
artifact while the default model was Claude. Measured consequences were already
in the port log: haiku burned 15 consecutive failed calls, `deepseek-v4-flash`
produced a valid envelope expressing the wrong intent, and there was **no
whole-file write at all**, so replacing a file meant Delete + Add.

#### The shape now

Four call shapes, one engine. Every lane goes through the same
`evaluatePermission` → `withMutationQueues` → `withFileLocks` → snapshot →
in-memory apply → commit-or-rollback → `saveChanges` path, so a new lane can
never add a way around a guard:

| lane | shape |
|---|---|
| write | `{ path, content }` — create or replace outright |
| edit | `{ path, old_string, new_string, replace_all? }` |
| batch | `{ ops: [ … ] }` — several files, all-or-nothing |
| envelope | `{ input: "*** Begin Patch …" }` — multi-hunk, or pasted |

`normalizeCall()` picks the lane at runtime and **refuses rather than resolves**
any call that reads as two lanes at once. Key aliases are accepted (`file_path`,
`contents`, `oldText`, `old_str`, …) because a key that is merely *named*
differently is unambiguous; a key that changes the *operation* is never inferred
across lanes.

#### Things that are not obvious and cost real debugging

- **`constrainedSampling` was REMOVED, not disabled.** pi-ai's
  `inferGrammarInputProperty` requires exactly one required string property,
  which four optional lanes cannot satisfy, and
  `resolveGrammarConstrainedSampling` **throws** rather than degrading — killing
  the whole turn on an OpenAI model while every Anthropic test stays green. It
  only ever applied to OpenAI-family providers, i.e. the one family that emits
  V4A correctly unaided. `apply-patch.test.ts` guards this in **both**
  directions.
- **Every schema field is optional, and that is forced.** pi validates arguments
  against the schema *before* `execute()` (`pi-ai validateToolArguments`), so a
  required field is a hard wall against the other three lanes. The cost is that
  malformed calls are caught one layer later, which is why every refusal ends
  with the menu of accepted shapes.
- **`edits` is an ops key, and a top-level `path` is inherited by entries that
  lack one.** That is exactly pi's own native edit shape
  (`{path, edits:[{oldText,newText}]}`) and Claude Code's MultiEdit
  (`{file_path, edits:[{old_string,new_string}]}`) — the single most likely
  thing a Claude-family model emits. Without inheritance it lands as
  "ops[0]: no file path".
- **A key that *means* patch is never rescued as content.** `{path, diff:
  "-old\n+new"}` is a model fumbling a patch; writing those two lines into the
  file would destroy it and report success. Only the generic key `input` can be
  rescued into a write, and only when it does not look like a patch attempt.
- **A bare `target` is not a path alias** (cursor's `target_file` is). It reads
  as a move *destination* at least as naturally as a source, and a path alias
  that can be misread writes the wrong file.
- **`type` and `command` are not op aliases.** They are generic enough to arrive
  carrying something that is not an operation (`type: "text/plain"`), and an
  unrecognised op is a hard error — so accepting them turns a valid write into
  "unknown op".
- **A field the chosen op ignores is a refusal, not a no-op.** `{op:"delete",
  path, content}` reads as two intentions; carrying on deletes a file the caller
  was trying to rewrite.
- **A move refuses to clobber an existing destination**, mirroring `add`. The
  envelope's `*** Move to:` never had this guard; it did not matter much when a
  move cost a whole extra header line, but `{path, to}` makes it two fields.
  `git mv` refuses this too.
- **A rename no longer rewrites bytes.** Applying zero hunks used to run the
  applier anyway, which appends a trailing newline.
- **The redaction guard now compares against the real file** for a whole-file
  write, so rewriting a file that legitimately contains "… rest unchanged" is
  allowed while introducing one is not. (It caught its own test fixture during
  development; the fixture is built at runtime for that reason.)

#### Parser tolerance (`lib/codex-patch.ts`)

Accepted now: `*** Begin Patch ***`, `** begin patch`, odd spacing/case, prose
around the envelope, `<<EOF` heredocs with or without a leading command, git's
`@@ -1,3 +1,3 @@` numbers, header aliases (Create/New/Remove/Edit/Modify/Change/
Write/Replace File, Rename to), an Add block with **no** `+` prefixes, and bare
blank lines inside a `+` block.

Two rules that look arbitrary and are not:

- **A numbered hunk header is git's, hint included.** `@@ -1,1 +1,1 @@ someFn`
  drops `someFn` too. In V4A `@@ foo` is a *required* anchor that must match a
  line exactly, whereas git's hint is a truncated label for the enclosing scope
  — promoting it turns a working patch into "failed to find context 'someFn'".
- **A patch with no end marker at all is still an error.** A patch truncated
  mid-generation looks exactly like one whose author forgot the marker, and
  guessing turns a dropped stream into a half-written file. *Honest limit:* the
  envelope ends at the LAST end-marker line and `isEndLine` trims, so a hunk's
  context line ` *** End Patch` is indistinguishable from a real terminator if
  the stream is cut off right after it. Upstream had the identical hole (its
  last-line check also trimmed — verified, not assumed), and closing it would
  break the marker padding that `codex-patch.test.ts` requires.
- **An UNPREFIXED Add/Write body containing a marker-shaped line is refused.**
  This is the one truncation case that *could* be closed, and it was a real
  regression from accepting unprefixed blocks: because the envelope ends at the
  last end-marker anywhere in the text, a file documenting this very format came
  back **missing its last line, reported as success**. `+` prefixes and the
  explicit `*** Content` block both make content unmistakable and are
  unaffected, as is `{path, content}`.
- **A header is only a header at column 0.** `matchHeader` trims the end of a
  line but never the start, so ` *** Update File: x` stays content. Only the
  top-level dispatch, where no chunk is open, tolerates indentation. Two tests
  pin this.

#### Two defects found by grok-4.5 stress-testing (2026-08-12)

Both were real, both are fixed, and both were **pre-existing mechanisms that the
new lanes made far easier to reach** — worth stating plainly, because the
tempting reading is "the rewrite broke it".

- **Nested indentation was translated between tabs and spaces.** `reindentToFile`
  fixes the OUTER level by construction (it prepends the file's own indent) but
  deeper levels kept the patch's character, so a tab-indented file patched with
  space-indented text came back as `\t  return 2;`. Silent byte corruption, and
  outright breakage in a Makefile (where a tab is syntax) or mixed-indent Python.
  It now **refuses** when the shift would mix the two, because repairing it needs
  the file's indent *width*, which is a guess. The safe case — same character,
  different depth — is unaffected, and that is the case the fuzzy tier exists for.
  His stronger claim, that matching normalises tabs→spaces generally, does **not**
  hold: a uniform-depth Makefile hunk keeps its tabs, verified.
- **Undoing a move lost or duplicated the file.** A move is one logical operation
  recorded as TWO path histories (delete source + create destination), and
  `undo_edit` takes a single path — so undoing the destination removed the file
  from both places, and undoing the source left it in two. He reproduced the data
  loss with content named `gold-bar-do-not-lose`. `findMovePartner` now pairs the
  two halves and `undo_edit` reverts both. The pairing rule demands **exactly one**
  deletion and **one** creation in that tool call with **identical bytes**, so a
  batch that moves one file and deletes another cannot pair them by accident;
  when it is ambiguous it pairs nothing and undoes only what was asked.

A third fix came out of the first: `applyEdit` swallowed the fallback applier's
error to write a better "not found" message, which also swallowed *ambiguity* and
*indentation* diagnoses. It now swallows only `failed to find` — an allow-list of
what to hide, so a newly added diagnosis surfaces by default.

#### Round two — he re-tested and found the first fixes incomplete

- **The indent guard had a hole, and it was the Makefile case.** The check lived
  inside `reindentToFile`, which **returns early when the first line's indent
  already matches** — so a hunk anchored at column 0 (`build:`) skipped every
  check and the tab-indented recipe under it was rewritten with spaces. No
  mixing, so the mix-detector never fired. The guard now proves the shift
  against the file's own lines: apply the same transformation to the OLD lines
  and require it to reproduce what is actually on disk. If it cannot rebuild the
  lines it was derived from, it does not get applied to the new ones. Both
  legitimate rescues (uniform depth across tab/space, and same-character
  different-depth) still work — there are tests for each.
- **Move pairing is now RECORDED, not inferred.** `FileChange.movePartnerUri` is
  written by `apply_patch` at the moment it performs the move, so the reader
  never guesses. That kills the case that beat the heuristic: a batch that moves
  x→z *and* deletes y where x and y hold identical bytes. Legacy records without
  the field still fall back to byte matching, and when that is undecidable
  `undo_edit` now **says so** and names the candidates — previously it said
  nothing, which is what made a recoverable state look like data loss. (That
  silence was also a documentation error on my part: I claimed it warned.)
- **Undo is now per-tool-call by default**, with `scope: "file"` to opt out. The
  records were always grouped by tool call on disk; only the reader was
  per-path. This also makes the move case correct *by construction* rather than
  by pairing — both halves are in the same call.
- **`redo_edit` exists.** Every record already stored both `before` and `after`,
  so re-applying was never the hard part; the hard part is invalidation, and
  redo **refuses** when any later still-applied change touched the path. Getting
  that wrong is worse than having no redo, which is why there wasn't one.
- **Ambiguity errors now show the line at each match**, not just its number.

Verified live end-to-end in one session: a 2-file `ops` batch, one `undo_edit`
reverting both, one `redo_edit` re-applying both. Note that undo/redo are scoped
to the current session branch by design — a redo cannot reach an undo performed
by a different pi process.

#### Round three — undo is a stack, not random access

His last finding was labelled "not a bug, mild edge", and it was worth fixing
anyway: create A and C in one batch, later move A elsewhere, then undo the create
batch. Undoing a creation means "delete it" — but A is not there any more, so the
delete is a no-op and the content lives on at the move destination with its
creation history marked undone. No data loss, but a state nobody can reason
about, and incoherent is how data loss starts.

`undo_edit` now **refuses when a later still-applied change touches any path the
undo would revert**, and names what to undo first. That is the same invalidation
rule `redo_edit` already used, pointed the other way, so the two agree on what
"newer" means. Independent work is unaffected — editing A then B leaves no later
change on A, so undoing A is still allowed, and there is a test for exactly that.

**A real bug surfaced while testing it: ordering came from `Date.now()`.** That is
millisecond-resolution, so two tool calls in quick succession carry the SAME
timestamp and a strictly-greater comparison reads them as concurrent — the guard
silently let the undo through. Both undo and redo now order by **position in
`activeIds`**, which is the branch in order and monotonic by construction. Any
future ordering check here should use the branch, never the clock.

**Testing that guard exposed a second bug: redo popped the WRONG END of the
stack.** `findRedoCandidate` scanned the branch newest-first, so with L1→L2→L3
undone twice down to L1, one redo jumped straight to L3 — skipping the middle
step and printing the diff as `-L2 +L3` while the file held L1. Single-step redo
passed and hid it, which is why the original tests missed it. Because undo now
refuses to reach past a newer change, the undone changes for a path are always a
contiguous run at the top of the stack, so redo must take the **oldest** of that
run: the step the file would take next. Verified by flipping the scan direction
back and watching the new test fail.

#### Round four — undo now looks at the file before overwriting it

The last item he raised, and the one he ranked lowest: `revertChange` writes its
remembered copy back **unconditionally**, never checking the file still holds
what the tool left there. So anything written since by a non-recording writer —
`bash`, `format_file`, another editor — is overwritten without a word.

It deserved more than "tiny edge", for a reason the ranking missed: **every other
undo is itself undoable from these records, and this one is not.** Those outside
bytes were never photocopied by anything; they exist in the file and nowhere
else. It is the only remaining way this tool can destroy something unrecoverable.
It is also more reachable here than he assumed: `format_file` and `bash` record
nothing, so `apply_patch → format_file → undo_edit` already exposes it.

`matchesRecordedState()` (in `lib/file-tracker.ts`) answers "is this file exactly
as we left it"; `undo_edit` checks every change it is about to revert and
refuses, naming the files, with `force: true` to override.

Deliberately a **notice, not a wall**. It is silent whenever the file is
untouched, which is nearly always — a check that fires on harmless things is one
you learn to force without reading, and then it guards nothing. One drifted file
blocks the whole batch (undoing the clean half would leave a state neither the
caller nor the records describe), and a **forced** undo appends what it
discarded, since the diff describes only the tool's own change and would
otherwise leave the one unrecoverable act with no trace in its own output. That
last part was raised by a sub-agent while testing the guard live.

Verified by sabotage: stubbing `matchesRecordedState` to always return true fails
exactly the three drift tests and nothing else. Verified live in one session —
edit, `python3` append, undo → refused; the same with `force: true` → undone,
with the discard note.

While confirming the check could not false-positive, `allPaths` was verified to
be a `Set`, so **one record per path per tool call**. Two comments claiming a
batch "may write the same path more than once" were wrong and the sorts they
justified are gone.

#### Round five — the same guard, on redo

The undo guard was justified in round four with the claim that "`redo_edit` had
guarded exactly this since it was written". **That was wrong, and the wrongness
was load-bearing:** redo's check reads the *records*, looking for a newer change
this tool made. A shell command records nothing, so it is invisible to it. The
whole scenario survived the fix that was supposed to be about it —
`v1 → v2 → undo → v1`, shell writes `v1-HACKED`, redo silently restores `v2`.
Caught by grok-4.5 immediately after round four.

`matchesRecordedState(change, side)` now takes which copy the file should be
holding: `after` for undo (what the tool wrote), `before` for redo (what the undo
restored). Redo gained the identical refusal, `force`, and discard note. Both
existence fields fall back the way `revertChange` does, so old records behave.

Redo keeps **both** checks. The records check gives the more useful message when
the newer writer was this tool ("make the change again instead"), and the disk
check catches everything else.

Two lessons, both cheap to state and expensive to relearn:

- **Do not cite a guard without reading it.** The claim was plausible, written in
  a code comment, and repeated into the docs, where it would have justified never
  looking again.
- **A symmetric mechanism needs symmetric tests.** The round-four suite proved
  undo refused, forced, and reported — and every one of those tests passed with
  redo wide open. The sabotage harness now takes a side
  (`PI_DRIFT_SABOTAGE=before|after`) and each disables exactly its own tests,
  which is the property that was missing.

Verified live: edit → undo → `python3` overwrite → redo refused, `v1-HACKED`
intact.

His other two remaining items are correctly left alone: unique `old_string` is
the safety property (the error now shows the line at each match, which was the
real friction), and separate `undo_edit`/`redo_edit` tools are clearer than one
tool with a direction flag.

#### Verified

**1167 real tool calls** across the lane suite (seeded fuzz: 300 edit
round-trips, 200 write round-trips, 200 wrapped envelopes, 150 forced-failure
batches asserting nothing was written; plus generated alias matrices and
`undo_edit` coverage for every lane), alongside the original disk-contract and
parser tests. Full suite **1177 pass / 0 fail**.

A `code_review` pass over the diff found three real defects, all fixed above:
the unprefixed-marker truncation, the move clobber, and a silently-dropped `to`
on a write. It also claimed the leading-space end-marker hole was a regression;
that was checked against the old code and **was not** — the pre-existing
behaviour is identical, so the claim was recorded rather than acted on. Verify
each claim against the code before acting (§3.8 of the port log).

Live, same task (one span edit + one whole-file replace), fixtures reset per run:

| model | result | lanes used |
|---|---|---|
| `anthropic/claude-opus-5` | correct | `batch(2)` — one atomic call |
| `kimi-code/kimi-for-coding:high` | correct | `edit(1)`, `write(1)` |
| `deepseek/deepseek-v4-pro` | correct | `edit(1)`, `write(1)` |
| `deepseek/deepseek-v4-flash` | correct | `edit(1)`, `write(1)` |

**No model used the envelope**, and `deepseek-v4-flash` — recorded as *wrong* in
the pre-change matrix (§3.9 of the port log) — is now correct. Set
`PI_APPLY_PATCH_METRICS=1` to append `{lane, files}` per call to
`~/.pi/apply-patch-lanes.jsonl`; it is off by default because a tool that writes
to the home directory as a side effect of being called is a surprise.

## Command Time Bounds — nothing runs unbounded (added 2026-08-14)

**Files:** `bash.ts`, `lib/pi-spawn.ts`, `lib/watchdog.ts` (new),
`lib/proc-cpu.ts` (new), plus `bash-timeout.test.ts` (54), `lib/watchdog.test.ts`
(16), `lib/proc-cpu.test.ts` (11), `lib/pi-spawn.test.ts` (+15).

### The incident

A `delegate` launched at 03:03 ran a `vitest` command that finished its work in
**3 seconds**, printed its complete summary, and then **failed to exit for 2h22m**
(8,555s). Every other bash call in that session took 2–28s — a **307× outlier**.
The session was aborted at 06:25 with the work lost and $21.27 spent.

Measured across **18,681 bash calls in 325 sub-agent sessions**: 87.6% finish
under 5s, 0.20% exceed 300s, 0.064% exceed 600s, and **7.6 hours total** were
lost to 38 long calls. The `timeout` parameter already existed and was used
**0 times in 45 calls** — its entire description was `"Timeout in seconds."`,
which states no default and no consequence, so there was no reason to use it.

**This was never a missing capability. It was a missing default, and then a
missing trigger.**

### Four layers, each covering what the others structurally cannot

| | mechanism | bounds |
|---|---|---|
| **L0** | description tells the model not to pipe to `tail`/`head`/`grep` | restores streaming visibility |
| **L1** | `timeout` **required**, schema-bounded 1–600s | the declared budget |
| **L2** | **idle kill** — no output **AND no CPU** for 300s, *whatever* was declared | a corpse whose caller asked for 10 minutes |
| **L3** | **stall watchdog** in `piSpawn` — no child stdout for 900s | anything that is not bash |

Env overrides: `PI_BASH_MAX_TIMEOUT_SEC` (600), `PI_BASH_IDLE_KILL_SEC` (300,
`0` disables), `PI_SPAWN_STALL_SEC` (900, `0` disables),
`PI_BASH_CPU_LIVENESS` (`0` disables the CPU signal, falling back to
stdout-only).

### L2 is CPU-aware — the Pareto upgrade

Stdout-silence alone is too blunt: a command can do real work while printing
nothing — a silent compile, an upload, or (the case that bites) a producer
behind `| tail`, where `tail` buffers everything until the command exits so we
see **zero bytes for the whole run**. That is indistinguishable from a hang by
output alone, so real deploys got killed.

**CPU time is the discriminator.** A working process burns CPU; a
finished-but-hung one (a test runner parked on a leaked handle) burns none.
Measured, ΔCPU over a 4s window:

```
sleep 30              0.00s   quiet   (idle / hung)
yes >/dev/null        4.03s   WORKING (silent to us)
yes | tail -1000000   4.03s   WORKING (the `| tail` shape)
node print-then-hang  0.00s   quiet   (the vitest bug)
```

Each idle tick also samples the process group's cumulative CPU via
`ps -o pgid=,cputime= -ax` (~10ms, measured; `child.pid` is the group id because
the command is spawned `detached`). If CPU advanced by more than
`elapsed × CPU_ALIVE_CORE_FRACTION` (5% of a core, scale-invariant so it works
at a 10s production tick and a sub-second test tick) the command counts as
alive. Output and CPU are **OR**'d; the kill fires only when **both** are quiet.

**The invariant that makes it safe: the CPU signal can only ever KEEP a command
alive, never cause a kill.** Its sole effect on the decision is bumping
`lastOutputAt` forward, which can only push `watchdogVerdict` toward `"wait"`.
`sampleGroupCpuSeconds` returns `undefined` on any failure (no `ps`, parse
error, group already gone), and `undefined` is treated as "no signal → fall back
to stdout-only" — i.e. exactly the previous behaviour. So a bug or a missing
`ps` degrades to the old guard; it cannot make anything worse. Strictly fewer
false kills, zero new ones. The parsing half lives in `lib/proc-cpu.ts`, pure
and unit-tested; the I/O half returns `undefined` rather than throwing.

**Two residuals, both bounded by the declared timeout and NEITHER worse than the
old stdout-only guard:**
- **0-CPU remote work** — `ssh host 'long-job'` where the work runs remotely and
  the local process just holds a socket: looks idle locally, indistinguishable
  from a hung ssh. Killed at the idle window unless it prints. (stdout-only
  killed it too.)
- **A busy-*loop* hang** — spinning at 100% CPU forever reads as alive, so the
  wall-clock declared timeout catches it, not the idle kill. Correct: the idle
  kill simply never fires (safe), and L1 is the bound.

Proven live, side by side on `sh busy-deploy.sh | tail -3` (a CPU-busy step
whose output `tail` hides), 3s idle window: **without** CPU liveness → killed at
3s, deploy never finished; **with** it → ran the full 8s, deploy completed. The
`with CPU liveness DISABLED` test is a permanent built-in sabotage that fails if
the CPU check ever stops being load-bearing.

### Things that look arbitrary and are not

- **`timeout` is REQUIRED, not defaulted.** A default is a number nobody can
  justify — the session logs record only call start/end, so the idle *gap*
  needed to pick one is unmeasurable. Required deletes the question and fails
  **closed**: no path exists by which a command runs unbounded. Verified safe
  against pi 0.84.1: validation runs in `prepareToolCall` → `validateToolArguments`
  **before** `execute()`, and a failure returns as an ordinary `isError` tool
  result the loop continues from (`agent-loop.js:445-451`), costing one turn.
  Same trade `delegate.ts` already made for `prompt`.
- **Bounds live in the schema, not in a runtime clamp.** `timeout: 0` and
  `timeout: 99999` become messages the model learns from. A silent clamp teaches
  nothing.
- **No TypeBox `default`.** pi fills none — `Value.Convert` coerces types only
  (it *does* turn `"120"` into `120`), so a default would be decorative and the
  field would still arrive `undefined`.
- **Grammar-constrained sampling is unaffected.** `resolveGrammarConstrainedSampling`
  returns early unless a tool declares `constrainedSampling`, and bash does not
  (`constrained-sampling.js:64-67`). This is the trap that forced `apply_patch`
  to drop its own — it does not apply here.
- **L2 measures SILENCE, not duration.** Duration is not the defect: of the 38
  calls over 300s, roughly 30 were real work (`chat:eval`, `ui-verify`, e2e) and
  ~8 were hangs. A blanket wall-clock would have destroyed four times more work
  than it saved. A working command keeps printing; a dead one does not.
- **The idle timer runs from t=0, NOT armed after first output.** The arming
  refinement was designed and then killed by measurement: piping through
  `grep`/`tail` block-buffers everything until the upstream closes — verified,
  `(echo A; sleep 4; echo B) | grep .` emits **both** lines at t+4s — and every
  command in the incident ended in such a pipe. An armed-later timer would never
  have fired on the exact case it exists for. This is also why L0 exists.
- **Liveness is stamped on RAW chunk arrival, before sanitization.** Bytes that
  sanitize to nothing (a redrawing progress bar) still prove the process runs.
- **L3 watches raw stdout bytes, not parsed events.** `piSpawn`'s `processLine`
  deliberately ignores `tool_execution_update`/`message_update` — which are
  exactly the events that prove liveness. Measured against a real child: events
  arrive at the command's own cadence, **max gap 5.1s** over a 65s run.
- **900s is derived, not guessed.** Longest legitimate silence a healthy child
  can produce, from pi's own defaults: HTTP idle 300s
  (`DEFAULT_HTTP_IDLE_TIMEOUT_MS`), provider retry cap 60s, agent-turn backoff 8s
  (and it *emits* `auto_retry_start` before sleeping), our own bash idle 300s.
  Worst realistic ≈360s; 900s is 2.5×. **Re-check those four numbers before
  shrinking it.**
- **The machine-sleep guard is mandatory.** macOS suspends timers on lid close;
  on wake one tick would otherwise observe hours of "silence" and kill a healthy
  process at the exact moment you start watching. `watchdogVerdict` checks sleep
  **first** and it wins outright — order is load-bearing and pinned by test.
- **`watchdog.ts` is a pure function on purpose.** Both watchdogs live inside
  `setInterval` closures over live child processes, i.e. untestable. Subtle plus
  untestable is precisely how the `deepseek-peak` timer took a session down.
- **Killing is not the same as being released.** `close` fires only when the
  child exits **and** its stdio pipes close, so a grandchild that inherited
  stdout keeps the parent waiting after a successful SIGKILL. Found by the stall
  test: the watchdog fired correctly at 1s and `piSpawn` still returned at
  **60s**. `FORCE_RELEASE_MS` (10s) resolves the promise regardless, and every
  kill path — stall, user abort, and both RPC paths — arms it.
- **The release backstop is its own timer, not a phase of the watchdog interval.**
  Folding it in made the actual release land anywhere between 10s and 40s,
  because the interval's period scales with the stall window.
- **The child is NOT spawned `detached`.** A detached child sits in its own
  process group and would stop receiving the terminal's SIGINT, so Ctrl+C would
  leave orphaned sub-agents burning tokens. Keeping it in our group and
  force-releasing is the safer half of that trade.
- **The stall message says RELAUNCH, never resume.** pi restores sessions
  verbatim (`sdk.js:231-237`) and its only trailing-assistant trim is gated on
  stopReason `"error"`/`"length"`, **not `"toolUse"`** (`agent-session.js:1696-1704`).
  A child killed mid-tool-call leaves a `tool_use` with no `tool_result`;
  replaying that is a provider 400. There is no repair logic anywhere in pi.
- **`killedAt` guards the watchdog after any kill**, which also fixes
  attribution: a user abort sets it first, so the watchdog never relabels an
  Esc as a stall.

### What the big three harnesses do (researched 2026-08-14)

| | default | max | **idle detection** |
|---|---|---|---|
| Claude Code | 120s | 600s hard | **none** — and it *discards* output on kill (issue #34266) |
| Codex CLI | **10s** | none | **none** |
| OpenCode | 120s | **none** | **none** |

Nobody has idle detection; all three have open hang issues. Relevant for the
`vitest` case specifically: vitest's own `teardownTimeout` watchdog is armed
inside `ctx.exit()`, which the CLI reaches only *after* `startVitest()` returns —
and `startVitest()` awaits `close()`, so a hang **inside** close never arms it.
There is no `--forceExit` in vitest. Upstream's own answer is an external hard
timeout.

### Verified

**1537 tests pass, 0 fail.** Sabotage-checked in four directions, each failing
exactly its own tests and nothing else: reversing the sleep-guard order fails the
two lid-close tests; removing the idle kill fails 6 tests **by timing out at
20–30s**, reproducing the original bug's shape; reverting `timeout` to `Optional`
fails the 3 schema tests; removing the liveness stamps fails exactly the
false-positive-protection tests on both sides.

A `code_review` pass found 4 real defects, all fixed: the RPC kill paths not
arming the release timer, the idle interval re-issuing SIGTERM every tick, the
`close` handler mutating an already-returned result, and `idleKillSec()` being
read at two different times. Its 5th claim (that the force-release path was
untested) was **checked and was wrong** — the path was exercised but not
*asserted*; assertions were added rather than the claim accepted.

---

## The bash call header (fixed 2026-08-15)

**Files:** `bash.ts` `renderCall`, `bash-command-display.test.ts` (12 tests).

Every bash row rendered as `$ cd "/Users/muzammil/Documents/Code stuff" …` —
distinct commands, identical headers. The header was `cmd.split("\n")[0]`, and
`renderCall` **never read `context.expanded`** even though pi passes it
(`types.d.ts:335`) and re-runs both renderers on toggle (`tool-execution.js`
`setExpanded` → `updateDisplay`). So `ctrl+o` expanded the output box and left
the command exactly as truncated — no key, setting or flag revealed it. Present
since the initial import (`6e62263`); not a regression from the smear work.

It now shows up to `COLLAPSED_CMD_LINES` (3) rows and everything on `ctrl+o`.

- **The `cd` needed no special handling.** A first draft split `cd DIR` off for
  display and rendered it as `in ~/…/dir`. That was ~30 lines existing purely to
  work around the truncation — once line 2 renders, the cd is self-evidently a
  cd. pi's own `formatBashCall` truncates nothing at all.
- **Several rows from `renderCall` is safe; a newline in a border label is not.**
  `Text.render()` wraps and the TUI counts every row it returns. The smear class
  above is about **single-line sinks** (editor labels, widget rows) and still
  applies there.
- **`\r` is split on, not left in.** `normalizeForDisplay` strips
  `\x00-\x08\x0b\x0c\x0e-\x1f\x7f`; `\x0d` is **not** in those ranges, and a
  surviving CR returns the cursor to column 0 mid-row.
- **`ctrl+o` is named literally.** pi's tools use `keyHint("app.tools.expand")`,
  which lives at a core path our extensions do not alias.

Sabotage-checked by restoring the first-line slice: **7 of 12 fail**, exactly the
multi-line/expand/CR cases.

### `[took 0.0s]` — the same renderer, a second bug (fixed 2026-08-15)

**Files:** `bash.ts` `renderCall`/`renderResult`, `bash-elapsed.test.ts` (13 tests).

Every command reported `took 0.0s`. Both timestamps lived in `renderResult` and
were stamped in the same pass:

```ts
if (context?.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
state.endedAt ??= Date.now();   // ← unconditional
```

`endedAt ??=` fires on the **first streaming update**, milliseconds after
`startedAt` is set a few lines above it. The clock stopped as soon as the first
byte of output rendered. Now mirrors pi core (`dist/core/tools/bash.js`):

- **`startedAt` moved to `renderCall`.** `markExecutionStarted()` sets the flag
  and forces a render, so that is the earliest observable moment. Stamping it in
  `renderResult` starts the clock at first *output* — and this tool's whole idle
  watchdog exists because commands can be silent for their entire run.
- **`endedAt` gated on `!options.isPartial || context.isError`.**
- **`setInterval(invalidate, 1000)` while partial**, cleared at the end, so the
  number ticks live (`elapsed 3.0s` → `took 12.4s`). Component-scoped and cleared
  on the final render, so it is not the `session_shutdown` timer class above.
- **Timing is stamped above the two `(no output)` early returns.** A command that
  printed nothing used to show no duration at all — exactly the case worth timing
  — and an interval armed below them could never be cleared.

### The ticker gets the full deepseek-peak treatment

The first version of this ticker only bounded a **leak**, and that was the wrong
half of the lesson. What killed a session in the `deepseek-peak` incident was not
a leak — it was **a throw inside a `setInterval` callback**, which is an
uncaughtException, which pi answers with `process.exit(1)`. A timer that throws
once does not degrade; it takes the session with it.

The AGENTS.md rule above exempts "component-scoped intervals" because they "only
touch local component state". **This one does not qualify** — `context.invalidate()`
reaches `ui.requestRender()`, i.e. live TUI state. So it gets all four properties
the deepseek fix has, and the earlier version had none of:

| | why it cannot be dropped |
|---|---|
| `try`/`catch` | a throw here is `process.exit(1)`, not a degraded row |
| **stop**, never retry | a render context that has begun throwing does not recover |
| silent | a `console.*` during a TUI render scribbles the screen |
| `unref()` | a timer must never be the reason pi cannot exit |

Three independent stops, each covering what the others cannot: the final
non-partial result (normal), the deadline (a session replacement can drop the row
mid-command, orphaning a timer owned by nothing — it self-clears at
`maxTimeoutSec() + TICKER_SLACK_MS`, since a command cannot outlive its declared
timeout), and the catch (whatever neither anticipated).

**The idle watchdog in `execute()` got the same wrapper.** Everything it calls is
already defensive — `sampleGroupCpuSeconds` returns `undefined` rather than
throwing, `watchdogVerdict` is pure, `killGracefully` catches — so the `catch`
should be unreachable. *That is precisely the reasoning that cost a session last
time.* On a throw it stops the watchdog rather than killing the command: the
declared timeout still bounds the run, so degrading to L1 is safe while killing on
an internal error is not.

**Verified by sabotage, not by inspection.** Removing the `try`/`catch` and
pointing `invalidate` at a throwing stub reproduces the original failure verbatim
— `error: stale render context` escaping the callback — and fails 2 tests. With
the guard, the same stub is caught once, the ticker stops, and nothing propagates.

**Cost, measured rather than asserted:** a 1s interval costs **1.17 ms of CPU over
10 s** (idle baseline 0.13 ms) — ~0.01% of one core, and only while a command runs.
During output it is strictly cheaper than what already happens: `STREAM_UPDATE_INTERVAL_MS`
is 150 ms, so streaming already re-renders up to 6.7×/s. The ticker only adds work
during *silence*, at 1 render/s, where there were none.

Sabotage-checked by restoring the unconditional `endedAt ??=`: a 360 ms run
reports **0.1 s**, and 2 of 13 fail. Note the first duration test written for
this backdated `startedAt` and so passed under sabotage; the test that catches it
drives the real `call → partial → final` sequence with real time passing.

Full suite 1585 pass / 0 fail.

---

### Tool Libraries (`tools/lib/`)

Shared code used by multiple tools:

| Library | Purpose |
|---------|---------|
| `agents-md.ts` | AGENTS.md/CLAUDE.md reading |
| `box-format.ts` | Box-drawing formatting |
| `vision.ts` | Claude vision budget arithmetic — token cost, resize target, slice plan. Pure, no I/O |
| `image.ts` | PNG decode/encode/crop + `readPngSize` (IHDR-only, no decode) |
| `resample.ts` | Area-average (box filter) downscale |
| `image-fit.ts` | The single seam: file → vision-safe image + payload ladder |
| `capture.ts` | macOS `screencapture` + JXA window enumeration |
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
| `read-only-bash.ts` | the read-only bash allowlist `chad` runs under. quote-aware scanner + per-command gates. see the chad section |
| `watchdog.ts` | the pure silence-detection decision (incl. the machine-sleep guard) shared by bash's idle kill and pi-spawn's stall watchdog. see "Command Time Bounds" |
| `proc-cpu.ts` | process-group CPU sampling (`ps`) + pure parsing for bash's CPU-aware idle liveness. returns `undefined` on any failure so the guard degrades to stdout-only. see "Command Time Bounds" |

---

## Skills

**30 loadable by name** (verified live 2026-08-13): 24 config-level +
`find-skills` + `userinterface-wiki` + `context-management` (pi-context) +
3 `autoresearch-*` (pi-autoresearch). The `mcp-scripting` skill that
pi-mcp-adapter 2.19+ ships is deliberately suppressed — see the
pi-mcp-adapter config section.

### Config-level (`~/.config/agents/skills/`) — 24 skills

`amp-voice`, `c-sqr`, `chrome-cdp`, `coordinate`, `dataforseo`, `design-port`,
`dig`, `dm-antislop`, `document`, `git`, `mat-cr2axis`, `mat-design`, `mat-tdd`,
`nexus-fix`, `remember`, `report`, `review`, `rounds`, `s-improve`, `shepherd`,
`spar`, `spawn`, `tmux`, `write`

Six of those are external skills adapted for pi, with author prefixes —
**`s-` shadcn, `c-` cursor, `mat-` matt pocock, `dm-` dmmulroy**:

| Skill | What it is | Subagents it spawns |
|-------|------------|---------------------|
| `s-improve` | read-only codebase auditor → writes self-contained handoff plans in `plans/`; never edits source | ≤4 read-only (standard) / ≤8 (deep), only during an audit |
| `c-sqr` | strict structural quality review of a branch diff | none |
| `mat-cr2axis` | two-axis diff review: standards (fowler smells) + spec, side by side | 2 read-only, parallel |
| `mat-design` | deep-modules vocabulary (module/interface/seam/adapter/depth) | 3–4, only in the DESIGN-IT-TWICE path |
| `mat-tdd` | test-driven development discipline (red→green, seams, anti-patterns) | none |
| `dm-antislop` | installs dmmulroy's anti-slop **Oxlint plugin** — 15 rules rejecting low-evidence TS (chained assertions, `unknown` contracts, `Record<string, unknown>`, runtime `typeof`, module mocking, undocumented casts) | none |

**Adapted for pi:** Claude-Code/Cursor machinery mapped to pi tools or cut
(shadcn's `execute`/`reconcile` worktree flow removed — pi sub-agents have no
worktree isolation). `code-review` was renamed `mat-cr2axis` to avoid clashing
with the `code_review` **tool**. As adapted, **none of the five ever edits code
via a subagent — every subagent they spawn is read-only.**

### Package-provided skills — why `skill.ts` had to change

Packages ship skills inside their own package dir. pi's native listing showed
them, but our custom `skill` tool only scanned the settings/agent/project skill
roots, so `skill({ name })` failed with "skill not found" on a skill the model
could plainly see. `skill.ts` now also discovers
`~/.pi/agent/npm/node_modules/<pkg>/skills/` (incl. `@scope/name`) and
`~/.pi/agent/git/<host>/<org>/<repo>/skills/`. An `isDirLike()` helper makes
symlinked skill dirs list correctly — `Dirent.isDirectory()` is **false** for a
symlink, which is why `find-skills` and `userinterface-wiki` were invisible.
User/config skills win over package skills of the same name.

`pi-skills/` in the repo is empty; `find-skills` and `userinterface-wiki` are
package-managed symlinks created on install.

---

## Screenshot & Vision Budget (`screenshot` tool + `lib/vision.ts`)

**Added 2026-08-05.** Files: `lib/vision.ts`, `lib/image.ts`, `lib/resample.ts`,
`lib/image-fit.ts`, `lib/capture.ts`, `lib/web-capture.ts`, `screenshot.ts`
(+ 6 test files). Harnesses: `pi-setup/port-harness/screenshot-bench.ts`,
`capture-probe.ts`, `web-capture-probe.ts`.

### Three capture backends, one fit pipeline

| target | mechanism | why |
|---|---|---|
| display / window / region | `screencapture` | photographs the glass |
| `url:` | headless Chrome via `playwright-core` | renders the WHOLE page, including below the fold |

`screencapture` can only ever return what is rendered on screen, so a page taller
than the display is unreachable by it. The `url:` path renders the full document and
`planView` slices it into ordered readable strips.

**`playwright-core`, not `playwright`, and `channel: "chrome"`.** Full `playwright`
bundles a ~150MB Chromium per platform; `playwright-core` is 13MB and ships none,
driving the Google Chrome already installed. Resolved at call time — if it is missing
the tool prints the install command instead of a module-resolution stack trace.
Verified: a 1200×7056 fixture page → 8 slices of 1200×1008, all inside budget.

Slicing a tall page honestly costs more than one image (8 slices ≈ 12,384 tokens), so
the tool says so and points at `selector:` for capturing one section instead.

### Sub-agent screenshots reach the caller

`collectSubAgentImages` (in `lib/sub-agent-render.ts`) pulls image blocks out of a
child's tool results and `subAgentResult` puts them **before** the child's text, for
`oracle`, `delegate` and `code_review`. Previously `getFinalOutput` kept text parts
only, so the pixels died with the child and the caller had to take its word.

Capped at the **2 most recent** images — images are the most expensive thing that can
enter a context, and a sub-agent's last look is usually the one that justified its
conclusion. A child that took no screenshots costs exactly nothing.

Verified live, and it immediately earned its keep: asked to check an oracle's claim,
the parent read figures out of the image the oracle never mentioned **and corrected it**
— the oracle said Stripema was the foreground app; the parent could see Finder held the
menu bar.

### The budget: two limits, and why one pass matters

Claude's budget is **two** limits — a 1568px padded edge AND **1568 visual
tokens**, where `tokens = ceil(w/28) × ceil(h/28)`. **The token limit binds first
for almost every screenshot**, which is why the obvious hand-rolled version is
wrong: `screencapture … && sips -Z 1400` on a 16:10 window gives 1400×900 =
50×33 = **1650 tokens**, over budget, so the API resizes it *again* to 1372×882 —
text resampled twice for a 2% size change, on top of a 3.2× reduction because a 2×
display had already captured 2800×1800. The tool resamples **once**, to the exact
size Anthropic's own resizer would pick, so the API's resize is a no-op. Verified
live: 2800×1800 → `1372×882 (1568 tokens, 1 pass)`.

### Where the numbers came from

`lib/vision.ts` is a behaviour-identical port of the `caliper` project's
`src/vision.ts` (`~/Documents/Code stuff/caliper`), which transcribes Anthropic's
published spec and reference resize implementation. The **same algorithm** is
implemented independently in the `ClaudeImageResizer` macOS app
(`ImageBudget.swift`). Two independent implementations agreeing on every test
vector is the only reason to trust either. **If you change a constant, change it
in all three and re-run `lib/vision.test.ts`.**

Details that look like nits and are not:

- **Banker's rounding.** `resizedSize` resolves exact .5 ties to even, matching
  Python's `round()`. `Math.round` drifts a pixel on tie-hitting aspect ratios —
  pinned by the 2000×1500 test.
- **The edge limit is tested against the PADDED edge**, `ceil(w/28)*28`.
- **High is the DEFAULT tier, and nothing decides it.** Swept 851 shapes
  (`port-harness/tier-dominance.ts`): high was larger 801 times, identical 50, and
  smaller **zero** times. It is not a trade-off, so there is nothing to weigh.
  Only an explicit `tier:"standard"` opts down; an absent or invented tier name
  gets high. In 54 wins the source already fitted, so high meant **no resample at
  all**. High is also safer for image *count* — 1988px slices vs 840 means a
  20,000px page needs 11 images instead of 25, and image count is what trips the
  >20 and 100-image rules.
- **No cost language anywhere in the tool surface.** A `screenshot.test.ts` case
  greps the description and every parameter for
  `token cost|cheaper|Nx the cost|expensive` and fails if any appears. Cost is the
  caller's business; the tool's business is not returning a degraded picture. The
  old `"~3x the token cost"` note actively pushed models to the weaker tier.
- **Patch-snapping was removed, not defaulted off.** Trimming each axis to a
  multiple of 28 saves ~3% of the budget and distorts the aspect ratio by up to
  2.7%; ClaudeImageResizer reached the same conclusion independently. It lives on
  in caliper if a measurement use ever wants it. `paddedSize` went the same way —
  the padding rule it reported is already inside `fits()`, which is what decides.
- **Area-average, not Lanczos.** Lanczos/bicubic ring on hard edges, and UI is
  nothing but hard edges (text stems, 1px borders). A deliberate divergence from
  ClaudeImageResizer's CoreGraphics `.high` path, which is the better choice for
  photos and the worse one here.

### Two caps that are ours, not Anthropic's

**`MAX_IMAGES_PER_CALL = 12`** (`lib/vision.ts`). Anthropic's wall is 100 images per
*request*, and a request is the whole conversation resent each turn — so one call
emitting 52 slices can clear that wall on its own. Measured at 1440px wide on the high
tier: a 100,000px page wanted 52 slices. 12 leaves 8× headroom and covers a ~23,000px
page. Exceeding it **truncates from the top** and says so in pixels; it never
bottom-aligns when truncating, because jumping to the end would leave an unannounced
hole in the middle.

**`MAX_RENDERABLE_HEIGHT = 16384`** (`lib/web-capture.ts`) — see below.

### Chromium silently returns BLANK past 16384px

Chromium cannot render a full-page screenshot taller than its maximum texture size
(2^14). Past that it does **not** fail — it returns an image of the requested
height whose lower portion is empty. Found by a model **reading our own slices**
and reporting that a 51,320px capture repeated and blanked out.

Measured (`port-harness/tall-page-limit.ts`) on a 40-section fixture: sections 1–13
rendered, **sections 14–40 came back blank**, boundary inside 15,506..16,719. The tool
then sliced that emptiness and handed it over as page content — worse than truncation,
because a caller cannot tell blank-because-empty from blank-because-broken.

`captureWebPage` now clips to 16384 and reports `clipped: { capturedHeight,
documentHeight }`, which `screenshot.ts` surfaces as a loud note. After the fix the same
fixture yields 13 distinct headings and **0 blank bands**.

Two probe bugs on the way there — one sampled at the CSS `height` when content-box
sizing made sections taller, the other assumed a mostly-whitespace fixture had ink
at the bottom. Lesson: **derive geometry from the artifact; do not assume it.**

### Two files that look like images and kill the request

`400 Could not process image` fails the **whole request**, not the one tool call — so it
takes the turn down. Two inputs reached the API and caused it, both for the same
structural reason: **the `asis` fast path deliberately never decodes.** Anything a decode
would catch is therefore already safe; only things that survive a *header read* need an
explicit refusal.

| input | why it slipped through |
|---|---|
| **0x0 PNG** (`DegenerateImageError`) | structurally valid, and zero tokens is inside every budget — so it is judged to "fit" perfectly and ships untouched |
| **truncated PNG** (`TruncatedImageError`) | intact IHDR reports plausible dimensions; measured, the first 100 bytes of a 300×200 PNG report 300×200 and ship as a 100-byte "image" |

Found live: a script killed mid-run left 65-byte 0x0 PNGs in `~/pi-scratch`, and reading
one killed the session. Empty files, not-an-image and half-a-file all throw while
decoding and never had this problem.

Both now throw `UnusableImageError` (the shared base) from `fitImageFile`, before
`planView` runs. Truncation is detected by the **missing 12-byte IEND chunk** — one tail
read, so `asis` stays decode-free. **PNG only, deliberately**: every valid PNG ends with
IEND so there are no false positives, and PNG is what `screencapture`, Chromium and our
own encoder produce — every path that can write a partial file. JPEGs commonly carry
trailing bytes after EOI, and refusing a valid image would be worse than the bug.

**`read.ts`'s raw-bytes fallback must skip this class.** It exists so a *fit* failure
never makes `read` worse than the five-line version it replaced — but falling back for
an unusable image re-sends the exact payload the API rejects. It now catches
`UnusableImageError` and reports it instead. Verified live: a fresh session read both
corrupt shapes, got clean errors, and kept working.

### Window targeting — the rules, and why each exists

**Every macOS tab is its own `NSWindow`, and the tab bar is a further separate
window.** Measured: 4 visible Ghostty terminals reported as 16 windows (two real
windows of 7 and 8 tabs, plus tab-bar windows at y=0 filtered by the height
floor). So a raw window count is accurate and useless. `groupLikelyTabs()` keys
on identical app+size+position; `renderWindowTable` folds siblings into one entry
with the capturable id first and the rest as `other tabs: …` (singletons stay
flat — a "1 tab(s)" header is noise).

This also explains a capture that looks 80px too tall: `screencapture -l` returns
the whole **tab group**, so a window whose `CGWindowBounds` says 1920×1040 @y=40
(the *content area*) captures as 1920×1080 from y=0 — the difference is exactly
the 40pt tab bar, verified by cropping and reading it. Nothing extra is captured
and nothing is lost. The tool notes any captured-pixels ≠ bounds×scale mismatch,
and suppresses that note when a region was applied (after a deliberate crop,
"the full window was captured" would be untrue).

Rules the tool follows, each from a live failure:

- **Disclose the choice.** Auto-picking used to be invisible: `app:"ghostty"`
  matched 12 windows and captured one silently. `resolveWindow` returns a
  `WindowChoice` carrying `autoPicked`; the tool names the match count and chosen
  id. Exactly one on-screen candidate → capture it and say so, never a second call.
- **Only give advice that can work.** The refusal used to say *"narrow it with
  window_title"* to a caller that had supplied one, when all candidates had
  byte-identical titles. That advice is now conditional on
  `new Set(titles).size > 1`; otherwise it says so and asks for `window_id`,
  the only thing that can separate them. `describeWindow` includes `@x,y` because
  terminals left-truncate their own titles, hiding the distinguishing prefix.
- **A dead end becomes a next step.** On failure, `displayedSibling()` names the
  on-screen member of the same tab group. It does **not** auto-capture it — the
  group renders whichever tab is active, so substituting would be the silent
  auto-pick bug again: right pixels, wrong subject.
- **`region` is window-relative** when combined with `window_id`/`app`, cropped
  from the window's own pixels after capture. Screen coordinates go stale the
  moment a window moves and cannot express the tab-bar offset `CGWindowBounds`
  omits. Over-large regions clamp and say so. Measured: a `[0,0,700,120]` crop
  costs **450 tokens instead of 2840**.

`resolveWindow` takes an injectable `pool` because these branches depend on which
Space is active — the ambiguous case stops being ambiguous the moment a window
moves, so it cannot be tested against the live desktop.

**Guardrail: every absolute claim made about macOS window behaviour here has been
wrong.** `[other Space]` (macOS only reports `kCGWindowIsOnscreen: false`, which
is equally true of a minimised window, a hidden app and — most often — a
background tab, so it is now `[not on screen]`); "cannot be captured while off
screen"; "a background tab can never be captured" (disproved by `window_id 13861`
capturing fine at 3840×2080). Three for three. State the observation, offer the
next step, and let the capture attempt be the authority. A test greps the rescue
message for `never|impossible|cannot be captured`.
- **Patch-snapping was removed, not merely defaulted off.** Trimming each axis down to a
  multiple of 28 saves ~3% of the budget and distorts the aspect ratio by up to 2.7%;
  ClaudeImageResizer reached the same conclusion independently, so nothing ever enabled
  it. It lives on in caliper if a measurement use ever wants it. `paddedSize` went the
  same way — the padding rule it reported is already inside `fits()`, which is what
  actually decides.
- **Area-average, not Lanczos.** Lanczos/bicubic ring on hard edges, and UI is nothing
  but hard edges (text stems, 1px borders). This is a deliberate divergence from
  ClaudeImageResizer's CoreGraphics `.high` path, which is the better choice for photos
  and the worse one here.

### The >20-image ceiling — why `high` is clamped to 2000px

Spec §7: once a request carries **more than 20 images**, the per-image ceiling
drops from 8000px to **2000px per axis**. The high-res tier's spec edge is 2576.

This went off live (session `019fcf7a`): a 2576×1449 image **succeeded at image
index 3 and 400'd at index 20 of the same session**, identical size, nothing wrong
with it — a 9-slice web capture had pushed the request past 21 images. Worst
possible failure shape, because it looks random.

**Fix:** `resolveTier()` clamps high to `MANY_IMAGE_MAX_EDGE = 2000`, so no image
this tool emits can ever be illegal. Costs ~23% of linear resolution (2576 → 1988
after padding) and 40% of token cost (4784 → 2840); 1988 is still 27% above the
standard tier, which is the reason to ask for `high`. `TIERS` keeps the **spec**
values — the test vectors and the ClaudeImageResizer cross-check are written
against those; only `resolveTier`, the seam every tool goes through, clamps.

**There is deliberately no opt-in back to 2576.** A tool cannot see how many
images are already in the conversation, so it cannot know whether 2576 is safe on
this call. An option that works early and fails later is worse than no option.

Guarded by a sweep of 12 shapes × both tiers asserting nothing exceeds 2000, plus
a separate one for slice boxes (slices are cropped, so they bypass `resizedSize`
entirely). **It was a known unknown:** the pre-build research listed this limit as
"NOT implemented" and it was then not built. Check that list before assuming a
limit is handled.

### The resample out-of-bounds bug (also fixed upstream in caliper)

`downscale`'s inner loops used `Math.ceil(xEnd)`/`Math.ceil(yEnd)` as bounds. At
the last row/column `(dx + 1) * xRatio` overshoots by ~1e-15, so `ceil` yields
`width + 1` and the loop reads one past the buffer. An out-of-bounds `Uint8Array`
read is `undefined` → `undefined * weight` is `NaN` → assigning `NaN` into a
`Uint8Array` silently stores **0**. A black pixel, no error anywhere.

| source → target | corrupt bytes |
|---|---|
| 21×21 → 19×19 | 57 (the entire bottom row) |
| **2880×1800 → 1389×868** (MBP Retina) | 3 (bottom-right pixel black) |
| 3840×2160 → 1456×819 | 0 — clean by luck |

**Why 107 tests missed it:** every resample test asserted an *aggregate* (mean,
buffer length, value range), and 3 bad bytes in 3.6 million move the mean by
0.00002. The fix clamps bounds to the buffer; regression tests now assert **exact
pixel values** across 7 named sizes plus an 873-combination sweep. Ported
faithfully from caliper and **fixed there too** — it mattered more there, since
caliper's `edges()`/`bands()` read a black pixel as ink.

### macOS facts verified on this machine (do not re-derive)

- `CGWindowListCopyWindowInfo` **is** reachable from JXA, but only through
  `ObjC.castRefToObject`. Calling it directly returns something that `typeof`s as
  `"function"` and unwraps to nothing. No compiled helper needed.
- **Use option `0` (all windows), never `1` (`OnScreenOnly`).** Option 1 omits every
  window on another Space — measured 17 vs 142, and this session's own terminal was in
  the missing 125.
- **Off-Space capture is mixed, not uniformly broken.** Survey: **9 of 10** off-Space
  windows captured fine; 1 failed with "could not create image from window". So the tool
  must *try* and explain on failure — pre-refusing would block 9 valid captures.
- `CGPreflightScreenCaptureAccess` has an **incomplete BridgeSupport entry** (declared
  with no signature) so JXA cannot call it. Authoritative check is
  `swift -e 'import CoreGraphics; print(CGPreflightScreenCaptureAccess())'` (~134ms),
  used only *after* something fails. The free heuristic is that `kCGWindowName` is blank
  for other processes when permission is denied.
- **Screen Recording must be granted to the terminal running pi.** Without it macOS
  returns the desktop with no windows rather than failing — a silently useless image.

### Performance (measured, real 8.3-megapixel Retina grab)

`readPngSize` 0.7ms · decode 118ms · downscale 45ms · encode 73ms · **~236ms total**.
That settled the "pure TS vs the Swift binary" question — no native helper, nothing for
`install.sh` to build. A full-screen 4K PNG is 6.8MB on disk = **9.07MB base64, 90.7% of
the 10MB API cap** before fitting; after fitting, 16.2%.

### Invariants

- **`sips` is a codec, never a resizer.** It transcodes non-PNG input and encodes JPEG at
  a given quality. Every geometry decision is made by `planView` in TypeScript.
- **`fitImageFile` is the only path from pixels to a vision model.** `screenshot` and
  `read` both funnel through it. Nothing else should base64 an image.
- **The `asis` path never decodes.** Dimensions come from the IHDR; if the image already
  fits, the original bytes ship untouched.
- `permissions.json` rejects the capture binary in bash and names the tool in the
  message. It does **not** match `sips` at all any more: that pattern produced three
  false positives in a single session — a git commit message describing the old pattern,
  and two files written through a shell heredoc that merely QUOTED it. The guard exists
  to stop an agent TAKING a screenshot by hand, not to stop anyone writing about it, and
  with the capture binary blocked there is no fresh screenshot to badly resize anyway.
  Pinned by `port-harness/permission-precision.ts` (5 real invocations still blocked,
  7 "talking about it" cases allowed) and by cases in `screenshot.test.ts`.
- Available to `delegate`, `oracle` and `code_review` sub-agents, and **a sub-agent's
  images now reach the parent** — see "Sub-agent screenshots reach the caller" above.

### `read` is covered too

`read.ts` routes images through `fitImageFile` as well, so an image the model *opens* gets
the same ceiling as one it *takes* — design mockups, downloaded PNGs, earlier screenshots.
Two deliberate properties:

- **An image that already fits returns exactly what it used to**: a single image block, no
  extra commentary. Only an image that needed work says so.
- **Any failure in the fit path falls back to the raw bytes.** `read` becoming more fragile
  than the five-line version it replaced would be a worse bug than a large payload.

Verified live: `/tmp/p0-display.png` (3840×2160, 6.8MB on disk, **9.07MB base64 = 90.7% of
the API cap**) now arrives as 1456×819 in one pass, and the model still read four-digit
figures out of a screenshot nested inside it.

### Not verified

- Multi-display: this machine has one display, so `display: 2` only ever produced
  `screencapture: Invalid display specified`. The flag is passed straight through.
- `activate` is implemented and unit-covered but **never run live** — it switches the
  user's Space, so it was not exercised during development. First real use may surface a
  macOS Automation (TCC) prompt. Note the tri-state: **unset** means a window that fails
  to capture because it is on another Space is retried with activation automatically;
  **true** activates up front; **false** forbids it. The auto-retry only fires for an
  off-screen window, because an on-screen failure is a permissions problem that stealing
  focus would not fix.

---

## Local Models (llama.cpp + LFM2.5-2.6B)

**Added 2026-08-05.** Files: `pi-setup/extensions/local-model.ts` (the `/local` command),
`pi-setup/llama-local.sh` (terminal launcher), the `llama-local` provider in `models.json`,
and its entry in `enabledModels`.

### ⚠️ llama.cpp MUST be >= b10270

Brew shipped **b8680 (commit `15f786e65`, dated 2026-04-06)** for months. That build has
**two silent tool-call parser bugs for the `lfm2` architecture** — neither raises an error,
both just hand the agent garbage:

| upstream | merged | symptom before the fix |
|---|---|---|
| **#24667** double-escaping | 2026-06-15 | `\n` in a tool argument arrives as **literal backslash-n**, so every multi-line argument is corrupt. Kills `apply_patch`, file writes, multi-line bash. |
| **#24178** parser unification | 2026-06-05 | `[f(a), f(b)]` parsed as **one mangled call** — the second call's raw text ends up inside the first call's last argument, and the result is still *valid JSON* so nothing rejects it. |

Both were reproduced here and traced by bypassing the parser: the **model emits correct
Pythonic output** (`[write_file(path='/tmp/x.py', content='import os\nprint(...)')]`) — llama.cpp
was copying the two characters `\`+`n` into JSON verbatim instead of interpreting the Python
escape. **Model was never at fault.** Upgrading `8680 → 10270` fixed both, verified.

If tool calling ever goes strange on a local model, check `llama-server --version` FIRST.

### The `/local` command

```
/local            status; if stopped, offers to start (interactive menu in TUI)
/local start      start router + load the model
/local stop       kill the server, release RAM
/local restart    stop then start
/local unload     drop the model, keep the server listening
/local status     quant, context, params, RAM, endpoint
/local logs       last 40 lines of /tmp/llama-server.log
```

**No auto-start at login** — deliberate, by user request. Start it when you want it.

### System prompt isolation — do not widen this

`before_agent_start` **returns `undefined` unless `ctx.model?.provider === "llama-local"`**.
pi chains that hook, and a handler returning nothing leaves the prompt byte-identical. So the
local-model rules + identity block are appended ONLY for the local model; claude/kimi/codex/
deepseek/sakana all keep the default prompt untouched.

**Verified with a canary**, not by asking the model (a 2.6B model introspecting its own prompt
is not evidence — it answered "ABSENT" while the text was demonstrably present). A unique token
was injected and the local model reproduced it exactly (`ZQ7X-VELVET-4419`); Claude and Kimi hit
the same hook and returned `NONE`, with instrumentation confirming the injection branch never ran
for them.

The injected rules exist because of measured failures, not theory: a 9-`apply_patch` loop with
only 2 verification runs (9m36s), a 10-call patch loop on a one-line fix (507s vs 23s median),
and bash arguments handed to `apply_patch`. Rules 3 (stop after two failures), 4 (verify each
edit) and 5 (never hand-compute expected values) target exactly those.

### Gotchas found while wiring this up

- **`ctx.hasUI`, not `ctx.canPrompt`.** There is no `canPrompt` — it reads `undefined`, which is
  falsy, so every dialog silently degraded to the non-interactive branch *inside a real TUI*.
- **A model must be in `enabledModels`** or `/model` shows "No matching models" even though
  `--list-models` and `--model provider/id` both work.
- **`toLocaleString()` follows the SYSTEM locale** — en-IN here, so 128000 rendered as
  `1,28,000`. Always pass `"en-US"` explicitly.
- **pi's built-in `llama.cpp` provider is TUI-only.** Its extension registers exactly one hook —
  the `/llama` command — and the model catalog is populated nowhere else, so headless `pi -p`
  can never see those models. That is why we use a `models.json` provider (`llama-local`) instead.
- **The extension embeds its own server command.** The 2026-07-23 `local-model.ts` shelled out to
  a `start-local.sh` living outside the repo; that script was later deleted and took the whole
  extension with it. Nothing here depends on a file that can vanish.

### Measured on this machine (M4 Pro, 48 GB)

decode **81-89 tok/s** · prefill ~1,049 tok/s · cold start → loaded **3.2s** ·
auto-sleep after 300s idle drops **3.25 GB → 0.18 GB**, wakes in **~1.0s**.
Our system prompt + 27 tools is **18,546 tokens** ≈ **17.7s prefill on every fresh `pi -p`**.

Reliability: clean, well-specified single-file task **5/5** at 24-25s. Structured JSON extraction
**3/3 byte-exact** at 35-38s. Self-directed work (write your own tests) **failed** — it does not
fail fast, it loops for 8-10 minutes and returns nothing. Put a timeout on anything unattended.

---

## Models

### Providers (in models.json)

| Provider | Models | Purpose |
|----------|--------|---------|
| `anthropic` | `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` (1M context override) | Direct Anthropic API + OAuth (Claude Max via pi-claude-code-use) |
| `deepseek` | `deepseek-v4-pro`, `deepseek-v4-flash` | 1M context, thinking mode, OpenAI-compatible API |
| `kimi-code` | `kimi-for-coding` (K2.7 Code, 262K ctx) | Kimi Code subscription OAuth via `~/.kimi-code/credentials/kimi-code.json`; token helper refreshes through `https://auth.kimi.com/api/oauth/token` |
| `llama-local` | `LFM2.5-2.6B` (Q6_K, 64K ctx active / 128K max) | Local llama.cpp router at `http://127.0.0.1:8080/v1`. Free, private, offline. Managed with `/local`. Requires llama.cpp >= b10270 — see "Local Models" above. |
| `sakana` | `fugu`, `fugu-ultra` (both 1M ctx, text+image) | Sakana AI "Fugu" multi-agent orchestration. OpenAI **Responses** API at `https://api.sakana.ai/v1` (`api: openai-responses`), Bearer `$SAKANA_API_KEY`. $20/mo "Standard" subscription. See "Sakana AI (Fugu)" section below. |

### Sub-agent Models

Set 2026-07-31. Constants live in each tool file (`const MODEL = …`); the
Anthropic-parent conditional in `lib/pi-spawn.ts` is unchanged, so a
non-Anthropic parent (deepseek/kimi/sakana) still makes every child inherit the
parent instead of demanding separate Claude access.

| sub-agent | model | why |
|---|---|---|
| **finder** | `claude-sonnet-5` | concept search is worth real reasoning; haiku missed connections |
| **librarian** | `claude-sonnet-5` | multi-repo exploration over the GitHub API |
| **code_review** | `claude-sonnet-5` | diff review |
| **oracle** | `claude-opus-4-6` | strongest model; architecture, hard bugs, alternative view |
| **delegate** | *(none — inherits `parentModel`)* | **deliberate.** a delegate is a peer doing your work, so it must match your model and provider. Do not add a `MODEL` const to `delegate.ts`. |
| **chad** | `deepseek/deepseek-v4-flash` **pinned** (`pinModel: true`, `--thinking high`) | the inverse of delegate, and equally deliberate. the model is not an implementation detail — $0.14/$0.28 per M with a 1M window is what makes a swarm affordable, so inheriting the parent would destroy the tool. provider-qualified because `pinModel` skips `qualifyModel`. |
| **read_session** | `claude-sonnet-5` | picking the right branch out of a long, branching session is comprehension, not summarisation |
| **read_web_page** | `claude-sonnet-5` | only the optional `prompt` path spawns a model; a plain fetch spawns none |

Verified live (model read off the wire, not just the constant): parent
`claude-opus-5` → finder `claude-sonnet-5`, oracle `claude-opus-4-6`, delegate
`claude-opus-5` (inherited), read_web_page `claude-sonnet-5`, read_session
`claude-sonnet-5`.

**Still on haiku, deliberately:** `extensions/session-name.ts` (`NAMING_MODEL`)
generates the short session title. It runs on *every* session for a one-line
output, so the cheap tier is the right call. Everything else we own is off haiku.

### Active Settings

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5",
  "defaultThinkingLevel": "high",
  "theme": "gruvbox",
  "compaction": { "enabled": true }
}
```

---

## Sakana AI (Fugu) Provider

**Added:** 2026-06-22. **Config-only** (no extension, no patches) — lives in `models.json` as the `sakana` provider, exactly how pi is designed to absorb a new OpenAI-compatible provider.

### What it is

Sakana's API serves **"Fugu"** — a multi-agent orchestration system exposed as a single OpenAI-compatible model. Two models registered: `fugu` and `fugu-ultra` (both 1M context, text+image vision). $20/mo "Standard" subscription.

- **Base URL:** `https://api.sakana.ai/v1`
- **Wire API:** `openai-responses` (Sakana **recommends** Responses over Chat Completions; required for proper reasoning/tool management).
- **Auth:** Bearer `$SAKANA_API_KEY` (env var in `~/.zshrc`, same as `DEEPSEEK_API_KEY`). Key from `https://console.sakana.ai/api-keys`.

### Why `openai-responses` is safe here (verified against pi source)

Read `@earendil-works/pi-ai/dist/providers/openai-responses.js` before changing anything:

1. **`store: false` is hardcoded** (`buildParams`, ~line 190) and pi never sends `previous_response_id` — it rebuilds full history each turn (`input: messages`). Sakana is **stateless** (rejects `previous_response_id`), so pi's behavior matches Sakana exactly. This is also why "store like deepseek" is automatic: no server-side session either way.
2. **Reasoning summaries** (~lines 204-213): when effort is set, pi sends `reasoning: { effort, summary: "auto" }` + `include: ["reasoning.encrypted_content"]`, and parses `response.reasoning_summary_text.delta` back into thinking blocks. `fugu-ultra` supports reasoning summaries → "proper thinking" displays.
3. **The one trap** (~lines 215-219): if effort is unset and `thinkingLevelMap.off !== null`, pi sends `effort: "none"` — which **Sakana rejects** (it only accepts `high` and `xhigh`/`max`). Mitigated by `"off": null` in the map (pi then sends no reasoning param → Sakana uses its default) and by mapping every other level to `high`/`xhigh`.

### thinkingLevelMap (mandatory shape)

Sakana rejects any effort other than `high`/`xhigh`(==`max`), so all levels collapse:
```json
"thinkingLevelMap": { "off": null, "minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "xhigh" }
```

### Pricing

Only `fugu-ultra` carries published PAYG rates (input $5 / output $30 / cached-in $0.50 per 1M, <272K ctx). `fugu` is routed across providers with unpublished per-token rates → set to `0` (not invented). Under the $20 subscription these cost numbers are informational only.

### Known unknowns (deliberately NOT invented)

- `maxTokens` ceiling undocumented → set to `32768` (flagged guess; bump once observed).
- Numeric rate limits / $20 token allowance unpublished.
- `include: ["reasoning.encrypted_content"]` support not explicitly documented by Sakana — but their official Codex integration uses stateless Responses (`store:false`) with encrypted reasoning, so it's almost certainly supported. **If reasoning requests 4xx on `encrypted_content`/`developer` role, fallback:** switch `api` to `openai-completions` (loses fugu-ultra reasoning-summary display but keeps everything else), optionally with `compat.supportsDeveloperRole: false`.

### Setup steps to reproduce

1. `models.json` → `sakana` provider block (done).
2. `settings.json` → `enabledModels` adds `sakana/fugu`, `sakana/fugu-ultra` (done).
3. `~/.zshrc` → `export SAKANA_API_KEY="..."` next to the other provider keys.
4. New shell (or `source ~/.zshrc`), launch pi: `/model sakana/fugu-ultra:high`.

`models.json` hot-reloads when you open `/model` — no restart needed.

---

## File Layout

```
pi-setup/
├── install.sh                  # Full installer (backs up, then deploys)
├── settings.json               # Pi settings (packages, extensions, theme)
├── models.json                 # Model overrides + custom providers
├── keybindings.json            # Model cycling keys
├── permissions.json            # Git/rm safety rules
├── mcp.json                    # pi-mcp-adapter global MCP servers (astro, paper)
├── pi-sub-bar-settings.json    # @marckrenn/pi-sub-bar widget layout
├── pi-sub-core-settings.json   # pi-sub-core provider/refresh config
├── README.md                   # Setup docs + session log
├── claude-bridge-patches/
│   ├── index.ts                # Patched pi-claude-bridge (our custom build)
│   └── package.json            # Version tracking
│   ├── package.json            # Version tracking
│   └── filters/
│       └── context-compress.ts # Patched context masking (cmd param support)
├── agents/                     # 10 agent prompt templates
│   ├── prompt.amp.system.md    # Main system prompt template
│   ├── agent.amp.chad.md       # read-only research subagent
│   ├── prompt.harness-docs.pi.md  # pi-specific docs
│   ├── prompt.amp.read-web-page.md  # web-page Q&A prompt
│   └── ...
├── themes/                     # 2 pi TUI themes
│   ├── gruvbox.json
│   └── nightowl.json
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 24 config-level skills
└── extensions/
    ├── deepseek-peak/          # peak/off-peak pricing clock (index.ts + peak.ts + 44 tests)
    ├── tools/                  # 29 custom tools + lib/ (config, prompt-patch, fs, mentions)
    ├── pi-tool-display/
    │   └── config.json         # All tool overrides disabled (required for compatibility)
    ├── mentions.ts             # @mention resolution + agent directives extension
    └── *.ts                    # other extensions (all active; auto-discovered)
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
| `agent.amp.chad.md` | Chad subagent: read-only deep research, structured Answer/Evidence/Verified-vs-inferred/Gaps report |
| `prompt.amp.handoff-extraction.md` | Handoff extraction prompt (kept for reference; the handoff extension was removed) |
| `prompt.amp.code-review-system.md` | Code review system prompt |
| `prompt.amp.code-review-report.md` | Code review report format |
| `prompt.amp.read-web-page.md` | Web page reading prompt |

---

## Update Workflow

### Post-update verification — ALWAYS RUN THIS FIRST

```bash
bash pi-setup/verify-patches.sh
```

Read-only audit of every patch and config this setup depends on: resource-loader
conflict suppression, session pinning, **pi-tui width patch in ALL installed
copies** (TUI smears without it), condensed-milk absence,
pi-tool-display config, editor label guards, box-format normalization,
provider-qualified sub-agent `--model`. Each
FAIL prints the exact fix command. Exit 0 = everything in place. Run it after
`pi update`, any `pi install`, any npm package update — or whenever something
feels off. `pi-setup/install.sh` also runs it as its final step.

**An import-level audit is not enough — also grep our own CLI call sites.**
`verify-patches.sh` and the usual API-compat sweep both check what our
extensions *import*. They cannot see a change in how pi interprets the
**command-line arguments we pass it**, and `lib/pi-spawn.ts` shells out to a
real `pi` process with `--model`, `--provider`, `--tools`, `--mode`. pi 0.84.0
#7327 changed bare `--model` resolution from "take the first catalog entry" to
"hard error if several authenticated providers match", which silently took out
**every sub-agent** — oracle, finder, code_review, librarian, read_session,
read_web_page — with an error that reads like an auth failure. The changelog
line had been read and filed as a *free win*. So: whenever a release mentions
model resolution, provider selection, tool filtering or CLI arguments, open
`lib/pi-spawn.ts` and check the flags it builds, then actually call one
sub-agent before declaring the update clean.

When pi or any package gets updated:

1. **pi itself updated** (`@earendil-works/pi-coding-agent`): Check if any internal APIs changed that our extensions depend on. Look at the [changelog](https://github.com/earendil-works/pi). Our extensions override built-in tools — if the tool API changed, update our tool files accordingly. The `@mariozechner/*` backward-compat aliases are currently preserved but will eventually be removed — when that happens, rename imports in all 46 `.ts` files (see log.md for the sed command). **Must re-apply `resource-loader.js` patch** — it suppresses extension tool-conflict boot errors; kept as a safety net (with the custom `web_search` removed there is currently no active conflict, but any future package/extension name collision would block startup without it). **Must re-run `apply-pi-tui-width-patch.mjs`** — without it, heavy output with Indic matras/exotic unicode desyncs and smears the whole TUI; note EVERY package update/install brings a fresh unpatched pi-tui copy (see "TUI Width Desync Fix").

2. **condensed-milk-pi**: REMOVED 2026-07-30 — do not reinstall. See "condensed-milk-pi: REMOVED" above for why (it reported failed git commands as successes).

3. **pi-sub-bar / pi-sub-core updated**: we ship a **local grok provider patch**
   (`pi-setup/pi-sub-patches/`). `pi install` / `pi update --extensions`
   restores stock copies and wipes it — re-run `install.sh` (or the cp block
   in that file) after every sub-* update. Stock upstream providers are:

   `anthropic, copilot, gemini, antigravity, codex, kiro, zai`

   plus our local **`grok`**. There is **no `kimi` and no `crofai`**. A
   provider named in `pi-sub-core-settings.json` that has no factory breaks
   the usage tools in two different ways:

   - in `providers{}` → `PROVIDER_FACTORIES[name] is not a function`
   - in `providerOrder[]` → `Cannot read properties of undefined (reading 'enabled')`

   Both surface only when pi-sub-core refreshes usage (status bar / refresh), so a normal boot looks clean.
   After any pi-sub-* update, re-check both keys in
   `pi-sub-core-settings.json` **and** `pi-sub-bar-settings.json` against the
   `PROVIDER_FACTORIES` map in
   `~/.pi/agent/npm/node_modules/@marckrenn/pi-sub-core/src/providers/registry.ts`,
   and confirm `verify-patches.sh` still PASSes the grok check.

   Grok reads `~/.grok/auth.json` (OIDC), refreshes via the issuer's token
   endpoint when expired, and fetches
   `GET {cli-chat-proxy}/billing?format=credits`. Windows: period %
   (`Week`/`Month`/`Usage`) + optional `Grok Build` + prepaid `Extra $…`.

4. **pi-tool-display updated**: Config file at `~/.pi/agent/extensions/pi-tool-display/config.json` is NOT touched by npm updates. But if you delete and reinstall, **recreate the config** with all tool overrides set to `false`. Without it, pi-tool-display overwrites our custom tools.

5. **Other packages** (pi-context, pi-token-burden, pi-codex-goal, pi-autoresearch, pi-mcp-adapter): Generally safe to update. No patches on these. Check if they register tools or skills that conflict with ours.

### Quick re-patch after any update

```bash
# pi core — suppress extension tool-conflict boot errors (safety net; keep even with web_search removed)
cp pi-setup/pi-core-patches/resource-loader.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js

# pi core — session pinning (Ctrl+B in /resume picker)
cp pi-setup/pi-core-patches/session-selector.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js
cp pi-setup/pi-core-patches/keybindings.js /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js

# pi-tui — conservative grapheme widths in ALL installed copies
# (CRITICAL — TUI smears on exotic unicode without it; every package bundles its own pi-tui)
node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs

# condensed-milk — REMOVED 2026-07-30, nothing to re-apply. Do not reinstall.

# pi-sub grok provider (wiped by pi install / pi update --extensions)
SUB_NM="$HOME/.pi/agent/npm/node_modules/@marckrenn"
cp pi-setup/pi-sub-patches/pi-sub-shared-index.ts "$SUB_NM/pi-sub-shared/index.ts"
cp pi-setup/pi-sub-patches/registry.ts "$SUB_NM/pi-sub-core/src/providers/registry.ts"
cp pi-setup/pi-sub-patches/grok.ts "$SUB_NM/pi-sub-core/src/providers/impl/grok.ts"
cp pi-setup/pi-sub-patches/bar-metadata.ts "$SUB_NM/pi-sub-bar/src/providers/metadata.ts"
cp pi-setup/pi-sub-patches/bar-settings-types.ts "$SUB_NM/pi-sub-bar/src/settings-types.ts"

# pi-tool-display config (verify exists, recreate if missing)
cp pi-setup/extensions/pi-tool-display/config.json ~/.pi/agent/extensions/pi-tool-display/config.json

# pi-claude-bridge — UNINSTALLED 2026-08-14. Reactivating needs a reinstall first:
# npm --prefix /opt/homebrew install -g pi-claude-bridge
# cp pi-setup/claude-bridge-patches/index.ts /opt/homebrew/lib/node_modules/pi-claude-bridge/index.ts
```

### What NOT to Do

- **Don't edit files directly in `/opt/homebrew/lib/node_modules/`** — they'll be wiped on the next npm update. Always edit in the repo (`pi-setup/`) and deploy via `install.sh` or manual `cp`.
- **Don't run `install.sh` without checking what changed** — it backs up existing files but overwrites them. If you've made live tweaks you want to keep, back them up first.
- **Don't reinstall condensed-milk-pi** — it silently rewrote failed git commands into success messages (`git add -A` rejected by permissions → reported as `ok (1 files staged)`), and needed three local patches to stay usable.
- **Don't set pi-tool-display overrides to `true`** — it replaces our custom tools with pi defaults, losing mutex locking, secret scrubbing, git trailers, image support.
- **Don't add `claude-agent-sdk-pi` back to packages** — it's the legacy bridge and conflicts with `pi-claude-bridge`.
- **Check `pi-setup/2026-05-17-migration-log.md`** if anything breaks — it has the full record of every change made, every decision, and rollback instructions.
- **Check `pi-setup/2026-07-30-bdsqqq-port.md`** before changing sub-agent tool wiring, `pi-spawn`, or the edit tools — it documents the OAuth tool-filter trap, the native `--tools` requirement, and the model-preservation rules.
