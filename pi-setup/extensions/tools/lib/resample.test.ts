import { describe, expect, test } from "bun:test";
import type { Image } from "./image";
import { downscale } from "./resample";

/**
 * A neutral vertical ramp: every row is one flat grey, stepping linearly from
 * `from` to `to`. Neutral so that any RGB channel can stand in for luminance,
 * which is what lets these tests assert exact integers.
 */
function verticalRamp(width: number, height: number, from: number, to: number): Image {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const value = height === 1 ? from : Math.round(from + ((to - from) * y) / (height - 1));
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      rgb[at] = value;
      rgb[at + 1] = value;
      rgb[at + 2] = value;
    }
  }
  return { width, height, rgb };
}

function checkerboard(width: number, height: number, cell: number): Image {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = on ? 0 : 255;
      const at = (y * width + x) * 3;
      rgb[at] = value;
      rgb[at + 1] = value;
      rgb[at + 2] = value;
    }
  }
  return { width, height, rgb };
}

const channel = (img: Image, stride = 3): number[] => {
  const out: number[] = [];
  for (let i = 0; i < img.rgb.length; i += stride) out.push(img.rgb[i] as number);
  return out;
};

const mean = (img: Image): number => {
  let total = 0;
  for (let i = 0; i < img.rgb.length; i += 1) total += img.rgb[i] as number;
  return total / img.rgb.length;
};

describe("downscale", () => {
  test("refuses to enlarge, on either axis", () => {
    const img = verticalRamp(8, 8, 0, 255);
    expect(() => downscale(img, { width: 16, height: 8 })).toThrow(/cannot enlarge/);
    expect(() => downscale(img, { width: 8, height: 16 })).toThrow(/cannot enlarge/);
  });

  test("refuses a zero-sized target", () => {
    const img = verticalRamp(8, 8, 0, 255);
    expect(() => downscale(img, { width: 0, height: 4 })).toThrow(/must be positive/);
  });

  test("an identical target is returned untouched, not copied", () => {
    const img = verticalRamp(8, 8, 0, 255);
    expect(downscale(img, { width: 8, height: 8 })).toBe(img);
  });

  test("an exact 2:1 ratio averages pixel pairs", () => {
    // Four rows of 0, 50, 100, 150 → two rows of 25 and 125.
    const img = verticalRamp(1, 4, 0, 150);
    expect(channel(img)).toEqual([0, 50, 100, 150]);
    expect(channel(downscale(img, { width: 1, height: 2 }))).toEqual([25, 125]);
  });

  test("a 3:2 ratio splits the straddling pixel by area, not by nearest neighbour", () => {
    // Rows 0, 105, 210. Output row 0 covers [0, 1.5) → (0·1 + 105·0.5)/1.5 = 35.
    // Output row 1 covers [1.5, 3)  → (105·0.5 + 210·1)/1.5 = 175.
    // Nearest-neighbour would give 0 and 210; bilinear would give neither.
    const img = verticalRamp(1, 3, 0, 210);
    expect(channel(img)).toEqual([0, 105, 210]);
    expect(channel(downscale(img, { width: 1, height: 2 }))).toEqual([35, 175]);
  });

  test("a flat colour survives untouched", () => {
    const img: Image = {
      width: 40,
      height: 40,
      rgb: new Uint8Array(40 * 40 * 3),
    };
    for (let i = 0; i < 40 * 40; i += 1) {
      img.rgb[i * 3] = 0x3b;
      img.rgb[i * 3 + 1] = 0x82;
      img.rgb[i * 3 + 2] = 0xf6;
    }
    const small = downscale(img, { width: 10, height: 10 });
    expect(Array.from(small.rgb.subarray(0, 3))).toEqual([0x3b, 0x82, 0xf6]);
    expect(new Set(small.rgb).size).toBe(3);
  });

  test("area averaging conserves the mean, which is why it cannot ring", () => {
    // A box filter has no negative lobes, so no output pixel can fall outside
    // the range of its inputs and the overall mean is preserved. Lanczos would
    // overshoot at every one of these hard edges.
    const img = checkerboard(240, 240, 12);
    const small = downscale(img, { width: 60, height: 60 });
    expect(Math.abs(mean(small) - mean(img))).toBeLessThan(1);
  });

  test("no output pixel escapes the input range — the no-ringing property", () => {
    const img = checkerboard(120, 120, 8);
    const small = downscale(img, { width: 37, height: 37 });
    for (const value of small.rgb) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  test("the requested size is the size returned", () => {
    const img = verticalRamp(1568, 1388, 0, 255);
    const fitted = downscale(img, { width: 1170, height: 1036 });
    expect(fitted.width).toBe(1170);
    expect(fitted.height).toBe(1036);
    expect(fitted.rgb.length).toBe(1170 * 1036 * 3);
  });

  test("the real screenshot target: 3840×2160 → 1456×819 keeps the buffer exact", () => {
  	const img = checkerboard(3840, 2160, 16);
  	const fitted = downscale(img, { width: 1456, height: 819 });
  	expect(fitted.rgb.length).toBe(1456 * 819 * 3);
  	expect(Math.abs(mean(fitted) - mean(img))).toBeLessThan(1);
  });
  });

  /**
  * Regression: a floating-point overshoot in the loop bounds read one pixel past
  * the source buffer. A `Uint8Array` OOB read is `undefined`, `undefined * w` is
  * `NaN`, and storing `NaN` into a `Uint8Array` silently writes 0 — a black
  * pixel with no error raised anywhere.
  *
  * These assert EXACT pixel values, deliberately. The pre-existing tests all
  * checked aggregates (mean, length, range) and every one of them passed while
  * the bug was live, because three black bytes out of 3.6 million move the mean
  * by 0.00002.
  */
  describe("downscale — no out-of-bounds read at the far edge", () => {
  function solid(width: number, height: number, value: number): Image {
  	return { width, height, rgb: new Uint8Array(width * height * 3).fill(value) };
  }

  /**
   * Averaging a constant must return that constant, everywhere. Any deviation
   * is arithmetic touching something that is not in the image.
   */
  const cases: Array<[number, number, number, number]> = [
  	[21, 21, 19, 19], // blackened a whole row before the fix
  	[2880, 1800, 1389, 868], // MacBook Pro Retina — blackened the corner pixel
  	[3840, 2160, 1456, 819], // this display, full screen
  	[2800, 1800, 1372, 882], // a 1400×900 window at 2x
  	[1800, 1200, 1344, 896], // a 900×600 region at 2x
  	[100, 100, 99, 99], // near-identity, worst case for ratio precision
  	[1000, 1000, 3, 3], // extreme reduction
  ];

  for (const [sw, sh, tw, th] of cases) {
  	test(`${sw}×${sh} → ${tw}×${th} produces no stray pixel`, () => {
  		const out = downscale(solid(sw, sh, 200), { width: tw, height: th });
  		const strays = out.rgb.reduce((n, v) => (v === 200 ? n : n + 1), 0);
  		expect(strays).toBe(0);
  	});
  }

  test("a brute-force sweep of target sizes finds no stray pixel", () => {
  	const source = solid(97, 61, 137);
  	for (let tw = 1; tw <= 97; tw += 1) {
  		for (let th = 1; th <= 61; th += 7) {
  			const out = downscale(source, { width: tw, height: th });
  			const strays = out.rgb.reduce((n, v) => (v === 137 ? n : n + 1), 0);
  			expect({ tw, th, strays }).toEqual({ tw, th, strays: 0 });
  		}
  	}
  });
  });
