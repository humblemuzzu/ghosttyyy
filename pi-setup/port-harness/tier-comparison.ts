/**
 * What each tier actually gives you, for the shapes this machine produces.
 * bun pi-setup/port-harness/tier-comparison.ts
 */

import { countImageTokens, resizedSize, resolveTier } from "../extensions/tools/lib/vision";

const cases: Array<[string, number, number]> = [
	["full display (4K)", 3840, 2160],
	["a 1400x900 window @2x", 2800, 1800],
	["a 1920x1040 Ghostty window @2x", 3840, 2080],
	["a 900x600 region @2x", 1800, 1200],
	["a 500x300 region @2x", 1000, 600],
	["a web page at 1440 wide", 1440, 900],
];

const pad = (s: string, n: number) => s.padEnd(n);
console.log(
	`\n${pad("capture", 32)}${pad("standard", 24)}${pad("high", 24)}cost ratio   detail gain`,
);
console.log("-".repeat(104));

for (const [label, w, h] of cases) {
	const s = resizedSize(w, h, resolveTier("standard"));
	const hi = resizedSize(w, h, resolveTier("high"));
	const st = countImageTokens(s.width, s.height);
	const ht = countImageTokens(hi.width, hi.height);
	const same = s.width === hi.width && s.height === hi.height;
	console.log(
		pad(label, 32) +
			pad(`${s.width}x${s.height}  ${st}t`, 24) +
			pad(`${hi.width}x${hi.height}  ${ht}t`, 24) +
			(same ? "identical — high buys nothing" : `${(ht / st).toFixed(2)}x        ${(hi.width / s.width).toFixed(2)}x wider`),
	);
}
console.log("");
