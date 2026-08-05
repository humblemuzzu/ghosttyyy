/**
 * Is the pure-JS fit pipeline fast enough to sit inside a tool call?
 *
 * Run against a REAL `screencapture` output, not a synthetic image — the whole
 * question is whether an 8.3-megapixel Retina grab decodes in a time a caller
 * will tolerate. Synthetic flat-colour PNGs compress to nothing and decode in
 * milliseconds, which would answer a question nobody asked.
 *
 *   screencapture -x -o /tmp/bench.png
 *   bun pi-setup/port-harness/screenshot-bench.ts /tmp/bench.png
 */

import { statSync } from "node:fs";
import { crop, encode, load, readPngSize } from "../extensions/tools/lib/image";
import { downscale } from "../extensions/tools/lib/resample";
import { base64Bytes, MAX_BASE64_BYTES, planView, TIERS } from "../extensions/tools/lib/vision";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun screenshot-bench.ts <capture.png>");
  process.exit(2);
}

function ms<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(34)} ${dt.toFixed(1).padStart(8)} ms`);
  return out;
}

const bytes = statSync(path).size;
console.log(`\nsource: ${path}`);
console.log(`  ${"on disk".padEnd(34)} ${bytes.toLocaleString().padStart(11)} bytes`);
console.log(
  `  ${"as base64".padEnd(34)} ${base64Bytes(bytes).toLocaleString().padStart(11)} bytes  ` +
    `(${((base64Bytes(bytes) / MAX_BASE64_BYTES.api) * 100).toFixed(1)}% of API cap)`,
);

console.log("\nheader-only size read (the asis fast path):");
const size = ms("readPngSize", () => readPngSize(path));
console.log(`  -> ${size.width}x${size.height}`);

for (const tierName of ["standard", "high"] as const) {
  const tier = tierName === "high" ? TIERS.highRes : TIERS.standard;
  const p = planView(size.width, size.height, { tier });
  console.log(`\ntier=${tierName}: plan=${p.kind}`);
  if (p.kind === "downscale") {
    console.log(
      `  ${size.width}x${size.height} -> ${p.to.width}x${p.to.height}` +
        `  (${(1 / p.scale).toFixed(2)}x reduction, ${p.tokens} tokens)`,
    );
  } else if (p.kind === "asis") {
    console.log(`  already fits, ${p.tokens} tokens`);
  } else {
    console.log(`  ${p.slices.length} slices - ${p.reason}`);
  }
}

console.log("\nfull pipeline @ tier=standard:");
const img = ms("load (pngjs decode + flatten)", () => load(path));
const plan = planView(img.width, img.height, { tier: TIERS.standard });

if (plan.kind === "downscale") {
  const small = ms("downscale (area-average)", () => downscale(img, plan.to));
  const out = ms("encode (pngjs)", () => encode(small));
  ms("base64", () => out.toString("base64"));
  console.log(
    `  -> ${small.width}x${small.height}, ${out.length.toLocaleString()} bytes, ` +
      `base64 ${base64Bytes(out.length).toLocaleString()} ` +
      `(${((base64Bytes(out.length) / MAX_BASE64_BYTES.api) * 100).toFixed(1)}% of API cap)`,
  );
} else if (plan.kind === "slice") {
  const first = plan.slices[0]!;
  ms("crop one slice", () => crop(img, first));
}

console.log("");
