# you-should-know — and how Claude Code's version works

Built 2026-10-04. Claude Code 2.1.287 added `cc-plugin-you-should-know`; this records
what that mod actually does, why a naive port costs real money, and what we built
instead.

Code: `pi-setup/extensions/you-should-know/` → `~/.pi/agent/extensions/you-should-know/`.

---

## 1. What Claude's mod actually is

Not a prompt trick and not a hook on Claude's output. It is a **second model call**:

```
main agent works
  ↓ every N turns
side agent = full conversation + a detect prompt, one completion
  ↓
"learn: none"                            → nothing shown (the usual case)
"learn: …\ntag: …\nevidence: …\nexplain: …" → a note above the prompt box
```

The note sits above the prompt box with `1: Learn more  2: Know this already  0: Dismiss`.

The side agent's whole contract is a strict text format, either:

```
learn: none
```

or

```
learn: <1–2 sentences, ~20 words, ends with a period>
tag: You should know | Heads up
evidence: path/to/file.rs:197; test name; command
explain:
**<3–7 word title>**
<plain-English explainer, ≤120 words>
```

Two tags with distinct meaning: **Heads up** = about this session's work (a decision
Claude made, something it did not highlight, a result that may be off). **You should
know** = educational, how something works.

The prompt is ~500 lines of calibrated good/bad examples, and its dominant
instruction is *"Default to learn: none. The bar for showing a suggestion is very
high."* plus *"Interesting is not the same as important!"* — the consequence must be
money, time, wasted work, a wrong result, or a decision in flight.

### Where the real source is

Anthropic publishes `github.com/anthropics/claude-code/tree/main/mods`, but **not this
mod** — that directory holds only `agents-md`, `diff`, `sec-default`, `telemetry`,
`types`. The actual prompt was recovered from the CLI binary at
`~/.local/share/claude/versions/2.1.289` (a 229 MB Bun-compiled Mach-O). Useful
anchors: `grep -c you-should-know <binary>` finds the plugin id, and the prompt text
is plain strings in the region around offset 82.9 M.

A clean copy of the verbatim prompt also exists at
`github.com/aliceisjustplaying/pi-you-should-know` → `extensions/you-should-know/detect-prompt.md`
(labeled CC verbatim, and it matches what came out of the binary).

### Mod capability manifest (what a mod is allowed to touch)

Extracted from the same binary. Every mod declares its surface, e.g.:

```
scan.hooks: prompt.submit, command.run, turn.step, ui.render, session.detach, session.end
calls:      model.fork, state.get, state.set, store.get, store.set, telemetry.log,
            ui.invalidate, ui.toast, prompt.read, clock.after, session.id, …
env.reads:  CLAUDE_CODE_YOU_SHOULD_KNOW_DEBUG, USER_TYPE
state:      { plugin: "cc-plugin-you-should-know", key: "aboutOpen" }
```

So the side call is a `model.fork` — same model, same conversation, one extra turn.

---

## 2. The cost trap

`github.com/aliceisjustplaying/pi-you-should-know` documents this in commit `07c8784`,
measured on Opus 5.5:

| attempt | what happens | cost |
|---|---|---|
| `complete(conversation + detect prompt)` | no tools, no thinking pin → Anthropic kept tools+system cached but **rewrote every message** | **$1.30/check** |
| move the cache marker | Anthropic only looks back ~20 content blocks, so most checks missed | ~$1/check |
| **align to the main request** | snapshot the main payload in `before_provider_request`; on the fork replace the outgoing request with `{...main, messages:[main's byte-identical prefix, unmarked tail + detect prompt]}` | cache-read hits; the tail is paid once as plain input and **never written to cache** |

The rule this establishes: **a side call is only cheap if its prefix matches something
that is already cached.** A conversation-sized prompt sent cold is a conversation-sized
bill.

---

## 3. What we built, and where it differs

Our side call always runs on **`deepseek/deepseek-flash`**, whatever the session model
is. That is the whole cost strategy, because DeepSeek's cache is automatic and priced
for this:

| deepseek-flash | $/MTok |
|---|---|
| input | 0.30 |
| output | 1.20 |
| **cache read** | **0.006** (50× cheaper) |
| cache write | 0 — automatic, nothing to mark |

Measured on this machine across 1305 real turns: 97.1% cache hit, `cacheWrite` always 0.

Differences from both Claude's mod and the existing pi port:

| | Claude | alice's port | ours |
|---|---|---|---|
| side model | same as session | same as session (`YSK_MODEL` opt) | **always deepseek-flash** |
| cache strategy | Anthropic `model.fork` | Anthropic-shaped payload align | fixed request shape, no alignment |
| trigger | `turn.step` | `turn_end` every 6, **reset per agent run** | `turn_end` every 6, **counted across prompts** |
| timers | — | 2 s inbox poll for herdr | **none** — nothing periodic |
| sub-agents | only the Task summary | only the summary | **child tool calls inlined as evidence** |
| tests | — | none | `logic.test.ts`, 31 cases |

The counter difference matters for pi: `turnIndex` resets at `agent_start`, so a
session made of many short questions would never reach 6. Ours accumulates.

### The sub-agent block (our addition)

A sub-agent's tool result carries the child's **entire transcript** in
`details.messages`, so its real tool calls are available without reading any file. We
extract, per sub-agent: the task, exit code, files edited, tool calls in order, and its
final claim — then inline them into the detect prompt under a heading that says the
claim is not evidence.

That is what makes *"heads up: the sub-agent loosened the tests instead of fixing the
code"* detectable. Claude's side agent and the existing port both see only the
summary their child handed back, so neither can check a claim against the work.

---

## 4. Verified numbers

Real sessions, this machine, side agent on deepseek-flash. Each check is one completion;
`checks.jsonl` carries the per-check line.

| session model | input | cacheRead | output | cost | wall |
|---|---|---|---|---|---|
| `xai/grok-4.6` | 21,241 | 15,232 | 76 | **$0.0033** | 1.9 s |
| `deepseek/deepseek-flash` | 8,296 | **28,288** | 31 | **$0.0013** | 1.3 s |

What a check costs is almost entirely about whether our own previous check is still in
the cache, so the first check of a session is the expensive one:

| | input | cacheRead | hit | cost |
|---|---|---|---|---|
| first check of a session (cold) | 31,897 | 4,864 | 13% | **$0.0048** |
| second check, same session | 8,107 | 29,056 | 78% | **$0.0013** |

The warm check is 3.6× cheaper. That is the design paying off: because every check sends
the same shape, check N+1 shares a long prefix with check N and DeepSeek serves it from
cache. A 120-turn session is therefore one cold check plus nineteen warm ones ≈
**3 cents**. A cold, unaligned version of the same call would be ~27× that, which is the
entire reason the request shape is fixed rather than tuned per call.

Checks return `none` on trivial work — the expected common case, and the prompt's
explicit default, not a failure.

Every check appends one line to `~/.pi/agent/you-should-know/checks.jsonl` with
`outcome`, `ms`, `input`, `cacheRead`, `output`, `cost`. That file is the cost
instrument — read it before believing anything about spend.

---

## 5. Files, state, tuning

```
pi-setup/extensions/you-should-know/
├── index.ts            wiring: hooks, widget, respond flow, the side call
├── logic.ts            pure: cadence numbers, parser, sub-agent extractor
├── logic.test.ts       bun test logic.test.ts   (31 cases, ~8 ms, no pi deps)
└── detect-prompt.md    the prompt (Claude's, with our sub-agent section)
```

`~/.pi/agent/you-should-know/` (user data, never in the repo):

| file | contents |
|---|---|
| `state.json` | `enabled`, `seen[]`, `known[]`, `ignoredInARow`, `skip`, `checks`, `shown` |
| `checks.jsonl` | one line per check, with tokens and cost |

`/ysk` answers the top note · `/ysk on` / `off` / `status` · `ctrl+shift+y` same as bare
`/ysk`. Knobs live at the top of `logic.ts`: `CHECK_EVERY_TURNS` (6), `FREE_IGNORES`
(2), `MAX_SKIP` (16), `MAX_NOTES` (5), `HISTORY_MAX` (50), `SUB_AGENT_REPORTS` (3).

Deliberate properties worth not "fixing":

- **Off by default.** `emptyState()` sets `enabled: false`, and `loadState` treats a
  missing field as "off" rather than "on unless disabled". Anyone who clones this setup
  has to run `/ysk on`, so nobody discovers the spend by seeing a bill. A bare `/ysk`
  while off says how to enable it instead of "nothing to know".
- **Nothing polls.** The one timer in the file is a per-request `setTimeout` abort,
  cleared in `finally`. Nothing survives a session, so there is nothing for
  `session_shutdown` to leak.
- **The prompt fails closed.** If `detect-prompt.md` cannot be read, checks stay off and
  the reason is notified — an empty prompt would produce confident, useless notes.
- **The side call never touches the conversation.** The only path in is the user
  choosing "Chat in main session", which sends a `followUp`.
- **Fixed request shape.** No tools, no per-check options. Changing the shape changes the
  prefix and throws away the cache — the thing that makes this affordable.
- **`test/`-style files can sit beside the extension** because pi loads only `index.ts`
  from a subdirectory.

## 6. Not verified

- Behaviour on a session whose conversation was compacted mid-run.
- Whether DeepSeek's cache survives a long idle between checks (its TTL is unpublished).
- Note quality on genuinely subtle sessions — only `none` outcomes were exercised here;
  the shown/respond path was verified against seeded notes, not a real note.
