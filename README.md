# 👻 ghosttyyy

A curated, aesthetic Ghostty terminal setup with **10 dark themes**, **11 developer fonts**, and **live-switching** — plus a **full portable pi (coding agent) setup** with 12 extensions, 29 custom tools, 8 packages, 30 skills, multi-provider support, and a custom agent identity.

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

Full portable backup of my [pi](https://github.com/badlogic/pi-mono) (v0.84.1) coding agent environment — 12 extensions, 29 custom tools, 6 dedicated sub-agents with @mention routing, 8 packages, 30 skills, 3 pi-core patches, multi-provider support, and a custom system prompt.

## 🚀 Installation

```bash
cd pi-setup && chmod +x install.sh && ./install.sh
```

Backs up existing config, deploys everything to `~/.pi/agent/` and `~/.config/agents/skills/`, installs packages and re-applies patches. Restart pi after.

---

## 📦 Packages (7 active)

| Package | Purpose | Patched? |
|---------|---------|----------|
| `pi-token-burden` | Token usage tracking and display | No |
| `@benvargas/pi-claude-code-use` | Claude Max subscription via OAuth payload rewrite | No |
| `@marckrenn/pi-sub-bar` | Usage widget in status bar | No (**config**) |
| `pi-autoresearch` | Autonomous experiment loop for optimization | No |
| `pi-tool-display` | Thinking labels, native user message box | **Config** |
| `pi-codex-goal` | Codex-style `/goal` — autonomous multi-turn objectives | No |
| `pi-mcp-adapter` | On-demand MCP gateway — single `mcp` proxy tool | No (**config**) |

**Removed (do not reinstall):** `pi-context` (checkpoint/timeline/compact), `todos.ts` (file todo tool), `pi-web-access` (dead `web_search` on every provider, replaced by our Parallel AI tool), `pi-tasks` (array params broken), `@tomooshi/condensed-milk-pi` (reported failed git commands as successes), `@sting8k/pi-vcc`, `pi-computer-use`, `pi-gpt-config`, `pi-ask`. See `pi-setup/pi-migrations.md`.

---

## 🧩 Extensions (11 active)

| Extension | Purpose |
|-----------|---------|
| `editor/` | Custom box-drawing editor with token/cost/model/git labels |
| `system-prompt.ts` | Injects Amp identity prompt with runtime variables; sub-agents instead get a short generated prompt listing only their own tools |
| `mentions.ts` | @mention resolution + agent directives (@oracle, @finder, @codereview, @task) |
| `session-name.ts` | Auto-generates short session titles via Haiku |
| `session-breakdown.ts` | `/session-breakdown` analytics |
| `notify.ts` | Desktop notifications via OSC 777 |
| `md-export.ts` | `/md` — session JSONL → markdown export |
| `command-palette/` | Ctrl+Shift+P fuzzy command overlay |
| `subagent-inspector/` | Ctrl+Shift+A / `/subagents` — drill into a sub-agent's live transcript |
| `local-model.ts` | `/local` — start/stop the llama.cpp router |
| `tools/` | 29 custom tools (see below) |

**Removed:** `todos.ts`, `tool-harness.ts` (replaced by piSpawn's native `--tools` allowlists), `handoff.ts`, `btw.ts`, `opencode-zen.ts`, `crof.ts`, `brain-loader.ts`. pi auto-discovers every `.ts`/dir in `~/.pi/agent/extensions/` — to disable one, delete it or move it out.

---

## 🛠 Custom Tools (28)

### Replacements (override pi built-ins)

| Tool | Enhancement |
|------|------------|
| **bash** | Git trailers, mutex locking, psst secret injection + scrubbing, permission rules, output scrubbing |
| **read** | Image support fitted to the vision budget, line numbers, `.env` blocking |
| **apply_patch** | The ONLY file-mutation tool — write/edit/batch/envelope lanes, mutex locking, undo tracking. Replaced `edit`/`write` (pi's natives are hidden) |
| **grep** | Per-file limits, 200-char truncation, context lines |
| **find** | `rg --files`, mtime sort (registers as `find`, shadows pi's built-in) |
| **ls**, **format_file**, **skill**, **undo_edit**, **redo_edit** | Enhanced versions of pi defaults |

### Sub-agents

| Tool | Model | Purpose |
|------|-------|---------|
| **finder** | claude-sonnet-5 | Concept-based parallel code search (8+ searches/turn, read-only) |
| **oracle** | claude-opus-4-6 | Architecture review, complex planning (read + bash + web + screenshot) |
| **code_review** | claude-sonnet-5 | Structured 2-phase diff review with XML output |
| **delegate** | `xai/grok-4.5` **pinned** | Full resumable sub-agent for parallel independent work |
| **chad** | `xai/grok-4.5` **pinned** | Read-only deep research, built to swarm — 5–8 at once, one question each |
| **librarian** | claude-sonnet-5 | Cross-repo GitHub exploration (7 GitHub tools) |

On a non-Anthropic parent (kimi/llama), finder/oracle/librarian inherit
the parent model — the Claude labels above apply on the default Anthropic route.

**`chad` and `delegate` are pinned, deliberately.** Both run `xai/grok-4.5` at
high thinking whatever session spawned them — the model the setup itself is on.
chad cannot change anything — no `apply_patch`, and its bash runs under an
allowlist that refuses writes, redirection, `sed -i`, interpreters and every git
subcommand that mutates. Reach for `chad` to find out, `delegate` to do.

### @Agent Mentions

Type `@` followed by an agent name to force the model to use that specific subagent tool:

| Mention | Routes to | When to use |
|---------|-----------|-------------|
| `@oracle` | `oracle` tool | "review this", "plan this", "debug this" |
| `@finder` | `finder` tool | "find where we handle X", "search for Y" |
| `@codereview` | `code_review` tool | "review my changes", "check this diff" |
| `@task` | `delegate` tool | "do this in parallel", "spawn a subagent" |
| `@chad` | `chad` tool | "research this", "swarm this", deep read-only investigation |

Example: `@oracle is this auth middleware safe?` → injects a hidden directive forcing the model to call oracle instead of guessing.

Autocomplete shows all agents when you type `@`. Agent mentions complete with a trailing space (not `/`).

### Other tools

`read_web_page`, `read_session`, `search_sessions`, `web_search` (Parallel AI), `screenshot`, `agent_message`, `mcp`, plus GitHub (×7 — read, search, list-dir, list-repos, glob, commit-search, diff).

**Removed:** `look-at` (low quality). `pi-web-access` was removed 2026-07-30 — `web_search` is now our self-contained Parallel AI tool.

---

## 🤖 Agent Prompts

| File | Purpose |
|------|---------|
| `prompt.amp.system.md` | Main Amp identity — behavior rules, tool selection, code defaults |
| `agent.amp.oracle.md` | Oracle sub-agent: simplicity-first advice, effort/scope signal |
| `agent.amp.finder.md` | Finder sub-agent: ≤3 turns, 8+ parallel searches per turn |
| `agent.amp.librarian.md` | Librarian sub-agent: cross-repo GitHub exploration |
| `agent.amp.chad.md` | Chad sub-agent: read-only research; Answer / Evidence / Verified vs inferred / Gaps |
| `prompt.amp.code-review-*.md` | Code review system prompt + XML report format |
| `prompt.amp.read-web-page.md` | Web page Q&A prompt (used by `read_web_page`'s `prompt` path) |
| `prompt.harness-docs.pi.md` | Pi-specific harness documentation |

---

## 🤖 Providers

| Provider | Models | Purpose |
|----------|--------|---------|
| `xai` | grok-4.5 (default · high), grok-4.6 | **Primary** — Grok OAuth |
| `anthropic` | claude-opus-5, claude-opus-4-6/4-7/4-8 (1M context) | Claude Max via pi-claude-code-use |
| `deepseek` | deepseek-v4-pro, deepseek-v4-flash | 1M context, thinking mode |
| `kimi-coding` | k3 (1M), k3-256k, kimi-for-coding (K2.7) | Kimi Code OAuth (native) |
| `llama-local` | LFM2.5-2.6B | Local llama.cpp router, managed via `/local` |
| `openai-codex` | gpt-5.5 | OpenAI Codex OAuth |

---

## 🧠 Skills (29 loadable)

24 config-level (`~/.config/agents/skills/`): `amp-voice`, `c-sqr`, `chrome-cdp`, `coordinate`, `dataforseo`, `design-port`, `dig`, `dm-antislop`, `document`, `git`, `mat-cr2axis`, `mat-design`, `mat-tdd`, `nexus-fix`, `remember`, `report`, `review`, `rounds`, `s-improve`, `shepherd`, `spar`, `spawn`, `tmux`, `write` — plus `find-skills`, `userinterface-wiki`, and 3 `autoresearch-*` at pi level.

---

## ⚙️ Settings

```json
{
  "defaultProvider": "xai",
  "defaultModel": "grok-4.5",
  "defaultThinkingLevel": "high",
  "theme": "gruvbox",
  "compaction": { "enabled": true }
}
```

Compaction enabled — pi's native compaction (the handoff/pi-vcc systems are gone).

---

## 🔒 Security

- **Permissions:** Block `git add -A`, `git push --force`, `rm` (use `trash`)
- **psst:** Secret vault injection + output scrubbing (values never reach the LLM)
- **Redaction guard:** `apply_patch` rejects placeholder patterns in code
- **Git trailers:** Session ID auto-injected into every commit

---

## 🎨 Pi Themes

**Gruvbox** (active) — warm retro palette. **Night Owl** — dark blue.

---

## 📁 Pi Setup Structure

```
pi-setup/
├── install.sh                  # Backs up + deploys everything
├── settings.json, models.json, keybindings.json, permissions.json, mcp.json
├── pi-core-patches/            # resource-loader, session pinning, pi-tui width patch
├── agents/                     # 9 prompt templates (main + sub-agents)
├── themes/                     # gruvbox + nightowl
├── pi-skills/                  # empty (find-skills + userinterface-wiki auto-created by packages)
├── config-skills/              # 24 skills
└── extensions/
    ├── tools/                  # 28 custom tools + lib/
    ├── editor/, command-palette/, subagent-inspector/, pi-tool-display/
    └── *.ts                    # 12 active extensions
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
