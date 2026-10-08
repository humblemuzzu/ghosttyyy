/** Fixture builders shared by the image tests. Not loaded by pi: it only loads index.ts. */

/** 40×20 lossless WebP: red, green / blue, white quadrants. sips cannot write WebP. */
export const TINY_WEBP = Buffer.from(
  "UklGRjoAAABXRUJQVlA4TC4AAAAvJ8AEAB8gEEjeHzqN+RcQFPwf3fxHZA9ATcA0DCYxicmOvAiI6P8EhGYzcdgM",
  "base64",
);

/** A TIFF block holding one IFD entry: Orientation (0x0112), SHORT, `value`. */
function tiffWithOrientation(value: number, bigEndian: boolean): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const u16 = (v: number, at: number) => (bigEndian ? tiff.writeUInt16BE(v, at) : tiff.writeUInt16LE(v, at));
  const u32 = (v: number, at: number) => (bigEndian ? tiff.writeUInt32BE(v, at) : tiff.writeUInt32LE(v, at));
  tiff.write(bigEndian ? "MM" : "II", 0, "latin1");
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(value, 18);
  return tiff;
}

/** `jpeg` with an APP1 EXIF segment carrying `value` inserted after SOI. */
export function jpegWithOrientation(jpeg: Buffer, value: number, bigEndian: boolean): Buffer {
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffWithOrientation(value, bigEndian)]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, body, jpeg.subarray(2)]);
}

/** `webp` with an EXIF chunk carrying `value` appended, RIFF size fixed up. */
export function webpWithOrientation(webp: Buffer, value: number): Buffer {
  const tiff = tiffWithOrientation(value, false);
  const header = Buffer.alloc(8);
  header.write("EXIF", 0, "latin1");
  header.writeUInt32LE(tiff.length, 4);
  const out = Buffer.concat([webp, header, tiff, Buffer.alloc(tiff.length % 2)]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
