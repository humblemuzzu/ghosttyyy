---
name: design-port
description: port a design screenshot into pixel-accurate code by measuring instead of eyeballing. use when implementing a UI from a mockup, screenshot, or figma export, or when a render "looks close but wrong". covers the image-budget trap that silently degrades screenshots, numeric measurement of references, and the token-vs-section classification that catches systematic errors.
---

# Porting a design from a screenshot

You cannot see accurately. You can measure accurately. Everything here follows
from that.

Looking at a reference and a render side by side gets you ±15% on any dimension
and leaves you blind to hue error and to systematic offsets. In one real project
a container was 76px too narrow — 6% — and survived four sections of careful
visual checking, because per-section eyeballing cannot detect an error that is
present in every section.

**Look only to decide what to measure next. Never to decide a number.**

---

## 1. The image budget — read this before anything else

Screenshots you hand to a model are silently downscaled if they exceed its budget.
You end up reasoning about a degraded picture without being told.

```
visual tokens = ceil(width / 28) * ceil(height / 28)

standard tier:  <= 1568 tokens, <= 1568 px long edge
high-res tier:  <= 4784 tokens, <= 2576 px long edge   (newer models)
```

**The token limit binds long before the edge limit does.** A 1568x859 screenshot
is inside the 1568px edge limit and still gets resized, because it costs 1736
tokens. Enforcing "longest side <= 1568" is not enough and is the single most
common mistake here.

Practical ceilings on the standard tier:

| shape | largest size that survives untouched |
| ----- | ------------------------------------ |
| square | 1092x1092 |
| 16:9 | 1456x819 |

What this costs when ignored, measured on real captures:

| screenshot | native | what the model actually saw |
| ---------- | ------ | -------------------------- |
| one UI section | 1568x602 | 1568x602 — fine |
| a taller section | 1568x1388 | **1170x1036, 75%** |
| a full page | 1568x7698 | **319x1568, 20% — useless** |

### The rules that follow

**Keep two images, never one.** The full-resolution file is for MEASURING. A
separate, pre-fitted copy is for LOOKING AT. Conflating them means you either
measure a degraded image or you view one and don't know it.

**Crop, don't scale, when an image is tall.** Scaling a 7698px page to 319px wide
destroys it. Six readable crops beat one unreadable overview. Set a legibility
floor — below roughly 0.55 scale, slice instead of shrink.

**Never view a full-page screenshot.** Capture the section you care about.

**Pre-resize to exactly the size the model would have picked.** Then it resizes
nothing and the image is resampled once instead of twice. Two resampling passes
over text are visibly worse than one.

**Do not trade geometry for tokens.** Landing both axes on a multiple of 28
eliminates padding, but trimming each axis independently stretches the image — up
to 2.7% on real screenshots. A few percent of budget is never worth a distorted
picture, and coordinates read off a stretched screenshot are wrong invisibly.

`caliper` implements all of this: `budget`, `fit`, and a `capture` harness that
writes `.raw.png` and `.view.png` and refuses to emit an illegible view. See
MEASURE.md.

---

## 2. The loop

```
reference
  -> measure it numerically
  -> CLASSIFY: is this value systemic or local?
  -> build
  -> render and capture
  -> measure the render THE SAME WAY
  -> diff the two number sets
  -> iterate until deltas are 1-3px
  -> verify behaviour, not just appearance
  -> gates
```

The load-bearing property is that measuring the reference and measuring your
render use **the same function with the same parameters**. Absolute accuracy
matters less than symmetry: if both sides are measured identically, the errors
cancel and the diff is meaningful.

---

## 3. Classify before you build

Ask of every value: **is this a property of this component, or of the system?**

The test is agreement across unrelated references. Measure the same thing in
three different screenshots. If they agree to within a pixel or two, it belongs in
a shared token, not in a component.

Real examples of systemic values found this way:

- three unrelated sections all had content spanning x 139->1430. The container was
  1292, not the 1216 that had been assumed.
- a brand green sampled in four unrelated components came back at hue 158.5, 158.4,
  158.7, 159.6. The token said 142. In hex those all just look like "some green";
  in HSV the error is obvious.
- a heading cap height of 43px in two independent sections meant 60px type, not the
  56px in the token file.

Getting this wrong is expensive both ways. Fix a token as a component override and
you get six divergent one-offs. Fix a component quirk as a token and you break
five things that were correct.

**After changing a token, re-measure everything that already matched.**

---

## 4. The escalation ladder

When a delta appears, go in this order and stop at the first thing that explains
it:

1. a number in this component (padding, max-width)
2. a design token — if two or more references agree
3. a missing primitive (a new texture variant, a new fade)
4. a different technique (per-row patterns rather than one tiled pattern)
5. a different library, or none

Step 5 needs evidence, not preference. A real instance: an FAQ accordion needed
every answer in the served HTML. Reading the library's compiled output found
`children: isOpen && children` — proof that no configuration would render closed
content. That justified replacing it with `<details>`. "I'd rather not use this
library" does not.

---

## 5. Recovering a font size

In order of reliability:

1. **Width ratio on an identical string.** Measure the same word in the reference
   and in your render. The ratio of ink widths is the ratio of font sizes. Same
   glyphs, same face, everything else cancels. Trust this one.
2. **Cap height / cap ratio** (0.727 for Inter). Only on a **flat-topped capital**
   — F, H, T, E, L. Never on `$`, `8`, `O`, or anything round: overshoot above and
   below the cap line inflates the measurement. A 33px number once measured as
   "41px" because the sample was a `$`.
3. **Line pitch / assumed line-height.** Two unknowns. Last resort.

---

## 6. Prefer invariants over dimensions

A ratio or a profile validates a shape far better than a single length.

- Reproducing a letterform: **aspect ratio** matched to 0.978 vs 0.979 proved the
  glyph was right, independent of scale.
- Reproducing a halftone: the **coverage profile** down the letter (0.99 at the
  top collapsing to 0.17) captured what average brightness could not — the dots
  vary in SIZE, not opacity.

When something "looks flat" or "looks off" and dimensions all check out, you are
measuring the wrong quantity. Find the invariant that actually describes the
effect.

---

## 7. Rules earned from specific failures

**A measurement that confirms what you already believe deserves more scrutiny,
not less.** A rectangular sample of a *tilted* pill returned the card colour
behind it, which "confirmed" a token that was wrong. It survived two commits.
Always check how much of your sample region actually matched — a modal colour
drawn from 2.7% of the box is not a measurement.

**Measure from a cold load.** A roving-tabindex reading taken after interacting
with the page gave `[0,-1,-1,-1]`; the true initial state was `[-1,-1,-1,-1]`.

**When the DOM disagrees with your mental model, read the library.** Do not
theorise about what a component does. Its compiled output is on disk.

**Wrong at one size means the unit is wrong, not the number.** An SVG dot pattern
sized "8" rendered at 8px at exactly one scale and 3px everywhere else, because
pattern units scale with the viewBox. The fix was to express it as dots-per-glyph,
not to pick a different number.

**A good fit to sampled points can still misbehave between them.** A power curve
matched every measured coverage value and rendered a hard horizontal seam, because
it has infinite slope at its start and crossed the dots-touching threshold inside
one row. The underlying shape was a sigmoid. Fit the shape, not just the points.

**Strip `<script>` before grepping served HTML.** Framework payloads contain your
content as escaped JSON, so a naive grep finds text that is not rendered anywhere.
An FAQ nearly shipped with five of six answers invisible to crawlers.

**A gate that cries wolf gets fixed, not worked around.** An accessibility check
reported three correctly-labelled switches as unlabelled because it only looked at
`textContent` and `aria-label`. The right response was to teach it
`aria-labelledby` and `label[for]`, not to silence it.

**A gate going red can be the gate working.** Adding a footer took a link audit
from green to twelve failures. Nothing broke — those routes had always been
linked, but a collapsed nav meant the crawler had never seen them.

---

## 8. Derive rather than restate

Wherever two things could drift, make one read from the other. Every instance is
a bug you no longer have to remember not to write:

- footer nav columns derived from the header's nav model
- a sentence listing supported models composed from the canonical model constant
- a monogram letter derived from the brand name, never typed
- pricing card copy derived from catalog rows, never hardcoded
- two components sharing one fixture so their numbers cannot disagree

---

## 9. Comment conventions

Say **why**, never what. And distinguish clearly between:

- **measured** — recoverable from the reference. Give the number and where it came
  from: `68px padding, measured`.
- **chosen** — a judgement call. Say what the alternative was and why it lost.

A later reader needs to know which numbers are safe to change.

---

## 10. When to diverge from the design

Design files contain bugs. Reproducing them faithfully is not fidelity.

Real instances, and the call made in each:

- Two pricing tiers showed the same price, both with the same "save" badge, above a
  toggle whose label contradicted the amount. **Wired the section to the real
  catalog instead** — that is what hand-maintained pricing looks like after one
  edit.
- A card's photograph had a dark ceiling, so a white logo read against it. Three
  replacement photographs were backlit and the same markup rendered an invisible
  logo. **Added a scrim the design does not have**, anchored to the logo rather
  than banded across the top.
- A design drew a 61px input in one CTA and the page's other CTA used 56px.
  **Kept 56px.** Two calls-to-action for one action must submit the same thing;
  internal consistency beat 5px of fidelity.
- Copy referenced a different company's product name, left over from whatever the
  layout was derived from. **Fixed silently** — that is a typo, not a decision.

When copy makes a claim the product cannot support, flag it rather than shipping
it or quietly rewriting it. A placeholder logo is a different risk class from a
specific feature promise or an uptime figure.
