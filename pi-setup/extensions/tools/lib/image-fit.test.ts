import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { limitsForModel } from "./image-budget";
import {
	DegenerateImageError,
	type FitResult,
	fitImageFile,
	fitResultBlocks,
	imageSize,
	pruneOutDir,
	TruncatedImageError,
	UnreadableImageError,
	UnusableImageError,
} from "./image-fit";
import { type Image, load, save } from "./image";
import { jpegWithOrientation, TINY_WEBP } from "./test-images";
import { countImageTokens, MAX_IMAGES_PER_CALL, TIERS } from "./vision";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fit-test-"));
const outDir = path.join(dir, "out");
const limits = limitsForModel();
const MiB = 1024 * 1024;

const { normalizeToolResultImages } = await import(
	path.join(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "utils", "tool-result-images.js")
);

/** Deterministic pseudo-noise: incompressible, so byte-size tests are meaningful. */
function noise(width: number, height: number, seed = 1): Image {
	const rgb = new Uint8Array(width * height * 3);
	let s = seed >>> 0;
	for (let i = 0; i < rgb.length; i += 1) {
		s = (s * 1664525 + 1013904223) >>> 0;
		rgb[i] = (s >>> 16) & 0xff;
	}
	return { width, height, rgb };
}

/** Smooth gradients with low-amplitude grain: large as PNG, much smaller as JPEG, like a photo. */
function photo(width: number, height: number, seed = 1): Image {
	const rgb = new Uint8Array(width * height * 3);
	let s = seed >>> 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			s = (s * 1664525 + 1013904223) >>> 0;
			const grain = (s >>> 24) & 0x07;
			const i = (y * width + x) * 3;
			rgb[i] = ((x * 255) / width + grain) & 0xff;
			rgb[i + 1] = (((y % 997) * 255) / 997 + grain) & 0xff;
			rgb[i + 2] = (((x + y) % 255) + grain) & 0xff;
		}
	}
	return { width, height, rgb };
}

function solid(width: number, height: number, v: number): Image {
	return { width, height, rgb: new Uint8Array(width * height * 3).fill(v) };
}

/** Red, green / blue, white quadrants. */
function quadrants(width: number, height: number): Image {
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const left = x < width / 2;
			const top = y < height / 2;
			const [r, g, b] = top ? (left ? [255, 0, 0] : [0, 255, 0]) : left ? [0, 0, 255] : [255, 255, 255];
			rgb.set([r!, g!, b!], (y * width + x) * 3);
		}
	}
	return { width, height, rgb };
}

function colorAt(img: Image, fx: number, fy: number): string {
	const i = (Math.floor(img.height * fy) * img.width + Math.floor(img.width * fx)) * 3;
	const [r, g, b] = [img.rgb[i]!, img.rgb[i + 1]!, img.rgb[i + 2]!];
	if (r > 200 && g > 200 && b > 200) return "white";
	if (r > 200) return "red";
	if (g > 200) return "green";
	if (b > 200) return "blue";
	return "other";
}

function write(name: string, img: Image): string {
	const p = path.join(dir, name);
	save(img, p);
	return p;
}

function convert(src: string, format: string, name: string): string {
	const out = path.join(dir, name);
	execFileSync("sips", ["-s", "format", format, src, "--out", out], { stdio: "ignore" });
	return out;
}

const decodeOutput = (file: string): Image =>
	file.endsWith(".png") ? load(file) : load(convert(file, "png", `${path.basename(file)}.check.png`));

const sniff = (base64: string): string => {
	const b = Buffer.from(base64.slice(0, 32), "base64");
	if (b[0] === 0x89) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
	if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
	if (b.subarray(8, 12).toString() === "WEBP") return "image/webp";
	return "unknown";
};

function expectWithinPiProfile(result: FitResult): void {
	for (const out of result.outputs) {
		expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(limits.maxSide);
		expect(out.base64.length).toBeLessThanOrEqual(limits.maxImageBase64);
		expect(sniff(out.base64)).toBe(out.mimeType);
	}
}

describe("fitImageFile — untouched when it already fits", () => {
	test("an image inside the budget is the original file, not a re-encode", () => {
		const src = write("small.png", solid(800, 600, 128));
		const result = fitImageFile(src, { outDir });
		expect(result.plan).toBe("asis");
		expect(result.resamples).toBe(0);
		expect(result.outputs).toHaveLength(1);
		expect(result.outputs[0]!.path).toBe(src);
		expect(result.totalTokens).toBe(countImageTokens(800, 600));
		expect(result.summary).toContain("untouched");
	});

	test("1920×1080 needs no resize on the high tier", () => {
		const result = fitImageFile(write("fhd.png", noise(1920, 1080, 5)), { outDir });
		expect(result.plan).toBe("asis");
		expect(result.resamples).toBe(0);
	});
});

describe("fitImageFile — downscale", () => {
	test("standard tier lands on the published size", () => {
		const result = fitImageFile(write("uhd.png", noise(1920, 1080)), { outDir, tier: "standard" });
		expect(result.plan).toBe("downscale");
		expect(result.resamples).toBe(1);
		expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([1456, 819]);
		expect(result.outputs[0]!.tokens).toBe(1560);
		expect(result.summary).toContain("1 pass");
	});

	test("the high tier fits a 4K grab to 2000×1125, inside every limit", () => {
		const result = fitImageFile(write("uhd-high.png", quadrants(3840, 2160)), { outDir, basename: "uhd-high" });
		expect(result.plan).toBe("downscale");
		expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([2000, 1125]);
		expect(result.outputs[0]!.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
		expect(result.outputs[0]!.width / result.outputs[0]!.height).toBeCloseTo(3840 / 2160, 2);
	});

	test("the output is final: fitting it again changes nothing", () => {
		const result = fitImageFile(write("once.png", noise(3840, 2160, 7)), { outDir, basename: "once" });
		const again = fitImageFile(result.outputs[0]!.path, { outDir, basename: "once-again" });
		expect(again.plan).toBe("asis");
		expect(again.resamples).toBe(0);
	});

	test("high keeps more pixels than standard", () => {
		const src = write("hi.png", noise(3840, 2160, 3));
		const std = fitImageFile(src, { outDir, basename: "std", tier: "standard" });
		const high = fitImageFile(src, { outDir, basename: "high" });
		expect(high.outputs[0]!.width).toBeGreaterThan(std.outputs[0]!.width);
	});

	test("no note mentions cost", () => {
		const result = fitImageFile(write("mild.png", noise(2500, 1500)), { outDir, basename: "mild" });
		expect(result.notes.join(" ")).not.toMatch(/cost|cheaper/i);
	});
});

describe("fitImageFile — slice", () => {
	test("standard tier crops a tall page into 784px strips", () => {
		const result = fitImageFile(write("tall.png", solid(1568, 5000, 200)), { outDir, tier: "standard" });
		expect(result.plan).toBe("slice");
		for (const out of result.outputs) {
			expect([out.width, out.height]).toEqual([1568, 784]);
		}
		expect(result.summary).toContain("cropped not scaled");
	});

	test("the high tier uses fewer, 2000px strips", () => {
		const src = write("tall-high.png", solid(1568, 12000, 200));
		const std = fitImageFile(src, { outDir, basename: "td-std", tier: "standard" });
		const high = fitImageFile(src, { outDir, basename: "td-high" });
		expect(high.outputs.length).toBeLessThan(std.outputs.length);
		for (const out of high.outputs) {
			expect(out.height).toBe(2000);
			expect(out.tokens).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
		}
	});

	test("slice files are named in reading order", () => {
		const result = fitImageFile(write("tall2.png", solid(1568, 3000, 90)), {
			outDir,
			basename: "page",
			tier: "standard",
		});
		expect(result.outputs.map((o) => path.basename(o.path)).slice(0, 2)).toEqual([
			"page.slice-1.png",
			"page.slice-2.png",
		]);
	});

	test("a very tall page is cut at the per-call image cap, and says so in pixels", () => {
		const result = fitImageFile(write("endless.png", solid(1568, 40000, 150)), { outDir, basename: "endless" });
		expect(result.outputs).toHaveLength(MAX_IMAGES_PER_CALL);
		for (const out of result.outputs) expect(fs.existsSync(out.path)).toBe(true);
		const notes = result.notes.join(" ");
		expect(notes).toContain("TRUNCATED");
		expect(notes).toContain("40,000px");
		expect(notes).toContain("NOT captured");
		expect(notes).toMatch(/selector|region/);
	}, 30_000);

	test("a page inside the cap says nothing about truncation", () => {
		const result = fitImageFile(write("short.png", solid(1568, 3000, 90)), { outDir, basename: "short" });
		expect(result.notes.join(" ")).not.toContain("TRUNCATED");
	});

	test("the image count comes from the call budget", () => {
		const result = fitImageFile(write("endless3.png", solid(1568, 40000, 150)), {
			outDir,
			basename: "endless3",
			budget: { bytes: 8 * MiB, images: 3 },
		});
		expect(result.outputs).toHaveLength(3);
	}, 30_000);
});

describe("fitImageFile — the call's byte budget", () => {
	const page = write("photo-page.png", photo(800, 10_000, 9));
	const full = fitImageFile(page, { outDir, basename: "photo-full", budget: { bytes: 100 * MiB, images: 12 } });

	test("with room to spare, every slice stays lossless PNG", () => {
		expect(full.plan).toBe("slice");
		expect(full.outputs.length).toBeGreaterThan(3);
		expect(full.outputs.every((o) => o.mimeType === "image/png")).toBe(true);
	});

	const halfBudget = Math.floor(full.totalBase64 * 0.5);
	const tight = fitImageFile(page, { outDir, basename: "photo-tight", budget: { bytes: halfBudget, images: 12 } });

	test("over budget, the largest slices become JPEG q90 before any is dropped", () => {
		expect(tight.outputs).toHaveLength(full.outputs.length);
		expect(tight.totalBase64).toBeLessThanOrEqual(halfBudget);
		expect(tight.outputs.some((o) => o.mimeType === "image/jpeg" && o.quality === 90)).toBe(true);
		expect(tight.notes.join(" ")).toContain("photo-heavy");
		expect(tight.notes.join(" ")).not.toContain("TRUNCATED");
	}, 30_000);

	test("when JPEG is not enough, slices are dropped from the bottom and the gap is reported", () => {
		const jpegSlice = Math.max(...tight.outputs.filter((o) => o.mimeType === "image/jpeg").map((o) => o.base64.length));
		const budget = Math.floor(jpegSlice * 2.5);
		const result = fitImageFile(page, { outDir, basename: "photo-drop", budget: { bytes: budget, images: 12 } });
		expect(result.outputs.length).toBeGreaterThanOrEqual(1);
		expect(result.outputs.length).toBeLessThan(full.outputs.length);
		expect(result.totalBase64).toBeLessThanOrEqual(budget);
		expect(result.notes.join(" ")).toMatch(/TRUNCATED.*request-size limit/);
		expect(path.basename(result.outputs[0]!.path)).toContain("slice-1");
		for (const out of result.outputs) expect(fs.existsSync(out.path)).toBe(true);
	}, 30_000);
});

describe("fitImageFile — the per-image byte ladder", () => {
	const src = write("payload.png", noise(1400, 900, 42));
	const natural = fitImageFile(src, { outDir, basename: "natural", limits: { ...limits, maxImageBase64: 100 * MiB } });
	const withCap = (cap: number, basename: string) =>
		fitImageFile(src, { outDir, basename, limits: { ...limits, maxImageBase64: cap } });

	test("the default cap sits just under pi's 4.5 MiB re-encode threshold", () => {
		expect(limits.maxImageBase64).toBe(4.5 * MiB - 1);
	});

	test("over the cap as PNG, full-size JPEG q90 comes before any shrinking", () => {
		const result = withCap(natural.outputs[0]!.base64.length - 1, "ladder-q90");
		expect(result.outputs[0]!.mimeType).toBe("image/jpeg");
		expect(result.outputs[0]!.quality).toBe(90);
		expect(result.outputs[0]!.width).toBe(1400);
		expect(result.notes.join(" ")).toContain("at full size");
		expect(result.summary).toContain("JPEG q90");
	});

	test("then q80, and only then a smaller size", () => {
		const q90 = withCap(natural.outputs[0]!.base64.length - 1, "ladder-a").outputs[0]!;
		const q80 = withCap(q90.base64.length - 1, "ladder-b").outputs[0]!;
		expect([q80.quality, q80.width]).toEqual([80, 1400]);
		const shrunk = withCap(q80.base64.length - 1, "ladder-c");
		expect(shrunk.outputs[0]!.width).toBe(Math.floor(1400 * 0.85));
		expect(shrunk.outputs[0]!.quality).toBe(80);
		expect(shrunk.notes.join(" ")).toContain("85% size");
		expect(shrunk.summary).toContain("1400×900 → 1190×765");
	});

	test("quality never goes below 80, and an impossible cap is reported", () => {
		const result = withCap(500, "impossible");
		expect(result.outputs[0]!.quality).toBe(80);
		expect(result.notes.join(" ")).toContain("WARNING");
		expect(result.notes.join(" ")).toContain("pi will re-encode");
		expect(fs.existsSync(result.outputs[0]!.path)).toBe(true);
	});

	test("slices that each need the ladder share one note", () => {
		const result = fitImageFile(write("noisy-page.png", noise(1440, 5000, 21)), {
			outDir,
			basename: "noisy-page",
			budget: { bytes: 100 * MiB, images: 12 },
		});
		const ladderNotes = result.notes.filter((n) => n.includes("as PNG"));
		expect(ladderNotes).toEqual([`${result.outputs.length} slices: over 4.5 MB as PNG; sent as JPEG q90 at full size`]);
		expect(result.summary).toContain(`${result.outputs.length} slices of`);
	}, 30_000);

	test("a noisy 4K capture still lands inside pi's profile", () => {
		expectWithinPiProfile(fitImageFile(write("noisy-4k.png", noise(3840, 2160, 13)), { outDir, basename: "noisy-4k" }));
	});
});

describe("fitImageFile — what a file really is", () => {
	test("PNG bytes named .jpg are sent as image/png", () => {
		const p = convert(write("liar-src.png", noise(400, 300)), "png", "liar.jpg");
		const result = fitImageFile(p, { outDir });
		expect(result.plan).toBe("asis");
		expect(result.outputs[0]!.mimeType).toBe("image/png");
	});

	test("JPEG bytes named .png are sent as image/jpeg, not refused as a truncated PNG", () => {
		const small = convert(write("j-src.png", noise(400, 300)), "jpeg", "small-jpeg.png");
		expect(fitImageFile(small, { outDir }).outputs[0]!.mimeType).toBe("image/jpeg");
		const big = convert(write("jbig-src.png", noise(3000, 2000)), "jpeg", "big-jpeg.png");
		const result = fitImageFile(big, { outDir, basename: "big-jpeg" });
		expect(result.plan).toBe("downscale");
		expectWithinPiProfile(result);
	});

	test("WebP bytes named .png are sent as image/webp", () => {
		const p = path.join(dir, "webp-named.png");
		fs.writeFileSync(p, TINY_WEBP);
		const result = fitImageFile(p, { outDir });
		expect(result.outputs[0]!.mimeType).toBe("image/webp");
		expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([40, 20]);
	});

	test("HEIC, TIFF and BMP are converted, because the API accepts none of them", () => {
		const src = write("foreign-src.png", quadrants(600, 400));
		for (const [format, ext] of [["heic", "heic"], ["tiff", "tif"], ["bmp", "bmp"]] as const) {
			const result = fitImageFile(convert(src, format, `foreign.${ext}`), { outDir, basename: `foreign-${ext}` });
			expect(result.outputs[0]!.mimeType).toBe("image/png");
			expect(result.summary).toContain("does not accept");
			const out = decodeOutput(result.outputs[0]!.path);
			expect([out.width, out.height]).toEqual([600, 400]);
			expect(colorAt(out, 0.25, 0.25)).toBe("red");
		}
	});

	test("bytes that are no image format are refused as unusable", () => {
		const p = path.join(dir, "text.png");
		fs.writeFileSync(p, "this is not an image");
		expect(() => fitImageFile(p, { outDir })).toThrow(UnreadableImageError);
		expect(() => fitImageFile(p, { outDir })).toThrow(UnusableImageError);
	});

	test("imageSize reads a PNG header and asks sips for anything else", () => {
		expect(imageSize(write("size.png", solid(321, 123, 1)))).toEqual({ width: 321, height: 123 });
		expect(imageSize(convert(write("size2.png", solid(321, 123, 1)), "jpeg", "size2.jpg"))).toEqual({
			width: 321,
			height: 123,
		});
	});
});

describe("fitImageFile — EXIF orientation", () => {
	const jpegOf = (img: Image, name: string, orientation: number) => {
		const plain = fs.readFileSync(convert(write(`${name}-src.png`, img), "jpeg", `${name}-plain.jpg`));
		const p = path.join(dir, `${name}.jpg`);
		fs.writeFileSync(p, jpegWithOrientation(plain, orientation, false));
		return p;
	};

	test("sips decodes the stored pixels without rotating them, which is why we rotate", () => {
		const p = jpegOf(quadrants(300, 200), "sips-pin", 6);
		const decoded = load(convert(p, "png", "sips-pin.png"));
		expect([decoded.width, decoded.height]).toEqual([300, 200]);
	});

	test("a resized photo comes out upright", () => {
		const result = fitImageFile(jpegOf(quadrants(3000, 2000), "rot6", 6), { outDir, basename: "rot6" });
		expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([1333, 2000]);
		expect(result.notes.join(" ")).toContain("EXIF orientation 6");
		const out = decodeOutput(result.outputs[0]!.path);
		expect(colorAt(out, 0.25, 0.25)).toBe("blue");
		expect(colorAt(out, 0.75, 0.25)).toBe("red");
		expect(colorAt(out, 0.25, 0.75)).toBe("white");
		expect(colorAt(out, 0.75, 0.75)).toBe("green");
	});

	test("orientation 8 rotates the other way", () => {
		const result = fitImageFile(jpegOf(quadrants(3000, 2000), "rot8", 8), { outDir, basename: "rot8" });
		expect(colorAt(decodeOutput(result.outputs[0]!.path), 0.25, 0.25)).toBe("green");
	});

	test("HEIC and TIFF keep their rotation outside EXIF, and come out upright too", () => {
		const rotatedJpeg = jpegOf(quadrants(1200, 900), "rot6-container", 6);
		for (const [format, ext] of [["heic", "heic"], ["tiff", "tif"]] as const) {
			const file = convert(rotatedJpeg, format, `rot6-container.${ext}`);
			expect(imageSize(file)).toEqual({ width: 1200, height: 900 });
			const result = fitImageFile(file, { outDir, basename: `rot6-${ext}` });
			expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([900, 1200]);
			const out = decodeOutput(result.outputs[0]!.path);
			expect(colorAt(out, 0.25, 0.25)).toBe("blue");
			expect(colorAt(out, 0.75, 0.25)).toBe("red");
		}
	});

	test("a photo that already fits ships untouched, and reports its upright size", () => {
		const p = jpegOf(quadrants(1200, 900), "rot6-small", 6);
		const result = fitImageFile(p, { outDir });
		expect(result.outputs[0]!.path).toBe(p);
		expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([900, 1200]);
	});
});

describe("pi's own image normalizer leaves every output alone", () => {
	test("so nothing we send is resampled or re-encoded a second time", async () => {
		const cases: FitResult[] = [
			fitImageFile(write("pi-small.png", noise(400, 300, 2)), { outDir }),
			fitImageFile(write("pi-4k.png", noise(3840, 2160, 3)), { outDir, basename: "pi-4k" }),
			fitImageFile(write("pi-4k-ui.png", quadrants(3840, 2160)), { outDir, basename: "pi-4k-ui" }),
			fitImageFile(write("pi-tall.png", photo(1440, 9000, 4)), { outDir, basename: "pi-tall" }),
			fitImageFile(write("pi-square.png", noise(2600, 2600, 5)), { outDir, basename: "pi-square" }),
			fitImageFile(convert(write("pi-heic-src.png", quadrants(2400, 1600)), "heic", "pi.heic"), {
				outDir,
				basename: "pi-heic",
			}),
		];
		for (const result of cases) {
			expectWithinPiProfile(result);
			const content = fitResultBlocks(result);
			const normalized = await normalizeToolResultImages(content);
			expect({ summary: result.summary, unchanged: normalized === content }).toEqual({
				summary: result.summary,
				unchanged: true,
			});
		}
	}, 60_000);

	test("the check has teeth: an over-limit image IS rewritten by pi", async () => {
		const big = fs.readFileSync(write("pi-raw-4k.png", noise(3840, 2160, 6))).toString("base64");
		const content = [{ type: "image", data: big, mimeType: "image/png" }];
		expect(await normalizeToolResultImages(content)).not.toBe(content);
	}, 30_000);
});

describe("fitResultBlocks", () => {
	test("images first, then one text block with the audit trail", () => {
		const blocks = fitResultBlocks(fitImageFile(write("blocks.png", noise(3840, 2160, 4)), { outDir, basename: "blocks" }));
		expect(blocks[0]!.type).toBe("image");
		expect(blocks[blocks.length - 1]!.type).toBe("text");
		expect(String(blocks[blocks.length - 1]!.text)).toContain("saved:");
	});

	test("base64 is padded", () => {
		const result = fitImageFile(write("pad.png", noise(200, 133, 8)), { outDir });
		const data = String(result.outputs[0]!.base64);
		expect(data.length % 4).toBe(0);
		expect(Buffer.from(data, "base64").length).toBe(result.outputs[0]!.bytes);
	});

	test("every slice becomes its own image block, listed in order", () => {
		const result = fitImageFile(write("many.png", solid(1568, 3000, 12)), {
			outDir,
			basename: "many",
			tier: "standard",
		});
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

describe("fitImageFile — files that must never reach the API", () => {
	// A 0x0 PNG fits every budget, so without a check it would ship untouched
	// and fail the whole request with "Could not process image".
	const zeroByZeroPng = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000000000000008060000001f15c4890000000a49444154" +
			"789c6300010000050001" +
			"0d0a2db40000000049454e44ae426082",
		"hex",
	);

	test("a 0x0 PNG is refused with an explanation", () => {
		const p = path.join(dir, "degenerate.png");
		fs.writeFileSync(p, zeroByZeroPng);
		expect(imageSize(p)).toEqual({ width: 0, height: 0 });
		expect(() => fitImageFile(p, { outDir })).toThrow(DegenerateImageError);
		try {
			fitImageFile(p, { outDir });
		} catch (e: any) {
			expect(e.message).toContain("no pixels");
		}
	});

	test("a PNG cut off mid-write is refused, though its header looks fine", () => {
		const good = write("trunc-src.png", noise(300, 200, 3));
		const p = path.join(dir, "truncated.png");
		fs.writeFileSync(p, fs.readFileSync(good).subarray(0, 100));
		expect(imageSize(p)).toEqual({ width: 300, height: 200 });
		expect(() => fitImageFile(p, { outDir })).toThrow(TruncatedImageError);
	});

	test("a complete PNG is never mistaken for a truncated one", () => {
		for (const [w, h] of [[1, 1], [17, 3], [300, 200], [1024, 768]] as const) {
			const p = write(`complete-${w}x${h}.png`, noise(w, h, w));
			expect(() => fitImageFile(p, { outDir, basename: `c-${w}x${h}` })).not.toThrow();
		}
	});

	test("empty, non-image and half-written files all fail as unusable", () => {
		const good = write("decode-src.png", noise(300, 200, 3));
		const cases: [string, Buffer][] = [
			["empty", Buffer.alloc(0)],
			["not an image", Buffer.from("this is not a png")],
			["half a file", fs.readFileSync(good).subarray(0, Math.floor(fs.statSync(good).size / 2))],
		];
		for (const [name, bytes] of cases) {
			const p = path.join(dir, `broken-${name.replace(/\W/g, "")}.png`);
			fs.writeFileSync(p, bytes);
			expect(() => fitImageFile(p, { outDir })).toThrow(UnusableImageError);
		}
	});

	test("a 1x1 image is legal", () => {
		const r = fitImageFile(write("tiny.png", noise(1, 1, 1)), { outDir, basename: "tiny-out" });
		expect(r.plan).toBe("asis");
		expect(r.outputs[0]!.width).toBe(1);
	});
});
