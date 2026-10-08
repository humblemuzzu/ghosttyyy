/**
 * Image budget maths for Claude's vision pipeline.
 * Behaviour-identical to caliper's src/vision.ts and ClaudeImageResizer's
 * ImageBudget.swift. Change a constant in all three and re-run vision.test.ts.
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
 * file size against them passes files the API then rejects.
 */
export const MAX_BASE64_BYTES = { api: 10_000_000, bedrock: 5_000_000 } as const;

/** §7: "The maximum dimensions per image are 8000x8000 px." */
export const MAX_EDGE_ABSOLUTE = 8000;

/**
 * §7: more than 20 images in a request drops the per-image ceiling to 2000px.
 * a tool cannot see how many images are already in the conversation, so
 * resolveTier never emits an image that could be illegal at that cap.
 */
export const MANY_IMAGE_MAX_EDGE = 2000;

/**
 * most images one tool call may produce. Anthropic's wall is 100 per request
 * (the whole conversation). exceeding this truncates from the top rather than
 * failing the turn.
 */
export const MAX_IMAGES_PER_CALL = 12;

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
 * size Claude resizes to before padding. the token limit binds first for most
 * screenshots — `sips -Z 1568` satisfies the edge and blows the token limit,
 * so the API resamples a second time.
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

/** §7: base64 encodes 3 bytes as 4 characters, so a payload is ~1.37× the file. */
export function base64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export type ViewPlan =
  | { kind: "asis"; tokens: number }
  | { kind: "downscale"; to: Size; scale: number; tokens: number }
  | {
      kind: "slice";
      slices: Box[];
      scaleIfForced: number;
      reason: string;
      /** Present only when the page was too tall for `maxSlices`. */
      truncated?: {
        /** Pixels of the source actually covered, from the top. */
        coveredHeight: number;
        totalHeight: number;
        /** How many slices full coverage would have taken. */
        neededSlices: number;
      };
    };

export interface ViewOptions {
  tier?: Tier;
  /** compared against `scale * tier.maxEdge`; below this, body text stops being readable. */
  minLongEdge?: number;
  /**
   * Vertical overlap between slices. A feature landing exactly on a seam is
   * unreadable in either neighbour, and 40px covers a line of body text plus
   * its leading.
   */
  overlap?: number;
  /**
   * Hard ceiling on how many slices the plan may contain. Defaults to
   * `MAX_IMAGES_PER_CALL`. See that constant for why a cap exists at all.
   */
  maxSlices?: number;
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

function tile(
  width: number,
  height: number,
  sliceHeight: number,
  overlap: number,
  maxSlices: number,
): { boxes: Box[]; neededSlices: number } {
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
  // How many slices FULL coverage would take, computed before any capping so
  // the caller can be told what it is missing rather than just handed a short
  // list with no explanation.
  const neededSlices = Math.max(1, Math.ceil((height - sliceHeight) / step) + 1);

  const boxes: Box[] = [];
  for (let y = 0; y < height; y += step) {
    // Capped: stop cleanly at the limit. Deliberately NOT bottom-aligned here —
    // that trick exists to cover the tail of a page we are covering entirely,
    // and jumping to the bottom mid-way would leave an unannounced hole in the
    // middle of the result.
    if (boxes.length >= maxSlices) return { boxes, neededSlices };
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
  return { boxes, neededSlices };
}

/**
 * when fitting would go below the legibility floor, slice into full-width
 * crops. slicing is only offered when a full-width slice itself fits the edge
 * limit.
 */
export function planView(width: number, height: number, opts: ViewOptions = {}): ViewPlan {
  const tier = opts.tier ?? TIERS.standard;
  const minLongEdge = opts.minLongEdge ?? 900;
  const overlap = opts.overlap ?? 40;
  const maxSlices = opts.maxSlices ?? MAX_IMAGES_PER_CALL;

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
    const { boxes: slices, neededSlices } = tile(width, height, sliceHeight, overlap, maxSlices);
    const percent = Math.round(scale * 100);

    const last = slices[slices.length - 1]!;
    const coveredHeight = last.y + last.height;
    const truncated =
      neededSlices > slices.length
        ? { coveredHeight, totalHeight: height, neededSlices }
        : undefined;

    return {
      kind: "slice",
      slices,
      scaleIfForced: scale,
      ...(truncated ? { truncated } : {}),
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

/**
 * high is the default: never smaller than standard. clamped to
 * MANY_IMAGE_MAX_EDGE — there is no escape hatch back to 2576 (legal early
 * in a session, a 400 later). TIERS keeps the spec values for the test vectors.
 */
export function resolveTier(name?: TierName | string): Tier {
  // Only an explicit "standard" opts down. Anything else — absent, "high", or a
  // name a model invented — gets the tier that is never worse.
  if (name === "standard") return TIERS.standard;
  return {
    maxEdge: Math.min(TIERS.highRes.maxEdge, MANY_IMAGE_MAX_EDGE),
    maxTokens: TIERS.highRes.maxTokens,
  };
}
