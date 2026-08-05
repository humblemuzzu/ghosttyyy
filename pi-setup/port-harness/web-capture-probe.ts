/**
 * Exercises lib/web-capture.ts + the fit pipeline against real pages.
 *
 * The interesting case is a page TALLER than the screen: `screencapture` cannot
 * produce that image at all, and once produced it must slice rather than shrink.
 *
 *   bun pi-setup/port-harness/web-capture-probe.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWebPage, WebCaptureError } from "../extensions/tools/lib/web-capture";
import { fitImageFile, imageSize } from "../extensions/tools/lib/image-fit";
import { crop, load } from "../extensions/tools/lib/image";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-probe-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

// A local page we fully control: deterministic height, known text.
const fixture = path.join(out, "tall.html");
fs.writeFileSync(
	fixture,
	`<!doctype html><html><head><title>Tall Fixture</title><style>
     body { margin:0; font: 16px/1.5 -apple-system, sans-serif; }
     section { height: 800px; padding: 40px; border-bottom: 2px solid #333; }
     h2 { font-size: 42px; margin: 0 0 12px; }
   </style></head><body>
   ${Array.from({ length: 8 }, (_, i) => `<section><h2>SECTION ${i + 1}</h2><p>marker-${i + 1}</p></section>`).join("")}
   </body></html>`,
);

console.log("\n=== viewport-only vs full-page ===");
const viewportPath = path.join(out, "viewport.png");
await captureWebPage(viewportPath, { url: `file://${fixture}`, width: 1200, fullPage: false });
const viewportSize = imageSize(viewportPath);

const fullPath = path.join(out, "full.png");
const info = await captureWebPage(fullPath, { url: `file://${fixture}`, width: 1200 });
const fullSize = imageSize(fullPath);

console.log(`  viewport: ${viewportSize.width}x${viewportSize.height}`);
console.log(`  fullPage: ${fullSize.width}x${fullSize.height}`);
check("full-page is much taller than the viewport", fullSize.height > viewportSize.height * 4);
check("title was read", info.title === "Tall Fixture", info.title);
check("no page errors on a clean fixture", info.pageErrors.length === 0);
check("no horizontal overflow", info.overflow === 0, `overflow=${info.overflow}`);
check(
	"dsf defaults to 1, so width matches the requested viewport",
	viewportSize.width === 1200,
	`got ${viewportSize.width}`,
);

console.log("\n=== the fit pipeline slices it instead of smearing it ===");
const fit = fitImageFile(fullPath, { outDir: out, basename: "tall" });
console.log(`  plan=${fit.plan}  outputs=${fit.outputs.length}  tokens=${fit.totalTokens}`);
console.log(`  ${fit.summary}`);
check("a very tall page slices rather than downscales", fit.plan === "slice");
check("more than one slice", fit.outputs.length > 1);
check(
	"every slice is inside the tier budget",
	// The default tier is high (4784), not standard — slices are 1988px tall.
	fit.outputs.every((o) => o.tokens <= 4784),
	`max ${Math.max(...fit.outputs.map((o) => o.tokens))} tokens`,
);
check(
	"slices keep full width — nothing was scaled",
	fit.outputs.every((o) => o.width === fullSize.width),
);

console.log("\n=== element capture ===");
const elPath = path.join(out, "element.png");
await captureWebPage(elPath, { url: `file://${fixture}`, width: 1200, selector: "section:nth-child(6)" });
const elSize = imageSize(elPath);
console.log(`  section 6: ${elSize.width}x${elSize.height}`);
check("element shot is one section tall, not the whole page", elSize.height < fullSize.height / 4);
check("element below the fold was still captured", elSize.height > 100);

console.log("\n=== viewport width changes the layout ===");
const narrow = path.join(out, "narrow.png");
await captureWebPage(narrow, { url: `file://${fixture}`, width: 480, fullPage: false });
check("narrow viewport is honoured", imageSize(narrow).width === 480);

console.log("\n=== errors are explained, not thrown raw ===");

console.log("\n=== a page taller than Chromium can draw ===");
/*
 * Chromium silently returns BLANK pixels past its 16384px texture limit rather
 * than failing, and the tool used to slice that emptiness and present it as
 * content. Verified by tall-page-limit.ts: a 51,320px fixture rendered only its
 * first 13 sections, the remaining 27 bands came back empty.
 */
const endless = path.join(import.meta.dir, "fixtures", "endless.html");
if (fs.existsSync(endless)) {
	const tallPath = path.join(out, "endless.png");
	const tall = await captureWebPage(tallPath, { url: `file://${endless}`, width: 1440 });
	const tallSize = imageSize(tallPath);
	console.log(`  document ${tall.clipped?.documentHeight ?? tallSize.height}px, captured ${tallSize.height}px`);
	check("the over-tall page is reported as clipped", Boolean(tall.clipped));
	check("the captured height is Chromium's limit, not the document height", tallSize.height === 16384);
	check(
		"the document height is preserved so the caller knows what it is missing",
		(tall.clipped?.documentHeight ?? 0) > 16384,
		`${tall.clipped?.documentHeight}px`,
	);

	/*
	 * The point of clipping: everything returned must be REAL.
	 *
	 * Do NOT test this by sampling the bottom strip — the fixture's sections are
	 * 1283px tall with content only in the top ~150px, so the last 300px is
	 * legitimately blank and proves nothing. Test the DEEPEST HEADING that fits
	 * inside the clipped image: if Chromium had stopped drawing, that heading
	 * would be empty.
	 */
	const img = load(tallPath);
	const sectionH = Math.round((tall.clipped?.documentHeight ?? img.height) / 40);
	const deepest = Math.floor((img.height - 40) / sectionH); // last heading fully inside
	const headingY = (deepest - 1) * sectionH + 40;
	const band = crop(img, { x: 0, y: headingY, width: Math.min(700, img.width), height: 70 });
	let ink = 0;
	for (let i = 0; i < band.rgb.length; i += 3) if ((band.rgb[i] as number) < 128) ink++;
	check(
		`the deepest heading in the capture (section ${deepest}, y=${headingY}) actually rendered`,
		ink > 50,
		`${ink} dark px`,
	);

	const shortShot = path.join(out, "short.png");
	const short = await captureWebPage(shortShot, { url: `file://${fixture}`, width: 1200 });
	check("a normal-length page is NOT reported as clipped", short.clipped === undefined);
} else {
	console.log("  (fixtures/endless.html missing; skipped)");
}

try {
	await captureWebPage(path.join(out, "nope.png"), {
		url: `file://${fixture}`,
		selector: "#definitely-not-here",
	});
	check("a missing selector fails", false);
} catch (err) {
	check("a missing selector fails as WebCaptureError", err instanceof WebCaptureError);
	check("the message names the selector", /definitely-not-here/.test(String((err as Error).message)));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`artifacts: ${out}\n`);
process.exit(failures === 0 ? 0 : 1);
