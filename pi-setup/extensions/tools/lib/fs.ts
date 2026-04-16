/**
 * fs — path resolution and directory walking utilities.
 *
 * ported from @bds_pi/fs by bdsqqq. used by mentions session-index
 * for recursive .jsonl file discovery.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function expandPath(filePath: string): string {
	const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (stripped === "~") return os.homedir();
	if (stripped.startsWith("~/")) return os.homedir() + stripped.slice(1);
	return stripped;
}

export function resolveToAbsolute(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function isPathWithin(rootPath: string, targetPath: string): boolean {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

export interface WalkDirOptions {
	filter?(entry: fs.Dirent, absolutePath: string): boolean;
	stopWhen?(entry: fs.Dirent, absolutePath: string): boolean;
}

export function walkDirSync(
	rootDir: string,
	options: WalkDirOptions = {},
): string[] {
	const matches: string[] = [];

	const walk = (dir: string): boolean => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolutePath = path.join(dir, entry.name);

			if (options.stopWhen?.(entry, absolutePath)) {
				matches.push(absolutePath);
				return true;
			}

			if (options.filter?.(entry, absolutePath)) {
				matches.push(absolutePath);
			}

			if (entry.isDirectory() && walk(absolutePath)) {
				return true;
			}
		}

		return false;
	};

	walk(rootDir);
	return matches;
}
