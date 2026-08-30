# pi version migrations

One entry per `pi update`. AGENTS.md carries only the *current* state and the
re-patch procedure; this file carries the per-version record — specifically
**which patched core file drifted and how the patch was re-derived**, because
that is the part that is easy to get wrong and expensive to discover late.

The standing rule, proven three times now: **never blind-copy a stored patch
file over a new pi release.** Diff stock-old vs stock-new first. Every release
so far has changed something *outside* our patch region, and copying the old
file would have silently reverted an upstream feature or fix.

---

## 0.84.4 (2026-08-30) — from 0.84.3; upstream fixed the /compact bug, patch retired

**`pi update` is broken on this machine.** The npm package declares
`devEngines: { packageManager: bun }`; npm 10.9.4 hard-fails install/view/pack
with EBADDEVENGINES, and `pi update` shells out to plain
`npm install -g --ignore-scripts --min-release-age=0` (no `--force`), so it
dies the same way. Working install (dry-run verified first):

```bash
npm install --prefix /opt/homebrew -g --force --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
```

`--prefix /opt/homebrew` is required: `npm root -g` here is the nvm root, not
the homebrew root pi runs from. `--force` is what bypasses the devEngines
check.

**Patch drift (stock 0.84.3 vs stock 0.84.4):**
- `resource-loader.js`, `keybindings.js`, `session-selector.js`,
  `dist/cli/args.js` — byte-identical. Stored patches re-applied as-is.
- `compaction/compaction.js` — CHANGED: upstream REMOVED the
  `toolChoice: "none"` we patched around in 0.84.3 (pi-mono #8649/#8638) and
  added `getSummarizationFailure` (rejects incomplete `length` stops). The
  stored patch is RETIRED and deleted from `pi-core-patches/` (recoverable from
  git history and `~/pi-update-backup-20260830_0843`). Compaction is now STOCK;
  verify-patches gained a guard that FAILS if `toolChoice` reappears in that
  file or `getSummarizationFailure` goes missing. Do NOT copy a stored file
  over compaction.js.
- pi-tui bundled `^0.84.4` — width patch anchors present; re-applied to the
  new copy (all other copies were already patched).

**Also on 0.84.4:** terminal capability overrides, `ui_prompt_start`/`_end`
extension events, RPC `clear_queue`, fullscreen selection copy, DeepSeek V4
Flash Vision exp. Spawn CLI flags unchanged. `@mariozechner/*` compat aliases
still present. `pi update` does not touch extensions; pi-mcp-adapter stayed
2.27.0 and pi-claude-code-use stayed 1.0.5 (still held).

**Verified live, not just by import audit:** `pi --version` 0.84.4 · modular
bin re-pinned to `dist/cli.js` (npm relinks bin to the bundle on install) ·
headless session replied `UPDATE_OK_0844` · one real sub-agent spawn
(`--tools read,grep,find,ls --model grok-4.5 --provider xai`) exit 0 with
session JSON streaming · tool surface has `mcp`, no `mcpScript` ·
`verify-patches.sh` all PASS. Rollback: `~/pi-update-backup-20260830_0843`
(3 patched 0.84.3 dist files, package.json, settings.json, mcp.json, auth.json,
bin link).

---

## 0.84.3 (2026-08-24) — from 0.84.2; the bundled-runtime release

**The one that changed the update procedure, not just the patches.** 0.84.3's
`bin` field points at `dist/bundle/cli.js` (0.84.2's pointed at the modular
`dist/cli.js`). The bundle inlines its own copies of resource-loader,
keybindings, session-selector and pi-tui, and loads **zero** on-disk
`dist/core/*` or `dist/modes/*` files — so after `pi update`, npm relinks the
bin to the bundle and every core patch goes silently inert while
`verify-patches.sh` still passes (it greps files that exist but are never
loaded).

**Fix, adopted as the standing procedure:** re-pin the bin to the modular
entrypoint after every update —

```bash
ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /opt/homebrew/bin/pi
```

`dist/cli.js` still ships in 0.84.3 and loads the modular core, so all three
patches + the width patch keep working; the only loss is the bundle's
startup-speed win. `verify-patches.sh` gained an entrypoint check that FAILS
loudly if the bin ever resolves to `dist/bundle/cli.js`.

**Patch drift (stock 0.84.2 vs stock 0.84.3):**
- `session-selector.js` — byte-identical. Deployed as-is.
- `resource-loader.js` — added `stripBom` import + two call sites, **outside**
  our patch region. RE-DERIVED onto fresh stock (suppression edit re-applied).
- `keybindings.js` — added `stripBom` + `useWindowsKeybindings`/`windowsKeybindings`
  machinery (macOS branches identical to 0.84.2 defaults), and `loadRawConfig`
  now strips BOM + inline-guards (equivalent to our `isRecord` there). RE-DERIVED:
  only the pin entry, `pinSession` migration and `toKeybindingsConfig` guard
  re-added; upstream's stripBom/windowsKeybindings kept.
- pi-tui bundled `^0.84.3` — width patch anchors all present; re-applied.
  Post-patch `patched >= stock` verified on 28 tokens (never lowers a width);
  the 6 DSR-measured vectors (हिंदी 4, क्त्र 3, বাংলা 5, 🖐 2, 日本語 6,
  👨👩👧👦 2) match exactly.

**Extension-migration verdict (asked for, investigated, answered):** the three
core patches **cannot** be moved to extensions — no API seam. The loader's
conflict diagnostics run during extension loading before any extension exists;
the session picker (`SessionSelectorComponent`, constructed directly at
`interactive-mode.js:4303`) has no override hook; pi-tui's `graphemeWidth` is a
non-exported function inside the module. A tool-name conflict scan found zero
live conflicts, so the resource-loader patch is a dormant safety net. Do not
re-attempt this migration; the pin above is the supported path.

**Also on 0.84.3:** `args.js` adds `--` end-of-options parsing and a
Windows-only `powershell` tool — none of `--tools/--model/--provider/--mode/
--thinking/--append-system-prompt` changed, so `pi-spawn.ts` is unaffected.
`@mariozechner/*` compat aliases intact. No new macOS keybinding conflicts.
`pi update` does not touch extensions, so pi-mcp-adapter stayed 2.27.0 and
pi-claude-code-use stayed 1.0.5 (still held).

**Verified live, not just by import audit:** `pi --version` 0.84.3 · headless
session replied `UPDATE_OK_0843` · one real sub-agent spawn (`--tools
read,grep,find,ls --model grok-4.5 --provider xai`) exit 0 with session JSON
streaming · tool surface has `mcp`, no `mcpScript` · `verify-patches.sh`
11/11 PASS. Rollback: `~/pi-update-backup-20260824_0842` (3 patched 0.84.2
dist files, VERSION, auth.json, settings.json, mcp.json).

**Post-install regression found same day — /compact 400s on xAI/OpenAI.**
0.84.3 added `toolChoice: "none"` unconditionally to every compaction
summarization request (`completeSummarization`, `dist/core/compaction/
compaction.js`), but the summarization context carries no tools, and the
Responses adapter serializes `toolChoice` → `tool_choice` whenever set
(`pi-ai/dist/api/openai-responses.js:239-240`). xAI and OpenAI reject
`tool_choice` without `tools` ("Invalid request content: A tool_choice was
set on the request but no tools were specified."), so `/compact` died with
"Compaction failed: Summarization failed: OpenAI API error (400)". Reproduced
live against `api.x.ai` before fixing. **Fix: fourth core patch**
(`pi-setup/pi-core-patches/compaction.js`) — `toolChoice` is now only set when
`context.tools?.length` is non-empty, which is never for summarization.
Deployed, module-verified (no toolChoice in requestOptions for a tool-less
context), and `verify-patches.sh` gained a guard for it (now 12 checks).
When upstream fixes this, drop the patch and re-verify /compact.

---

## 2026-08-14 — duplicate-copy cleanup (~3.0 GB), same day as 0.84.2

Not a version migration, but it belongs here because it changes **where packages
may live** and it fixed a latent hazard that a future update could have tripped.

**Three npm roots held the same pi packages at different versions.** pi loads
`npm:` packages only from `~/.pi/agent/npm/node_modules`
(`getManagedNpmInstallPath`, `dist/core/package-manager.js:1710-1719`). The other
two — `/opt/homebrew/lib/node_modules` (which also holds the pi binary) and
`~/.nvm/versions/node/v22.22.0/lib/node_modules` (what a bare `npm root -g`
resolves to) — held 18 stale pi packages between them, some ancient
(`pi-context@1.1.4` against the live 2.1.2).

**The hazard was not disk.** `getNpmInstallPath` (`package-manager.js:1728-1735`)
falls back to `join(npm root -g, name)` when a package is **missing** from the
managed store, and our `packages` entries pin no version. The nvm root held
`@benvargas/pi-claude-code-use@2.2.0` — the exact version AGENTS.md deliberately
holds at 1.0.5 — so one missing managed copy would have silently loaded it. An
earlier note in this repo claiming "no fallback to any global root" was **wrong**;
the fallback is real and was read at the call site to confirm.

**Second finding: 8 of those copies bundled UNPATCHED pi-tui** while
`verify-patches.sh` reported "ALL copies patched", because
`apply-pi-tui-width-patch.mjs` only searched `/opt/homebrew` and `~/.pi/agent`
— never `npm root -g`. Grepped each: no `__clusterAdvance`. So the audit was
blind exactly where the loadable-fallback root was.

Removed: 11 pi packages from the homebrew root (keeping
`@earendil-works/pi-coding-agent`, the binary), 7 from the nvm root
(`npm uninstall -g pi-mcp-adapter` for the one with a bin link, `trash` for the
rest), and **5** dangling symlinks in `~/.pi/agent/node_modules/` — four
`@mariozechner/*` plus `@sinclair/typebox`, all pointing at the pre-rename
`@mariozechner/pi-coding-agent` path. The whole `node_modules` dir is gone; pi
never constructs `join(agentDir, "node_modules")`.

pi-tui copies: **24 → 4**, all patched, all actually loaded.

**Two fixes so it cannot regress:**
- `apply-pi-tui-width-patch.mjs` now also scans `npm root -g` and the running
  pi's own root. **Verified by sabotage**: a fake unpatched copy planted in the
  nvm root is now found and flagged (exit 1); the old script saw nothing.
- `install.sh`'s `pi-claude-bridge` block is gone. It had been **broken for
  months**: `npm list -g` / `npm install -g` hit the nvm root while the patch
  block hardcoded `/opt/homebrew/...`, so the check always failed, the install
  went to one root and the patch was applied to a copy in another. Reinstall
  commands are preserved as comments.

**Verified after each step** (not just at the end): `pi --version`; a live
headless run asserting `mcp` + `context_compact` + `get_goal` still resolve —
deliberately three tools from three *different* packages whose duplicates had
just been deleted; then `apply_patch` + `screenshot` + `web_search` + `chad` to
prove the custom extension tools (which import `@mariozechner/pi-tui`, the
specifier those dead symlinks pretended to serve) still load; clean stderr; no
dangling bin symlinks in either root; `verify-patches.sh` 9/9 PASS.

One scare worth recording: `netlify` was missing from PATH afterwards. It was
**pre-existing and unrelated** — netlify-cli 24.4.0 is intact, but its bin links
are npm's *temporary* names (`.netlify-3lxmSHT1`, `.ntl-egPpTo9E`) from an
install interrupted on 5 Mar. Check timestamps before blaming your own change.

**Second pass, same day \u2014 stale artifacts (~5.1 GB more).** Eight backup dirs
from earlier migrations (2.6 GB `~/.pi/agent-backup-20260517`, 2.2 GB
`~/.pi-backup-20260423-204604`, `pi-cleanup-`, `pi-port-`, four `pi-update-`),
`~/.pi/agent/extensions-disabled/`, a Feb `agent/backups/` settings snapshot, one
stale md-export file, and an empty untracked `pi-setup/extensions/tools/.pi/todos`.

Each was **proved** redundant rather than assumed: the two large backups' session
files were diffed by name against the live store \u2014 2,235 and 619 sessions,
**zero unique to either**; every extension inside them was confirmed in git
history (`git log --all -- <path>`). `pi-sessions-extracted/` was kept as a
directory because `md-export.ts:584` uses it as a fallback output dir.

**A third hazard surfaced in that pass:** the repo's own
`pi-setup/extensions/tools/node_modules` held 3 **unpatched** pi-tui copies, and
install.sh copies that directory straight into the loaded path (`:102`). It
re-patches at `:250`, so ordering saved it \u2014 but correctness depending on step
order inside one script is fragile, and a manual `cp -R` deploy would have
installed unpatched copies into the live path. `apply-pi-tui-width-patch.mjs`
now also scans its own repo checkout, so the deployment SOURCE is patched.
Final count: **7 copies, all patched** (4 loaded + 3 deployment-source).

Verified afterwards: repo vs deployed is byte-identical for extensions, themes,
agent prompts, config skills and every config file except `settings.json`, whose
only diff was `lastChangelogVersion` (runtime state pi writes itself; repo bumped
to match) and JSON formatting pi rewrote \u2014 the load-bearing
`{ source, skills: [] }` object form is intact.

**`@benvargas/pi-claude-code-use` was NOT updated** and is still **1.0.5**,
mtime 17 Jul. Only `pi update --extension npm:pi-mcp-adapter` was run, never
`pi update --extensions`, which would have bumped it. Exactly one copy of it now
exists on the machine.

Everything went to Trash, recoverable. Inventory snapshot:
`/tmp/pi-cleanup-baseline.txt`.

---

## 0.84.2 (2026-08-14) — from 0.84.1, + pi-mcp-adapter 2.25.0

First release with **zero drift in all three patched core files** — stock 0.84.1
and stock 0.84.2 `resource-loader.js`, `session-selector.js` and
`keybindings.js` are byte-identical, so the stored patches were copied rather
than re-derived. They were still diffed from real tarballs first; the standing
rule is unchanged.

**pi-tui 0.84.1 → 0.84.2**, so pi core brought one fresh unpatched copy. The
apply script reported `patched v0.84.2` for it and `already-patched` for the
other 15; `--check` is clean across all 16.

**Four changelog lines looked dangerous and were each read at the call site**
rather than trusted — this is the class that took out every sub-agent in 0.84.0
(#7327):

- **`defaultTools` (new setting, new tool-selection path).** `sdk.js` now reads
  `options.tools ?? (noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))`.
  `--tools`, which is what `lib/pi-spawn.ts` passes, still wins outright, and we
  do not set `defaultTools`. Behaviour identical for us. **If we ever set
  `defaultTools`, re-read this line** — it sits directly upstream of every
  sub-agent's tool surface.
- **"Fixed custom system prompts concatenating the current working directory
  with later appended prompt content" (#7887).** The entire `system-prompt.js`
  diff is one trailing `\n` after `Current working directory: …`. No effect on
  our `system-prompt.ts` or on `--append-system-prompt`.
- **"Experimental strict JSON-schema constrained sampling for the default read,
  bash, edit and write tools".** Gated on `PI_EXPERIMENTAL=1`
  (`core/experimental.js`) and applied to pi's *built-ins*, which our tools
  replace. **This is not the `apply_patch` grammar trap** — that one throws in
  `resolveGrammarConstrainedSampling` for tools that declare
  `constrainedSampling` themselves, and ours still declares none.
- **"Fixed fallback rendering for extension tool results" (#7979).** Only
  touches the path for tools with no custom renderer; ours all render
  themselves.

**One regression this audit did NOT predict: a new keybinding conflict.** pi-tui
0.84.2 added `ctrl+shift+f` (fullscreen transcript search) and `ctrl+shift+g`,
and `pi-autoresearch` defaults its dashboard to `ctrl+shift+f` — so every startup
printed `Extension shortcut conflict` and the extension won, shadowing the new
built-in. The pre-install diff missed it because it compared pi **core**'s
`dist/core/keybindings.js` (byte-identical, correctly reported) while the new
binding shipped in the **pi-tui** package under the `tui.*` namespace. Lesson:
when a release adds a TUI feature with a shortcut, grep the new **pi-tui** for
`ctrl+`/`alt+` bindings too, not just pi core's keybindings map. Fixed via
autoresearch's own config file (`pi-setup/extensions/pi-autoresearch.json`,
`fullscreenDashboard: "ctrl+shift+r"`) rather than patching a git-installed
package that an update would overwrite.

Also checked because our extensions depend on them: `cli/args.js` gained
**`--use-theme` and nothing else** (`--tools`, `--model`, `--provider`,
`--mode`, `--thinking`, `--append-system-prompt` untouched), and
`interactive-mode.js` still guards with `if (!customEditor.onPasteImage)`, so
the editor's clipboard-image placeholder still wins.

**pi-mcp-adapter 2.21.0 → 2.25.0.** Both suppressions survive: the gate is
still `earlyConfig.settings?.scriptMode !== false` (`index.ts:651`), there are
still exactly two `registerTool` sites (`mcpScript`, `mcp`), and the shipped
`skills/` dir still contains only `mcp-scripting`. 2.24 added per-server
`searchKeywords`; 2.25 **changes the DEFAULT tool-result rendering** from the
boxed row to compact self-rendered rows — it measures with pi-tui's own
`truncateToWidth`/`visibleWidth`, i.e. the exact invariant our width work
requires, so it cannot reopen the smear/crash class. `settings.toolResultRendering:
"boxed"` restores the old row if the compact one is disliked.

**Verified live, not just by import audit:** `verify-patches.sh` 9/9 PASS before
and after; a headless session reports `mcpScript` absent / `mcp` present and no
`mcp-scripting` skill; and one real `finder` sub-agent was spawned against the
new binary and came back with correct cited output.

Only the two requested packages moved — `@benvargas/pi-claude-code-use` is still
**1.0.5**, and pi-context/pi-token-burden/pi-tool-display/pi-codex-goal are
unchanged (`pi update --extension npm:pi-mcp-adapter`, never `--extensions`,
which would have bumped the held-back one).

No backup dir: `install.sh` was not run, so the patches were re-applied by hand
(three `cp`s + the width script) as documented in AGENTS.md's quick re-patch
block.

**Machine note, found while auditing.** There are **three** npm global roots
here and they hold different versions of the same pi packages:
`/opt/homebrew/lib/node_modules` (where the `pi` binary itself lives),
`~/.nvm/versions/node/v22.22.0/lib/node_modules` (what a bare `npm root -g`
resolves to — it has `@benvargas/pi-claude-code-use@2.2.0`, the version we
deliberately do **not** want), and `~/.pi/agent/npm/node_modules` (the only one
pi actually loads packages from). Read package versions from the agent dir; a
bare `npm ls -g` reports the nvm root and will mislead you.

---

## 0.84.1 (2026-08-08) — from 0.83.0, + pi-codex-goal 0.2.0, pi-mcp-adapter 2.21.0

`@benvargas/pi-claude-code-use` deliberately **held at 1.0.5** (2.1.0 exists).
Audited against real tarballs before installing anything.

**Held-back package verified safe on 0.84.1.** 1.0.5 uses exactly one registry
API — `ctx.modelRegistry.isUsingOAuth(model)` — whose signature is unchanged,
so the `getApiKeyAndHeaders` → `string | null` breaking change misses it.
`before_provider_request` and the `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER` gate
are intact; all its imports still alias. Its `buildCaptureShim` lacks 0.84's new
`registerMarkdownTransformer`, which is harmless: `satisfies` is compile-time,
jiti does not typecheck, and the capture path only runs for exa/firecrawl
companions (not installed) or `toolAliases` in settings.json (we have none).
2.x's only ≥0.84 feature is display-only un-cloaking of `mcp__*` alias mentions
in assistant prose — it requires registered MCP aliases, which we never have.

**Breaking changes: none reach us.** Grepped our sources for every one
(`ModelsStreamTransforms`, `setRuntimeApiKey`, `modelRegistry.refresh`,
`getApiKeyAndHeaders`, `refreshToken`, `registerProvider`, `context.store`,
`JsonlSessionRepo`, `assistantMessageEvent`) — **zero hits**. The v4 lane-based
session rewrite is pi-agent-core *harness* API; the coding agent's own session
writer is untouched (`session-manager.js` diff is 6 lines, symlink discovery),
so our JSONL-parsing tools are safe. `dist/tools/` has **zero** changes, so the
nine tool overrides are safe.

**pi-core patches (verified stock 0.83.0 vs stock 0.84.1):**
- `resource-loader.js` — **RE-DERIVED.** 0.84.1 added `AGENTS.override.md` to the
  context-file candidate list (line 32) plus a comment reword, both **outside**
  our patch region (`addExtensionConflictDiagnostics`, same line numbers).
  Applied the suppression edit onto live stock 0.84.1, then copied live → repo.
  Blind-copying would have reverted the override feature.
- `keybindings.js` + `session-selector.js` — **0 upstream drift** (stock
  byte-identical). Repo copies deployed as-is; `app.session.pin` ×2,
  session-selector 7 `LOCAL PATCH`.
- pi-tui width patch — **the one to actually think about this release.** 0.84.0
  shipped #6987, upstream's own fix for Indic conjunct width, reworking
  `graphemeWidth` (new `terminalSpacingMarkRegex` early return, `followsMark`
  tracking). **All three of our anchors still match**, and since our patch is
  `max(upstream, __clusterAdvance)` it can only raise widths on the improved
  base — no new undercount, no double-count. Post-patch widths re-measured
  against the DSR vectors: हिंदी 4, क्त्र 3, বাংলা 5, 🖐 2, CJK 6, ZWJ family 2 —
  identical to patched 0.83.0. Patch is now partly redundant, not harmful; keep.

**New in 0.84 that touches us — `normalizeToolResultImages` (#7330).** pi now
runs *every* tool-returned image through Photon (max 2000×2000, 4.5MB) as it
enters history. Our images are already ≤2000px (the `MANY_IMAGE_MAX_EDGE` clamp),
so it returns `wasResized: false` and the original bytes pass through unchanged —
**no double resample, no injected dimension-hint text**. It does decode every
image in a worker to discover that, which defeats the `asis` never-decode fast
path; `images.autoResize: false` disables it if that cost ever matters.

**Packages (targeted `pi update npm:<pkg>`, never `--extensions`):**
- **pi-codex-goal 0.1.39 → 0.2.0** — minor number, trivial diff: 3 imports moved
  off `@earendil-works/pi-ai/compat` to the root specifier (early compat
  migration; the root still aliases to compat), and `executionMode: "sequential"`
  added to two tool defs (field valid in both 0.83.0 and 0.84.1). Tool names,
  schemas and behaviour unchanged. Note `engines.node: ">=24.0.0"` produces an
  npm EBADENGINE warning on node 22 — **pre-existing, 0.1.39 declared the same**,
  and `/goal` works.
- **pi-mcp-adapter 2.15.0 → 2.21.0** (6 minors) — two default-on behaviour
  changes needed decisions, both taken *against* the defaults:
  - 2.19.0 made **`mcpScript` a default-registered second tool** that executes
    arbitrary JavaScript in a worker. That contradicts the reason this package
    was chosen (one ~200-token proxy tool) and adds an execution surface
    `permissions.json` does not cover. **Disabled** via `settings.scriptMode:
    false` in `mcp.json`.
  - it also ships an **`mcp-scripting` skill**, which after the above would teach
    a tool that does not exist. **Suppressed** via the object-form package entry
    `{ "source": "npm:pi-mcp-adapter", "skills": [] }`. Verified against 0.84.1's
    `collectPackageResources`: with `autoload` unset, `skills: []` filters skills
    to none while `extensions` (undefined) still loads from the pi manifest.
  - riskiest change, **still unverified**: 2.20.0 migrated the MCP client from
    SDK v1 to `@modelcontextprotocol/client`+`/core` 2.0.0 (2.16.0 had rolled
    *back* to v1, so this path has churned). Default `protocolVersion` stays
    `"legacy"`. astro/paper are localhost HTTP with `auth: false`, but **neither
    app was running**, so the transport was never exercised. Test it the next
    time either app is open.

**Also done this pass:** `@mariozechner/clipboard` pinned in
`extensions/tools/package.json`. It is **not** a declared dependency of pi
0.83.0 or 0.84.1 — it was a stale leftover in pi's `node_modules` that npm could
prune at any update, which would have silently degraded editor image paste to
pi's path-insert with no error. AGENTS.md previously asserted it was "pi's own
dep, always present"; that was false and is now corrected.

**Smoke-tested:** `pi --version` 0.84.1 · `verify-patches.sh` 8/8 PASS ·
width-patch `--check` exit 0 · clean `pi -p` boot with real Claude reply
(`UPDATE_OK_0841`) · 38 tools listed incl. all 27 ours and **no `mcpScript`** ·
29 skills and **no `mcp-scripting`** · `get_goal` responds.
Rollback: `~/pi-update-backup-20260808_020648` (auth.json, settings.json,
mcp.json, the 3 patched 0.83.0 dist files, VERSION).

### What this migration BROKE — every sub-agent, and why the audit missed it

**Symptom:** first real session after the update, `oracle` failed instantly with

```
Model "claude-opus-4-6" is ambiguous across providers: anthropic/claude-opus-4-6,
cloudflare-ai-gateway/claude-opus-4-6, opencode/claude-opus-4-6.
More than one matching provider is authenticated. Use --provider or provider/model.
```

`finder`, `code_review`, `librarian`, `read_session` and `read_web_page`'s prompt
path were broken identically — all six carry a **bare** model constant and all six
spawn through `piSpawn`. Only `delegate` was unaffected, because it inherits
`parentModel`, which is already built as `${provider}/${id}`.

**Cause: 0.84.0 #7327**, which the release notes list under *Fixed* —
"bare exact `--model` IDs shared by multiple providers choosing the first catalog
entry instead of the sole authenticated provider or a clear ambiguity error".
Before, `--model claude-opus-4-6` silently resolved to the first catalog entry
(anthropic). Now, with anthropic + cloudflare-ai-gateway + opencode +
github-copilot all authenticated on this machine, `claude-sonnet-5` matches four
providers and `claude-opus-4-6` matches three, so it is a hard error.

Nothing to do with `pi-claude-code-use` — the held-back package was never involved,
though the failure looks like an auth problem and invites that conclusion.

**Fix:** `qualifyModel()` in `lib/pi-spawn.ts`, applied at the single seam every
sub-agent passes through. Tool constants stay bare model names (`claude-opus-4-6`)
— the provider is attached at spawn time, preferring the **parent's own provider**
(the one proven to serve Claude in this session) and falling back to `anthropic`.
Already-qualified ids pass through untouched. Verified across 11 parent/child
combinations including every non-Anthropic inherit path (kimi-code, deepseek,
sakana, llama-local) and delegate's inherit-parent rule; then live in fresh
sessions: oracle, finder, delegate, librarian all return normally.

**Why the audit missed it — the lesson worth keeping.** This exact changelog line
was read, understood, and written into the pre-update report *as a free win*
("Free wins for us: … #7327"). The audit checked the compat surface, the session
format, the patch anchors, the breaking-changes list and every API our extensions
*import* — but never grepped our own code for how it *invokes* pi. A CLI-argument
behaviour change is invisible to an import-level audit.

**Added to the post-update checklist:** grep our own `--model` / `--provider` /
`--tools` call sites (`lib/pi-spawn.ts`) whenever a release touches model
resolution or CLI argument handling. `verify-patches.sh` now asserts
`qualifyModel` is present in the deployed `pi-spawn.ts`, so a stale copy fails
loudly instead of at the first sub-agent call.

---

## 0.83.0 (2026-07-30) — from 0.82.1, + pi-context 2.1.2, pi-codex-goal 0.1.39

Mostly additive, one Breaking Change (TypeBox 1.3.7) our source was clean of.

- **Breaking — TypeBox 1.3.7:** removed `Type.Base/Awaited/Promise/AsyncIterator/
  Iterator/Options` and `Value.Mutate`; fixed compiled validation of nullable
  array tool args (#7243). Grep of our `.ts` source returned zero hits (only
  vendored typebox internals matched). No migration needed.
- **Additive:** `pi auth print-api-key`/`print-bearer-token` with OAuth refresh
  (#7168), headless OpenRouter login, Claude Opus 5 on Copilot, `ctx.scopedModels`
  (#7191), per-request `fetch` injection, `"pending"` stop reason, raw provider
  stop reasons surfacing unmapped terminal reasons as errors (#7272).
- **`resource-loader.js` — RE-DERIVED.** 0.83.0 added `findShadowedContextFile()`
  (worktree shadowing, ~lines 52-80) outside our patch region. Blind-copying the
  0.82.1 file would have reverted that feature.
- `keybindings.js` + `session-selector.js` — 0 drift, deployed as-is.
- **pi-context 2.1.1 → 2.1.2** — adds `didConversationAdvance()` so passive
  session entries no longer cancel a requested compaction. No API change.
- **pi-codex-goal 0.1.38 → 0.1.39** — pauses a goal when a hidden continuation
  run only calls `get_goal` with no actionable progress (#47). Tools unchanged.
- Backup: `~/pi-update-backup-20260730_235801`.

---

## 0.82.1 (2026-07-27) — from 0.82.0, + pi-web-access 0.14.0, pi-mcp-adapter 2.15.0

Purely additive upstream (no Breaking Changes section).

- **Additive:** Claude Opus 5 on Anthropic + Bedrock, `ANTHROPIC_AUTH_TOKEN`
  bearer auth for Anthropic-compatible gateways, `If-None-Match` catalog
  revalidation, `outputPad` for custom renderers (#7045). Helped us directly:
  startup context-file discovery now skips *directories* named like `AGENTS.md`
  (#7106 — we have one).
- **`resource-loader.js` — RE-DERIVED.** 0.82.1 added the `statSync().isFile()`
  EISDIR guard (#7106) outside our patch region; blind-copying would have
  reverted it.
- `keybindings.js` + `session-selector.js` — 0 drift.
- **pi-web-access 0.13.0 → 0.14.0** — its bundled `librarian` **skill** was
  dropped upstream; our custom `librarian` **tool** is separate and unaffected.
  (The package itself was removed entirely three days later.)
- **pi-mcp-adapter 2.11.0 → 2.15.0** — additive; the `get_`→`read_` rename
  affects only generated MCP *resource* tools, not the `mcp` proxy.
- Backup: `~/pi-update-backup-20260727_152216`.

---

## Standing caution — the compat entrypoint will be removed

`@mariozechner/*` aliases and `@earendil-works/pi-ai/compat` are slated for
removal "in a future release" (no version announced). Both are **still present
and verified in 0.84.2** — `getAliases()` still maps all seven
`@mariozechner/*` specifiers, and `@mariozechner/pi-ai` still resolves to
`ai/dist/compat.js`. Our 100 non-vendored extension `.ts` files import
exactly three specifiers, all aliased:
`@mariozechner/pi-coding-agent` (42), `@mariozechner/pi-tui` (33),
`@mariozechner/pi-ai` (8) — plus `@sinclair/typebox` (22), also aliased.

When removal lands: rename `@mariozechner/*` → `@earendil-works/*` across those
files and move runtime pi-ai imports to `/compat` or the `createModels()` API.
Re-check `getAliases()` in `dist/core/extensions/loader.js` every release —
that function is the whole compat surface.
