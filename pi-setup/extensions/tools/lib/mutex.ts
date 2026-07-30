/**
 * per-path async mutex for file operations.
 *
 * serializes concurrent edits to the same file path to prevent
 * partial writes and race conditions. pi's built-in edit tool doesn't.
 * this mutex is keyed by resolved absolute path — two relative paths
 * pointing to the same file share one lock.
 */

import * as path from "node:path";

const locks = new Map<string, Promise<void>>();

/**
 * execute `fn` while holding an exclusive lock on `filePath`.
 * concurrent calls for the same resolved path queue sequentially.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = path.resolve(filePath);

	while (locks.has(key)) {
		await locks.get(key);
	}

	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	locks.set(key, promise);

	try {
		return await fn();
	} finally {
		locks.delete(key);
		resolve();
	}
}

/**
 * execute `fn` while holding exclusive locks on EVERY given path.
 *
 * apply_patch mutates several files as one atomic batch, so it must hold
 * all locks for the whole operation rather than locking each file in turn.
 *
 * locks are acquired in sorted order and duplicates are collapsed. the sort
 * is what prevents deadlock: two concurrent batches sharing files always
 * request them in the same global order, so neither can hold one while
 * waiting on the other.
 */
export async function withFileLocks<T>(filePaths: string[], fn: () => Promise<T>): Promise<T> {
	const ordered = [...new Set(filePaths.map((p) => path.resolve(p)))].sort();

	const acquire = (index: number): Promise<T> => {
		const next = ordered[index];
		return next === undefined ? fn() : withFileLock(next, () => acquire(index + 1));
	};

	return acquire(0);
}
