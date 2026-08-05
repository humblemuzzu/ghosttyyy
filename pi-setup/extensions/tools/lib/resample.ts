import type { Image } from "./image";
import type { Size } from "./vision";

/**
 * Area-average (box filter) downscale.
 *
 * Ported from the `caliper` project's src/resample.ts, minus its grayscale
 * plane (see image.ts for why).
 *
 * Lanczos and bicubic ring on hard edges, and a UI screenshot is nothing but
 * hard edges — text stems, 1px borders, button outlines. The ringing shows up
 * as a light halo around every glyph. Area averaging has no negative lobes, so
 * it cannot ring, and it is what a browser approximates when it draws an <img>
 * smaller than its natural size.
 *
 * This is the one place where we knowingly diverge from ClaudeImageResizer,
 * which uses CoreGraphics `.high` interpolation (a Lanczos-class filter). For
 * photographs Lanczos is the better choice; for the screenshots this tool
 * exists to take, it is the worse one.
 *
 * Each output pixel maps to a fractional rectangle in the source and every
 * straddling source pixel is weighted by its overlapping area, so non-integer
 * scale factors are handled exactly rather than approximated.
 *
 * Upscaling throws rather than returning something. Enlarging a capture invents
 * pixels that were never on screen.
 *
 * FLOATING-POINT BOUNDS (fixed 2026-08-05, present in the caliper original):
 * `(dx + 1) * xRatio` is not exactly `img.width` at the last column — for many
 * integer size pairs it overshoots by ~1e-15, so `Math.ceil` gives
 * `img.width + 1` and the inner loop reads one past the buffer. A `Uint8Array`
 * out-of-bounds read is `undefined`, `undefined * weight` is `NaN`, and
 * assigning `NaN` back into a `Uint8Array` silently stores 0 — a BLACK pixel,
 * with no error anywhere. Measured: 2880×1800 → 1389×868 (a real MacBook Pro
 * Retina resolution) blackens the bottom-right pixel; 21×21 → 19×19 blackens
 * the entire bottom row. The loop bounds are therefore clamped to the buffer.
 */
export function downscale(img: Image, to: Size): Image {
  if (to.width > img.width || to.height > img.height) {
    throw new Error(
      `downscale cannot enlarge: ${img.width}×${img.height} → ${to.width}×${to.height}`,
    );
  }
  if (to.width <= 0 || to.height <= 0) {
    throw new Error(`downscale target must be positive, got ${to.width}×${to.height}`);
  }
  if (to.width === img.width && to.height === img.height) return img;

  const xRatio = img.width / to.width;
  const yRatio = img.height / to.height;
  const rgb = new Uint8Array(to.width * to.height * 3);

  for (let dy = 0; dy < to.height; dy += 1) {
    const yStart = dy * yRatio;
    const yEnd = (dy + 1) * yRatio;
    // Clamped, not merely ceil'd — see the floating-point note above.
    const yLimit = Math.min(Math.ceil(yEnd), img.height);
    for (let dx = 0; dx < to.width; dx += 1) {
      const xStart = dx * xRatio;
      const xEnd = (dx + 1) * xRatio;
      const xLimit = Math.min(Math.ceil(xEnd), img.width);
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let sy = Math.floor(yStart); sy < yLimit; sy += 1) {
        const yWeight = Math.min(sy + 1, yEnd) - Math.max(sy, yStart);
        for (let sx = Math.floor(xStart); sx < xLimit; sx += 1) {
          const weight = yWeight * (Math.min(sx + 1, xEnd) - Math.max(sx, xStart));
          const at = (sy * img.width + sx) * 3;
          r += (img.rgb[at] as number) * weight;
          g += (img.rgb[at + 1] as number) * weight;
          b += (img.rgb[at + 2] as number) * weight;
          total += weight;
        }
      }
      const out = (dy * to.width + dx) * 3;
      rgb[out] = Math.round(r / total);
      rgb[out + 1] = Math.round(g / total);
      rgb[out + 2] = Math.round(b / total);
    }
  }

  return { width: to.width, height: to.height, rgb };
}
