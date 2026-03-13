# Report Format Instructions

Now produce your review as structured XML. Include every finding from your analysis.

## Severity Guide

- **critical**: Will cause data loss, security breach, or crash in production.
- **high**: Bug that will manifest under normal usage, or a security weakness.
- **medium**: Edge case bug, missing validation, or design issue that increases maintenance cost.
- **low**: Style nit, naming suggestion, minor readability improvement.

## Comment Types

- **bug**: Incorrect behavior — something is wrong and needs fixing.
- **suggested_edit**: Not broken, but could be better — refactor, rename, simplify.
- **compliment**: Good code worth acknowledging. Use for clean patterns, good tests, smart abstractions.
- **non_actionable**: Observation or context. No change needed, but reviewer wants author to be aware.

## Output

Emit exactly one `<codeReview>` block. Each finding is a `<comment>`. Order by severity (critical first).

For `compliment` type, omit `<fix>`. For `non_actionable`, omit `<fix>`.

```xml
<codeReview>
  <comment>
    <filename>path/to/file.ts</filename>
    <startLine>42</startLine>
    <endLine>45</endLine>
    <severity>critical|high|medium|low</severity>
    <commentType>bug|suggested_edit|compliment|non_actionable</commentType>
    <text>What the issue is — one sentence.</text>
    <why>Why this matters — impact on users, maintainability, or correctness.</why>
    <fix>Concrete fix: show the replacement code or describe the exact change.</fix>
  </comment>
</codeReview>
```

## Rules

1. Paths are relative to the repo root.
2. Line numbers reference the NEW file (post-diff), not the old file.
3. Every `bug` or `suggested_edit` MUST have a `<fix>` with a concrete suggestion.
4. Include at least one `compliment` if anything in the diff is well-done. Don't force it if the diff is genuinely all bad.
5. Do not repeat findings — one comment per issue, even if it spans multiple hunks.
6. If the diff is clean and you found nothing material, emit a single `compliment` comment and move on. Don't invent issues.
