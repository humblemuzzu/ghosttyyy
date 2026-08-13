# caliper — the measurement cookbook

`caliper` lives at `~/Documents/Code stuff/caliper`. Bun, two dependencies
(`pngjs`, `playwright`), no build step.

```bash
cd ~/Documents/Code\ stuff/caliper
bun run src/cli.ts <command> ...
```

Everything below is a real invocation. All thresholds are parameters — the
defaults suit a light UI in Inter and will lie to you on a different design
language or typeface.

---

## Before you look at any image

```bash
bun run src/cli.ts budget 1568 1388
```

```
1568×1388  ·  2800 tokens  ·  standard tier (max edge 1568, max tokens 1568)

  plan: DOWNSCALE to 1170×1036 — 75% of the original, 1554 tokens
  Claude pads that to 1176×1036
  pre-resize to exactly 1170×1036 and the API resizes nothing,
  which saves a second resampling pass over the text
```

A tall image is refused rather than crushed:

```bash
bun run src/cli.ts budget 1568 7698
```

```
  plan: SLICE — fitting 1568×7698 would give 319×1568 — 20% of the width, under
  the 900px legibility floor. 11 full-width slices of 1568×784 instead, 40px overlap.
```

Make an existing file safe to look at:

```bash
bun run src/cli.ts fit big.png view.png            # exact, aspect preserved
bun run src/cli.ts fit big.png view.png --snap     # also lands on the 28px grid
bun run src/cli.ts fit big.png view.png --tier=high
```

`--snap` eliminates padding but trims each axis independently, so it stretches by
up to ~2.7%. Leave it off unless you are counting tokens.

---

## Capturing your own render

```bash
bun run src/cli.ts capture --url=http://localhost:3000 \
  --section=pricing --widths=1568,1280,768,390 --out=shots
```

Per width it writes **two** files and reports the budget decision:

```
pricing @1568 → raw 1568×1388 (2800 tok) view 1170×1036 (1554 tok, 75%)
  .title: top 48 left 32 1504×60
  raw  shots/pricing-1568.raw.png
  view shots/pricing-1568.view.png
```

- **measure the `.raw.png`**, always
- **look at the `.view.png`**, only

It hides sticky chrome, zeroes animations (two consecutive runs produce
byte-identical PNGs), screenshots the *element* rather than a page clip — a page
clip silently fails once the element is below the fold — and reports horizontal
overflow plus any page errors.

---

## The seven primitives

### `bands` — vertical rhythm

Every text baseline and every gap, as integers. The workhorse.

```bash
bun run src/cli.ts bands ref.png --box=130,60,670,340
bun run src/cli.ts bands ref.png --box=... --invert     # light text on dark
```

Restrict the box to **one column**. Full-width detection merges the left column's
paragraph with the right column's chart into one meaningless band.

### `caps` — font size from cap height

```bash
bun run src/cli.ts caps ref.png --box=144,155,42,60
bun run src/cli.ts caps ref.png --box=... --cap-ratio=0.75
```

Point the box at a **flat-topped capital**. Round glyphs overshoot and inflate the
answer.

### `inkWidth` — font size by width ratio, the reliable one

```bash
bun run src/cli.ts bands ref.png  --box=...   # note xStart..xEnd
bun run src/cli.ts bands mine.png --box=...
```

Same string in both, ratio of widths = ratio of sizes.

### `edges` — borders a threshold cannot find

```bash
bun run src/cli.ts edges ref.png --row=620
bun run src/cli.ts edges ref.png --col=300 --depth=1.2
```

Finds local minima. A `#fafafa` card on a `#fafafa` page has identical background
on both sides, so no cutoff can separate them; the `#e9e9e9` hairline is only 17
luma levels down. This is the tool for card rects, dividers and hairlines.

### `color` — modal colour with confidence

```bash
bun run src/cli.ts color ref.png --box=430,684,85,20
```

```
#d0fbe7  hsv(158.6, 0.17, 0.98)  matched 3421/4000 px (85.5%)
```

**Read the confidence.** Anything low means your box is not on the thing you think
it is — a tilted element, an antialiased edge, a gradient. This exists because a
2.7% sample once "confirmed" a wrong token.

### `field` — where a texture is, and is not

```bash
bun run src/cli.ts field ref.png --box=0,0,1568,420 --cell=12
```

An ASCII variance map. Use it to distinguish "faint texture" from **none**: one
design's header measured variance 0.00 across a 300x150 sample, which is not faint,
it is nothing.

### `coverage` — halftones and anything whose dot size varies

```bash
bun run src/cli.ts coverage ref.png --box=560,330,450,460 --rows=12
```

Lit pixels over silhouette pixels, per band. Average brightness cannot see a size
ramp; coverage can.

---

## Comparing, and the classifier

```bash
bun run src/cli.ts compare ref.png mine.png \
  --box-a=130,60,670,340 --box-b=138,72,670,340
```

```
band        ref    mine   Δ
badge         0       0    0
h2 L1        55      53   -2
h2 L2       122     122    0
card top    201     201    0
```

Both lists are offset so the first entry is zero, so you are comparing *rhythm*
rather than absolute position.

**The classifier is the one that saves you days:**

```bash
bun run src/cli.ts compare --classify=1292,1292,1291 --tolerance=2
```

```
systemic (spread 1) — this belongs in a shared token, not in one component
```

Feed it the same measurement from several unrelated references. Agreement means
the value is systemic. This is the check that catches an error present in every
section, which no amount of per-section verification will ever surface.

---

## Sanity-checking a folder of screenshots

```bash
bun run scripts/sanity.ts
```

Reports how many would be silently degraded if sent raw. On one real library:
**39 of 67 (58%)**, one of them unusable at 41% of its width.
