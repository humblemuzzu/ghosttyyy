/**
 * A model reading our own slices reported that a ~51,000px full-page capture
 * REPEATS earlier content past a certain depth: sections 1..13, then 1..6 again.
 *
 * Hypothesis: Chromium cannot produce a correct full-page screenshot beyond its
 * maximum texture size, 16384px (2^14), and silently returns garbage rather
 * than failing. If true, our tool has been handing back images that are simply
 * WRONG below that line — worse than truncation, because nothing says so.
 *
 * This measures it: capture the page, then compare a band from the top against
 * bands taken deeper down. Identical pixels where the content should differ
 * proves the repeat.
 *
 *   bun pi-setup/port-harness/tall-page-limit.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crop, load, readPngSize } from "../extensions/tools/lib/image";
import { captureWebPage } from "../extensions/tools/lib/web-capture";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tallpage-"));
const fixture = path.join(import.meta.dir, "fixtures", "endless.html");
const shot = path.join(out, "endless.png");

console.log("\ncapturing the fixture full-page…");
const info = await captureWebPage(shot, { url: `file://${fixture}`, width: 1440 });
const size = readPngSize(shot);
console.log(`  ${size.width}x${size.height}`);
console.log(
	info.clipped
		? `  clipped by the browser: ${info.clipped.capturedHeight}px of ${info.clipped.documentHeight}px`
		: "  not clipped",
);

const img = load(shot);

/**
 * Section geometry, derived from the image rather than assumed. The first probe
 * guessed 1200px because that is the CSS `height`, and was wrong: content-box
 * sizing adds 80px of padding and a 3px border, so each section is 1283px. That
 * error made it sample blank body areas — which are legitimately identical — and
 * report a repeat that was not there. Derive, do not guess.
 */
const SECTIONS = 40;
// Derived from the DOCUMENT, not the image — once clipping is in play the image
// no longer spans all 40 sections.
const documentHeight = info.clipped?.documentHeight ?? img.height;
const sectionHeight = Math.round(documentHeight / SECTIONS);
const HEADING_OFFSET = 40; // the section's top padding; the <h2> starts here
const BAND = 70; // tall enough to cover the 64px heading glyphs
console.log(`  derived section height: ${sectionHeight}px (${documentHeight} / ${SECTIONS})`);

/** Cheap content fingerprint for a horizontal band. */
function fingerprint(y: number): string {
	if (y < 0 || y + BAND > img.height) return "out-of-range";
	const band = crop(img, { x: 0, y, width: Math.min(700, img.width), height: BAND });
	let hash = 0;
	let ink = 0;
	for (let i = 0; i < band.rgb.length; i += 3) {
		const v = band.rgb[i] as number;
		hash = (hash * 31 + v) >>> 0;
		if (v < 128) ink++;
	}
	// A band with no dark pixels is blank, and blank bands match each other for
	// reasons that say nothing about the capture.
	return ink < 50 ? "blank" : hash.toString(16).padStart(8, "0");
}

console.log("\nfingerprint of each section's HEADING band:");
const seen = new Map<string, number>();
let firstRepeat = -1;
let blanks = 0;
for (let section = 1; section <= SECTIONS; section++) {
	const y = (section - 1) * sectionHeight + HEADING_OFFSET;
	const fp = fingerprint(y);
	if (fp === "out-of-range") {
		console.log(`  section ${String(section).padStart(2)}  y=${String(y).padStart(6)}  (past the image)`);
		break;
	}
	if (fp === "blank") {
		blanks++;
		console.log(`  section ${String(section).padStart(2)}  y=${String(y).padStart(6)}  BLANK — no heading rendered here`);
		continue;
	}
	const prior = seen.get(fp);
	const note = prior ? `  <== IDENTICAL to section ${prior}` : "";
	if (prior && firstRepeat < 0) firstRepeat = y;
	if (!prior) seen.set(fp, section);
	console.log(`  section ${String(section).padStart(2)}  y=${String(y).padStart(6)}  ${fp}${note}`);
}

console.log("");
console.log(`distinct headings found: ${seen.size} of ${SECTIONS}   blank bands: ${blanks}`);
console.log(
	`sections that FIT in the captured image: ${Math.floor(img.height / sectionHeight)}`,
);
if (firstRepeat < 0) {
	console.log(
		blanks === 0
			? "no repeats, no blanks — the capture is SOUND for its full height"
			: `no repeats, but ${blanks} band(s) rendered blank — content is MISSING below some depth`,
	);
} else {
	console.log(`FIRST REPEAT at y=${firstRepeat}`);
	console.log(`(Chromium's max texture size is 16384 = 2^14, a common suspect for this class.)`);
}
console.log(`\nartifacts: ${out}\n`);
