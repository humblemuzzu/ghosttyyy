# import-opencode-sessions

Converts opencode sessions (SQLite) into pi's JSONL session format so they appear in `search_sessions` / `read_session`.

## Usage

```bash
# Standard import
~/.bun/bin/bun run pi-setup/tools/import-opencode-sessions.ts

# Dry run (preview without writing files)
~/.bun/bin/bun run pi-setup/tools/import-opencode-sessions.ts --dry-run

# Custom database path
~/.bun/bin/bun run pi-setup/tools/import-opencode-sessions.ts --db /path/to/opencode.db
```

## What gets imported

- All non-archived opencode sessions
- User messages (text parts concatenated)
- Assistant messages (text + reasoning → thinking)
- Tool calls + tool results (as separate JSONL entries, properly chained)
- Token usage and model/provider metadata
- Session names prefixed with `[opencode]` for easy filtering

## What gets skipped

- **Empty sessions** — no messages at all
- **Already imported sessions** — matched by creation timestamp in the target directory (idempotent)
- **Part types with no pi equivalent** — `file`, `patch`, `step-start`, `step-finish`, `compaction`, `agent`, `subtask`, `snapshot`, `retry`
- **Synthetic text parts** — opencode marks some text as synthetic (tool output echoes); these are excluded

## Output format

Files are written to `~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<uuid>.jsonl` matching pi's native format (v3). Each file contains:

1. Session header
2. Model change entry (from first assistant message's provider/model)
3. Session info with `[opencode] <title>` name
4. User/assistant/toolResult messages chained via `parentId`

## Limitations

- **No per-token cost breakdown** — opencode stores a single `cost` number; pi wants per-category costs. The total is preserved but input/output/cache costs are zeroed.
- **No thinkingSignature** — pi's Anthropic responses include a thinking signature for cache validation. Imported sessions won't have this.
- **File/patch diffs not preserved** — opencode stores file diffs as `patch` parts; these don't map to pi's format and are skipped. The tool calls that produced them are still present.
- **Read-only database access** — the script never modifies the opencode database. Safe to run while opencode is open (uses readonly + WAL mode).
- **One-way import** — there's no export back to opencode format.

## Requirements

- Bun (`~/.bun/bin/bun`)
- opencode database at `~/.local/share/opencode/opencode.db` (or specify with `--db`)
