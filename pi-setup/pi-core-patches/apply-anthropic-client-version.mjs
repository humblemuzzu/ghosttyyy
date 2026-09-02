#!/usr/bin/env node
// Anthropic gates Claude Max model access by the Claude Code client version pi
// claims. New models 400 (claude_code_version_too_old) until it is bumped.
// Finds every anthropic-messages implementation on the machine and bumps the
// claudeCodeVersion literal to TARGET. --check audits only.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGET = [2, 1, 258];
const VERSION = TARGET.join(".");
const HOME = process.env.HOME;
const ROOTS = [
	"/opt/homebrew/lib/node_modules/@earendil-works",
	"/opt/homebrew/lib/node_modules/@mariozechner",
	join(HOME, ".pi", "agent", "npm"),
	join(HOME, ".pi", "agent", "extensions"),
];
const check = process.argv.includes("--check");
const RE = /claudeCodeVersion\s*=\s*"(\d+\.\d+\.\d+)"/g;

function atLeast(a, b) {
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}

function parse(v) {
	return v.split(".").map((n) => parseInt(n, 10) || 0);
}

function collect(root, files, depth = 0) {
	if (depth > 15 || !existsSync(root)) return;
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === ".cache") continue;
		const p = join(root, entry.name);
		if (entry.isDirectory()) {
			collect(p, files, depth + 1);
		} else if (/\.(js|mjs|cjs)$/.test(entry.name) && !/\.(map|d\.ts)/.test(entry.name)) {
			files.push(p);
		}
	}
}

const files = [];
for (const root of ROOTS) collect(root, files);

let found = 0;
let stale = 0;
let patched = 0;
for (const file of files) {
	const content = readFileSync(file, "utf-8");
	if (!content.includes("claudeCodeVersion")) continue;
	const matches = [...content.matchAll(RE)];
	if (matches.length === 0) continue;
	found++;
	const needsBump = matches.some((m) => !atLeast(parse(m[1]), TARGET));
	if (!needsBump) continue;
	stale++;
	if (check) {
		console.log(`STALE ${file} (${matches.map((m) => m[1]).join(", ")})`);
		continue;
	}
	const patchedContent = content.replace(RE, `claudeCodeVersion = "${VERSION}"`);
	writeFileSync(file, patchedContent, "utf-8");
	patched++;
	console.log(`PATCHED ${file} (${matches.map((m) => m[1]).join(", ")} -> ${VERSION})`);
}

if (found === 0) {
	console.log("NO claudeCodeVersion copies found");
	process.exit(2);
}
process.exit(check && stale > 0 ? 1 : 0);
