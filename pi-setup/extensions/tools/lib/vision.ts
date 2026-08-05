/**
 * Image budget maths for Claude's vision pipeline.
 *
 * Ported verbatim (behaviour-identical) from the `caliper` project's
 * src/vision.ts, which is itself a transcription of Anthropic's published
 * vision spec and its reference resize implementation. Section references in
 * the comments point at the paragraph a number came from.
 *
 * The same algorithm is implemented independently in the ClaudeImageResizer
 * macOS app (ImageBudget.swift). The two agree on every test vector, which is
 * the only reason to trust either. If you change a constant here, change it
 * there, and re-run vision.test.ts.
 *
 * Nothing in this file touches the filesystem, the network, or macOS. It is
 * pure arithmetic and is unit-testable under bare `bun test`.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** §1: "Each patch is a 28×28-pixel block of the image, referred to as a visual token." */
export const PATCH = 28;

export interface Tier {
  readonly maxEdge: number;
  readonly maxTokens: number;
}

/** §2, the resolution-tier table. */
export const TIERS = {
  standard: { maxEdge: 1568, maxTokens: 1568 },
  highRes: { maxEdge: 2576, maxTokens: 4784 },
} as const satisfies Record<string, Tier>;

/**
 * The tier name as callers spell it. Deliberately NOT `keyof typeof TIERS` —
 * "highRes" is an awkward thing to ask a model to type, and the public spelling
 * should not be coupled to the internal key.
 */
export type TierName = "standard" | "high";

/**
 * §7. These bound the BASE64 payload, not the bytes on disk. Comparing a raw
 * file size against them passes files the API then rejects: a 4.5 MB PNG is a
 * 6 MB payload.
 *
 * Measured on this machine: a 3840×2160 `screencapture` PNG is 6,798,763 bytes
 * on disk and 9,065,020 as base64 — 90.6% of the API cap from a single
 * full-screen grab. This limit is not theoretical.
 */
export const MAX_BASE64_BYTES = { api: 10_000_000, bedrock: 5_000_000 } as const;

/** §7: "The maximum dimensions per image are 8000x8000 px." */
export const MAX_EDGE_ABSOLUTE = 8000;

/**
 * Python's round() is half-to-even, and §6 note 2 says the live API resolves
 * exact .5 ties toward the even neighbour. Math.round rounds halves up, so a
 * port that uses it drifts by a pixel on tie-hitting aspect ratios and every
 * coordinate derived from that size is off.
 */
function roundHalfToEven(x: number): number {
  const lower = Math.floor(x);
  const frac = x - lower;
  if (frac > 0.5) return lower + 1;
  if (frac < 0.5) return lower;
  return lower % 2 === 0 ? lower : lower + 1;
}

/** §1: tokens(w, h) = ceil(w / 28) * ceil(h / 28). */
export function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

/**
 * §6 note 1: the edge limit is tested against the PADDED edge, ceil(w/28)*28,
 * because Claude pads before it measures. A 1560px edge is really 1568 to the
 * limit check.
 */
function fits(width: number, height: number, tier: Tier): boolean {
  return (
    Math.ceil(width / PATCH) * PATCH <= tier.maxEdge &&
    Math.ceil(height / PATCH) * PATCH <= tier.maxEdge &&
    countImageTokens(width, height) <= tier.maxTokens
  );
}

/**
 * The size Claude resizes an image to before padding — a direct port of the
 * reference implementation in §6. Images already inside both limits come back
 * unchanged.
 *
 * The token limit, not the edge limit, decides the outcome for nearly all
 * screenshots (§4): 1920×1080 lands on 1456×819, not 1568×882. This is why
 * `sips -Z 1568` is wrong — it satisfies the edge limit and blows the token
 * limit, so the API resizes a second time.
 */
export function resizedSize(width: number, height: number, tier: Tier = TIERS.standard): Size {
  if (fits(width, height, tier)) return { width, height };

  // §6 note 3: the tall case solves the transposed problem and swaps back, so
  // the binary search below only ever has to handle the landscape orientation.
  if (height > width) {
    const swapped = resizedSize(height, width, tier);
    return { width: swapped.height, height: swapped.width };
  }

  const aspectRatio = width / height;
  const heightFor = (w: number): number => Math.max(roundHalfToEven(w / aspectRatio), 1);

  // lo always fits, hi never does; converge on the largest width that fits.
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, heightFor(mid), tier)) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: heightFor(lo) };
}

/**
 * §5: Claude pads every image up to the next multiple of 28 on the bottom and
 * right. The padding holds no content — normalise coordinates by the resized
 * size, never by this.
 */
export function paddedSize(width: number, height: number): Size {
  return {
    width: Math.ceil(width / PATCH) * PATCH,
    height: Math.ceil(height / PATCH) * PATCH,
  };
}

/**
 * Round DOWN to a multiple of 28. §5: an image whose dimensions are already
 * multiples of 28 incurs no padding and no wasted tokens. Rounding down rather
 * than up guarantees the result still fits whatever budget the input fit.
 *
 * An axis under one patch is LEFT ALONE rather than clamped up to 28. Clamping
 * up is an enlargement, which contradicts everything above: it can push an
 * image back over a budget it already fit, and `downscale` — correctly —
 * refuses to enlarge.
 *
 * OFF BY DEFAULT in the screenshot tool. It saves at most ~3% of the budget and
 * trims each axis independently, distorting the aspect ratio by up to 2.7%.
 * ClaudeImageResizer reached the same conclusion: trading geometry for 3% of the
 * budget is the wrong default for a tool whose job is handing Claude an
 * accurate picture.
 */
export function snapToPatch(width: number, height: number): Size {
  return { width: snapAxis(width), height: snapAxis(height) };
}

function snapAxis(pixels: number): number {
  const snapped = Math.floor(pixels / PATCH) * PATCH;
  return snapped >= PATCH ? snapped : pixels;
}

/** §7: base64 encodes 3 bytes as 4 characters, so a payload is ~1.37× the file. */
export function base64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export type ViewPlan =
  | { kind: "asis"; tokens: number }
  | { kind: "downscale"; to: Size; scale: number; tokens: number }
  | { kind: "slice"; slices: Box[]; scaleIfForced: number; reason: string };

export interface ViewOptions {
  tier?: Tier;
  /**
   * Legibility floor in pixels, read as: "do not take a full-budget capture
   * below this width". It is compared against `scale * tier.maxEdge`, so for a
   * 1568px-wide source it is simply the fitted width; for other sizes it is the
   * same shrink expressed on a common ruler.
   *
   * 900 out of 1568 is ~0.57 scale. Below that, 14px body text lands under 8px
   * and stops being readable. A floor on scale rather than on absolute pixels
   * is what separates 1568×7698 (fits at 20% — unusable) from 1080×1920 (fits
   * at 76% — fine).
   */
  minLongEdge?: number;
  /**
   * Vertical overlap between slices. A feature landing exactly on a seam is
   * unreadable in either neighbour, and 40px covers a line of body text plus
   * its leading.
   */
  overlap?: number;
}

/**
 * Largest full-width slice height that fits the budget on its own. Sized in
 * whole patch rows so the slice spends its entire token allowance on content
 * rather than on padding.
 */
function maxSliceHeight(width: number, tier: Tier): number {
  const patchCols = Math.ceil(width / PATCH);
  const patchRows = Math.min(
    Math.floor(tier.maxTokens / patchCols),
    Math.floor(tier.maxEdge / PATCH),
  );
  return patchRows * PATCH;
}

function tile(width: number, height: number, sliceHeight: number, overlap: number): Box[] {
  // An overlap at or above the slice height means consecutive slices advance by
  // almost nothing: at `overlap = 2000` on a 784px slice the step collapses to 1
  // and a 7698px page produces over 1,800 near-identical crops. Caller error, so
  // it throws rather than quietly producing a useless plan.
  if (overlap < 0 || overlap >= sliceHeight) {
    throw new Error(
      `overlap must be between 0 and ${sliceHeight - 1}px for a ${sliceHeight}px slice, got ${overlap}`,
    );
  }
  const step = sliceHeight - overlap;
  const boxes: Box[] = [];
  for (let y = 0; y < height; y += step) {
    // Bottom-align the final slice instead of emitting a sliver: a 30px tall
    // last crop shows nothing, and the extra overlap costs nothing.
    if (y + sliceHeight >= height) {
      boxes.push({
        x: 0,
        y: Math.max(0, height - sliceHeight),
        width,
        height: Math.min(sliceHeight, height),
      });
      break;
    }
    boxes.push({ x: 0, y, width, height: sliceHeight });
  }
  return boxes;
}

/**
 * Decide how to look at an image without being silently degraded.
 *
 * The `slice` branch is the whole point of this module. When fitting an image
 * to the budget would take it below the legibility floor, downscaling produces
 * a picture that looks fine in a viewer and is worthless to read from. Six
 * readable crops beat one 319px-wide smear of a 7698px page.
 *
 * Slicing is only offered when a full-width slice can itself fit the edge
 * limit. A 3840px-wide image cannot be helped by full-width strips, so it is
 * downscaled however badly that reads — which is exactly the full-screen
 * capture case, and why the tool reports the reduction factor to the caller.
 */
export function planView(width: number, height: number, opts: ViewOptions = {}): ViewPlan {
  const tier = opts.tier ?? TIERS.standard;
  const minLongEdge = opts.minLongEdge ?? 900;
  const overlap = opts.overlap ?? 40;

  const fitted = resizedSize(width, height, tier);
  if (fitted.width === width && fitted.height === height) {
    return { kind: "asis", tokens: countImageTokens(width, height) };
  }

  const scale = fitted.width / width;
  const sliceable = Math.ceil(width / PATCH) * PATCH <= tier.maxEdge;
  // The shrink this fit demands, restated as the width it would leave on a
  // capture that filled the tier's edge budget. See ViewOptions.minLongEdge.
  const widthOnAFullBudgetCapture = scale * tier.maxEdge;

  if (sliceable && widthOnAFullBudgetCapture < minLongEdge) {
    const sliceHeight = maxSliceHeight(width, tier);
    const slices = tile(width, height, sliceHeight, overlap);
    const percent = Math.round(scale * 100);
    return {
      kind: "slice",
      slices,
      scaleIfForced: scale,
      reason:
        `fitting ${width}×${height} would give ${fitted.width}×${fitted.height} — ` +
        `${percent}% of the width, under the ${minLongEdge}px legibility floor. ` +
        `${slices.length} full-width slices of ${width}×${sliceHeight} instead, ` +
        `${overlap}px overlap.`,
    };
  }

  return {
    kind: "downscale",
    to: fitted,
    scale,
    tokens: countImageTokens(fitted.width, fitted.height),
  };
}

/** Unknown / absent names fall back to standard rather than throwing. */
export function resolveTier(name?: TierName | string): Tier {
  return name === "high" ? TIERS.highRes : TIERS.standard;
}
