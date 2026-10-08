/**
 * What an image file really is, read from its bytes. The API compares the
 * declared media type against the bytes and rejects a mismatch with a 400
 * that fails the whole request, so a file's extension is never trusted.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";

export type ImageFormatName = "png" | "jpeg" | "gif" | "webp" | "heif" | "tiff" | "bmp";

export interface ImageFormat {
  name: ImageFormatName;
  /** Set only for the formats the API accepts as-is. */
  apiMime?: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** Enough for the signature and, in practice, for a JPEG's APP1 EXIF segment. */
export const HEAD_BYTES = 128 * 1024;

export function readHead(file: string, bytes = HEAD_BYTES): Buffer {
  const head = Buffer.alloc(bytes);
  const fd = openSync(file, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

const ascii = (buf: Buffer, start: number, end: number): string =>
  buf.subarray(start, end).toString("latin1");

export function sniffImageFormat(head: Buffer): ImageFormat | undefined {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
    return { name: "png", apiMime: "image/png" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { name: "jpeg", apiMime: "image/jpeg" };
  }
  if (head.length >= 6 && (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a")) {
    return { name: "gif", apiMime: "image/gif" };
  }
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return { name: "webp", apiMime: "image/webp" };
  }
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(ascii(head, 8, 12))) {
    return { name: "heif" };
  }
  if (head.length >= 4 && (ascii(head, 0, 4) === "II*\0" || ascii(head, 0, 4) === "MM\0*")) {
    return { name: "tiff" };
  }
  if (head.length >= 2 && ascii(head, 0, 2) === "BM") {
    return { name: "bmp" };
  }
  return undefined;
}

/** EXIF orientation (1-8) of a JPEG or WebP; 1 when absent or unreadable. */
export function readExifOrientation(head: Buffer, format: ImageFormatName): number {
  const tiff = format === "jpeg" ? jpegTiffOffset(head) : format === "webp" ? webpTiffOffset(head) : -1;
  if (tiff < 0) return 1;
  const value = orientationFromTiff(head, tiff);
  return value >= 1 && value <= 8 ? value : 1;
}

const IMAGEIO_ORIENTATION_JXA = `
ObjC.import("ImageIO");
function run(argv) {
  var src = $.CGImageSourceCreateWithURL($.NSURL.fileURLWithPath(argv[0]), null);
  if (!src) return "1";
  var props = ObjC.deepUnwrap(ObjC.castRefToObject($.CGImageSourceCopyPropertiesAtIndex(src, 0, null)));
  return String((props && props.Orientation) || 1);
}`;

/**
 * Orientation as macOS ImageIO reports it, for containers the byte parser does
 * not read: HEIF keeps it in `irot`/`imir` boxes, TIFF in its own IFD.
 */
export function imageIoOrientation(file: string): number {
  try {
    const out = execFileSync("osascript", ["-l", "JavaScript", "-e", IMAGEIO_ORIENTATION_JXA, file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const value = Number(out.trim());
    return value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1;
  }
}

/** Orientation for any format: bytes for JPEG/WebP, ImageIO for HEIF/TIFF. */
export function orientationOf(file: string, head: Buffer, format: ImageFormat): number {
  if (format.name === "jpeg" || format.name === "webp") return readExifOrientation(head, format.name);
  if (format.name === "heif" || format.name === "tiff") return imageIoOrientation(file);
  return 1;
}

function isExifHeader(buf: Buffer, at: number): boolean {
  return at + 6 <= buf.length && ascii(buf, at, at + 6) === "Exif\0\0";
}

function jpegTiffOffset(buf: Buffer): number {
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return -1;
    const marker = buf[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return -1;
    const length = buf.readUInt16BE(at + 2);
    if (marker === 0xe1 && isExifHeader(buf, at + 4)) return at + 10;
    at += 2 + length;
  }
  return -1;
}

function webpTiffOffset(buf: Buffer): number {
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = ascii(buf, at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const data = at + 8;
    if (id === "EXIF") return isExifHeader(buf, data) ? data + 6 : data;
    at = data + size + (size % 2);
  }
  return -1;
}

function orientationFromTiff(buf: Buffer, tiff: number): number {
  if (tiff + 8 > buf.length) return 1;
  const order = ascii(buf, tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (at: number) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));

  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > buf.length) return 1;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buf.length) return 1;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}
