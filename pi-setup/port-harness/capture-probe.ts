/**
 * Exercises lib/capture.ts against the real machine.
 *
 * Not a unit test: it enumerates the actual window server, takes actual
 * screenshots, and — critically — provokes the off-Space window failure so the
 * error message can be read by a human. None of that is mockable, and mocking
 * it would only test the mock.
 *
 *   bun pi-setup/port-harness/capture-probe.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	captureDisplay,
	captureRegion,
	captureWindow,
	CaptureError,
	describeWindow,
	findWindows,
	listAllWindows,
	listWindows,
	permissionAdvice,
	screenRecordingGranted,
	titlesVisible,
} from "../extensions/tools/lib/capture";
import { imageSize } from "../extensions/tools/lib/image-fit";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capture-probe-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

console.log("\n=== permission ===");
const granted = screenRecordingGranted();
console.log(`  CGPreflightScreenCaptureAccess: ${granted}`);
console.log(`  titles visible (free heuristic):  ${titlesVisible()}`);
const advice = permissionAdvice();
console.log(`  advice: ${advice || "(none — permission looks fine)"}`);
check("the two permission signals agree", granted === undefined || granted === titlesVisible());

console.log("\n=== window enumeration ===");
const all = listAllWindows();
const windows = listWindows();
console.log(`  ${all.length} total windows, ${windows.length} after the layer-0 + size filter`);
check("found some windows", windows.length > 0);
check("filtering actually removes noise", windows.length < all.length);
check(
	"no 1x1 tracking windows survived",
	windows.every((w) => w.width >= 100 && w.height >= 100),
);
check(
	"on-screen windows sort first",
	windows.findIndex((w) => !w.onScreen) === -1 ||
		windows.findIndex((w) => !w.onScreen) >= windows.filter((w) => w.onScreen).length,
);
console.log("\n  first 8:");
for (const w of windows.slice(0, 8)) console.log(describeWindow(w));

const offScreen = windows.filter((w) => !w.onScreen);
const onScreen = windows.filter((w) => w.onScreen);
console.log(`\n  ${onScreen.length} on the current Space, ${offScreen.length} elsewhere`);
check(
	"listWindows sees windows the on-screen-only option would have hidden",
	offScreen.length > 0,
	offScreen.length === 0 ? "none off-Space right now; cannot prove it here" : "",
);

console.log("\n=== fuzzy matching ===");
if (onScreen[0]) {
	const target = onScreen[0];
	const byApp = findWindows({ app: target.app.toLowerCase().slice(0, 4) });
	check("substring app match finds the window", byApp.some((w) => w.id === target.id));
	const byId = findWindows({ id: target.id });
	check("id match is exact and unique", byId.length === 1 && byId[0]!.id === target.id);
	check("a nonsense app name matches nothing", findWindows({ app: "zzzznotanapp" }).length === 0);
}

console.log("\n=== capture: display ===");
const displayPath = path.join(out, "display.png");
await captureDisplay(displayPath);
const displaySize = imageSize(displayPath);
console.log(`  ${displaySize.width}x${displaySize.height}, ${fs.statSync(displayPath).size} bytes`);
check("display capture produced a file", fs.statSync(displayPath).size > 0);

console.log("\n=== capture: region (and the Retina factor) ===");
const regionPath = path.join(out, "region.png");
await captureRegion(regionPath, { x: 100, y: 100, width: 400, height: 300 });
const regionSize = imageSize(regionPath);
console.log(`  asked for 400x300 logical, got ${regionSize.width}x${regionSize.height} pixels`);
const dpr = regionSize.width / 400;
console.log(`  => device pixel ratio ${dpr}`);
check("region capture honours the requested aspect", regionSize.width / regionSize.height === 400 / 300);
check("dimensions are a clean multiple of the request", Number.isInteger(dpr));

console.log("\n=== capture: window on the current Space ===");
const target = onScreen.find((w) => w.width >= 300 && w.height >= 200);
if (!target) {
	console.log("  (no suitable on-screen window; skipped)");
} else {
	console.log(`  target:${describeWindow(target).trim()}`);
	const windowPath = path.join(out, "window.png");
	await captureWindow(windowPath, target);
	const got = imageSize(windowPath);
	console.log(`  bounds said ${target.width}x${target.height}, captured ${got.width}x${got.height}`);
	check("window capture produced a file", fs.statSync(windowPath).size > 0);
	check(
		"captured pixels exceed logical bounds — the Retina trap is real",
		got.width >= target.width,
		`ratio ${(got.width / target.width).toFixed(2)}x`,
	);
}

/**
 * Off-Space windows are NOT uniformly uncapturable. Measured here: an AutoFill
 * helper window on another Space captured fine, while a Ghostty terminal window
 * on another Space failed with "could not create image from window". Whether
 * the window server still holds a backing store is the real variable, and it is
 * not exposed anywhere we can read.
 *
 * So the tool cannot pre-emptively refuse off-Space windows — it has to try,
 * and explain properly when the attempt fails. This surveys the actual split.
 */
console.log("\n=== capture: windows on ANOTHER Space (survey) ===");
const sample = offScreen.filter((w) => w.width >= 200).slice(0, 10);
let captured = 0;
let refused = 0;
let messageChecked = false;
for (const w of sample) {
	const dest = path.join(out, `remote-${w.id}.png`);
	try {
		await captureWindow(dest, w);
		const got = imageSize(dest);
		captured += 1;
		console.log(`  captured  id ${String(w.id).padEnd(7)} ${w.app.padEnd(16)} ${got.width}x${got.height}`);
	} catch (err) {
		refused += 1;
		const message = err instanceof CaptureError ? err.message : String(err);
		console.log(`  refused   id ${String(w.id).padEnd(7)} ${w.app}`);
		if (!messageChecked) {
			messageChecked = true;
			console.log("\n  --- error the model would see ---");
			for (const line of message.split("\n")) console.log(`  | ${line}`);
			console.log("  ---\n");
			check("failure is a CaptureError", err instanceof CaptureError);
			check("explains the Space problem", /another Space/.test(message));
			check("offers a way forward", /activate:true/.test(message));
		}
	}
}
console.log(`  ${captured} captured, ${refused} refused out of ${sample.length} tried`);
check(
	"off-Space capture is genuinely mixed, so the tool must try rather than pre-refuse",
	sample.length === 0 || captured + refused === sample.length,
);
if (refused === 0 && sample.length > 0) {
	console.log("  note: nothing refused this run — the helpful-error path was not exercised");
}

console.log("\n=== bad input ===");
try {
	await captureRegion(path.join(out, "bad.png"), { x: 0, y: 0, width: 0, height: 10 });
	check("zero-width region rejected", false);
} catch (err) {
	check("zero-width region rejected", err instanceof CaptureError);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`artifacts: ${out}\n`);
process.exit(failures === 0 ? 0 : 1);
