import * as fs from "node:fs";
import * as path from "node:path";

export const GITIGNORE_NOTE = "files matched by .gitignore are skipped; an ignored directory passed as `path` is searched";

/**
 * rg matches a glob containing `/` against the path relative to its target, so
 * rg must run FROM the search dir on a relative target: an absolute target
 * makes `src/**\/*.ts` match nothing.
 */
export function rgLocation(searchPath: string): { cwd: string; target: string } | { error: string } {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(searchPath);
	} catch {
		return { error: `path not found: ${searchPath}` };
	}
	return stat.isDirectory()
		? { cwd: searchPath, target: "." }
		: { cwd: path.dirname(searchPath), target: path.basename(searchPath) };
}
