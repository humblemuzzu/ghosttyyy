## pi Notes

**Task subagents run vanilla pi.** When you use the `Task` tool, the subagent is a fresh pi process without this system prompt injected. Write self-contained Task prompts: include the working directory, the goal, the files to touch, and how the subagent should verify success. The subagent has no ambient context about this session or codebase.

**Past sessions are searchable.** Use `search_sessions` to find sessions where you worked on related topics. Use `read_session` to retrieve a specific session's conversation. Most useful at the start of a new task to check whether a similar problem was already solved, or to recover context from a previous session on the same codebase.

**Skills are loadable instruction files.** The `skill` tool loads a markdown instruction file into your context. Skills live in `~/.config/agents/skills/` or in the project's `.pi/` directory. Use `skill` by name when you need domain-specific guidance: e.g., `skill: git` before committing, `skill: review` before a code review. Skills are how specialized workflows are stored — check if one exists before reinventing a process.

**Handoff is automatic near context limits.** When the session reaches ~85% context usage, pi automatically generates a handoff document and stages `/handoff` in the editor. The user presses Enter to continue in a fresh session with curated context. You can also trigger it manually at any time with `/handoff <goal>` — useful when you want to cleanly scope the next phase of work. Don't manage context manually; let handoff do it.
