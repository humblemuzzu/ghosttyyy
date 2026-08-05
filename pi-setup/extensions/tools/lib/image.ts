/**
 * Minimal PNG decode / encode / crop for the screenshot pipeline.
 *
 * Adapted from the `caliper` project's src/png.ts. Two deliberate deviations:
 *
 *  1. NO grayscale plane. caliper computes Rec.709 luma at load because every
 *     one of its measurement primitives reads it. We do no measurement, so on a
 *     3840×2160 capture that plane is 8.3 MB of allocation and one extra full
 *     pass over 8.3M pixels bought for nothing.
 *
 *  2. `readPngSize` reads the IHDR header only. The `asis` path must be able to
 *     answer "does this already fit?" without decoding an 8-megapixel image,
 *     and when it does fit we ship the original bytes rather than a re-encode.
 *     Decoding to re-encode an unchanged image is a pure loss: slower, and PNG
 *     round-trips are only lossless for pixels, not for whatever the encoder
 *     chose about filtering and chunk layout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { Box } from "./vision";

/*
 * DEPENDENCY NOTE: `pngjs` is ^7 but `@types/pngjs` is ^6.0.5, because 6.0.5 is
 * the newest version DefinitelyTyped publishes — there is no @types/pngjs@7 to
 * bump to, and pngjs ships no types of its own. The gap is safe only because
 * this file touches nothing but `PNG`, `PNG.sync.read` and `PNG.sync.write`,
 * which are unchanged across the major. Do not reach for newer pngjs APIs here
 * without checking them against the runtime rather than the types.
 */

/** A decoded image. `rgb` is 3 bytes per pixel, row-major, no padding. */
export interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Pixel dimensions straight out of the IHDR chunk — 24 bytes read, no decode.
 *
 * This is the "pixel truth" step. It must never be replaced by a logical or
 * point size: on this 2× display a window whose CGWindowBounds says 1400×900 is
 * captured at 2800×1800, and ClaudeImageResizer shipped a bug for exactly that
 * reason (NSImage.size reports points, so a 3136×2000 Retina capture read as
 * 1568×1000 and sailed past the budget check untouched).
 */
export function readPngSize(path: string): { width: number; height: number } {
  const fd = readFileSync(path, { flag: "r" });
  if (fd.length < 24) throw new Error(`not a PNG: ${path} is only ${fd.length} bytes`);
  if (!fd.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`not a PNG: ${path} has a bad signature`);
  }
  // 8-byte signature, then the IHDR chunk: 4 length + 4 type + width + height.
  return { width: fd.readUInt32BE(16), height: fd.readUInt32BE(20) };
}

export function load(path: string): Image {
  const png = PNG.sync.read(readFileSync(path));
  const pixels = png.width * png.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const alpha = png.data[i * 4 + 3] as number;
    // Flatten onto white. `screencapture -o` still leaves alpha at a window's
    // rounded corners; carrying an alpha channel through to the API would hand
    // Claude a composite decision we cannot predict, so we make it here and
    // make it the same way every time.
    for (let channel = 0; channel < 3; channel += 1) {
      const value = png.data[i * 4 + channel] as number;
      rgb[i * 3 + channel] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width: png.width, height: png.height, rgb };
}

export function encode(img: Image): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.width * img.height; i += 1) {
    png.data[i * 4] = img.rgb[i * 3] as number;
    png.data[i * 4 + 1] = img.rgb[i * 3 + 1] as number;
    png.data[i * 4 + 2] = img.rgb[i * 3 + 2] as number;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function save(img: Image, path: string): void {
  writeFileSync(path, encode(img));
}

export function crop(img: Image, box: Box): Image {
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > img.width ||
    box.y + box.height > img.height
  ) {
    throw new Error(
      `crop box ${box.x},${box.y} ${box.width}×${box.height} falls outside ${img.width}×${img.height}`,
    );
  }
  const rgb = new Uint8Array(box.width * box.height * 3);
  for (let y = 0; y < box.height; y += 1) {
    const from = (box.y + y) * img.width + box.x;
    rgb.set(img.rgb.subarray(from * 3, (from + box.width) * 3), y * box.width * 3);
  }
  return { width: box.width, height: box.height, rgb };
}
