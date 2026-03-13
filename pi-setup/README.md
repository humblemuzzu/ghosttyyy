# Pi Setup — Muzammil's Customizations

Portable backup of all pi (coding agent) extensions, themes, skills, and settings.

## Quick Install on a New Mac

```bash
# 1. Make sure pi is already installed on the new Mac
# 2. Copy this entire pi-setup folder to the new Mac
# 3. Run:
cd pi-setup
chmod +x install.sh
./install.sh
# 4. Restart pi
```

That's it. The script backs up any existing config before overwriting.

## What's Inside

### Extensions (11)
| Extension | What it does |
|---|---|
| `editor/` | Custom box-drawing bordered editor with labels (context %, cost, model, git branch) and enlarged prompt bar |
| `btw.ts` | `/btw` side conversations — async Q&A while agent works |
| `handoff.ts` | Context transfer to new sessions (replaces compaction) |
| `session-name.ts` | Auto-generates session names from first message |
| `session-breakdown.ts` | `/session-breakdown` — visual analytics (sessions/day, cost, tokens, model breakdown) |
| `system-prompt.ts` | Injects the full Amp system prompt with runtime vars |
| `tool-harness.ts` | Env-gated tool filtering for sub-agents |
| `notify.ts` | Desktop notifications when agent finishes (OSC 777) |
| `todos.ts` | File-based todo manager with TUI |
| `command-palette/` | `Ctrl+Shift+P` command palette overlay |
| `tools/` | Full replacement tool suite (bash, read, grep, edit, github, oracle, finder, etc.) |

### Themes (2)
- **gruvbox** (active) — warm retro colors
- **nightowl** — dark blue Night Owl

### Skills (16)
`git`, `review`, `spawn`, `tmux`, `dig`, `document`, `write`, `remember`, `coordinate`, `rounds`, `spar`, `report`, `shepherd`, `nexus-fix`, `amp-voice`, `handoff`

### Settings
- Model: `claude-opus-4-6` (Anthropic)
- Theme: gruvbox
- Thinking: high (visible)
- Compaction: disabled (handoff replaces it)
- Quiet startup
- Double-escape: tree view

### Permissions
- Blocks `git add -A` / `git add .` (forces explicit staging)
- Blocks force push
- Blocks `rm` (use `trash` instead)

## For the AI on the Other Mac

If you're an AI being asked to install this, just run:

```bash
cd /path/to/pi-setup
./install.sh
```

The script handles everything — creates directories, backs up existing files, copies everything into place, and runs `npm install` for tool dependencies.
