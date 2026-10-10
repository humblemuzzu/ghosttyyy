import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { emptyRecord, type FileRecord, ingestLine } from "./parse";

const CACHE_VERSION = 4;
const cacheFile = (dir: string) => path.join(dir, `index-v${CACHE_VERSION}.json`);
let saves = 0;

interface CacheFile {
	version: number;
	/** Day keys are local dates, so a timezone change invalidates every bucket. */
	timeZone: string;
	records: FileRecord[];
}

export interface IngestProgress {
	files: number;
	parsed: number;
	bytes: number;
	totalBytes: number;
}

function timeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
}

async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
		}
	}
	return out;
}

async function loadCache(dir: string): Promise<Map<string, FileRecord> | undefined> {
	try {
		const raw = JSON.parse(await fs.readFile(cacheFile(dir), "utf8")) as CacheFile;
		if (raw.version !== CACHE_VERSION || raw.timeZone !== timeZone()) return undefined;
		return new Map(raw.records.map((r) => [r.path, r]));
	} catch {
		return undefined;
	}
}

async function saveCache(dir: string, records: FileRecord[]): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const file = cacheFile(dir);
	const tmp = `${file}.${process.pid}-${++saves}.tmp`;
	const body: CacheFile = { version: CACHE_VERSION, timeZone: timeZone(), records };
	await fs.writeFile(tmp, JSON.stringify(body));
	await fs.rename(tmp, file);
}

/** pi only appends, so a cached record resumes where it stopped unless the file shrank or was rewritten. */
async function canResume(rec: FileRecord, size: number): Promise<boolean> {
	if (rec.offset === 0) return true;
	if (size < rec.offset) return false;
	const fh = await fs.open(rec.path, "r").catch(() => undefined);
	if (!fh) return false;
	try {
		const buf = Buffer.alloc(1);
		await fh.read(buf, 0, 1, rec.offset - 1);
		return buf[0] === 0x0a;
	} finally {
		await fh.close();
	}
}

async function parseFrom(rec: FileRecord, parentExists: (p: string) => boolean, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
	const stream = createReadStream(rec.path, { start: rec.offset, highWaterMark: 1 << 20 });
	let pending: Buffer[] = [];
	let consumed = rec.offset;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (signal?.aborted) return;
			let start = 0;
			let nl = chunk.indexOf(0x0a, start);
			while (nl !== -1) {
				const piece = chunk.subarray(start, nl);
				const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
				pending = [];
				consumed += line.length + 1;
				if (line.length) ingestLine(rec, line.toString("utf8"), parentExists);
				start = nl + 1;
				nl = chunk.indexOf(0x0a, start);
			}
			if (start < chunk.length) pending.push(chunk.subarray(start));
			onBytes(chunk.length);
		}
	} finally {
		stream.destroy();
	}
	rec.offset = consumed;
}

/**
 * Every session file under `root`, parsed incrementally against the on-disk
 * cache. A partially written last line is left for the next run.
 */
export async function ingest(root: string, cacheDir: string, onProgress?: (p: IngestProgress) => void, signal?: AbortSignal): Promise<FileRecord[]> {
	const [paths, cache] = await Promise.all([walk(root), loadCache(cacheDir)]);
	return update(paths, cache ?? new Map(), cacheDir, onProgress, signal);
}

/** Like `ingest`, but only on top of a usable cache: without one it returns undefined instead of reading everything. */
export async function ingestWarm(root: string, cacheDir: string): Promise<FileRecord[] | undefined> {
	const [paths, cache] = await Promise.all([walk(root), loadCache(cacheDir)]);
	return cache && update(paths, cache, cacheDir);
}

async function update(paths: string[], cache: Map<string, FileRecord>, cacheDir: string, onProgress?: (p: IngestProgress) => void, signal?: AbortSignal): Promise<FileRecord[]> {
	const stats = await Promise.all(paths.map((p) => fs.stat(p).catch(() => undefined)));

	const parentCache = new Map<string, boolean>();
	const parentExists = (p: string): boolean => {
		let hit = parentCache.get(p);
		if (hit === undefined) parentCache.set(p, (hit = existsSync(p)));
		return hit;
	};

	const work: Array<{ rec: FileRecord; size: number; mtimeMs: number }> = [];
	const records: FileRecord[] = [];
	let totalBytes = 0;
	for (let i = 0; i < paths.length; i++) {
		const st = stats[i];
		if (!st) continue;
		let rec = cache.get(paths[i]);
		if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) {
			records.push(rec);
			continue;
		}
		if (!rec || !(await canResume(rec, st.size))) rec = emptyRecord(paths[i]);
		work.push({ rec, size: st.size, mtimeMs: st.mtimeMs });
		totalBytes += st.size - rec.offset;
	}

	const progress: IngestProgress = { files: paths.length, parsed: 0, bytes: 0, totalBytes };
	onProgress?.(progress);
	for (const item of work) {
		if (signal?.aborted) break;
		try {
			await parseFrom(item.rec, parentExists, (n) => {
				progress.bytes += n;
				onProgress?.(progress);
			}, signal);
		} catch {
			// deleted or unreadable since the walk: left out, and out of the cache, so the next run starts it fresh
			continue;
		}
		if (signal?.aborted) break;
		item.rec.size = item.size;
		item.rec.mtimeMs = item.mtimeMs;
		records.push(item.rec);
		progress.parsed++;
		onProgress?.(progress);
	}

	if (work.length && !signal?.aborted) await saveCache(cacheDir, records);
	return records.filter((r) => r.id);
}
