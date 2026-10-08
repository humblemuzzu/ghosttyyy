import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { save } from "./image";
import { imageIoOrientation, readExifOrientation, readHead, sniffImageFormat } from "./image-format";
import { jpegWithOrientation, TINY_WEBP, webpWithOrientation } from "./test-images";

const dir = mkdtempSync(join(tmpdir(), "pi-image-format-"));

function sipsConvert(format: string, ext: string): Buffer {
  const png = join(dir, "src.png");
  save({ width: 8, height: 6, rgb: new Uint8Array(8 * 6 * 3).fill(90) }, png);
  const out = join(dir, `out.${ext}`);
  execFileSync("sips", ["-s", "format", format, png, "--out", out], { stdio: "ignore" });
  return readFileSync(out);
}

describe("sniffImageFormat", () => {
  test("the four formats the API accepts, with their media types", () => {
    expect(sniffImageFormat(sipsConvert("png", "png"))).toEqual({ name: "png", apiMime: "image/png" });
    expect(sniffImageFormat(sipsConvert("jpeg", "jpg"))).toEqual({ name: "jpeg", apiMime: "image/jpeg" });
    expect(sniffImageFormat(sipsConvert("gif", "gif"))).toEqual({ name: "gif", apiMime: "image/gif" });
    expect(sniffImageFormat(TINY_WEBP)).toEqual({ name: "webp", apiMime: "image/webp" });
  });

  test("formats sips can decode but the API refuses carry no media type", () => {
    expect(sniffImageFormat(sipsConvert("heic", "heic"))).toEqual({ name: "heif" });
    expect(sniffImageFormat(sipsConvert("tiff", "tiff"))).toEqual({ name: "tiff" });
    expect(sniffImageFormat(sipsConvert("bmp", "bmp"))).toEqual({ name: "bmp" });
  });

  test("anything else is not an image", () => {
    expect(sniffImageFormat(Buffer.from("not an image at all"))).toBeUndefined();
    expect(sniffImageFormat(Buffer.alloc(0))).toBeUndefined();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  test("readHead returns the whole file when it is shorter than the window", () => {
    const p = join(dir, "short.png");
    save({ width: 2, height: 2, rgb: new Uint8Array(12) }, p);
    expect(readHead(p).length).toBe(readFileSync(p).length);
  });
});

describe("readExifOrientation", () => {
  const jpeg = sipsConvert("jpeg", "jpg");

  test("every value 1-8, little- and big-endian", () => {
    for (let o = 1; o <= 8; o += 1) {
      expect(readExifOrientation(jpegWithOrientation(jpeg, o, false), "jpeg")).toBe(o);
      expect(readExifOrientation(jpegWithOrientation(jpeg, o, true), "jpeg")).toBe(o);
    }
  });

  test("1 when there is no EXIF, or a value outside 1-8", () => {
    expect(readExifOrientation(jpeg, "jpeg")).toBe(1);
    expect(readExifOrientation(jpegWithOrientation(jpeg, 42, false), "jpeg")).toBe(1);
  });

  test("WebP keeps EXIF in its own RIFF chunk", () => {
    expect(readExifOrientation(TINY_WEBP, "webp")).toBe(1);
    expect(readExifOrientation(webpWithOrientation(TINY_WEBP, 6), "webp")).toBe(6);
  });

  test("other formats report 1", () => {
    expect(readExifOrientation(jpegWithOrientation(jpeg, 6, false), "png")).toBe(1);
  });
});

describe("imageIoOrientation", () => {
  test("reads rotation from HEIC and TIFF containers", () => {
    const rotated = join(dir, "rotated.jpg");
    writeFileSync(rotated, jpegWithOrientation(sipsConvert("jpeg", "jpg"), 6, false));
    for (const ext of ["heic", "tiff"]) {
      const out = join(dir, `rotated.${ext}`);
      execFileSync("sips", ["-s", "format", ext, rotated, "--out", out], { stdio: "ignore" });
      expect(imageIoOrientation(out)).toBe(6);
    }
    expect(imageIoOrientation(rotated)).toBe(6);
  });

  test("1 for an unrotated file, a non-image, or a missing path", () => {
    const plain = join(dir, "plain.heic");
    writeFileSync(plain, sipsConvert("heic", "heic"));
    expect(imageIoOrientation(plain)).toBe(1);
    expect(imageIoOrientation(join(dir, "does-not-exist.heic"))).toBe(1);
    const text = join(dir, "text.tiff");
    writeFileSync(text, "not an image");
    expect(imageIoOrientation(text)).toBe(1);
  });
});
