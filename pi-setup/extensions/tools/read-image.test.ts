/**
 * `read` on an image must not hand the API a payload it will reject, and must
 * not become more fragile than the five-line version it replaced.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadTool, NORMAL_LIMITS } from "./read";
import { save, type Image } from "./lib/image";
import { base64Bytes, countImageTokens, TIERS } from "./lib/vision";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-image-"));
const tool = createReadTool(NORMAL_LIMITS) as any;
const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test" } };

function noise(width: number, height: number, seed = 1): Image {
	const rgb = new Uint8Array(width * height * 3);
	let s = seed >>> 0;
	for (let i = 0; i < rgb.length; i += 1) {
		s = (s * 1664525 + 1013904223) >>> 0;
		rgb[i] = (s >>> 16) & 0xff;
	}
	return { width, height, rgb };
}

const run = (p: string) => tool.execute("call-1", { path: p }, undefined, undefined, ctx);

describe("read: images are fitted before they reach the model", () => {
	test("a small image is returned exactly as before — one image block, no commentary", async () => {
		const p = path.join(dir, "small.png");
		save(noise(400, 300), p);
		const result = await run(p);

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("image");
		expect(result.content[0].mimeType).toBe("image/png");
		expect(result.isError).toBeFalsy();
	});

	test("an oversized image is downscaled instead of shipped whole", async () => {
		const p = path.join(dir, "huge.png");
		save(noise(3000, 2000), p);
		const raw = fs.statSync(p).size;
		const result = await run(p);

		const image = result.content.find((c: any) => c.type === "image");
		const text = result.content.find((c: any) => c.type === "text");
		expect(image).toBeDefined();
		expect(text.text).toContain("1 pass");

		const sent = Buffer.from(image.data, "base64").length;
		expect(sent).toBeLessThan(raw);
		expect(base64Bytes(sent)).toBeLessThan(10_000_000);
	});

	test("what is sent actually fits the token budget", async () => {
		const p = path.join(dir, "budget.png");
		save(noise(3000, 2000, 9), p);
		const result = await run(p);
		const text = result.content.find((c: any) => c.type === "text").text;
		const [, w, h] = /(\d+)×(\d+)\s*\((\d+) tokens/.exec(text) ?? [];
		// `read` goes through the same seam as `screenshot`, so it gets the high
		// tier by default too — an image the model OPENS deserves the same
		// treatment as one it TAKES.
		expect(countImageTokens(Number(w), Number(h))).toBeLessThanOrEqual(TIERS.highRes.maxTokens);
	});

	test("base64 stays padded through the fitted path", async () => {
		const p = path.join(dir, "pad.png");
		save(noise(2400, 1600, 3), p);
		const result = await run(p);
		const image = result.content.find((c: any) => c.type === "image");
		expect(image.data.length % 4).toBe(0);
	});

	test("a corrupt image still errors rather than throwing", async () => {
		const p = path.join(dir, "broken.png");
		fs.writeFileSync(p, Buffer.from("nowhere near a png"));
		const result = await run(p);
		// Either the raw fallback ships the bytes, or it reports an error — but it
		// must not reject the promise, which would surface as a tool crash.
		expect(result).toBeDefined();
		expect(Array.isArray(result.content)).toBe(true);
	});

	test("a missing file is still a clean error", async () => {
		const result = await run(path.join(dir, "nope.png"));
		expect(result.isError).toBe(true);
	});
});
