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
	"every slice is inside the standard budget",
	fit.outputs.every((o) => o.tokens <= 1568),
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
