import { describe, expect, test } from "bun:test";
import {
  base64Bytes,
  countImageTokens,
  MANY_IMAGE_MAX_EDGE,
  MAX_BASE64_BYTES,
  MAX_EDGE_ABSOLUTE,
  planView,
  resizedSize,
  resolveTier,
  TIERS,
} from "./vision";

const size = (width: number, height: number) => ({ width, height });

describe("resizedSize — the published table in spec §3/§4", () => {
  test("1075×1520 → 924×1307 (the A4 example, §4)", () => {
    expect(resizedSize(1075, 1520)).toEqual(size(924, 1307));
  });

  test("1920×1080 → 1456×819, NOT 1568×882 (§4 warns explicitly)", () => {
    expect(resizedSize(1920, 1080)).toEqual(size(1456, 819));
    expect(resizedSize(1920, 1080)).not.toEqual(size(1568, 882));
  });

  test("3840×2160 → 1456×819", () => {
    expect(resizedSize(3840, 2160)).toEqual(size(1456, 819));
  });

  test("1092×1092 unchanged — the square ceiling", () => {
    expect(resizedSize(1092, 1092)).toEqual(size(1092, 1092));
  });

  test("1000×1000 and 200×200 unchanged", () => {
    expect(resizedSize(1000, 1000)).toEqual(size(1000, 1000));
    expect(resizedSize(200, 200)).toEqual(size(200, 200));
  });

  test("1075×1520 unchanged on the high-res tier — 2145 tokens fits in 4784", () => {
    expect(resizedSize(1075, 1520, TIERS.highRes)).toEqual(size(1075, 1520));
    expect(countImageTokens(1075, 1520)).toBe(2145);
  });

  test("3840×2160 → 2576×1449 on the high-res tier", () => {
    expect(resizedSize(3840, 2160, TIERS.highRes)).toEqual(size(2576, 1449));
    expect(countImageTokens(2576, 1449)).toBe(4784);
  });
});

/**
 * 2000×1500 is the one row where the spec contradicts itself, and it is not a
 * coincidence that it is also the banker's-rounding tie case.
 *
 * The binary search probes width 1270, where 1270 / (2000/1500) is exactly
 * 952.5. Half-to-even gives 952 → 46×34 = 1564 tokens → fits → the answer is
 * 1270×952. Rounding halves up gives 953 → 46×35 = 1610 tokens → does not fit
 * → the search settles one pixel lower, on 1269×952.
 *
 * §6's reference implementation is the executable artifact, so it wins over
 * §3's printed table. These assertions exist so that a refactor to Math.round
 * fails loudly rather than silently shifting every derived size by a pixel.
 */
describe("resizedSize — 2000×1500, the banker's-rounding pin", () => {
  test("§6's reference implementation gives 1270×952", () => {
    expect(resizedSize(2000, 1500)).toEqual(size(1270, 952));
  });

  test("Math.round would have produced the other answer", () => {
    const mathRoundHeight = Math.round(1270 / (2000 / 1500));
    expect(mathRoundHeight).toBe(953);
    expect(countImageTokens(1270, mathRoundHeight)).toBeGreaterThan(TIERS.standard.maxTokens);
  });

  test("both candidates cost the 1564 tokens §3 reports", () => {
    expect(countImageTokens(1270, 952)).toBe(1564);
    expect(countImageTokens(1269, 952)).toBe(1564);
  });
});

describe("resizedSize — the axis-swap recursion (§6 note 3)", () => {
  test("1080×1920 portrait → 819×1456, the transpose of 1920×1080", () => {
    expect(resizedSize(1080, 1920)).toEqual(size(819, 1456));
    expect(resizedSize(1920, 1080)).toEqual(size(1456, 819));
  });

  test("1520×1075 landscape is the transpose of the A4 example", () => {
    expect(resizedSize(1520, 1075)).toEqual(size(1307, 924));
  });

  test("a very tall image is driven to the edge limit, not the token limit", () => {
    expect(resizedSize(1568, 7698)).toEqual(size(319, 1568));
  });
});

describe("countImageTokens (§1)", () => {
  test("1000×1000 → 1296, 1092×1092 → 1521, 200×200 → 64", () => {
    expect(countImageTokens(1000, 1000)).toBe(1296);
    expect(countImageTokens(1092, 1092)).toBe(1521);
    expect(countImageTokens(200, 200)).toBe(64);
  });

  test("1456×819 → 1560, inside the 1568 budget", () => {
    expect(countImageTokens(1456, 819)).toBe(1560);
  });
});

/**
 * §10's "practical ceilings" table lists 2044×2044 as the largest unresized
 * square on the high-res tier. It cannot be: 2044 pads to 73 patches, and
 * 73 × 73 = 5329 tokens against a 4784 budget. The true ceiling is 1932×1932.
 */
describe("the practical ceilings (§10)", () => {
  test("1092×1092 is the largest unresized square on the standard tier", () => {
    expect(resizedSize(1092, 1092)).toEqual(size(1092, 1092));
    expect(countImageTokens(1120, 1120)).toBeGreaterThan(TIERS.standard.maxTokens);
  });

  test("the high-res square ceiling is 1932, not the 2044 §10 prints", () => {
    expect(countImageTokens(2044, 2044)).toBe(5329);
    expect(resizedSize(2044, 2044, TIERS.highRes)).toEqual(size(1932, 1932));
    expect(countImageTokens(1932, 1932)).toBe(4761);
  });
});

describe("padding (§5)", () => {
  // `paddedSize` was removed as dead code, but the rule it described is still
  // load-bearing and lives inside `fits()`: the edge limit is checked against
  // the PADDED edge. A 1560px edge is really 1568 to the limit check, so an
  // image one pixel over a patch boundary costs a whole extra row of tokens.
  test("the padded edge, not the raw edge, is what the limit sees", () => {
    expect(countImageTokens(1560, 28)).toBe(56); // 1560 pads to 1568 = 56 patches
    expect(countImageTokens(1568, 28)).toBe(56); // …and so does 1568 itself
    expect(countImageTokens(1569, 28)).toBe(57); // one pixel over costs a patch
  });
});

describe("base64 payload size (§7)", () => {
  test("a 4.5 MB raw file is a 6 MB payload", () => {
    expect(base64Bytes(4_500_000)).toBe(6_000_000);
  });

  test("that payload passes the API limit and fails Bedrock's", () => {
    expect(base64Bytes(4_500_000)).toBeLessThan(MAX_BASE64_BYTES.api);
    expect(base64Bytes(4_500_000)).toBeGreaterThan(MAX_BASE64_BYTES.bedrock);
  });
});

describe("planView", () => {
  test("1568×602 fits as-is", () => {
    const plan = planView(1568, 602);
    expect(plan.kind).toBe("asis");
    if (plan.kind !== "asis") throw new Error("unreachable");
    expect(plan.tokens).toBe(1232);
  });

  test("1568×1388 downscales to 1170×1036", () => {
    const plan = planView(1568, 1388);
    if (plan.kind !== "downscale") throw new Error("expected a downscale plan");
    expect(plan.to).toEqual(size(1170, 1036));
    expect(plan.tokens).toBe(1554);
    expect(Math.round(plan.scale * 100)).toBe(75);
  });

  test("1568×7698 slices rather than shrinking to 319px wide", () => {
    const plan = planView(1568, 7698);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    expect(plan.scaleIfForced).toBeCloseTo(319 / 1568, 4);
    expect(plan.reason).toContain("319");
  });

  test("every slice fits the budget on its own and none is a sliver", () => {
    const plan = planView(1568, 7698);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.width).toBe(1568);
      expect(box.height).toBe(784);
      expect(countImageTokens(box.width, box.height)).toBeLessThanOrEqual(
        TIERS.standard.maxTokens,
      );
    }
  });

  test("slices cover the image top to bottom and overlap by the requested amount", () => {
    const plan = planView(1568, 7698, { overlap: 40 });
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    const first = plan.slices[0]!;
    const last = plan.slices[plan.slices.length - 1]!;
    expect(first.y).toBe(0);
    expect(last.y + last.height).toBe(7698);
    for (let i = 1; i < plan.slices.length; i += 1) {
      const previous = plan.slices[i - 1]!;
      const current = plan.slices[i]!;
      expect(current.y).toBeLessThanOrEqual(previous.y + previous.height - 40);
    }
  });

  test("a portrait phone screenshot downscales — 76% is legible", () => {
    expect(planView(1080, 1920).kind).toBe("downscale");
  });

  test("a 4K screenshot downscales because full-width slices could never fit", () => {
    const plan = planView(3840, 2160);
    if (plan.kind !== "downscale") throw new Error("expected a downscale plan");
    expect(plan.to).toEqual(size(1456, 819));
  });

  test("an overlap at or above the slice height is caller error, not a silent 1800-crop plan", () => {
    expect(() => planView(1568, 7698, { overlap: 2000 })).toThrow(/overlap must be between/);
  });
});

describe("resolveTier", () => {
  test('"high" selects the high-res tier; everything else is standard', () => {
    expect(resolveTier("high").maxTokens).toBe(TIERS.highRes.maxTokens);
    expect(resolveTier("standard")).toBe(TIERS.standard);
    expect(resolveTier(undefined)).toBe(TIERS.standard);
    // A model that invents a tier name gets the safe default, not a throw.
    expect(resolveTier("ultra")).toBe(TIERS.standard);
  });
});

/**
 * Regression for a live 400 on 2026-08-05.
 *
 * Anthropic drops the per-image ceiling to 2000px once a request holds more
 * than 20 images. The high-res tier's spec edge is 2576, so `tier:"high"`
 * worked early in a session and killed the request later. Measured in the real
 * session that failed: 21 images, of which two were 2576×1449 — the first
 * succeeded at index 3, the second 400'd at index 20.
 */
describe("the >20-image ceiling (§7)", () => {
  test("the spec tier really is over the limit — this is why the clamp exists", () => {
    expect(TIERS.highRes.maxEdge).toBe(2576);
    expect(TIERS.highRes.maxEdge).toBeGreaterThan(MANY_IMAGE_MAX_EDGE);
  });

  test("the tier a tool actually gets is clamped to 2000", () => {
    expect(resolveTier("high").maxEdge).toBe(MANY_IMAGE_MAX_EDGE);
    // …without touching the token budget, which is what makes `high` useful.
    expect(resolveTier("high").maxTokens).toBe(4784);
  });

  test("the exact capture that died: 3840×2160 at high tier is now legal", () => {
    const fitted = resizedSize(3840, 2160, resolveTier("high"));
    expect(fitted).toEqual({ width: 1988, height: 1118 });
    expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(MANY_IMAGE_MAX_EDGE);
    // and it is still meaningfully better than standard, which is the point
    expect(fitted.width).toBeGreaterThan(resizedSize(3840, 2160, TIERS.standard).width);
  });

  test("NO input can make either shipped tier emit an image over 2000px", () => {
    const shapes: Array<[number, number]> = [
      [3840, 2160], [2880, 1800], [2800, 1800], [5120, 2880],
      [1000, 9000], [9000, 1000], [8000, 8000], [2576, 1449],
      [1092, 1092], [400, 300], [1, 12000], [12000, 1],
    ];
    for (const name of ["standard", "high"] as const) {
      const tier = resolveTier(name);
      for (const [w, h] of shapes) {
        const fitted = resizedSize(w, h, tier);
        expect({ name, w, h, over: Math.max(fitted.width, fitted.height) > MANY_IMAGE_MAX_EDGE })
          .toEqual({ name, w, h, over: false });
      }
    }
  });

  test("slices are legal too — they are cropped, not fitted, so they bypass resizedSize", () => {
    for (const name of ["standard", "high"] as const) {
      const plan = planView(1440, 6996, { tier: resolveTier(name) });
      if (plan.kind !== "slice") throw new Error(`expected a slice plan for ${name}`);
      for (const box of plan.slices) {
        expect(Math.max(box.width, box.height)).toBeLessThanOrEqual(MANY_IMAGE_MAX_EDGE);
      }
    }
  });
});

/**
 * The two failures that motivated this tool. Both are regressions waiting to
 * happen, so both are pinned.
 */
describe("the failures this pipeline exists to prevent", () => {
  test("`sips -Z 1400` leaves a 16:10 window OVER budget, so the API resizes again", () => {
    // What the sub-agent's shell one-liner actually produced.
    expect(countImageTokens(1400, 900)).toBe(1650);
    expect(countImageTokens(1400, 900)).toBeGreaterThan(TIERS.standard.maxTokens);
    // …so Claude resamples a second time, over text that was already resampled.
    expect(resizedSize(1400, 900)).toEqual(size(1372, 882));
    expect(countImageTokens(1372, 882)).toBe(1568);
  });

  test("`sips -Z 1568` is wrong for the same reason — the edge limit is not the binding one", () => {
    expect(countImageTokens(1568, 1008)).toBeGreaterThan(TIERS.standard.maxTokens);
  });

  test("trusting logical bounds under-resizes a 2× capture by a factor of 4 in area", () => {
    // Window 12394 reported CGWindowBounds of 1400×900 and captured at 2800×1800.
    // Planning from the logical size would have picked a target for the wrong image.
    expect(resizedSize(1400, 900)).toEqual(size(1372, 882));
    expect(resizedSize(2800, 1800)).toEqual(size(1372, 882));
    // Same target here by luck of the aspect ratio — but the token costs differ
    // by 4×, which is what a size check would have been reading.
    expect(countImageTokens(2800, 1800)).toBe(6500);
    expect(countImageTokens(1400, 900)).toBe(1650);
  });

  test("a full-screen 4K grab is 90% of the API payload cap before fitting", () => {
    // Measured: /tmp/p0-display.png, 3840×2160, 6,798,763 bytes on disk.
    const raw = 6_798_763;
    expect(base64Bytes(raw)).toBeGreaterThan(0.9 * MAX_BASE64_BYTES.api);
    expect(base64Bytes(raw)).toBeLessThan(MAX_BASE64_BYTES.api);
    // and over Bedrock's cap outright.
    expect(base64Bytes(raw)).toBeGreaterThan(MAX_BASE64_BYTES.bedrock);
  });
});

describe("the hard limits (§7)", () => {
  test("8000px is the absolute per-image dimension limit", () => {
    expect(MAX_EDGE_ABSOLUTE).toBe(8000);
    const plan = planView(1568, 12_000);
    if (plan.kind !== "slice") throw new Error("expected a slice plan");
    for (const box of plan.slices) {
      expect(box.height).toBeLessThanOrEqual(MAX_EDGE_ABSOLUTE);
    }
  });
});
