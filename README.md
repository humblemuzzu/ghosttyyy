# 👻 ghosttyyy

A curated, aesthetic Ghostty terminal setup with **10 dark themes**, **11 developer fonts**, and **live-switching** — plus a **full portable pi (coding agent) setup** with 11 extensions, 17 skills, a multi-agent system, and custom TUI.

Scroll through themes and fonts and watch your terminal change **in real-time**. Press Enter to keep it, Esc to revert.

> Themes inspired by [opencode](https://github.com/anomalyco/opencode)'s theme system — Tokyo Night, Catppuccin, Dracula, Kanagawa, Rosé Pine, and more.

---

## What's in this repo

| Folder | What it is |
|--------|-----------|
| `config`, `themes/`, `scripts/` | Ghostty terminal customization — themes, fonts, cursor styles, live preview |
| `pi-setup/` | Full portable [pi](https://github.com/badlogic/pi-mono) coding agent setup — extensions, themes, skills, subagent prompts, config |

---

# Part 1: Ghostty Terminal Setup

## ✨ Features

- 🎨 **10 hand-crafted dark themes** with full 16-color ANSI palettes
- 🔤 **11 premium developer fonts** (JetBrains Mono, Fira Code, Geist Mono, etc.)
- ✏️ **3 cursor styles** × 2 blink modes = 6 combinations
- 🪟 **Frosted glass effect** — background blur + opacity
- ⚡ **Live preview** — themes/fonts/cursors apply in real-time as you browse
- ↩️ **Esc to revert** — cancelled? automatically goes back to what you had
- 📦 **One-command install** — fonts, themes, scripts, config, all set up

---

## 📸 What You Get

| Command | What it does |
|---------|-------------|
| `gg` | Master config hub — pick what to customize |
| `gt` | Interactive theme switcher with **live preview** |
| `gf` | Interactive font switcher with **live preview** |
| `gc` | Interactive cursor style switcher with **live preview** |

---

## 🚀 Ghostty Installation

### Prerequisites

- **macOS** (tested on macOS 14+)
- **[Ghostty](https://ghostty.org)** terminal installed
- **[Homebrew](https://brew.sh)** package manager

### One-Command Install

```bash
git clone https://github.com/humblemuzzu/ghosttyyy.git
cd ghosttyyy
./install.sh
```

The install script will:
1. ✅ Check that Ghostty is installed
2. 📦 Install `fzf` (the fuzzy finder that powers the switchers)
3. 🔤 Install all 11 developer fonts via Homebrew
4. ⚙️ Back up your existing Ghostty config and install the new one
5. 🎨 Copy all 10 themes to the correct directory
6. 🛠️ Install the switcher scripts (`gtheme`, `gfont`, `gcursor`, `ghostty-config`)
7. 🔗 Add PATH and shell aliases to your `.zshrc`

After the install completes:

```bash
source ~/.zshrc
```

> You only need to run `source` once. Every new terminal tab/window will have the aliases automatically.

---

## ⚠️ IMPORTANT: macOS Accessibility Permissions

The **live preview** feature works by sending a config-reload keystroke (`⌘+Shift+,`) to Ghostty when you scroll through options. macOS requires **Accessibility permissions** for this to work.

### How to grant permissions:

1. Open **System Settings**
2. Go to **Privacy & Security** → **Accessibility**
3. Click the **+** button
4. Add **Ghostty** (`/Applications/Ghostty.app`)
5. Add your **Terminal app** (Ghostty itself, or Terminal.app if you ran the install from there)
6. Make sure both toggles are **ON** ✅

> **Without this step**, the live preview won't auto-reload. You can still use the switchers — you'll just need to press `⌘+Shift+,` manually after selecting.

---

## 📁 File Structure

Here's what goes where and why:

### Repository

```
ghosttyyy/
├── README.md              ← you're here
├── install.sh             ← one-command installer
├── config                 ← main Ghostty config file
├── themes/                ← all 10 theme files
│   ├── midnight-code
│   ├── catppuccin-macchiato
│   ├── dracula-pro
│   ├── vesper
│   ├── kanagawa
│   ├── rosepine
│   ├── gruvbox-dark
│   ├── nord-frost
│   ├── opencode
│   └── synthwave
├── scripts/               ← switcher scripts
│   ├── gtheme             ← theme switcher
│   ├── gfont              ← font switcher
│   ├── gcursor            ← cursor switcher
│   └── ghostty-config     ← master hub
└── pi-setup/              ← full pi coding agent setup (see Part 2)
```

### Where files get installed on your system

| File | Installed to | Purpose |
|------|-------------|---------|
| `config` | `~/Library/Application Support/com.mitchellh.ghostty/config` | Main Ghostty config — theme, font, cursor, opacity, padding, everything |
| `themes/*` | `~/.config/ghostty/themes/` | Custom theme files. **This is the directory Ghostty looks in** for custom themes |
| `scripts/*` | `~/.local/bin/` | The switcher scripts. Added to your PATH |

> **⚠️ Common mistake:** Ghostty does NOT look for themes in `~/Library/Application Support/com.mitchellh.ghostty/themes/`. It looks in `~/.config/ghostty/themes/`. This tripped us up during development.

---

## 🎨 Themes

All themes are dark. Each has a carefully tuned 16-color ANSI palette, cursor color, selection colors, and background.

| Theme | Vibe | Background |
|-------|------|-----------|
| **midnight-code** | Deep blue-black, pastel accents | `#1a1b26` |
| **catppuccin-macchiato** | Warm purple-blue, soft pastels, cozy | `#24273a` |
| **dracula-pro** | Classic purple, vibrant neons | `#282a36` |
| **vesper** | True black, warm amber + mint, ultra minimal | `#101010` |
| **kanagawa** | Japanese ink, muted earth tones, zen | `#1f1f28` |
| **rosepine** | Dark plum, floral pinks & golds, elegant | `#191724` |
| **gruvbox-dark** | Warm brown-orange, retro vibes | `#1d2021` |
| **nord-frost** | Arctic blue-gray, cool & Scandinavian | `#2e3440` |
| **opencode** | Near-black, orange accent, developer pro | `#0a0a0a` |
| **synthwave** | 80s neon purple, hot pink, electric retro | `#1b1720` |

### Switching themes

```bash
gt
```

Use arrow keys to browse. **Your terminal changes live** as you move through the list. Press Enter to keep, Esc to revert.

### Manual switching

Edit `~/Library/Application Support/com.mitchellh.ghostty/config`:

```ini
theme = kanagawa
```

Then press `⌘+Shift+,` to reload.

---

## 🔤 Fonts

All fonts are installed via Homebrew. Each one is a monospace font designed for coding.

| Font | Size | Character |
|------|------|-----------|
| **JetBrains Mono** | 14pt | Sharp, clean, best all-rounder. Ligatures. Default. |
| **Geist Mono** | 14pt | Vercel's font. Ultra minimal & modern. |
| **Fira Code** | 14pt | The OG ligature font. Wide & very readable. |
| **Cascadia Code** | 14pt | Microsoft's terminal font. Friendly curves. |
| **Monaspace Neon** | 14pt | GitHub's font family. Techy, texture healing. |
| **Monaspace Argon** | 14pt | GitHub's softer, rounder variant. |
| **Monaspace Radon** | 14pt | GitHub's handwritten feel. Unique. |
| **Victor Mono** | 15pt | Thin elegant strokes. Beautiful cursive italics. |
| **Maple Mono** | 14pt | Playful but clean. Rounded terminals. |
| **Commit Mono** | 14pt | Neutral & balanced. Great for long sessions. |
| **Iosevka** | 14pt | Ultra-narrow. Fits maximum columns on screen. |

### Switching fonts

```bash
gf
```

Live preview — your terminal font changes as you scroll. Enter to keep, Esc to revert.

---

## ✏️ Cursor Styles

| Style | Look | Blink |
|-------|------|-------|
| bar + blink | `▏` thin blinking line | ✅ |
| block + blink | `█` solid blinking block | ✅ |
| underline + blink | `▁` thin blinking underline | ✅ |
| bar + static | `▏` thin steady line | ❌ |
| block + static | `█` solid steady block | ❌ |
| underline + static | `▁` thin steady underline | ❌ |

### Switching cursor

```bash
gc
```

---

## 🪟 Opacity & Blur

The config comes with a frosted glass effect:

```ini
background-opacity = 0.92
background-blur = 20
```

### Changing opacity

Use the master hub:

```bash
gg
```

Select "Opacity" and pick a preset:

| Preset | Value | Effect |
|--------|-------|--------|
| Solid | `1.0` | No transparency |
| Barely there | `0.95` | Very subtle |
| Subtle glass | `0.92` | Default — sweet spot |
| Frosted | `0.88` | Noticeable transparency |
| See-through | `0.82` | Desktop clearly visible |
| Very transparent | `0.75` | Maximum vibes |

Or enter a custom value between `0.0` and `1.0`.

---

## ⚙️ Config Reference

The main config file at `~/Library/Application Support/com.mitchellh.ghostty/config` has everything organized in labeled sections:

```ini
# ── THEME ──────────────
theme = midnight-code        # just change this name

# ── FONT ───────────────
font-family = JetBrains Mono
font-size = 14

# ── CURSOR ─────────────
cursor-style = bar
cursor-style-blink = true

# ── WINDOW ─────────────
window-padding-x = 16
window-padding-y = 12
macos-titlebar-style = tabs

# ── OPACITY & BLUR ─────
background-opacity = 0.92
background-blur = 20
```

### Hot-reload

After editing the config file manually, press `⌘+Shift+,` in Ghostty to reload without restarting.

---

## 🧩 Adding Your Own Theme

1. Create a file in `~/.config/ghostty/themes/` (no extension needed):

```bash
touch ~/.config/ghostty/themes/my-theme
```

2. Add your colors:

```ini
background = #0d1117
foreground = #e6edf3
cursor-color = #58a6ff
cursor-text = #0d1117
selection-background = #264f78
selection-foreground = #e6edf3
palette = 0=#0d1117
palette = 1=#ff7b72
palette = 2=#7ee787
palette = 3=#d29922
palette = 4=#58a6ff
palette = 5=#bc8cff
palette = 6=#39d2c0
palette = 7=#e6edf3
palette = 8=#484f58
palette = 9=#ffa198
palette = 10=#56d364
palette = 11=#e3b341
palette = 12=#79c0ff
palette = 13=#d2a8ff
palette = 14=#56d4dd
palette = 15=#ffffff
```

3. Use it:

```ini
theme = my-theme
```

4. Reload: `⌘+Shift+,`

The theme will also appear in the `gt` switcher automatically.

---

# Part 2: Pi Coding Agent Setup

Everything in `pi-setup/` is a portable backup of my full [pi](https://github.com/badlogic/pi-mono) coding agent environment — the custom TUI, all extensions, the multi-agent system (oracle, finder, librarian, task), 17 skills, 2 themes, and all the config that makes it work the way I want.

## 🚀 Pi Setup Installation

```bash
cd pi-setup
chmod +x install.sh
./install.sh
```

One command. It backs up your existing pi config, copies everything into the right places (`~/.pi/agent/` and `~/.config/agents/skills/`), and installs npm dependencies. Restart pi after.

---

## 🧩 Extensions (11)

Extensions are TypeScript files that hook into pi's extension API to add commands, modify the TUI, register tools, and react to agent events.

### `editor/` — Custom Bordered Editor

Replaces pi's default editor with a box-drawing bordered input area (`╭╮╰╯`). The prompt bar is **enlarged** (minimum 4 content lines instead of the default) so you have room to compose multi-line prompts.

**What it shows in the borders:**
- **Top-left:** Context usage (`42% of 200k`) and session cost (`$1.23`)
- **Top-right:** Active model (`claude-opus-4-6`) and thinking level (`high`)
- **Bottom-right:** Current directory and git branch (`~/myproject (main)`)

**Below the editor:** An animated activity spinner that shows what the agent is doing in real-time — `· turn 2 · read(file.ts) · 12s` — plus uncommitted git diff stats.

Other extensions can inject labels into the borders via an event bus (`editor:set-label` / `editor:remove-label`).

Also makes tool call backgrounds transparent — removes the colored boxes that pi puts around tool results for a cleaner look.

### `btw.ts` — Side Conversations

`/btw <question>` — ask a question **while the main agent is busy working**. It streams the answer in a floating widget above the editor using the same model and context. Think of it as a second conversation channel.

The btw thread maintains its own history — follow-up `/btw` calls continue the thread. The main agent never sees btw messages unless you explicitly inject them.

**Commands:**
| Command | What it does |
|---------|-------------|
| `/btw <question>` | Ask a side question (works while agent is running) |
| `/btw:new <question>` | Start a fresh btw thread |
| `/btw:clear` | Dismiss the widget |
| `/btw:inject [msg]` | Send the full btw conversation into the main agent's context |
| `/btw:summarize [msg]` | Summarize the btw thread and inject the summary into main context |

### `handoff.ts` — Context Transfer (Replaces Compaction)

When the context window hits ~85%, instead of compacting (summarizing and losing detail), this extension generates a focused **handoff prompt** via LLM and stages `/handoff` in the editor. Press Enter → new session starts with curated context from the old one.

You can also trigger it manually anytime: `/handoff implement the auth system` — it extracts relevant context from the current session and starts a new session focused on that goal.

Also shows provenance — when a session was handed off from another, it displays `↳ handed off from: <parent session name>` in the UI.

**This completely replaces pi's built-in compaction.** Compaction is disabled in settings.

### `session-name.ts` — Auto Session Naming

Automatically generates a 3-5 word title for each session from the first user message. Uses Haiku for speed/cost. The name appears while the agent is still thinking on the first turn.

### `session-breakdown.ts` — Usage Analytics

`/session-breakdown` opens an interactive TUI that analyzes all your pi sessions and shows:
- Sessions, messages, tokens, and cost per day
- GitHub-contributions-style calendar heatmap (color = model mix, brightness = activity)
- Model breakdown table (which models used how many sessions/tokens/cost)
- Switchable between 7/30/90 day ranges

### `system-prompt.ts` — Amp System Prompt Injection

Injects the full **Amp system prompt** (`prompt.amp.system.md`) into the agent's context on every turn, with runtime-interpolated variables: working directory, OS info, git remote, session ID, workspace listing.

This is what makes the agent behave as "Amp" — the identity, coding philosophy, tool selection rules, and communication style all come from this prompt. See the [Agent Prompts](#-agent-prompts-the-amp-system) section below.

### `tool-harness.ts` — Sub-Agent Tool Filtering

When spawning sub-agents (via the Task tool), this extension reads `PI_INCLUDE_TOOLS` from the environment and restricts which tools the sub-agent can use. For example, a read-only search agent only gets `read, grep, glob, ls` — no file editing, no bash.

### `notify.ts` — Desktop Notifications

Sends a native desktop notification via OSC 777 escape sequence when the agent finishes and is waiting for input. Shows the last few words of the agent's response as the notification body.

Works in Ghostty, iTerm2, WezTerm. Doesn't work in Kitty or Terminal.app.

### `todos.ts` — File-Based Todo Manager

A full todo system stored as markdown files in `.pi/todos/`. Each todo is a standalone `.md` file with JSON frontmatter (id, title, tags, status, assignment).

**TUI:** `/todos` opens an interactive overlay with fuzzy search, action menus (work, refine, close, reopen, delete), and keyboard shortcuts. The agent can also use todos programmatically via the `todo` tool.

**Features:** Auto-GC of closed todos after 7 days, session-based locking (claim/release), tag filtering, clipboard copy.

### `command-palette/` — Command Palette

`Ctrl+Shift+P` opens a VS Code-style command palette overlay. Shows all available commands (built-in, extension, and skill commands) with fuzzy search, source badges `[cmd]` `[ext]` `[skill]`, and descriptions.

### `tools/` — Full Replacement Tool Suite

A complete set of custom tools that replace pi's built-in tools with enhanced versions. This is where the agent's actual capabilities live — file reading, editing, searching, running commands, web access, sub-agents, and more.

**Tools included:**

| Tool | What it does |
|------|-------------|
| `read.ts` | Read files and directories with line numbers, image support, range slicing |
| `edit-file.ts` | Precise text replacement with exact string matching and diffs |
| `create-file.ts` | Create new files with auto-created parent directories |
| `bash.ts` | Execute shell commands with output truncation (first/last 50 lines) |
| `grep.ts` | Ripgrep-powered fast search with regex and literal modes |
| `glob.ts` | File pattern matching sorted by modification time |
| `ls.ts` | Directory listing |
| `format-file.ts` | Run prettier/biome on a file |
| `undo-edit.ts` | Revert the last edit to a file |
| `finder.ts` | **Sub-agent** — spawns a Haiku agent for multi-step code search |
| `oracle.ts` | **Sub-agent** — spawns a Sonnet agent for architecture review, hard bugs, planning |
| `librarian.ts` | **Sub-agent** — spawns a Haiku agent to explore GitHub repos via API |
| `task.ts` | **Sub-agent** — spawns a full Opus agent for independent parallel work |
| `code-review.ts` | Generates and reviews diffs with structured feedback |
| `look-at.ts` | Examine specific UI/visual elements |
| `skill.ts` | Load skill instruction files into agent context |
| `github.ts` | GitHub API tools — read files, search code, list repos, view diffs, commit history |
| `read-web-page.ts` | Fetch and convert web pages to markdown |
| `web-search.ts` | Search the web for documentation or information |
| `search-sessions.ts` | Search past pi session history by keyword, file, or date |
| `read-session.ts` | Extract relevant content from a past session |

**`lib/` directory** contains shared utilities: output buffering, HTML-to-markdown conversion, file tracking, GitHub API helpers, sub-agent rendering, prompt interpolation, permissions checking, and tool cost tracking.

---

## 🤖 Agent Prompts — The Amp System

The `agents/` folder contains the prompt files that define how the agent and its sub-agents behave. This is the brain of the whole setup.

### `prompt.amp.system.md` — Main Agent Identity

The core system prompt that makes the agent "Amp." Injected on every turn by the `system-prompt.ts` extension with runtime variables (`{cwd}`, `{os}`, `{repo}`, `{sessionId}`, etc.).

**Key behaviors it defines:**
- **"Read first"** — always open files before editing, understand patterns before changing them
- **"Do the work yourself"** — use direct tools for most tasks, sub-agents are a deliberate escalation
- **"Edit, then verify"** — check imports, types, and logic after every edit
- **"Context is not the bottleneck"** — 200k tokens is enough, don't skip reading to save space
- **Tool selection hierarchy** — when to use direct tools vs. finder vs. oracle vs. Task vs. librarian
- **The Task rule** — ≤5 tool calls → do it yourself; 5+ independent workstreams → parallel Tasks
- **Code defaults** — match surrounding style, error handling at real boundaries, explicit over clever
- **Communication** — state intent, do the work, summarize. Don't ask for clarification when you can read the code.

### `agent.amp.oracle.md` — Oracle Sub-Agent

The prompt for the **Oracle** — a senior technical advisor sub-agent running on **Claude Sonnet** with `read, grep, glob, ls, bash` tools.

The parent agent consults the oracle for:
- Code reviews and architecture feedback
- Hard multi-file bugs that need deep reasoning
- Complex planning and design decisions

**Key behaviors:**
- Verify before claiming — read the actual code, grep for actual usages
- Be opinionated — give recommendations, not options
- Surface non-obvious problems — race conditions, state inconsistencies, resource leaks
- Reference code precisely — every claim includes `path/file:line` and a snippet
- Three-phase investigation: understand scope → analyze deeply → synthesize by severity
- Structured output: Critical → Important → Minor → Architecture Notes → Recommendation

### `agent.amp.finder.md` — Finder Sub-Agent

A fast code search agent running on **Claude Haiku** with `read, grep, glob, ls` (read-only).

Designed to finish in 2-3 turns with 6-10 parallel tool calls per turn:
- **Turn 1:** Cast a wide net — grep for exact symbols, related symbols, glob for filenames, ls directories
- **Turn 2:** Confirm — read files at exact line ranges from grep hits, follow imports
- **Turn 3 (if needed):** Trace connections — follow call chains, data flow

Returns structured findings with file paths, line numbers, code snippets, and connection analysis.

### `agent.amp.librarian.md` — Librarian Sub-Agent

A cross-repository codebase explorer running on **Claude Haiku** with GitHub API tools (`read_github`, `search_github`, `list_directory_github`, `glob_github`, `commit_search`, `diff`).

Used when the parent agent needs to understand code in **external GitHub repositories** it can't clone locally. Explores thoroughly — reads actual source files, follows dependency chains, traces callers and callees.

### Other Prompt Files

| File | Purpose |
|------|---------|
| `prompt.amp.code-review-system.md` | System prompt for the code review tool — how to analyze diffs |
| `prompt.amp.code-review-report.md` | Template for code review output format |
| `prompt.amp.handoff-extraction.md` | Instructions for the LLM that extracts context during handoff |
| `prompt.amp.look-at.md` | Prompt for the look-at (visual examination) tool |
| `prompt.amp.read-web-page.md` | Prompt for web page reading with objective-based extraction |
| `prompt.harness-docs.pi.md` | Pi-specific documentation injected into the system prompt |

---

## 🎨 Pi Themes (2)

Custom color themes for pi's TUI. These control the colors of everything — borders, text, syntax highlighting, tool output, thinking indicators, diffs, markdown rendering.

### Gruvbox (Active)

Warm retro palette with orange/yellow accents. Based on the popular Gruvbox color scheme.

- Accent: yellow
- Borders: yellow / bright yellow
- Code blocks: bright green
- Headings: bright orange
- Links: bright aqua
- Diffs: bright green / bright red

### Night Owl

Dark blue palette inspired by Sarah Drasner's Night Owl theme.

- Accent: teal (`#80CBC4`)
- Borders: blue / cyan
- Code blocks: green
- Headings: blue
- Links: cyan
- Background: deep navy (`#011627`)

---

## 🧠 Skills (17)

Skills are loadable instruction files (markdown) that inject domain-specific workflows and rules into the agent's context when activated. The agent loads them with the `skill` tool — e.g., `skill: git` before committing.

| Skill | What it teaches the agent |
|-------|--------------------------|
| **git** | Ship workflow (stage → commit → push), worktree for parallel branches, hunks for selective staging, conventional commits, never force push, never `git add -A` |
| **review** | Epistemic standards — trace-or-delete (every claim needs a file:line reference), confidence labeling, falsification. Load before code reviews or debugging. |
| **spawn** | Spawn parallel agents in tmux with thread linkage for independent side-quests |
| **coordinate** | Orchestrate multiple agents with bidirectional tmux communication for multi-hour autonomous runs |
| **tmux** | Manage background processes in tmux windows — dev servers, build watchers, long-running tasks |
| **dig** | Systematic investigation methodology — hypothesis-driven analysis with verification agents for incident response, root cause analysis |
| **document** | Documentation philosophy — explain why, not what. For JSDoc, READMEs, inline comments |
| **write** | Prose style guide — enforces precise language, supported claims, no hyperbole. Applied to conversations, commits, PRs |
| **amp-voice** | Write in Amp's voice — direct, technical, opinionated, honest. For technical writing. |
| **remember** | Record context that would help future sessions — learnings, gotchas, decisions worth preserving |
| **rounds** | Iterate with spawned agents until stable — bounded verification with explicit exit criteria |
| **spar** | Adversarial review via spawned antithesis agent — prunes false positives from existing findings |
| **report** | Report back to a coordinator when spawned as a sub-agent |
| **shepherd** | Watchdog for long autonomous runs — supervises tmux agents, respawns on death, orchestrates handoffs |
| **nexus-fix** | Investigation-to-PR workflow for Linear issues — hypothesis-driven debugging with browser validation |
| **chrome-cdp** | Interact with your live Chrome browser — screenshots, accessibility tree, click, type, eval JS, navigate. Connects to tabs you already have open via Chrome DevTools Protocol. Requires Chrome remote debugging enabled (`chrome://inspect/#remote-debugging`) and Node.js 22+. |
| **handoff** | Context management via handoff instead of compaction (complements the handoff extension) |

---

## ⚙️ Settings

```json
{
  "theme": "gruvbox",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-6",
  "defaultThinkingLevel": "high",
  "hideThinkingBlock": false,
  "compaction": { "enabled": false },
  "quietStartup": true,
  "doubleEscapeAction": "tree",
  "steeringMode": "all",
  "followUpMode": "all"
}
```

**Key choices:**
- **Opus as default** — the most capable model for coding tasks
- **High thinking** — extended thinking enabled and visible (not hidden)
- **Compaction disabled** — handoff extension replaces it entirely
- **Double-escape = tree** — pressing Esc twice shows the session tree (branch history)
- **Quiet startup** — no splash screen or changelog on launch

---

## 🔒 Permissions

Safety rails that prevent the agent from doing dangerous things:

| Rule | What it blocks | Why |
|------|---------------|-----|
| Reject `git add -A` / `git add .` | Staging all files blindly | Unstaged changes may belong to other branches or sessions |
| Reject `git push --force` | Force pushing | Could destroy remote history. Use `fetch + rebase + push` instead |
| Reject `rm` | Deleting files with `rm` | Use `trash` instead — recoverable deletion |
| Allow everything else | — | Default allow for all other tool calls |

---

## 📁 Pi Setup File Structure

```
pi-setup/
├── install.sh              ← one-command installer (backs up existing config)
├── README.md               ← detailed install docs
├── settings.json           ← pi settings (model, theme, thinking, etc.)
├── keybindings.json        ← custom keybindings
├── permissions.json        ← safety rails (no force push, no rm, etc.)
├── extensions/             ← 11 extensions
│   ├── editor/             ← custom bordered editor + activity spinner
│   ├── command-palette/    ← Ctrl+Shift+P command overlay
│   ├── tools/              ← full replacement tool suite (20+ tools)
│   │   └── lib/            ← shared utilities
│   ├── btw.ts              ← side conversations
│   ├── handoff.ts          ← context transfer
│   ├── session-name.ts     ← auto naming
│   ├── session-breakdown.ts ← usage analytics
│   ├── system-prompt.ts    ← Amp identity injection
│   ├── tool-harness.ts     ← sub-agent tool filtering
│   ├── notify.ts           ← desktop notifications
│   └── todos.ts            ← todo manager
├── themes/                 ← 2 TUI themes
│   ├── gruvbox.json        ← warm retro (active)
│   └── nightowl.json       ← dark blue
├── agents/                 ← agent prompt files
│   ├── prompt.amp.system.md          ← main Amp system prompt
│   ├── agent.amp.oracle.md           ← Oracle (Sonnet) sub-agent prompt
│   ├── agent.amp.finder.md           ← Finder (Haiku) sub-agent prompt
│   ├── agent.amp.librarian.md        ← Librarian (Haiku) sub-agent prompt
│   ├── prompt.amp.code-review-*.md   ← code review system + report
│   ├── prompt.amp.handoff-*.md       ← handoff extraction
│   └── prompt.harness-docs.pi.md     ← pi harness documentation
├── config-skills/          ← 16 skills
│   ├── git/                ← git workflows
│   ├── review/             ← epistemic standards
│   ├── spawn/              ← parallel agent spawning
│   ├── coordinate/         ← multi-agent orchestration
│   ├── tmux/               ← background process management
│   ├── dig/                ← investigation methodology
│   ├── document/           ← documentation philosophy
│   ├── write/              ← prose style guide
│   ├── amp-voice/          ← Amp's writing voice
│   ├── remember/           ← context persistence
│   ├── rounds/             ← iterative verification
│   ├── spar/               ← adversarial review
│   ├── report/             ← sub-agent reporting
│   ├── shepherd/           ← autonomous run watchdog
│   ├── nexus-fix/          ← issue-to-PR workflow
│   └── chrome-cdp/         ← Chrome browser interaction via DevTools Protocol
└── pi-skills/              ← 1 pi-level skill
    └── handoff/            ← handoff context management
```

---

# Troubleshooting (Ghostty)

### "theme not found" error on launch

Ghostty looks for custom themes in `~/.config/ghostty/themes/`, **not** in `~/Library/Application Support/com.mitchellh.ghostty/themes/`. Make sure your theme files are in the right directory:

```bash
ls ~/.config/ghostty/themes/
```

If empty, re-run the installer or copy manually:

```bash
cp themes/* ~/.config/ghostty/themes/
```

### Live preview doesn't auto-reload

The scripts use `osascript` to send `⌘+Shift+,` to Ghostty. This requires **Accessibility permissions**:

1. System Settings → Privacy & Security → Accessibility
2. Add and enable **Ghostty**
3. Add and enable your **Terminal** app

If it still doesn't work, the switchers will still save your selection — just press `⌘+Shift+,` manually.

### `declare -A: invalid option` error

This happens if macOS's built-in bash (3.2) is used. All scripts in this repo are written to be compatible with bash 3.2. If you see this error, make sure you're using the latest version of the scripts from this repo:

```bash
cd ghosttyyy
./install.sh
```

### `gtheme: command not found`

Your PATH doesn't include `~/.local/bin`. Either:

```bash
# Add to PATH manually
export PATH="$PATH:$HOME/.local/bin"

# Or re-run install to fix it
./install.sh
```

Then `source ~/.zshrc`.

### Fonts not showing up

After installing fonts via Homebrew, you may need to restart Ghostty completely (not just reload config). Quit Ghostty (`⌘+Q`) and reopen it.

---

## 🔧 Uninstall

### Ghostty

```bash
# Remove scripts
rm ~/.local/bin/gtheme ~/.local/bin/gfont ~/.local/bin/gcursor ~/.local/bin/ghostty-config
rm -f ~/.local/bin/.gtheme-apply ~/.local/bin/.gfont-apply ~/.local/bin/.gcursor-apply

# Remove themes
rm -rf ~/.config/ghostty/themes

# Restore original config (if you had one)
ls ~/Library/Application\ Support/com.mitchellh.ghostty/config.backup.*
# Pick the one you want and:
# cp ~/Library/Application\ Support/com.mitchellh.ghostty/config.backup.XXXXX \
#    ~/Library/Application\ Support/com.mitchellh.ghostty/config

# Remove aliases from ~/.zshrc — delete these lines:
# alias gg="ghostty-config"
# alias gt="gtheme"
# alias gf="gfont"
# alias gc="gcursor"
```

### Pi Setup

The install script creates `.backup-<timestamp>` copies of everything it overwrites. To restore:

```bash
# Check for backups
ls ~/.pi/agent/*.backup-*
ls ~/.config/agents/skills.backup-*

# Restore whichever you need
```

---

## 📝 Credits

- Theme palettes inspired by [opencode](https://github.com/anomalyco/opencode) (MIT License)
- [Ghostty](https://ghostty.org) by Mitchell Hashimoto
- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner
- Fonts by JetBrains, GitHub (Monaspace), Vercel (Geist), Microsoft (Cascadia), and their respective creators
- Built with [fzf](https://github.com/junegunn/fzf)

---

## 📜 License

MIT — do whatever you want with it.
