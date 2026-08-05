/**
 * The one place an image is made safe to send to a vision model.
 *
 * Both `read` (any image the model opens) and `screenshot` (any image the model
 * takes) funnel through `fitImageFile`. Nothing else should base64 an image.
 *
 * THE INVARIANT: geometry decisions are made here, in TypeScript, by
 * `planView`. `sips` is used ONLY as a codec — transcoding between formats and
 * encoding JPEG at a given quality. It is never asked to resize anything.
 * `sips -Z <n>` is precisely the bug this module exists to remove: it picks a
 * long edge that ignores the token budget, so the API resamples a second time
 * over text we already resampled once.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crop, encode, type Image, load, readPngSize } from "./image";
import { downscale } from "./resample";
import {
	base64Bytes,
	countImageTokens,
	MAX_BASE64_BYTES,
	planView,
	resolveTier,
	type TierName,
	type ViewPlan,
} from "./vision";

export const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * ClaudeImageResizer's ladder. Dimensions come down before quality does, and
 * quality never goes below 0.75 — heavy JPEG artefacts make small text harder
 * to read than a smaller-but-clean image.
 */
const DIMENSION_STEPS = [1.0, 0.85, 0.72, 0.61, 0.52] as const;
const JPEG_QUALITY_STEPS = [95, 90, 85, 80, 75] as const;

/** Outputs live here so a caller can re-read or reference them by path. */
export function defaultOutDir(): string {
	return path.join(os.tmpdir(), "pi-vision");
}

export interface FitOptions {
	tier?: TierName;
	/** Payload ceiling. Defaults to the direct-API limit, not Bedrock's. */
	maxBase64?: number;
	outDir?: string;
	basename?: string;
	minLongEdge?: number;
	overlap?: number;
	/** Hard ceiling on images produced by one call. See MAX_IMAGES_PER_CALL. */
	maxSlices?: number;
}

export interface FitOutput {
	path: string;
	width: number;
	height: number;
	bytes: number;
	tokens: number;
	mimeType: string;
	base64: string;
}

export interface FitResult {
	source: { path: string; width: number; height: number; bytes: number };
	plan: ViewPlan["kind"];
	outputs: FitOutput[];
	totalTokens: number;
	/** How many times WE resampled the pixels. 0 or 1. Never 2. */
	resamples: number;
	/** One line per thing worth telling the caller. */
	notes: string[];
	summary: string;
}

function sips(args: string[]): string {
	return execFileSync("sips", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A file that LOOKS like a valid image to a header read, but cannot be rendered.
 *
 * This is a distinct error type because it is the one failure a caller must NOT
 * recover from by falling back to the original bytes. Anthropic rejects such a
 * payload with `400 Could not process image`, and that 400 fails the whole
 * REQUEST, not just the one tool call — it takes the turn down with it.
 *
 * Both known members of this class slip through for the same structural reason:
 * the `asis` fast path deliberately never decodes (see AGENTS.md — decoding a
 * 4K PNG costs ~118ms and the whole point of `asis` is to ship bytes untouched
 * when they already fit). Anything caught by a DECODE is therefore already
 * safe; only things that survive a header read need an explicit refusal.
 */
export class UnusableImageError extends Error {}

/**
 * An image that parses but describes no pixels — an IHDR of 0x0, or any axis
 * that is zero or negative.
 *
 * Observed live: a script killed mid-run left 65-byte 0x0 PNGs on disk, and
 * reading one killed the session. It is doubly invisible because zero tokens is
 * inside every budget, so it is judged to "fit" perfectly.
 */
export class DegenerateImageError extends UnusableImageError {
	constructor(file: string, width: number, height: number) {
		super(
			`${file} declares ${width}x${height} — an image with no pixels. It cannot ` +
				`be sent: the API rejects zero-area images with "Could not process ` +
				`image", which fails the entire request. The file is corrupt.`,
		);
		this.name = "DegenerateImageError";
	}
}

/**
 * An image whose header is intact but whose pixel data was never finished —
 * a capture interrupted mid-write, a partial download, a killed process.
 *
 * The header still reports plausible dimensions, so it passes every geometry
 * check and takes `asis` straight to the API. Measured: the first 100 bytes of
 * a 300x200 PNG report 300x200 and ship as a 100-byte "image".
 */
export class TruncatedImageError extends UnusableImageError {
	constructor(file: string, bytes: number) {
		super(
			`${file} is ${bytes} bytes and has no end-of-image marker — the pixel ` +
				`data was never finished writing. It cannot be sent: the API rejects ` +
				`incomplete images with "Could not process image", which fails the ` +
				`entire request.`,
		);
		this.name = "TruncatedImageError";
	}
}

/**
 * Is the file missing its end-of-image marker? Reads the last 12 bytes; never
 * decodes.
 *
 * PNG only, deliberately. Every valid PNG ends with the 12-byte IEND chunk, so
 * this has no false positives — and PNG is what `screencapture`, Chromium and
 * our own encoder all produce, which is every path that can write a partial
 * file. JPEGs arrive from the user's disk already complete, and trailing bytes
 * after a JPEG's EOI marker are common enough in the wild that checking would
 * risk refusing valid images. Refusing something valid would be a worse bug
 * than the one being fixed.
 */
function isTruncatedPng(file: string, bytes: number): boolean {
	if (bytes < 12) return true;
	const fd = fs.openSync(file, "r");
	try {
		const tail = Buffer.alloc(12);
		fs.readSync(fd, tail, 0, 12, bytes - 12);
		return tail.subarray(4, 8).toString("latin1") !== "IEND";
	} finally {
		fs.closeSync(fd);
	}
}

/** Dimensions for a format pngjs cannot decode. Subprocess, ~30ms. */
function sipsSize(file: string): { width: number; height: number } {
	const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", file]);
	const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
	const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		throw new Error(`could not read dimensions from ${file}`);
	}
	return { width, height };
}

export function imageSize(file: string): { width: number; height: number } {
	if (path.extname(file).toLowerCase() === ".png") {
		try {
			return readPngSize(file);
		} catch {
			// A .png that is not a PNG. Fall through to sips rather than fail.
		}
	}
	return sipsSize(file);
}

/** Transcode to PNG so the in-process pipeline can decode it. Never resizes. */
function transcodeToPng(file: string, outDir: string): string {
	const target = path.join(outDir, `transcode-${process.pid}-${Date.now()}.png`);
	sips(["-s", "format", "png", file, "--out", target]);
	return target;
}

function encodeJpeg(img: Image, quality: number, outDir: string, base: string): FitOutput {
	const pngPath = path.join(outDir, `${base}.tmp.png`);
	fs.writeFileSync(pngPath, encode(img));
	const jpgPath = path.join(outDir, `${base}.jpg`);
	sips(["-s", "format", "jpeg", "-s", "formatOptions", String(quality), pngPath, "--out", jpgPath]);
	fs.rmSync(pngPath, { force: true });
	const bytes = fs.statSync(jpgPath).size;
	return {
		path: jpgPath,
		width: img.width,
		height: img.height,
		bytes,
		tokens: countImageTokens(img.width, img.height),
		mimeType: "image/jpeg",
		base64: fs.readFileSync(jpgPath).toString("base64"),
	};
}

function writePng(img: Image, outDir: string, base: string): FitOutput {
	const target = path.join(outDir, `${base}.png`);
	const bytes = encode(img);
	fs.writeFileSync(target, bytes);
	return {
		path: target,
		width: img.width,
		height: img.height,
		bytes: bytes.length,
		tokens: countImageTokens(img.width, img.height),
		mimeType: "image/png",
		base64: bytes.toString("base64"),
	};
}

/**
 * Bring one already-fitted image under the payload cap.
 *
 * Shrink the geometry first, in lossless PNG, because a smaller clean image
 * reads better than a same-size smeared one. Only when every PNG step is still
 * too big does quality come down, and JPEG stops at 75.
 */
function applyPayloadLadder(
	img: Image,
	outDir: string,
	base: string,
	cap: number,
	notes: string[],
): FitOutput {
	let smallest: FitOutput | undefined;
	for (const step of DIMENSION_STEPS) {
		const candidate =
			step === 1
				? img
				: downscale(img, {
						width: Math.max(Math.floor(img.width * step), 1),
						height: Math.max(Math.floor(img.height * step), 1),
					});
		const out = writePng(candidate, outDir, base);
		smallest = out;
		if (base64Bytes(out.bytes) <= cap) {
			if (step !== 1) {
				notes.push(
					`payload ladder: PNG at ${Math.round(step * 100)}% of the fitted size ` +
						`(${out.width}×${out.height}) to stay under the ${(cap / 1e6).toFixed(0)}MB cap`,
				);
			}
			return out;
		}
	}

	const floor = downscale(img, {
		width: Math.max(Math.floor(img.width * DIMENSION_STEPS[DIMENSION_STEPS.length - 1]), 1),
		height: Math.max(Math.floor(img.height * DIMENSION_STEPS[DIMENSION_STEPS.length - 1]), 1),
	});
	for (const quality of JPEG_QUALITY_STEPS) {
		const out = encodeJpeg(floor, quality, outDir, base);
		if (base64Bytes(out.bytes) <= cap) {
			// The dimension loop left its last attempt at `${base}.png`. We are
			// returning the .jpg, so that PNG is now unreferenced — drop it rather
			// than wait for the 6-hour prune, which `read` never triggers at all.
			if (smallest) fs.rmSync(smallest.path, { force: true });
			notes.push(
				`payload ladder: lossless PNG could not fit the cap; JPEG q${quality} at ` +
					`${out.width}×${out.height}`,
			);
			return out;
		}
	}
	// Every JPEG step also failed. `smallest` is what we ship, so it must still
	// exist on disk — deliberately NOT deleted above in this path.

	// Nothing fits. Ship the smallest lossless version rather than mangling the
	// text further, and say so — a rejected request is more useful than an
	// unreadable one that silently answers wrong.
	notes.push(
		`WARNING: still over the ${(cap / 1e6).toFixed(0)}MB payload cap after the full ladder; ` +
			`sending the smallest lossless version. The API may reject this.`,
	);
	return smallest as FitOutput;
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Keep the scratch dir from growing without bound across a long session. */
export function pruneOutDir(dir: string, maxAgeMs = 6 * 60 * 60 * 1000): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const entry of entries) {
		const full = path.join(dir, entry);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		} catch {
			// racing another prune, or a file we do not own; skip it
		}
	}
}

/**
 * Make `file` safe to hand to a vision model.
 *
 * The `asis` fast path never decodes the image at all: dimensions come from the
 * PNG header, and if they already fit the budget the original bytes are shipped
 * untouched. Re-encoding an image that needs no change is a pure loss.
 */
export function fitImageFile(file: string, opts: FitOptions = {}): FitResult {
	const tier = resolveTier(opts.tier);
	const cap = opts.maxBase64 ?? MAX_BASE64_BYTES.api;
	const outDir = opts.outDir ?? defaultOutDir();
	const base = opts.basename ?? `fit-${Date.now()}-${process.pid}`;
	const notes: string[] = [];

	ensureDir(outDir);

	const sourceBytes = fs.statSync(file).size;
	const size = imageSize(file);
	// Refuse before planning. `planView` would report `asis` for 0x0 — zero
	// tokens is inside every budget — and the fast path below then ships the
	// source bytes untouched, so this is the only point where it can be caught.
	if (size.width <= 0 || size.height <= 0) {
		throw new DegenerateImageError(file, size.width, size.height);
	}
	// Same class, different cause: an intact header over unfinished pixel data.
	// Costs one 12-byte read, so it does not compromise `asis` staying decode-free.
	if ((MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "image/png") === "image/png") {
		if (isTruncatedPng(file, sourceBytes)) throw new TruncatedImageError(file, sourceBytes);
	}
	const plan = planView(size.width, size.height, {
		tier,
		minLongEdge: opts.minLongEdge,
		overlap: opts.overlap,
		maxSlices: opts.maxSlices,
	});
	const ext = path.extname(file).toLowerCase();
	const sourceMime = MIME_BY_EXT[ext] ?? "image/png";
	const source = { path: file, width: size.width, height: size.height, bytes: sourceBytes };

	// --- fast path: already inside both the geometry budget and the payload cap
	if (plan.kind === "asis" && base64Bytes(sourceBytes) <= cap) {
		const out: FitOutput = {
			path: file,
			width: size.width,
			height: size.height,
			bytes: sourceBytes,
			tokens: plan.tokens,
			mimeType: sourceMime,
			base64: fs.readFileSync(file).toString("base64"),
		};
		return {
			source,
			plan: "asis",
			outputs: [out],
			totalTokens: plan.tokens,
			resamples: 0,
			notes,
			summary: `${size.width}×${size.height} (${plan.tokens} tokens, already within budget, untouched)`,
		};
	}

	// --- everything below needs the pixels
	let decodePath = file;
	let scratch: string | undefined;
	if (ext !== ".png") {
		scratch = transcodeToPng(file, outDir);
		decodePath = scratch;
		notes.push(`transcoded ${ext.slice(1) || "image"} → png for resampling (no resize applied)`);
	}

	try {
		const img = load(decodePath);
		let outputs: FitOutput[];
		let resamples = 0;
		let summary: string;

		if (plan.kind === "slice") {
			outputs = plan.slices.map((box, i) =>
				writePng(crop(img, box), outDir, `${base}.slice-${i + 1}`),
			);
			notes.push(plan.reason);
			const sliceTokens = outputs.reduce((n, o) => n + o.tokens, 0);
			// The only thing worth saying here is what the caller did NOT get.
			// Anything about token cost belongs to whoever is paying, not to a tool
			// deciding how much of a page to hand back.
			if (plan.truncated) {
				const { coveredHeight, totalHeight, neededSlices } = plan.truncated;
				notes.push(
					`TRUNCATED: captured the top ${coveredHeight.toLocaleString()}px of a ` +
						`${totalHeight.toLocaleString()}px page (${outputs.length} of ${neededSlices} slices). ` +
						`The remaining ${(totalHeight - coveredHeight).toLocaleString()}px was NOT captured. ` +
						`To see a specific section, pass a selector, or capture that region directly.`,
				);
			}
			summary =
				`${size.width}×${size.height} → ${outputs.length} slices of ` +
				`${outputs[0]!.width}×${outputs[0]!.height} ` +
				`(${sliceTokens} tokens total, cropped not scaled)`;
		} else if (plan.kind === "downscale") {
			const small = downscale(img, plan.to);
			resamples = 1;
			outputs = [applyPayloadLadder(small, outDir, base, cap, notes)];
			summary =
				`${size.width}×${size.height} → ${outputs[0]!.width}×${outputs[0]!.height} ` +
				`(${outputs[0]!.tokens} tokens, area-average, 1 pass)`;
		} else {
			// asis geometry, but the payload was over the cap (a big lossless image).
			outputs = [applyPayloadLadder(img, outDir, base, cap, notes)];
			summary =
				`${size.width}×${size.height} fits the token budget but not the payload cap; ` +
				`re-encoded to ${outputs[0]!.width}×${outputs[0]!.height}`;
		}

		return {
			source,
			plan: plan.kind,
			outputs,
			totalTokens: outputs.reduce((n, o) => n + o.tokens, 0),
			resamples,
			notes,
			summary,
		};
	} finally {
		if (scratch) fs.rmSync(scratch, { force: true });
	}
}

/** The content blocks to hand back from a tool, images first then the audit line. */
export function fitResultBlocks(result: FitResult): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = result.outputs.map((o) => ({
		type: "image" as const,
		data: o.base64,
		mimeType: o.mimeType,
	}));
	const lines = [result.summary, ...result.notes];
	if (result.outputs.length > 1) {
		lines.push(
			`slices, in order: ${result.outputs.map((o) => path.basename(o.path)).join(", ")}`,
		);
	}
	lines.push(`saved: ${result.outputs.map((o) => o.path).join("\n       ")}`);
	blocks.push({ type: "text" as const, text: lines.join("\n") });
	return blocks;
}
