/**
 * Every documented way an image request can be REJECTED, checked against what
 * this tool can actually emit. Reliability audit, not a cost audit.
 *
 * bun pi-setup/port-harness/failure-surface.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encode, save, type Image } from "../extensions/tools/lib/image";
import { fitImageFile } from "../extensions/tools/lib/image-fit";
import {
	base64Bytes,
	countImageTokens,
	MANY_IMAGE_MAX_EDGE,
	MAX_BASE64_BYTES,
	MAX_EDGE_ABSOLUTE,
	planView,
	resizedSize,
	resolveTier,
} from "../extensions/tools/lib/vision";

function noise(w: number, h: number): Image {
	const rgb = new Uint8Array(w * h * 3);
	let s = 7 >>> 0;
	for (let i = 0; i < rgb.length; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		rgb[i] = (s >>> 16) & 0xff;
	}
	return { width: w, height: h, rgb };
}

let risks = 0;
const flag = (ok: boolean, label: string, detail: string) => {
	if (!ok) risks++;
	console.log(`  ${ok ? "SAFE" : "RISK"}  ${label.padEnd(46)} ${detail}`);
};

console.log("\n=== 1. per-image dimension ceilings ===");
for (const name of ["standard", "high"] as const) {
	const tier = resolveTier(name);
	let maxEdge = 0;
	for (const [w, h] of [[3840, 2160], [5120, 2880], [8000, 8000], [1, 20000], [20000, 1], [2800, 1800]] as const) {
		const f = resizedSize(w, h, tier);
		maxEdge = Math.max(maxEdge, f.width, f.height);
	}
	flag(maxEdge <= MANY_IMAGE_MAX_EDGE, `${name}: largest edge we can emit`, `${maxEdge}px vs 2000 (>20-image rule)`);
	flag(maxEdge <= MAX_EDGE_ABSOLUTE, `${name}: vs the absolute 8000px ceiling`, `${maxEdge}px`);
}

console.log("\n=== 2. payload cap, worst-case incompressible content ===");
for (const name of ["standard", "high"] as const) {
	const tier = resolveTier(name);
	const f = resizedSize(3840, 2160, tier);
	const bytes = encode(noise(f.width, f.height)).length;
	const b64 = base64Bytes(bytes);
	console.log(
		`  ....  ${`${name}: raw payload at ${f.width}x${f.height}`.padEnd(46)} ` +
			`${(b64 / 1e6).toFixed(2)}MB vs 10MB cap${b64 > MAX_BASE64_BYTES.api ? "  (needs the ladder)" : ""}`,
	);
}

// Assumption-free version of the above: actually run the pipeline on the worst
// case and confirm what comes OUT is under the cap. "the ladder must engage" is
// a claim; this is a measurement.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-failsurf-"));
for (const name of ["standard", "high"] as const) {
	const f = resizedSize(3840, 2160, resolveTier(name));
	const src = path.join(scratch, `${name}.png`);
	save(noise(f.width, f.height), src);
	const fit = fitImageFile(src, { tier: name, outDir: scratch, basename: `out-${name}` });
	const out = fit.outputs[0]!;
	flag(
		base64Bytes(out.bytes) <= MAX_BASE64_BYTES.api,
		`${name}: what the pipeline ACTUALLY emits`,
		`${out.width}x${out.height} ${out.mimeType.split("/")[1]} -> ${(base64Bytes(out.bytes) / 1e6).toFixed(2)}MB`,
	);
}
fs.rmSync(scratch, { recursive: true, force: true });

console.log("\n=== 3. images produced by ONE call (the 100-per-request cap) ===");
for (const pageHeight of [3000, 6996, 12000, 20000, 50000, 100000]) {
	const plan = planView(1440, pageHeight, { tier: resolveTier("standard") });
	const n = plan.kind === "slice" ? plan.slices.length : 1;
	const tokens = plan.kind === "slice" ? n * countImageTokens(1440, plan.slices[0]!.height) : 0;
	flag(
		n <= 20,
		`a ${pageHeight}px page yields`,
		`${n} image(s)${tokens ? `, ~${tokens.toLocaleString()} tokens` : ""}${n > 20 ? "  <== blows past 20 in ONE call" : ""}`,
	);
}

console.log(`\n${risks === 0 ? "no risks found" : `${risks} RISK(S) FOUND`}\n`);
