/**
 * Count image blocks in a session JSONL and report their real pixel dimensions,
 * WITHOUT ever materialising the base64 into anything readable.
 *
 * Written to diagnose a live 400:
 *   "messages.1.content.20.image.source.base64.data: At least one of the image
 *    dimensions exceed max allowed size for many-image requests: 2000 pixels"
 *
 * bun pi-setup/port-harness/analyze-session-images.ts <session.jsonl>
 */

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: bun analyze-session-images.ts <session.jsonl>");
	process.exit(2);
}

/** PNG IHDR, straight out of the decoded header bytes. No decode. */
function pngSize(b64: string): { w: number; h: number; kind: string } | null {
	const head = Buffer.from(b64.slice(0, 120), "base64");
	if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50) {
		return { w: head.readUInt32BE(16), h: head.readUInt32BE(20), kind: "png" };
	}
	if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
		return { w: -1, h: -1, kind: "jpeg" };
	}
	return null;
}

let total = 0;
let over2000 = 0;
const byDim = new Map<string, number>();
const order: Array<{ line: number; role: string; dim: string; over: boolean }> = [];

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
for (let i = 0; i < lines.length; i++) {
	let entry: any;
	try {
		entry = JSON.parse(lines[i]!);
	} catch {
		continue;
	}
	const msg = entry.message ?? entry;
	const content = msg?.content;
	if (!Array.isArray(content)) continue;
	for (const part of content) {
		if (part?.type !== "image") continue;
		const data = part.data ?? part.source?.data;
		if (typeof data !== "string") continue;
		total += 1;
		const size = pngSize(data);
		const dim = size ? (size.w > 0 ? `${size.w}x${size.h}` : size.kind) : "unknown";
		const over = !!size && (size.w > 2000 || size.h > 2000);
		if (over) over2000 += 1;
		byDim.set(dim, (byDim.get(dim) ?? 0) + 1);
		order.push({ line: i + 1, role: msg.role ?? entry.type ?? "?", dim, over });
	}
}

console.log(`\nsession: ${file.split("/").pop()}`);
console.log(`total image blocks: ${total}`);
console.log(`images with a dimension > 2000px: ${over2000}\n`);

console.log("by size:");
for (const [dim, n] of [...byDim.entries()].sort((a, b) => b[1] - a[1])) {
	const w = Number(dim.split("x")[0]);
	const flag = Number.isFinite(w) && w > 2000 ? "  <-- OVER THE 2000px MANY-IMAGE LIMIT" : "";
	console.log(`  ${String(n).padStart(3)} x  ${dim.padEnd(12)}${flag}`);
}

console.log("\nin order (image index -> size), 21st onward is where the limit applies:");
order.forEach((o, idx) => {
	const marker = idx === 20 ? "  <== content.20, the one the API named" : o.over ? "  <== over 2000px" : "";
	if (idx < 30) console.log(`  #${String(idx).padStart(2)}  line ${String(o.line).padStart(4)}  ${o.dim.padEnd(12)}${marker}`);
});
console.log("");
