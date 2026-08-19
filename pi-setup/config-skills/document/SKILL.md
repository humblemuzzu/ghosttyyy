---
name: document
description: documentation rules — almost nothing in code, real prose in READMEs. use when writing a README or when deciding whether a comment earns its place.
---

# document

the default is no comment. this skill is mostly about what not to write.

## the bar

a comment earns its place only if a careful reader, looking at the code with
no other context, would **misread** it without the comment.

not "would find it helpful". not "would take a moment longer". misread.

if you cannot name the specific wrong conclusion the reader would draw, there
is no comment to write.

## never write

- what the code does — the names already say it
- anything about the task, the ticket, the fix, or who calls it. it belongs in
  your message to the user, and it rots in the file the moment anything moves
- a header block summarising a file. the exports are the summary
- a restatement of the type
- `@param` / `@example` blocks that repeat the signature
- a comment on a constant whose name is already the explanation

## write, rarely

- a workaround: what breaks without it, in one line
- an invariant the code relies on but does not state
- a constraint from outside the file (an api limit, a wire format, a race)
- a warning where the obvious edit is the wrong one

## length

one line. two if the why genuinely needs a second.

more than that is an essay, and an essay in a source file is a sign the code
should be clearer instead. a change that is mostly commentary will be refused
before it lands.

```typescript
// good — names the failure, one line
// undici 8.x closes the socket on a 204, so the retry has to rebuild the agent.

// bad — restates the code
/** context provider that wraps children in a DisclosureProvider. */

// bad — task context, rots immediately
/** added for the detect-health flow, see PR #13. handles the case where … */
```

## readmes are different

prose docs are for readers who do not have the code open, so they carry the
context that must stay out of the source. write them properly:

- what it is, in a sentence
- how to run it
- the decisions a reader would otherwise have to reverse-engineer
- lowercase, terse, no unsupported claims, describe rather than emote

## cleanup

when you touch a file that is already over-commented, delete the comments that
fail the bar above. leave the ones that pass.
