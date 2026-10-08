/**
 * The one place an image is made safe to send to a model: `read` and
 * `screenshot` both go through `fitImageFile`.
 *
 * Geometry comes from `planView`; `sips` is only a codec (decoding formats
 * pngjs cannot, encoding JPEG) and never resizes. Every output stays inside
 * pi's resize profile, so pi's own normalizer passes it through untouched
 * instead of resampling it a second time.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crop, encode, type Image, load, orient, pngSizeFromHeader } from "./image";
import { type CallBudget, defaultCallBudget, type ImageLimits, limitsForModel } from "./image-budget";
import { type ImageFormat, orientationOf, readHead, sniffImageFormat } from "./image-format";
import { downscale } from "./resample";
import {
	base64Bytes,
	countImageTokens,
	planView,
	resolveTier,
	type Size,
	type TierName,
	type ViewPlan,
} from "./vision";

/**
 * Tried in order until one fits the byte cap. An image too big as PNG is
 * photographic (UI text compresses well), and JPEG is the codec for photos;
 * shrinking throws away detail, so it comes last. Never below q80: heavy
 * compression blurs small text.
 */
const ENCODE_LADDER: ReadonlyArray<{ scale: number; quality?: number }> = [
	{ scale: 1 },
	{ scale: 1, quality: 90 },
	{ scale: 1, quality: 80 },
	{ scale: 0.85, quality: 80 },
	{ scale: 0.72, quality: 80 },
	{ scale: 0.61, quality: 80 },
	{ scale: 0.52, quality: 80 },
];

const SLICE_JPEG_QUALITY = 90;

export function defaultOutDir(): string {
	return path.join(os.tmpdir(), "pi-vision");
}

export interface FitOptions {
	tier?: TierName;
	limits?: ImageLimits;
	budget?: CallBudget;
	outDir?: string;
	basename?: string;
	minLongEdge?: number;
	overlap?: number;
}

export interface FitOutput {
	path: string;
	width: number;
	height: number;
	bytes: number;
	tokens: number;
	mimeType: string;
	/** JPEG quality; absent for lossless output. */
	quality?: number;
	base64: string;
}

export interface FitResult {
	source: { path: string; width: number; height: number; bytes: number; format: string };
	plan: ViewPlan["kind"];
	outputs: FitOutput[];
	totalTokens: number;
	totalBase64: number;
	/** How many times the pixels were resampled: 0, 1, or 2 when the byte ladder had to shrink. */
	resamples: number;
	notes: string[];
	summary: string;
}

/**
 * An image that must not be sent at all. The API answers these with a 400
 * that fails the whole request, so callers report it instead of falling back
 * to the raw bytes.
 */
export class UnusableImageError extends Error {}

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

export class UnreadableImageError extends UnusableImageError {
	constructor(file: string, head: Buffer) {
		const start = head.subarray(0, 8).toString("hex");
		super(
			`${file} is not an image format this tool can read (its first bytes are ` +
				`${start || "empty"}). Supported: PNG, JPEG, GIF, WebP, HEIC/HEIF, TIFF, BMP.`,
		);
		this.name = "UnreadableImageError";
	}
}

function sips(args: string[]): string {
	return execFileSync("sips", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** PNG only: every valid PNG ends with IEND. JPEGs often carry trailing bytes, so they are not checked. */
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

function sipsSize(file: string): Size {
	const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", file]);
	const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
	const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		throw new Error(`could not read dimensions from ${file}`);
	}
	return { width, height };
}

/** Stored pixel size, before any EXIF orientation. */
export function imageSize(file: string): Size {
	const head = readHead(file, 32);
	if (sniffImageFormat(head)?.name === "png") return pngSizeFromHeader(head, file);
	return sipsSize(file);
}

function decode(file: string, format: ImageFormat, outDir: string): Image {
	if (format.name === "png") return load(file);
	const scratch = path.join(outDir, `decode-${process.pid}-${Date.now()}.png`);
	try {
		sips(["-s", "format", "png", file, "--out", scratch]);
		return load(scratch);
	} finally {
		fs.rmSync(scratch, { force: true });
	}
}

function writePng(img: Image, target: string): FitOutput {
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

function writeJpeg(img: Image, quality: number, target: string): FitOutput {
	const scratch = `${target}.tmp.png`;
	fs.writeFileSync(scratch, encode(img));
	try {
		sips(["-s", "format", "jpeg", "-s", "formatOptions", String(quality), scratch, "--out", target]);
	} finally {
		fs.rmSync(scratch, { force: true });
	}
	const bytes = fs.readFileSync(target);
	return {
		path: target,
		width: img.width,
		height: img.height,
		bytes: bytes.length,
		tokens: countImageTokens(img.width, img.height),
		mimeType: "image/jpeg",
		quality,
		base64: bytes.toString("base64"),
	};
}

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

export function encodingLabel(out: FitOutput): string {
	return out.mimeType === "image/jpeg" ? `JPEG q${out.quality}` : "PNG";
}

/** The first ladder step whose base64 fits `cap`; the smallest attempt when none does. */
function encodeWithin(
	img: Image,
	cap: number,
	stem: string,
	notes: string[],
): { out: FitOutput; shrunk: boolean } {
	let smallest: FitOutput | undefined;
	let smallestShrunk = false;
	for (const step of ENCODE_LADDER) {
		const scaled =
			step.scale === 1
				? img
				: downscale(img, {
						width: Math.max(Math.floor(img.width * step.scale), 1),
						height: Math.max(Math.floor(img.height * step.scale), 1),
					});
		const scaleTag = step.scale === 1 ? "" : `.${Math.round(step.scale * 100)}pct`;
		const target = step.quality ? `${stem}${scaleTag}.q${step.quality}.jpg` : `${stem}${scaleTag}.png`;
		const out = step.quality ? writeJpeg(scaled, step.quality, target) : writePng(scaled, target);

		if (out.base64.length <= cap) {
			if (smallest && smallest.path !== out.path) fs.rmSync(smallest.path, { force: true });
			if (step !== ENCODE_LADDER[0]) {
				notes.push(
					`over ${mb(cap)} MB as PNG; sent as ${encodingLabel(out)}` +
						(step.scale === 1 ? " at full size" : ` at ${Math.round(step.scale * 100)}% size`),
				);
			}
			return { out, shrunk: step.scale !== 1 };
		}
		if (!smallest || out.base64.length < smallest.base64.length) {
			if (smallest && smallest.path !== out.path) fs.rmSync(smallest.path, { force: true });
			smallest = out;
			smallestShrunk = step.scale !== 1;
		} else {
			fs.rmSync(out.path, { force: true });
		}
	}
	notes.push(
		`WARNING: still over the ${mb(cap)} MB limit after every encoding; sent the ` +
			`smallest (${encodingLabel(smallest!)}), which pi will re-encode.`,
	);
	return { out: smallest!, shrunk: smallestShrunk };
}

/**
 * Encode slices, then bring the set under `budget`: the largest PNG slices
 * become JPEG first, and only then are slices dropped from the bottom.
 */
function encodeSlices(
	crops: Image[],
	cap: number,
	budget: number,
	stem: string,
	notes: string[],
): FitOutput[] {
	const sliceNotes = crops.map((): string[] => []);
	const outputs = crops.map((c, i) => encodeWithin(c, cap, `${stem}.slice-${i + 1}`, sliceNotes[i]!).out);
	const total = () => outputs.reduce((n, o) => n + o.base64.length, 0);

	const tried = new Set<number>();
	const converted = new Set<number>();
	while (total() > budget) {
		let largest = -1;
		outputs.forEach((o, i) => {
			if (o.mimeType === "image/png" && !tried.has(i) && (largest < 0 || o.base64.length > outputs[largest]!.base64.length)) {
				largest = i;
			}
		});
		if (largest < 0) break;
		tried.add(largest);
		const jpeg = writeJpeg(
			crops[largest]!,
			SLICE_JPEG_QUALITY,
			`${stem}.slice-${largest + 1}.q${SLICE_JPEG_QUALITY}.jpg`,
		);
		if (jpeg.base64.length < outputs[largest]!.base64.length) {
			fs.rmSync(outputs[largest]!.path, { force: true });
			outputs[largest] = jpeg;
			converted.add(largest);
		} else {
			fs.rmSync(jpeg.path, { force: true });
		}
	}
	while (total() > budget && outputs.length > 1) {
		fs.rmSync(outputs.pop()!.path, { force: true });
	}

	const counts = new Map<string, number>();
	for (const note of sliceNotes.slice(0, outputs.length).flat()) counts.set(note, (counts.get(note) ?? 0) + 1);
	for (const [note, n] of counts) notes.push(n > 1 ? `${n} slices: ${note}` : note);
	const kept = [...converted].filter((i) => i < outputs.length).length;
	if (kept > 0) {
		notes.push(
			`${kept} photo-heavy slice${kept === 1 ? "" : "s"} sent as JPEG q${SLICE_JPEG_QUALITY} to fit ` +
				`this call's ${mb(budget)} MB share of the request-size limit`,
		);
	}
	return outputs;
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
			// racing another prune, or a file we do not own
		}
	}
}

export function fitImageFile(file: string, opts: FitOptions = {}): FitResult {
	const limits = opts.limits ?? limitsForModel();
	const budget = opts.budget ?? defaultCallBudget(limits);
	const tier = resolveTier(opts.tier, limits.maxSide);
	const cap = Math.min(limits.maxImageBase64, budget.bytes);
	const outDir = opts.outDir ?? defaultOutDir();
	const stem = path.join(outDir, opts.basename ?? `fit-${Date.now()}-${process.pid}`);
	const notes: string[] = [];
	fs.mkdirSync(outDir, { recursive: true });

	const sourceBytes = fs.statSync(file).size;
	const head = readHead(file);
	const format = sniffImageFormat(head);
	if (!format) throw new UnreadableImageError(file, head);

	const stored = format.name === "png" ? pngSizeFromHeader(head, file) : sipsSize(file);
	// A 0x0 image is "inside" every budget and would ship untouched.
	if (stored.width <= 0 || stored.height <= 0) {
		throw new DegenerateImageError(file, stored.width, stored.height);
	}
	if (format.name === "png" && isTruncatedPng(file, sourceBytes)) {
		throw new TruncatedImageError(file, sourceBytes);
	}
	const orientation = orientationOf(file, head, format);
	let size = orientation >= 5 ? { width: stored.height, height: stored.width } : stored;

	const maxSlices = Math.max(1, budget.images);
	const planFor = (s: Size): ViewPlan =>
		planView(s.width, s.height, { tier, minLongEdge: opts.minLongEdge, overlap: opts.overlap, maxSlices });
	let plan = planFor(size);
	const finish = (outputs: FitOutput[], resamples: number, summary: string): FitResult => ({
		source: { path: file, ...size, bytes: sourceBytes, format: format.name },
		plan: plan.kind,
		outputs,
		totalTokens: outputs.reduce((n, o) => n + o.tokens, 0),
		totalBase64: outputs.reduce((n, o) => n + o.base64.length, 0),
		resamples,
		notes,
		summary,
	});

	if (plan.kind === "asis" && format.apiMime && base64Bytes(sourceBytes) <= cap) {
		const data = fs.readFileSync(file);
		const out: FitOutput = {
			path: file,
			...size,
			bytes: sourceBytes,
			tokens: plan.tokens,
			mimeType: format.apiMime,
			base64: data.toString("base64"),
		};
		return finish([out], 0, `${size.width}×${size.height} (${plan.tokens} tokens, already within budget, untouched)`);
	}

	let img = decode(file, format, outDir);
	// sips decodes the stored pixels without applying EXIF orientation.
	if (orientation !== 1) {
		img = orient(img, orientation);
		notes.push(`rotated upright (EXIF orientation ${orientation})`);
	}
	// Some decoders apply a container's own rotation; plan from the real pixels.
	if (img.width !== size.width || img.height !== size.height) {
		size = { width: img.width, height: img.height };
		plan = planFor(size);
	}

	if (plan.kind === "slice") {
		const crops = plan.slices.map((box) => crop(img, box));
		const outputs = encodeSlices(crops, cap, budget.bytes, stem, notes);
		notes.unshift(plan.reason);

		const needed = plan.truncated?.neededSlices ?? plan.slices.length;
		if (outputs.length < needed) {
			const last = plan.slices[outputs.length - 1]!;
			const covered = last.y + last.height;
			const why =
				outputs.length < plan.slices.length
					? "the rest would not fit this call's share of the request-size limit"
					: `one call returns at most ${maxSlices} images`;
			notes.push(
				`TRUNCATED: captured the top ${covered.toLocaleString("en-US")}px of a ` +
					`${size.height.toLocaleString("en-US")}px page (${outputs.length} of ${needed} slices); ` +
					`${why}. The remaining ${(size.height - covered).toLocaleString("en-US")}px was NOT ` +
					`captured. To see a specific section, pass a selector, or capture that region directly.`,
			);
		}
		const tokens = outputs.reduce((n, o) => n + o.tokens, 0);
		return finish(
			outputs,
			0,
			`${size.width}×${size.height} → ${outputs.length} slice${outputs.length === 1 ? "" : "s"} of ` +
				`${outputs[0]!.width}×${outputs[0]!.height} (${tokens} tokens total, cropped not scaled)`,
		);
	}

	if (plan.kind === "downscale") {
		const { out, shrunk } = encodeWithin(downscale(img, plan.to), cap, stem, notes);
		return finish(
			[out],
			shrunk ? 2 : 1,
			`${size.width}×${size.height} → ${out.width}×${out.height} ` +
				`(${out.tokens} tokens, area-average, 1 pass, ${encodingLabel(out)})`,
		);
	}

	const { out, shrunk } = encodeWithin(img, cap, stem, notes);
	const why = format.apiMime ? `over the ${mb(cap)} MB per-image limit` : `the API does not accept ${format.name}`;
	const geometry = shrunk ? `${size.width}×${size.height} → ${out.width}×${out.height}` : `${size.width}×${size.height}`;
	return finish(
		[out],
		shrunk ? 1 : 0,
		`${geometry} (${out.tokens} tokens) re-encoded as ${encodingLabel(out)}: ${why}`,
	);
}

/** Tool content: the images in reading order, then one text block with the audit trail. */
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
