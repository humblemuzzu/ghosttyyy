import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { crop, encode, type Image, load, readPngSize, save } from "./image";

const dir = mkdtempSync(join(tmpdir(), "pi-image-test-"));

function solid(width: number, height: number, r: number, g: number, b: number): Image {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

/** Write an RGBA PNG directly, so alpha handling can be exercised on load. */
function writeRgba(path: string, width: number, height: number, px: number[][]): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b, a] = px[i]!;
    png.data[i * 4] = r!;
    png.data[i * 4 + 1] = g!;
    png.data[i * 4 + 2] = b!;
    png.data[i * 4 + 3] = a!;
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe("readPngSize", () => {
  test("reads dimensions from the IHDR without decoding", () => {
    const path = join(dir, "size.png");
    save(solid(637, 421, 10, 20, 30), path);
    expect(readPngSize(path)).toEqual({ width: 637, height: 421 });
  });

  test("agrees with a full decode", () => {
    const path = join(dir, "agree.png");
    save(solid(129, 77, 1, 2, 3), path);
    const header = readPngSize(path);
    const decoded = load(path);
    expect(header).toEqual({ width: decoded.width, height: decoded.height });
  });

  test("rejects a non-PNG rather than returning garbage dimensions", () => {
    const path = join(dir, "not.png");
    writeFileSync(path, Buffer.from("this is definitely not a png file at all"));
    expect(() => readPngSize(path)).toThrow(/bad signature/);
  });

  test("rejects a truncated file", () => {
    const path = join(dir, "tiny.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(() => readPngSize(path)).toThrow(/only 4 bytes/);
  });
});

describe("load / encode round-trip", () => {
  test("an opaque image survives a round-trip exactly", () => {
    const path = join(dir, "rt.png");
    const original = solid(16, 9, 0x3b, 0x82, 0xf6);
    save(original, path);
    const back = load(path);
    expect(back.width).toBe(16);
    expect(back.height).toBe(9);
    expect(Array.from(back.rgb)).toEqual(Array.from(original.rgb));
  });

  test("encode produces bytes a decoder accepts", () => {
    const bytes = encode(solid(4, 4, 200, 100, 50));
    const png = PNG.sync.read(bytes);
    expect(png.width).toBe(4);
    expect(png.height).toBe(4);
    expect(png.data[3]).toBe(255);
  });
});

describe("alpha flattening", () => {
  test("a fully transparent pixel becomes white, not black", () => {
    // Leaving it at 0 would put a black block where a window's rounded corner
    // was. Compositing onto white is the decision we make once, here.
    const path = join(dir, "alpha.png");
    writeRgba(path, 2, 1, [
      [255, 0, 0, 255],
      [255, 0, 0, 0],
    ]);
    const img = load(path);
    expect(Array.from(img.rgb.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(img.rgb.subarray(3, 6))).toEqual([255, 255, 255]);
  });

  test("a half-transparent black pixel lands halfway to white", () => {
    const path = join(dir, "half.png");
    writeRgba(path, 1, 1, [[0, 0, 0, 128]]);
    const img = load(path);
    // (0*128 + 255*127)/255 = 127.0
    expect(Array.from(img.rgb.subarray(0, 3))).toEqual([127, 127, 127]);
  });
});

describe("crop", () => {
  test("extracts the requested box", () => {
    const img: Image = { width: 4, height: 2, rgb: new Uint8Array(4 * 2 * 3) };
    for (let i = 0; i < 8; i += 1) {
      img.rgb[i * 3] = i;
      img.rgb[i * 3 + 1] = i;
      img.rgb[i * 3 + 2] = i;
    }
    const box = crop(img, { x: 1, y: 0, width: 2, height: 2 });
    expect(box.width).toBe(2);
    expect(box.height).toBe(2);
    // row 0 cols 1,2 = pixels 1,2 ; row 1 cols 1,2 = pixels 5,6
    expect([box.rgb[0], box.rgb[3], box.rgb[6], box.rgb[9]]).toEqual([1, 2, 5, 6]);
  });

  test("a box that runs off the edge throws instead of reading adjacent rows", () => {
    const img = solid(4, 4, 1, 1, 1);
    expect(() => crop(img, { x: 3, y: 0, width: 2, height: 1 })).toThrow(/falls outside/);
    expect(() => crop(img, { x: 0, y: 0, width: 0, height: 1 })).toThrow(/falls outside/);
    expect(() => crop(img, { x: -1, y: 0, width: 2, height: 1 })).toThrow(/falls outside/);
  });

  test("a full-size crop is the whole image", () => {
    const img = solid(3, 3, 9, 8, 7);
    const whole = crop(img, { x: 0, y: 0, width: 3, height: 3 });
    expect(Array.from(whole.rgb)).toEqual(Array.from(img.rgb));
  });
});
