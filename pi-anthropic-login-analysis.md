# Analysis: pi `/login anthropic`, `@benvargas/pi-claude-code-use`, and Claude Code CLI

**Date:** 2026-06-15  
**Workspace:** `/Users/muzammil/Documents/Code stuff/ghosttyyy`  
**pi version:** 0.79.2 (`@earendil-works/pi-coding-agent`)  
**`@benvargas/pi-claude-code-use` version:** 1.0.4  
**Claude Code CLI version:** 2.1.173 (`~/.local/bin/claude`)

---

## Executive Summary

- **Anthropic OAuth in pi is native**, implemented in `@earendil-works/pi-ai` (the shared AI package). It performs PKCE authorization-code flow against Anthropic's own OAuth endpoints, stores tokens in `~/.pi/agent/auth.json`, and refreshes them under a file lock.
- **`@benvargas/pi-claude-code-use` is a third-party extension, not part of pi core.** It hooks `before_provider_request` **only** when the active model is `anthropic` **and** pi has an OAuth credential for it. It rewrites **outbound API request payloads** (system-prompt wording and tool names), not OAuth token requests.
- **The extension does not spawn the Claude Code CLI**, does not read `~/.claude/settings.json`, and does not replace pi's Anthropic transport. It operates entirely inside pi's native `anthropic` provider request path.
- **The official Claude Code CLI (`claude`) is a separate program** with its own config directory (`~/.claude`), session store, plugins, and login mechanism. It is not invoked by pi or by `pi-claude-code-use` during `/login anthropic`.
- **`pi-claude-bridge` is a different custom provider** that uses `@anthropic-ai/claude-agent-sdk` and can spawn the Claude Code CLI subprocess. It is installed but inactive in this setup.
- **`AGENTS.md` contains materially inaccurate claims** about what `pi-claude-code-use` does: it says the package "intercepts OAuth requests and rewrites payloads," when in fact the OAuth flow is native and the extension only intercepts provider API requests.

---

## 1. Native Anthropic OAuth in pi

### 1.1 Implementation location

The OAuth provider lives in the shared AI package, not in `pi-coding-agent` directly:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/oauth/anthropic.js
```

It is exported through the OAuth registry:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/oauth/index.js
```

Built-in providers in that registry are `anthropicOAuthProvider`, `githubCopilotOAuthProvider`, and `openaiCodexOAuthProvider`.

### 1.2 OAuth constants

From `anthropic.js:11-19`:

```javascript
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"); // → 9d1c250a-e61b-44d9-88ed-5944d1962f5e
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
```

The flow uses a local HTTP callback server on `127.0.0.1:53692` (`anthropic.js:79-140`) and PKCE (`anthropic.js:190-204`).

### 1.3 Token storage and refresh

Tokens are stored in pi's central credential store at `~/.pi/agent/auth.json`. The current Anthropic entry is:

```json
{
  "anthropic": {
    "type": "oauth",
    "refresh": "...",
    "access": "...",
    "expires": 1781468179377
  }
}
```

Refresh logic is in `AuthStorage.getApiKey()` at:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js
```

It refreshes expired tokens under a file lock and returns `provider.getApiKey(cred)` — i.e., the access token (`anthropic.js:331-333`).

### 1.4 Native Anthropic provider already impersonates Claude Code

The provider file:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js
```

detects OAuth tokens by the `sk-ant-oat` prefix (`anthropic.js:587-589`) and, when OAuth is used, builds the Anthropic SDK client with:

```javascript
{
  apiKey: null,
  authToken: apiKey,          // the OAuth access token
  defaultHeaders: {
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,...",
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli"
  }
}
```

(`anthropic.js:632-647`). It also prepends the system prompt with:

> "You are Claude Code, Anthropic's official CLI for Claude."

(`anthropic.js:674-680`).

So the native provider already performs the "Claude Code-style subscription use" identity spoofing. The extension layers additional changes on top.

### 1.5 OAuth detection in UI

`ModelRegistry.isUsingOAuth(model)` checks whether the model's provider has an OAuth credential in `authStorage`:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:652-655
```

The interactive footer appends `"(sub)"` when this is true:

```
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js:126-129
```

---

## 2. What `@benvargas/pi-claude-code-use` actually does

### 2.1 Activation conditions

The extension registers one `before_provider_request` handler (`extensions/index.ts:729-743`):

```typescript
pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) {
        return undefined;
    }
    ...
});
```

It only runs for **Anthropic OAuth requests**. API-key Anthropic usage and non-Anthropic providers are untouched.

### 2.2 Payload transformations

When active, it deep-clones the payload and applies `transformPayload()` (`extensions/index.ts:370-413`):

1. **System prompt rewrite** (`rewritePromptText`, `extensions/index.ts:218-223`):
   - `"pi itself"` → `"the cli itself"`
   - `"pi .md files"` → `"cli .md files"`
   - `"pi packages"` → `"cli packages"`

2. **Tool filtering / remapping** (`filterAndRemapTools`, `extensions/index.ts:273-327`):
   - Passes through Anthropic-native typed tools (`tool.type` is a string).
   - Passes through a hard-coded allowlist of core Claude Code tool names (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `KillShell`, `NotebookEdit`, `Skill`, `Task`, `TaskOutput`, `TodoWrite`, `WebFetch`, `WebSearch`).
   - Passes through any tool already prefixed with `mcp__`.
   - Renames known companion tools to MCP-style aliases, e.g. `web_search_exa` → `mcp__exa__web_search`.
   - Drops unknown flat-named tools unless `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1`.

3. **`tool_choice` remapping** (`remapToolChoice`, `extensions/index.ts:329-349`).

4. **Message history rewriting** (`remapMessageToolNames`, `extensions/index.ts:351-364`) so historical `tool_use` blocks use the same MCP names.

5. **Managed alias unaliasing** on `message_end` (`unaliasToolCalls`, `extensions/index.ts:199-209`) so that when the model calls a managed MCP alias, pi executes the original flat tool.

### 2.3 What it does NOT do

- It does **not** register a provider.
- It does **not** replace `apiKey`/`authToken` headers.
- It does **not** touch the OAuth authorize/token endpoints.
- It does **not** spawn `claude -p` or any Claude Code CLI subprocess.
- It does **not** read `~/.claude/settings.json` or `~/.claude/auth.json`.

Its own README states this explicitly (`README.md:4-6`):

> "`pi-claude-code-use` keeps Pi's built-in `anthropic` provider intact and applies the smallest payload changes needed for Anthropic OAuth subscription use in Pi. It does not register a new provider or replace Pi's Anthropic request transport."

---

## 3. Claude Code CLI (`claude`)

### 3.1 Separate binary and config

Claude Code CLI is installed at `~/.local/bin/claude` (v2.1.173). It maintains its own state under `~/.claude`:

```
~/.claude/settings.json
~/.claude/sessions/
~/.claude/plugins/
~/.claude/history.jsonl
...
```

The settings file contains user preferences, plugins, hooks (`PreToolUse`), and a `model` field (`"claude-fable-5[1m]"`). There is no `~/.claude/auth.json`; the CLI manages its own session/auth separately.

### 3.2 Not invoked by pi or by `pi-claude-code-use`

A workspace-wide search found no `exec("claude"` or `spawn("claude"` calls in `pi-claude-code-use`. The only `claude` references in the relevant pi packages are:

- User-agent strings in the native Anthropic provider (`claude-cli/2.1.75`).
- Documentation/comments about Claude Code tool names.

---

## 4. `pi-claude-bridge` (inactive custom provider)

`pi-claude-bridge` is a distinct package installed at:

```
/opt/homebrew/lib/node_modules/pi-claude-bridge/
```

It imports `@anthropic-ai/claude-agent-sdk` (`src/index.ts:4`) and uses `createSdkMcpServer`, `query`, and `buildSessionContext`. It can spawn a Claude Code CLI subprocess for debug logging (`src/index.ts:68-86`) and uses `~/.claude` session files (`cc-session-io`). Its provider ID is `claude-bridge` (`src/convert.ts:8`).

It is **not listed** in `~/.pi/agent/settings.json` and is therefore inactive. `AGENTS.md` correctly describes it as "legacy fallback" and "installed but inactive."

---

## 5. Comparison Table

| Aspect | Native pi Anthropic OAuth | `@benvargas/pi-claude-code-use` | Official Claude Code CLI (`claude`) |
|---|---|---|---|
| **Code location** | `@earendil-works/pi-ai/dist/utils/oauth/anthropic.js` and `dist/providers/anthropic.js` | `@benvargas/pi-claude-code-use/extensions/index.ts` | `~/.local/bin/claude` (v2.1.173) |
| **Relationship to pi** | First-class, built-in provider | Third-party npm package loaded as pi extension | External binary, unrelated to pi |
| **Triggered by** | `/login anthropic` command | `before_provider_request` when `model.provider === "anthropic"` and OAuth is active | User runs `claude` in a terminal |
| **OAuth endpoints** | `https://claude.ai/oauth/authorize` → `https://platform.claude.com/v1/oauth/token` | None | Anthropic's CLI-specific login |
| **Credential store** | `~/.pi/agent/auth.json` | Reads `ctx.modelRegistry.isUsingOAuth()`; does not store credentials | `~/.claude/` (no `auth.json` observed) |
| **HTTP transport** | Native `Anthropic` SDK client with `authToken` and Claude Code headers | Does not replace transport; mutates payload before native transport sends it | Own SDK + CLI subprocess |
| **System prompt** | Native provider prepends "You are Claude Code, Anthropic's official CLI for Claude." | Rewrites `"pi itself"` → `"the cli itself"`, etc. | Own prompt, managed by CLI |
| **Tool handling** | Native provider maps tool names to Pascal-case Claude Code names (`toClaudeCodeName`) | Filters/remaps flat tools to `mcp__` aliases; unaliases managed calls on `message_end` | Full Claude Code tool set |
| **Spawns `claude -p`** | No | No | N/A (it *is* `claude`) |
| **Reads `~/.claude`** | No | No | Yes — owns the directory |
| **Status in this setup** | Active when `/model anthropic/*` + OAuth | Active package in `~/.pi/agent/settings.json` | Installed but not used by pi |

---

## 6. Contradictions with `AGENTS.md`

| `AGENTS.md` claim | Location | What the code shows | Verdict |
|---|---|---|---|
| "`anthropic` provider (native) + `pi-claude-code-use` (OAuth rewrite for Claude Max)" | Line 25 | `pi-claude-code-use` rewrites **API request payloads** (system text + tool names), not OAuth token/login payloads. OAuth itself is native. | Misleading |
| "`@benvargas/pi-claude-code-use` … Patches Anthropic OAuth payloads for Claude Max subscription use" | Line 296 | Package description says "Patch Anthropic OAuth payloads," but the actual code mutates `before_provider_request` payloads (tools/system), not OAuth authorize/token requests. | Imprecise / marketing wording |
| "`pi-claude-code-use` intercepts OAuth requests and rewrites payloads for Claude Code-style subscription use" | Line 312 | The extension intercepts **provider API requests** (`before_provider_request`), not OAuth requests. OAuth endpoints and token refresh are handled natively by `@earendil-works/pi-ai`. | **False** |
| "No custom provider needed — uses pi's native `anthropic` provider" | Line 312 | Correct. The extension does not register a provider and only activates inside the native `anthropic` provider path. | Accurate |
| Legacy `pi-claude-bridge` described as inactive | Package table | Confirmed not in `~/.pi/agent/settings.json` packages list. | Accurate |

### 6.1 Why the distinction matters

Saying "intercepts OAuth requests" implies the extension sits between the user and Anthropic's token endpoint, which would mean it could read or modify refresh tokens. That is not true. The extension receives an already-authenticated provider request object and changes tool names + prompt wording. The OAuth credentials remain managed entirely by pi core's `AuthStorage` and `anthropicOAuthProvider`.

---

## 7. Exact code references

### Native OAuth

- `CLIENT_ID` decode and endpoints: `anthropic.js:11-19`
- PKCE + callback server: `anthropic.js:79-204`
- Token exchange: `anthropic.js:158-185`
- Refresh token: `anthropic.js:291-315`
- Provider export: `anthropic.js:316-334`
- OAuth registry: `utils/oauth/index.js`

### Native provider Claude Code impersonation

- OAuth token detection: `providers/anthropic.js:587-589`
- OAuth client headers + system prompt injection: `providers/anthropic.js:632-689`
- `claudeCodeTools` list: `providers/anthropic.js:40-58`

### Extension behavior

- Entry point: `@benvargas/pi-claude-code-use/extensions/index.ts:710-744`
- Activation gate (`provider === "anthropic"` + OAuth): `index.ts:731`
- `transformPayload`: `index.ts:370-413`
- `rewritePromptText`: `index.ts:218-223`
- `filterAndRemapTools`: `index.ts:273-327`
- `before_provider_request` runner: `pi-coding-agent/dist/core/extensions/runner.js:714-744`

### UI / model registry

- `isUsingOAuth`: `pi-coding-agent/dist/core/model-registry.js:652-655`
- Footer `(sub)` indicator: `pi-coding-agent/dist/modes/interactive/components/footer.js:126-129`

### Settings / credentials

- Active packages: `~/.pi/agent/settings.json`
- Stored OAuth tokens: `~/.pi/agent/auth.json`
- Claude Code CLI config: `~/.claude/settings.json`

---

## 8. Conclusion

pi's `/login anthropic` flow is **native** to `@earendil-works/pi-ai`. It performs a standard PKCE OAuth flow against Anthropic's own endpoints, stores tokens in `~/.pi/agent/auth.json`, and the native `anthropic` provider already adds Claude Code identity headers and system text when an OAuth token is used.

`@benvargas/pi-claude-code-use` is an **additional compatibility shim** that runs inside pi's native provider path. It rewrites outbound API request payloads (system prompt wording and tool names) but does not intercept OAuth requests, replace the transport, or spawn the Claude Code CLI.

The official Claude Code CLI (`claude`) is a **separate program** with its own configuration and auth ecosystem. It is not involved in pi's `/login anthropic` flow.

`AGENTS.md` should be corrected to state that `pi-claude-code-use` intercepts **provider API requests** (after OAuth) for tool-name and system-prompt compatibility, not that it "intercepts OAuth requests" or "rewrites OAuth payloads."
