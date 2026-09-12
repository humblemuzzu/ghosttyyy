import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const fileFlag = argv.indexOf("--file");
const target =
	fileFlag === -1
		? path.join(os.homedir(), ".pi/agent/npm/node_modules/@marckrenn/pi-sub-core/index.ts")
		: argv[fileFlag + 1];

const ANCHOR = `\tconst controllerState = {
\t\tcurrentProvider: undefined as ProviderName | undefined,
\t\tcachedUsage: undefined as UsageSnapshot | undefined,
\t\tproviderCycleIndex: 0,
\t};
`;

const HELPER = `${ANCHOR}
\tlet stale = false;

\tconst stopRefreshTimers = (): void => {
\t\tif (usageRefreshInterval) {
\t\t\tclearInterval(usageRefreshInterval);
\t\t\tusageRefreshInterval = undefined;
\t\t}
\t\tif (statusRefreshInterval) {
\t\t\tclearInterval(statusRefreshInterval);
\t\t\tstatusRefreshInterval = undefined;
\t\t}
\t};

\tconst emitEvent = (channel: string, data: unknown): void => {
\t\tif (stale) return;
\t\ttry {
\t\t\tpi.events.emit(channel, data);
\t\t} catch {
\t\t\tstale = true;
\t\t\tstopRefreshTimers();
\t\t}
\t};
`;

const EMIT_CALL = /\bpi\.events\.emit\(/g;

function patch(source) {
	if (source.includes("const emitEvent = ")) {
		return { ok: true, status: "already", output: source };
	}
	if (!source.includes(ANCHOR)) {
		return { ok: false, status: "insertion anchor missing", output: source };
	}
	const calls = source.match(EMIT_CALL)?.length ?? 0;
	if (calls !== 5) {
		return { ok: false, status: `expected 5 pi.events.emit call sites, found ${calls}`, output: source };
	}
	let output = source.replace(EMIT_CALL, "emitEvent(");
	output = output.replace(ANCHOR, HELPER);
	const remaining = output.match(EMIT_CALL)?.length ?? 0;
	if (remaining !== 1) {
		return { ok: false, status: `guard did not take, ${remaining} raw emit call sites left`, output: source };
	}
	return { ok: true, status: "patched", output };
}

let source;
try {
	source = fs.readFileSync(target, "utf-8");
} catch {
	console.error(`apply-sub-core-stale-guard: cannot read ${target}`);
	process.exit(1);
}

const result = patch(source);

if (!result.ok) {
	console.error(`apply-sub-core-stale-guard: ${result.status} in ${target}`);
	console.error("Every pi.events.emit inside createExtension must go through emitEvent.");
	process.exit(1);
}

if (result.status === "already") {
	console.log(`apply-sub-core-stale-guard: already applied (${target})`);
	process.exit(0);
}

if (checkOnly) {
	console.error(`apply-sub-core-stale-guard: guard MISSING (${target})`);
	process.exit(1);
}

fs.writeFileSync(target, result.output);
console.log(`apply-sub-core-stale-guard: patched (${target})`);
