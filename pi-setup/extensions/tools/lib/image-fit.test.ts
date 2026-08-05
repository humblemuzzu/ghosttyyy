import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DegenerateImageError,
	fitImageFile,
	fitResultBlocks,
	imageSize,
	pruneOutDir,
	TruncatedImageError,
} from "./image-fit";
import { type Image, save } from "./image";
import { base64Bytes, countImageTokens, MAX_IMAGES_PER_CALL, TIERS } from "./vision";

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
	test("standard tier lands on exactly the size planView predicted", () => {
		// Pinned to standard so the numbers are the published ones. The default
		// tier is covered separately below.
		const src = write("uhd.png", noise(1920, 1080));
		const result = fitImageFile(src, { outDir, tier: "standard" });

		expect(result.plan).toBe("downscale");
		expect(result.resamples).toBe(1);
		expect(result.outputs[0]!.width).toBe(1456);
		expect(result.outputs[0]!.height).toBe(819);
		expect(result.outputs[0]!.tokens).toBe(1560);
		expect(result.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.standard.maxTokens);
		expect(result.summary).toContain("1 pass");
	});

	test("the DEFAULT tier fits a real 4K grab to 1988x1118", () => {
		const src = write("uhd-default.png", noise(3840, 2160));
		const result = fitImageFile(src, { outDir, basename: "uhd-default" });
		expect(result.plan).toBe("downscale");
		expect(result.outputs[0]!.width).toBe(1988);
		expect(result.outputs[0]!.height).toBe(1118);
		expect(result.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
	});

	test("the default leaves a 1920x1080 source completely untouched", () => {
		// It already fits the high tier, so there is no resample at all — strictly
		// better than what standard would have done to it.
		const src = write("untouched.png", noise(1920, 1080, 5));
		const result = fitImageFile(src, { outDir, basename: "untouched" });
		expect(result.plan).toBe("asis");
		expect(result.resamples).toBe(0);
	});

	test("it resamples once — the output is never re-fitted by a second pass", () => {
		const src = write("once.png", noise(3840, 2160, 7));
		const result = fitImageFile(src, { outDir });
		// Feeding the output back in must be a no-op, which is the definition of
		// "the API will not resize this again".
		const again = fitImageFile(result.outputs[0]!.path, { outDir });
		expect(again.plan).toBe("asis");
		expect(again.resamples).toBe(0);
	});

	test("the default keeps more detail than an explicit standard", () => {
		const src = write("hi.png", noise(3840, 2160, 3));
		const std = fitImageFile(src, { outDir, basename: "std", tier: "standard" });
		const high = fitImageFile(src, { outDir, basename: "high" });
		expect(high.outputs[0]!.width).toBeGreaterThan(std.outputs[0]!.width);
		expect(high.outputs[0]!.tokens).toBeGreaterThan(std.outputs[0]!.tokens);
		expect(high.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
	});

	test("a >2x reduction warns that small text may soften", () => {
		const src = write("big.png", noise(3200, 1800));
		const result = fitImageFile(src, { outDir });
		// The old "small text may soften, pass tier:high" nag is gone: high is now
		// the floor, so the advice was both meaningless and fired on every 4K shot.
		expect(result.notes.join(" ")).not.toMatch(/soften/);
		expect(result.notes.join(" ")).not.toMatch(/token cost/);
	});

	test("no note mentions token cost anywhere", () => {
		const src = write("mild.png", noise(1500, 900));
		const result = fitImageFile(src, { outDir });
		expect(result.notes.join(" ")).not.toMatch(/cost|cheaper|tokens/i);
	});

	test("the fitted size preserves the source aspect ratio", () => {
		// What `snapToPatch` used to trade away, before it was removed as dead
		// code: patch-aligning each axis independently moved the aspect ratio by
		// up to 2.7%. The fit must not do that.
		const src = write("aspect.png", noise(3840, 2160, 11));
		const out = fitImageFile(src, { outDir, basename: "aspect" }).outputs[0]!;
		expect(out.width).toBe(1988);
		expect(out.height).toBe(1118);
		expect(out.width / out.height).toBeCloseTo(3840 / 2160, 2);
	});
});

describe("fitImageFile — slice", () => {
	test("standard tier crops a tall page into 784px strips", () => {
		// Pinned to standard so the slice geometry is the published one.
		const src = write("tall.png", solid(1568, 5000, 200));
		const result = fitImageFile(src, { outDir, tier: "standard" });

		expect(result.plan).toBe("slice");
		expect(result.outputs.length).toBeGreaterThan(1);
		for (const out of result.outputs) {
			expect(out.width).toBe(1568);
			expect(out.height).toBe(784);
			expect(out.tokens).toBeLessThanOrEqual(TIERS.standard.maxTokens);
		}
		expect(result.summary).toContain("cropped not scaled");
	});

	test("the DEFAULT tier slices the same page into FEWER, taller strips", () => {
		// Slice height scales with the tier budget, so the richer tier needs fewer
		// images for the same page — which is what keeps it away from the >20 and
		// 100-image request limits.
		const src = write("tall-default.png", solid(1568, 12000, 200));
		const std = fitImageFile(src, { outDir, basename: "td-std", tier: "standard" });
		const def = fitImageFile(src, { outDir, basename: "td-def" });

		expect(def.plan).toBe("slice");
		expect(def.outputs.length).toBeLessThan(std.outputs.length);
		for (const out of def.outputs) {
			expect(out.height).toBe(1988);
			expect(out.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
		}
	});

	test("slice files are named in reading order", () => {
		const src = write("tall2.png", solid(1568, 3000, 90));
		const result = fitImageFile(src, { outDir, basename: "page", tier: "standard" });
		const names = result.outputs.map((o) => path.basename(o.path));
		expect(names[0]).toBe("page.slice-1.png");
		expect(names[1]).toBe("page.slice-2.png");
	});

	test("an absurdly tall page is truncated to the cap, not returned in full", () => {
		// 1568 wide keeps it sliceable; 40,000 tall would need far more than the cap.
		const src = write("endless.png", solid(1568, 40000, 150));
		const result = fitImageFile(src, { outDir, basename: "endless" });

		expect(result.plan).toBe("slice");
		expect(result.outputs).toHaveLength(MAX_IMAGES_PER_CALL);
		// exactly as many files on disk as image blocks returned
		for (const out of result.outputs) expect(fs.existsSync(out.path)).toBe(true);
	}, 30_000);

	test("truncation is stated in the notes, in pixels, with a way forward", () => {
		const src = write("endless2.png", solid(1568, 40000, 150));
		const notes = fitImageFile(src, { outDir, basename: "endless2" }).notes.join(" ");
		expect(notes).toContain("TRUNCATED");
		expect(notes).toContain("40,000px");
		expect(notes).toContain("NOT captured");
		expect(notes).toMatch(/selector|region/);
	}, 30_000);

	test("a page inside the cap says nothing about truncation", () => {
		const src = write("short.png", solid(1568, 3000, 90));
		const notes = fitImageFile(src, { outDir, basename: "short" }).notes.join(" ");
		expect(notes).not.toContain("TRUNCATED");
	});

	test("the cap can be overridden per call", () => {
		const src = write("endless3.png", solid(1568, 40000, 150));
		const result = fitImageFile(src, { outDir, basename: "endless3", maxSlices: 3 });
		expect(result.outputs).toHaveLength(3);
	}, 30_000);
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
		// Must be large enough to actually need fitting — 1920x1080 now passes
		// through untouched on the default tier, which would test nothing.
		const pngPath = write("photo-src.png", noise(3840, 2160, 21));
		const jpgPath = path.join(dir, "photo.jpg");
		execFileSync("sips", ["-s", "format", "jpeg", pngPath, "--out", jpgPath], {
			stdio: "ignore",
		});

		expect(imageSize(jpgPath)).toEqual({ width: 3840, height: 2160 });
		const result = fitImageFile(jpgPath, { outDir, basename: "photo" });
		expect(result.plan).toBe("downscale");
		expect(result.outputs[0]!.width).toBe(1988);
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
		const src = write("blocks.png", noise(3840, 2160, 4));
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
		const result = fitImageFile(src, { outDir, basename: "many", tier: "standard" });
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

describe("fitImageFile — input that cannot become an image", () => {
	/*
	 * A live 400 — `Could not process image` — traced to a 65-byte PNG whose
	 * IHDR declared 0x0. A script killed mid-run left several on disk, and
	 * reading one failed the whole request, not just the call.
	 *
	 * It is the only malformed input that reaches the API: everything else fails
	 * while decoding. A 0x0 PNG parses fine and trivially fits every budget
	 * (zero tokens is inside any limit), so it takes the untouched `asis` path.
	 */
	const zeroByZeroPng = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000000000000008060000001f15c4890000000a49444154" +
			"789c6300010000050001" +
			"0d0a2db40000000049454e44ae426082",
		"hex",
	);

	test("a 0x0 PNG is refused, not forwarded to the API", () => {
		const p = path.join(dir, "degenerate.png");
		fs.writeFileSync(p, zeroByZeroPng);
		// Guard the fixture itself: if it stopped being 0x0 this test would pass
		// for the wrong reason.
		expect(imageSize(p)).toEqual({ width: 0, height: 0 });
		expect(() => fitImageFile(p, { outDir })).toThrow(DegenerateImageError);
	});

	test("the refusal explains what is wrong and why it matters", () => {
		const p = path.join(dir, "degenerate2.png");
		fs.writeFileSync(p, zeroByZeroPng);
		try {
			fitImageFile(p, { outDir });
			throw new Error("should have refused");
		} catch (e: any) {
			expect(e).toBeInstanceOf(DegenerateImageError);
			expect(e.message).toContain("0x0");
			expect(e.message).toContain("no pixels");
			expect(e.message).toMatch(/corrupt/i);
		}
	});

	test("a truncated PNG is refused — intact header, unfinished pixels", () => {
		// The nastier sibling of the 0x0 case: the header reports a plausible
		// 300x200, so every geometry check passes and `asis` ships 100 bytes as
		// an "image". Caught by the missing IEND marker, without decoding.
		const good = write("trunc-src.png", noise(300, 200, 3));
		const p = path.join(dir, "truncated.png");
		fs.writeFileSync(p, fs.readFileSync(good).subarray(0, 100));
		expect(imageSize(p)).toEqual({ width: 300, height: 200 }); // header still lies convincingly
		expect(() => fitImageFile(p, { outDir })).toThrow(TruncatedImageError);
	});

	test("a complete PNG is never mistaken for a truncated one", () => {
		// The check must have no false positives: refusing a valid image would be
		// a worse bug than the one it fixes.
		for (const [w, h] of [[1, 1], [17, 3], [300, 200], [1024, 768]] as const) {
			const p = write(`complete-${w}x${h}.png`, noise(w, h, w));
			expect(() => fitImageFile(p, { outDir, basename: `c-${w}x${h}` })).not.toThrow();
		}
	});

	test("genuinely broken files still fail, never silently", () => {
		const good = write("decode-src.png", noise(300, 200, 3));
		const cases: [string, Buffer][] = [
			["empty", Buffer.alloc(0)],
			["not an image", Buffer.from("this is not a png")],
			["half a file", fs.readFileSync(good).subarray(0, Math.floor(fs.statSync(good).size / 2))],
		];
		for (const [name, bytes] of cases) {
			const p = path.join(dir, `broken-${name.replace(/\W/g, "")}.png`);
			fs.writeFileSync(p, bytes);
			expect(() => fitImageFile(p, { outDir })).toThrow();
		}
	});

	test("a 1x1 image is still perfectly legal — only ZERO is refused", () => {
		const p = write("tiny.png", noise(1, 1, 1));
		const r = fitImageFile(p, { outDir, basename: "tiny-out" });
		expect(r.plan).toBe("asis");
		expect(r.outputs[0]!.width).toBe(1);
	});
});
