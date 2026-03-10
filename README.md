# 👻 ghosttyyy

A curated, aesthetic Ghostty terminal setup with **10 dark themes**, **11 developer fonts**, and **live-switching** — all from your terminal.

Scroll through themes and fonts and watch your terminal change **in real-time**. Press Enter to keep it, Esc to revert.

> Themes inspired by [opencode](https://github.com/anomalyco/opencode)'s theme system — Tokyo Night, Catppuccin, Dracula, Kanagawa, Rosé Pine, and more.

---

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

## 🚀 Installation

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
└── scripts/               ← switcher scripts
    ├── gtheme             ← theme switcher
    ├── gfont              ← font switcher
    ├── gcursor            ← cursor switcher
    └── ghostty-config     ← master hub
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

## 🐛 Troubleshooting

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

---

## 📝 Credits

- Theme palettes inspired by [opencode](https://github.com/anomalyco/opencode) (MIT License)
- [Ghostty](https://ghostty.org) by Mitchell Hashimoto
- Fonts by JetBrains, GitHub (Monaspace), Vercel (Geist), Microsoft (Cascadia), and their respective creators
- Built with [fzf](https://github.com/junegunn/fzf)

---

## 📜 License

MIT — do whatever you want with it.
