# tool-description

Extract the most important context from this conversation for handoff to a new session. Focus on discoveries, decisions, current state, and what remains to be done. Omit exploration noise.

# field-relevant-information

First-person bullets summarizing what the next session needs to know: discoveries, decisions made, current state of the work, blockers, and remaining tasks. Write as "I discovered...", "I fixed...", "The bug is in...", "Still needs...". Be concise — this has limited space.

# field-relevant-files

Workspace-relative paths of files that were read, created, or modified during this session. Include files central to the task. Omit files that were only glanced at. Max 10.

# extraction-prompt

Extract context from the conversation above for handoff to a new session.

Rules:
1. Extract ONLY information the next session needs to continue working. Skip greetings, thinking, intermediate exploration that led nowhere, and tool call mechanics.
2. Write relevantInformation as first-person bullets: "I discovered...", "I changed X in file Y to fix Z", "The root cause is...", "Still needs: ...". Each bullet should be one actionable fact.
3. Include file paths that were read, created, or modified. Omit files opened briefly during exploration that aren't relevant to the outcome.
4. Omit: tool call syntax, thinking block contents, repeated failed attempts (just note what finally worked), file contents (the new session can read them).
5. Prioritize: what changed, why, what's left. The handoff prompt has limited space — every word must earn its place.

The goal for the next session is:
