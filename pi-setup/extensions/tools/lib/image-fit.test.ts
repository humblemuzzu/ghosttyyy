import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fitImageFile, fitResultBlocks, imageSize, pruneOutDir } from "./image-fit";
import { type Image, save } from "./image";
import { base64Bytes, countImageTokens, TIERS } from "./vision";

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-fit-test-"));
const outDir = path.join(dir, "out");

/** Deterministic pseudo-noise: incompressible, so payload tests are meaningful. */
function noise(width: number, height: number, seed = 1): Image {
	const rgb = new Uint8Array(width * height * 3);
	let s = seed >>> 0;
	for (let i = 0; i < rgb.length; i += 1) {
		s = (s * 1664525 + 1013904223) >>> 0;
		rgb[i] = (s >>> 16) & 0xff;
	}
	return { width, height, rgb };
}

function solid(width: number, height: number, v: number): Image {
	return { width, height, rgb: new Uint8Array(width * height * 3).fill(v) };
}

function write(name: string, img: Image): string {
	const p = path.join(dir, name);
	save(img, p);
	return p;
}

describe("fitImageFile — the asis fast path", () => {
	test("an image already inside the budget is passed through untouched", () => {
		const src = write("small.png", solid(800, 600, 128));
		const result = fitImageFile(src, { outDir });

		expect(result.plan).toBe("asis");
		expect(result.resamples).toBe(0);
		// The original file itself is returned — not a re-encode of it.
		expect(result.outputs).toHaveLength(1);
		expect(result.outputs[0]!.path).toBe(src);
		expect(result.outputs[0]!.width).toBe(800);
		expect(result.totalTokens).toBe(countImageTokens(800, 600));
		expect(result.summary).toContain("untouched");
	});

	test("the 1092×1092 square ceiling passes through", () => {
		const src = write("ceiling.png", solid(1092, 1092, 40));
		expect(fitImageFile(src, { outDir }).plan).toBe("asis");
	});
});

describe("fitImageFile — downscale", () => {
	test("a 4K-shaped capture lands on exactly the size planView predicted", () => {
		const src = write("uhd.png", noise(1920, 1080));
		const result = fitImageFile(src, { outDir });

		expect(result.plan).toBe("downscale");
		expect(result.resamples).toBe(1);
		expect(result.outputs[0]!.width).toBe(1456);
		expect(result.outputs[0]!.height).toBe(819);
		expect(result.outputs[0]!.tokens).toBe(1560);
		expect(result.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.standard.maxTokens);
		expect(result.summary).toContain("1 pass");
	});

	test("it resamples once — the output is never re-fitted by a second pass", () => {
		const src = write("once.png", noise(1920, 1080, 7));
		const result = fitImageFile(src, { outDir });
		// Feeding the output back in must be a no-op, which is the definition of
		// "the API will not resize this again".
		const again = fitImageFile(result.outputs[0]!.path, { outDir });
		expect(again.plan).toBe("asis");
		expect(again.resamples).toBe(0);
	});

	test("tier:high keeps more detail", () => {
		const src = write("hi.png", noise(1920, 1080, 3));
		const std = fitImageFile(src, { outDir, basename: "std" });
		const high = fitImageFile(src, { outDir, basename: "high", tier: "high" });
		expect(high.outputs[0]!.width).toBeGreaterThan(std.outputs[0]!.width);
		expect(high.outputs[0]!.tokens).toBeGreaterThan(std.outputs[0]!.tokens);
		expect(high.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
	});

	test("a >2x reduction warns that small text may soften", () => {
		const src = write("big.png", noise(3200, 1800));
		const result = fitImageFile(src, { outDir });
		expect(result.notes.join(" ")).toMatch(/reduction/);
		expect(result.notes.join(" ")).toContain('tier:"high"');
	});

	test("a mild reduction does not warn", () => {
		const src = write("mild.png", noise(1500, 900));
		const result = fitImageFile(src, { outDir });
		expect(result.plan).toBe("downscale");
		expect(result.notes.join(" ")).not.toMatch(/reduction/);
	});

	test("snap trades aspect ratio for patch alignment only when asked", () => {
		const src = write("snap.png", noise(1920, 1080, 11));
		const plain = fitImageFile(src, { outDir, basename: "plain" });
		const snapped = fitImageFile(src, { outDir, basename: "snapped", snap: true });
		// The fitted 16:9 width is 1456 = 52×28, already patch-aligned by luck of
		// the aspect ratio. Only the height (819) carries padding waste, so that
		// is the axis snapping can be observed on.
		expect(plain.outputs[0]!.width).toBe(1456);
		expect(plain.outputs[0]!.height).toBe(819);
		expect(plain.outputs[0]!.height % 28).not.toBe(0);
		expect(snapped.outputs[0]!.height).toBe(812);
		expect(snapped.outputs[0]!.height % 28).toBe(0);
		// …and this is the cost: the aspect ratio moved.
		expect(snapped.outputs[0]!.width / snapped.outputs[0]!.height).not.toBeCloseTo(
			plain.outputs[0]!.width / plain.outputs[0]!.height,
			3,
		);
	});
});

describe("fitImageFile — slice", () => {
	test("a tall page is cropped into readable strips rather than shrunk to a smear", () => {
		const src = write("tall.png", solid(1568, 5000, 200));
		const result = fitImageFile(src, { outDir });

		expect(result.plan).toBe("slice");
		expect(result.outputs.length).toBeGreaterThan(1);
		for (const out of result.outputs) {
			expect(out.width).toBe(1568);
			expect(out.height).toBe(784);
			expect(out.tokens).toBeLessThanOrEqual(TIERS.standard.maxTokens);
		}
		expect(result.summary).toContain("cropped not scaled");
	});

	test("slice files are named in reading order", () => {
		const src = write("tall2.png", solid(1568, 3000, 90));
		const result = fitImageFile(src, { outDir, basename: "page" });
		const names = result.outputs.map((o) => path.basename(o.path));
		expect(names[0]).toBe("page.slice-1.png");
		expect(names[1]).toBe("page.slice-2.png");
	});
});

describe("fitImageFile — the payload ladder", () => {
	// These caps are MEASURED, not guessed. How well pseudo-noise happens to
	// compress is not a property worth hard-coding, and a guessed constant here
	// tests the fixture rather than the ladder.
	const src = write("payload.png", noise(1400, 900, 42));
	const natural = fitImageFile(src, { outDir, basename: "natural" });
	const pngFloor = fitImageFile(src, { outDir, basename: "floor", maxBase64: 1 });

	test("the ladder shrinks geometry first, staying lossless", () => {
		// One byte under what the full-size fit produced: the very next dimension
		// step is far below this, so PNG must win.
		const cap = base64Bytes(natural.outputs[0]!.bytes) - 1;
		const result = fitImageFile(src, { outDir, basename: "ladder", maxBase64: cap });

		expect(base64Bytes(result.outputs[0]!.bytes)).toBeLessThanOrEqual(cap);
		expect(result.notes.join(" ")).toContain("payload ladder");
		expect(result.outputs[0]!.mimeType).toBe("image/png");
		expect(result.outputs[0]!.width).toBeLessThan(natural.outputs[0]!.width);
	});

	test("JPEG is the last resort and is announced", () => {
		// Below what the smallest lossless step can achieve, so only a lossy
		// encode can satisfy it.
		const cap = base64Bytes(pngFloor.outputs[0]!.bytes) - 1;
		const result = fitImageFile(src, { outDir, basename: "jpeg", maxBase64: cap });

		expect(result.outputs[0]!.mimeType).toBe("image/jpeg");
		expect(result.notes.join(" ")).toMatch(/JPEG q\d+/);
		expect(base64Bytes(result.outputs[0]!.bytes)).toBeLessThanOrEqual(cap);
		// Quality never goes below 75, however small the cap.
		expect(result.notes.join(" ")).not.toMatch(/JPEG q(7[0-4]|[0-6]\d)\b/);
	});

	test("the lossless floor is the 52% dimension step, not a quality reduction", () => {
		expect(pngFloor.outputs[0]!.mimeType).toBe("image/png");
		expect(pngFloor.outputs[0]!.width).toBe(Math.floor(natural.outputs[0]!.width * 0.52));
	});

	test("an impossible cap warns loudly instead of shipping a mangled image silently", () => {
		const src = write("payload3.png", noise(1400, 900, 5));
		const result = fitImageFile(src, { outDir, basename: "impossible", maxBase64: 500 });
		expect(result.notes.join(" ")).toContain("WARNING");
		expect(result.notes.join(" ")).toContain("may reject");
		// …and what it ships is still lossless, not a q10 smear.
		expect(result.outputs[0]!.mimeType).toBe("image/png");
	});
});

describe("fitImageFile — non-PNG input", () => {
	test("a JPEG is transcoded, fitted, and reported as transcoded", () => {
		const pngPath = write("photo-src.png", noise(1920, 1080, 21));
		const jpgPath = path.join(dir, "photo.jpg");
		execFileSync("sips", ["-s", "format", "jpeg", pngPath, "--out", jpgPath], {
			stdio: "ignore",
		});

		expect(imageSize(jpgPath)).toEqual({ width: 1920, height: 1080 });
		const result = fitImageFile(jpgPath, { outDir, basename: "photo" });
		expect(result.plan).toBe("downscale");
		expect(result.outputs[0]!.width).toBe(1456);
		expect(result.notes.join(" ")).toContain("no resize applied");
	});

	test("a small JPEG inside the budget is passed through with its own mime type", () => {
		const pngPath = write("tiny-src.png", solid(400, 300, 77));
		const jpgPath = path.join(dir, "tiny.jpg");
		execFileSync("sips", ["-s", "format", "jpeg", pngPath, "--out", jpgPath], {
			stdio: "ignore",
		});
		const result = fitImageFile(jpgPath, { outDir });
		expect(result.plan).toBe("asis");
		expect(result.outputs[0]!.mimeType).toBe("image/jpeg");
		expect(result.outputs[0]!.path).toBe(jpgPath);
	});
});

describe("fitResultBlocks", () => {
	test("images come first, then one text block with the audit trail", () => {
		const src = write("blocks.png", noise(1920, 1080, 4));
		const blocks = fitResultBlocks(fitImageFile(src, { outDir, basename: "blocks" }));
		expect(blocks[0]!.type).toBe("image");
		expect(blocks[blocks.length - 1]!.type).toBe("text");
		expect(String(blocks[blocks.length - 1]!.text)).toContain("1 pass");
		expect(String(blocks[blocks.length - 1]!.text)).toContain("saved:");
	});

	test("base64 is padded — unpadded data is rejected by the API with a 400", () => {
		const src = write("pad.png", noise(200, 133, 8));
		const result = fitImageFile(src, { outDir });
		const data = String(result.outputs[0]!.base64);
		expect(data.length % 4).toBe(0);
		expect(Buffer.from(data, "base64").length).toBe(result.outputs[0]!.bytes);
	});

	test("every slice becomes its own image block", () => {
		const src = write("many.png", solid(1568, 3000, 12));
		const result = fitImageFile(src, { outDir, basename: "many" });
		const blocks = fitResultBlocks(result);
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(result.outputs.length);
		expect(String(blocks[blocks.length - 1]!.text)).toContain("in order");
	});
});

describe("pruneOutDir", () => {
	test("removes stale files and keeps fresh ones", () => {
		const scratch = path.join(dir, "prune");
		fs.mkdirSync(scratch, { recursive: true });
		const old = path.join(scratch, "old.png");
		const fresh = path.join(scratch, "fresh.png");
		fs.writeFileSync(old, "x");
		fs.writeFileSync(fresh, "y");
		const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
		fs.utimesSync(old, longAgo, longAgo);

		pruneOutDir(scratch, 60 * 60 * 1000);
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
	});

	test("a missing directory is not an error", () => {
		expect(() => pruneOutDir(path.join(dir, "nope"))).not.toThrow();
	});
});
