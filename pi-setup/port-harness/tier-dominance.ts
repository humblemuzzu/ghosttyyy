/**
 * Is `high` EVER worse than `standard`?
 *
 * If high always produces an image at least as large as standard, then the tier
 * choice is not a trade-off at all and no decision needs to be made — by the
 * model or by the tool. Sweeps a wide space of real and pathological shapes.
 *
 * bun pi-setup/port-harness/tier-dominance.ts
 */

import { countImageTokens, resizedSize, resolveTier } from "../extensions/tools/lib/vision";

const std = resolveTier("standard");
const high = resolveTier("high");

let checked = 0;
let worse = 0;
let identical = 0;
let better = 0;
let noResampleWins = 0;

function compare(w: number, h: number): void {
	checked++;
	const s = resizedSize(w, h, std);
	const g = resizedSize(w, h, high);
	const sPix = s.width * s.height;
	const gPix = g.width * g.height;

	if (gPix < sPix) {
		worse++;
		console.log(`  WORSE  ${w}x${h}: standard ${s.width}x${s.height} vs high ${g.width}x${g.height}`);
	} else if (gPix === sPix) {
		identical++;
	} else {
		better++;
		// The best case: high fits the source untouched, so there is NO resample
		// at all, while standard would have had to resample.
		const highIsAsIs = g.width === w && g.height === h;
		const stdIsAsIs = s.width === w && s.height === h;
		if (highIsAsIs && !stdIsAsIs) noResampleWins++;
	}
}

// real capture shapes on a 2x display, plus web viewports
const real: Array<[number, number]> = [
	[3840, 2160], [2800, 1800], [3840, 2080], [1800, 1200], [1000, 600],
	[1440, 900], [2560, 1440], [5120, 2880], [1512, 982], [3024, 1964],
	[660, 1664], [990, 2406], [1440, 6996], [800, 600], [390, 844],
];
for (const [w, h] of real) compare(w, h);

// a broad sweep, including extreme aspect ratios
for (let w = 100; w <= 6000; w += 137) {
	for (let h = 100; h <= 6000; h += 311) compare(w, h);
}

console.log(`\nchecked ${checked} shapes`);
console.log(`  high strictly better : ${better}`);
console.log(`  identical            : ${identical}`);
console.log(`  high WORSE           : ${worse}`);
console.log(`  of the wins, cases where high needs NO resample at all: ${noResampleWins}`);
console.log(
	`\nverdict: ${worse === 0 ? "high DOMINATES standard — it is never worse, so there is no trade-off to decide" : "high is sometimes worse; a decision IS needed"}\n`,
);
process.exit(worse === 0 ? 0 : 1);
