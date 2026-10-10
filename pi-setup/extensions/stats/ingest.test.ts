import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistant, header, MIN } from "./fixtures";
import { ingest } from "./ingest";
import { U } from "./parse";

const T0 = new Date(2026, 5, 10, 9, 0).getTime();
let dir: string;
let sessions: string;
let cache: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "stats-ingest-"));
	sessions = path.join(dir, "sessions");
	cache = path.join(dir, "cache");
	mkdirSync(path.join(sessions, "--w--"), { recursive: true });
	file = path.join(sessions, "--w--", "s.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const turns = async (cacheDir = cache) => {
	const [rec] = await ingest(sessions, cacheDir);
	return Object.values(rec.usage).reduce((n, u) => n + u[U.turns], 0);
};

test("appends are read from the saved offset, a partial last line waits for its newline", async () => {
	writeFileSync(file, `${header("s", "/w", T0)}\n${assistant(T0, { cost: 1 })}\n`);
	expect(await turns()).toBe(1);

	const next = assistant(T0 + MIN, { cost: 2 });
	appendFileSync(file, next.slice(0, 40));
	expect(await turns()).toBe(1);

	appendFileSync(file, `${next.slice(40)}\n${assistant(T0 + 2 * MIN)}\n`);
	expect(await turns()).toBe(3);
	expect(await turns(path.join(dir, "fresh"))).toBe(3);
});

test("a file that shrank is parsed again from the start", async () => {
	writeFileSync(file, `${header("s", "/w", T0)}\n${assistant(T0)}\n${assistant(T0 + MIN)}\n`);
	expect(await turns()).toBe(2);
	writeFileSync(file, `${header("s", "/w", T0)}\n${assistant(T0)}\n`);
	expect(await turns()).toBe(1);
});

test("an unchanged file is served from the cache", async () => {
	writeFileSync(file, `${header("s", "/w", T0)}\n${assistant(T0)}\n`);
	const [first] = await ingest(sessions, cache);
	const [second] = await ingest(sessions, cache);
	expect(second.offset).toBe(first.offset);
	expect(second.usage).toEqual(first.usage);
});
