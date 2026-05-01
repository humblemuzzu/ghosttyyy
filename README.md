# 👻 ghosttyyy

A curated, aesthetic Ghostty terminal setup with **10 dark themes**, **11 developer fonts**, and **live-switching** — plus a **full portable pi (coding agent) setup** with 15 extensions, 25 custom tools, 12 packages, 16 skills, multi-provider support, and a custom agent identity.

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

Full portable backup of my [pi](https://github.com/badlogic/pi-mono) (v0.71.0) coding agent environment — 15 extensions, 25 custom tools, 4 sub-agent types with @mention routing, 12 packages, 16 skills, 4 patched packages, multi-provider support, and custom system prompt.

## 🚀 Installation

```bash
cd pi-setup && chmod +x install.sh && ./install.sh
```

Backs up existing config, deploys everything to `~/.pi/agent/` and `~/.config/agents/skills/`, installs packages and re-applies patches. Restart pi after.

---

## 📦 Packages (12 active)

| Package | Purpose | Patched? |
|---------|---------|----------|
| `pi-web-access` | Web search (Exa MCP free, Perplexity, Gemini), URL fetching, GitHub API | No |
| `pi-context` | Context management: `context_log`, `context_tag`, `context_checkout` | No |
| `pi-token-burden` | Token usage tracking and display | No |
| `@benvargas/pi-claude-code-use` | Claude Max subscription via OAuth rewrite | No |
| `@marckrenn/pi-sub-bar` | Usage widget in status bar | **Yes** |
| `pi-autoresearch` | Autonomous experiment loop for optimization | No |
| `@sting8k/pi-vcc` | Algorithmic compaction + `vcc_recall` history search | No |
| `pi-tool-display` | Thinking labels, native user message box | **Config** |
| `@tomooshi/condensed-milk-pi` | Bash output compression + stale result masking | **Yes** |
| `pi-gpt-config` | GPT Codex-parity: personality, verbosity, fast mode | **Yes** |
| `pi-computer-use` | macOS GUI automation: screenshots, AX clicks, typing, browser nav | No |
| `pi-ask` | Structured `ask_user` tool with TUI — single/multi select, notes, review | No |

---

## 🧩 Extensions (15 active, 2 disabled)

| Extension | Purpose |
|-----------|---------|
| `editor/` | Custom box-drawing editor with token/cost/model/git labels |
| `system-prompt.ts` | Injects Amp identity prompt with runtime variables |
| `tool-harness.ts` | Env-gated tool filtering for sub-agent sandboxing |
| `handoff.ts` | LLM-driven context transfer at ~85% (replaces compaction) |
| `mentions.ts` | @mention resolution + agent directives (@oracle, @finder, @codereview, @task) |
| `session-name.ts` | Auto-generates 3-5 word session titles via Haiku |
| `session-breakdown.ts` | `/session-breakdown` analytics with calendar heatmap |
| `btw.ts` | `/btw` side conversations while agent works |
| `notify.ts` | Desktop notifications via OSC 777 (Ghostty/iTerm2/WezTerm) |
| `todos.ts` | File-based todo manager with full TUI |
| `local-model.ts` | `/llm start\|stop\|status` for llama-server |
| `opencode-zen.ts` | Curated models.dev provider (free + paid tiers) |
| `crof.ts` | Budget OSS model provider (DeepSeek/GLM/Qwen/Kimi) |
| `command-palette/` | Ctrl+Shift+P fuzzy command overlay |
| `tools/` | 25 custom tools (see below) |

**Disabled (on disk, not loaded):** `brain-loader.ts` (brain vault injection), `md-export.ts` (session→markdown)

---

## 🛠 Custom Tools (25)

### Replacements (override pi built-ins)

| Tool | Enhancement |
|------|------------|
| **bash** | Git trailers, mutex locking, psst secret injection + scrubbing, permission rules, ANSI sanitization |
| **read** | Image support (jpg/png/gif/webp), line numbers, `.env` blocking |
| **edit** | Mutex locking, redaction detection, 3-tier matching, change tracking |
| **write** | Mutex locking, auto parent directory creation |
| **grep** | Per-file limits, 200-char truncation, context lines |
| **find** | `rg --files`, mtime sort |
| **ls**, **format_file**, **undo_edit**, **skill** | Enhanced versions of pi defaults |

### Sub-agents

| Tool | Model | Purpose |
|------|-------|---------|
| **finder** | claude-haiku-4-5 | Concept-based parallel code search (8+ searches/turn) |
| **oracle** | claude-sonnet-4-6 | Architecture review, complex planning |
| **code_review** | claude-sonnet-4-6 | Structured 2-phase diff review with XML output |
| **Task** | inherits parent | Full sub-agent for parallel independent work |
| **librarian** | claude-haiku-4-5 | Cross-repo GitHub exploration |

### @Agent Mentions

Type `@` followed by an agent name to force the model to use that specific subagent tool:

| Mention | Routes to | When to use |
|---------|-----------|-------------|
| `@oracle` | `oracle` tool | "review this", "plan this", "debug this" |
| `@finder` | `finder` tool | "find where we handle X", "search for Y" |
| `@codereview` | `code_review` tool | "review my changes", "check this diff" |
| `@task` | `Task` tool | "do this in parallel", "spawn a subagent" |

Example: `@oracle is this auth middleware safe?` → injects a hidden directive forcing the model to call oracle instead of guessing.

Autocomplete shows all agents when you type `@`. Agent mentions complete with a trailing space (not `/`).

### Other tools

`read_web_page`, `read_session`, `search_sessions`, `github` (×7 — read, search, list-dir, list-repos, glob, commit-search, diff)

**Disabled:** `look-at` (low quality), `web-search` (conflicts with pi-web-access)

---

## 🤖 Agent Prompts

| File | Purpose |
|------|---------|
| `prompt.amp.system.md` | Main Amp identity — behavior rules, tool selection, code defaults |
| `agent.amp.oracle.md` | Oracle sub-agent: verify before claiming, be opinionated, reference precisely |
| `agent.amp.finder.md` | Finder sub-agent: 2-3 turns, 6-10 parallel searches per turn |
| `agent.amp.librarian.md` | Librarian sub-agent: cross-repo GitHub exploration |
| `prompt.amp.code-review-*.md` | Code review system prompt + XML report format |
| `prompt.amp.handoff-extraction.md` | Handoff context extraction prompt |
| `prompt.harness-docs.pi.md` | Pi-specific harness documentation |

---

## 🤖 Providers

| Provider | Models | Purpose |
|----------|--------|---------|
| `anthropic` | Claude Opus 4-6/4-7 (1M context) | **Primary** — Claude Max via pi-claude-code-use |
| `deepseek` | V4 Pro, V4 Flash | 1M context, thinking mode |
| `local-llama` | Qwen3.6 35B-A3B, Gemma 4 E2B | llama-server on localhost:8080 |
| `nvidia` | GLM-5.1, DeepSeek V4 Pro | NVIDIA NIM API |
| `opencode` | models.dev catalog | Curated free/paid models |
| `crof` | Budget OSS models | Quantized DeepSeek/GLM/Qwen/Kimi |

---

## 🧠 Skills (16 config + 1 pi-level)

`amp-voice`, `chrome-cdp`, `coordinate`, `dig`, `document`, `git`, `nexus-fix`, `remember`, `report`, `review`, `rounds`, `shepherd`, `spar`, `spawn`, `tmux`, `write` — plus `handoff` at pi level.

---

## ⚙️ Settings

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-6",
  "defaultThinkingLevel": "high",
  "theme": "gruvbox",
  "compaction": { "enabled": false }
}
```

Compaction disabled → replaced by handoff system + manual `/pi-vcc`.

---

## 🔒 Security

- **Permissions:** Block `git add -A`, `git push --force`, `rm` (use `trash`)
- **psst:** Secret vault injection + output scrubbing (values never reach the LLM)
- **Redaction guard:** Edit tool rejects placeholder patterns in code
- **Git trailers:** Session ID auto-injected into every commit

---

## 🎨 Pi Themes

**Gruvbox** (active) — warm retro palette. **Night Owl** — dark blue.

---

## 📁 Pi Setup Structure

```
pi-setup/
├── install.sh                  # Backs up + deploys everything
├── settings.json, models.json, keybindings.json, permissions.json
├── claude-bridge-patches/      # Patched pi-claude-bridge (inactive)
├── condensed-milk-patches/     # Patched condensed-milk
├── sub-bar-patches/            # Patched pi-sub-bar (CrofAI + Kimi)
├── gpt-config-patches/         # Patched pi-gpt-config (tool discipline removed)
├── agents/                     # 10 prompt templates
├── themes/                     # gruvbox + nightowl
├── pi-skills/                  # handoff skill
├── config-skills/              # 16 skills
└── extensions/
    ├── tools/                  # 25 custom tools + lib/
    ├── editor/, command-palette/
    └── *.ts                    # 15 active + 2 disabled extensions
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
