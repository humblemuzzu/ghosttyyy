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
and verified in 0.84.1**, and our 100 non-vendored extension `.ts` files import
exactly three specifiers, all aliased:
`@mariozechner/pi-coding-agent` (42), `@mariozechner/pi-tui` (33),
`@mariozechner/pi-ai` (8) — plus `@sinclair/typebox` (22), also aliased.

When removal lands: rename `@mariozechner/*` → `@earendil-works/*` across those
files and move runtime pi-ai imports to `/compat` or the `createModels()` API.
Re-check `getAliases()` in `dist/core/extensions/loader.js` every release —
that function is the whole compat surface.
