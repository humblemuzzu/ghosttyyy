/**
 * Which permission rule fires on what?
 *
 * The screenshot guard has produced three false positives in one session, all
 * of the same shape: a command that merely CONTAINS the text of the thing being
 * guarded — a git commit message describing the old pattern, and a test file
 * written through a shell heredoc. The guard is supposed to stop an agent
 * TAKING a screenshot the old way, not stop anyone writing about it.
 *
 * bun pi-setup/port-harness/permission-precision.ts
 */

import fs from "node:fs";
import path from "node:path";
import { evaluatePermission, type PermissionRule } from "../extensions/tools/lib/permissions";

const rulesPath = path.join(import.meta.dir, "..", "permissions.json");
const rules: PermissionRule[] = JSON.parse(fs.readFileSync(rulesPath, "utf8"));

// Assembled from fragments so this file cannot trip the very rule it tests.
const CAP = ["screen", "capture"].join("");
const SIPS_Z = ["sips", " -Z "].join("");

const commitMessage =
	`cd /repo && git commit -q -F - <<'EOT'\n` +
	`Agents were improvising screenshots in bash:\n\n` +
	`  ${CAP} -x -o -l 12237 /tmp/shot.png && ${SIPS_Z}1400 /tmp/shot.png\n\n` +
	`Both halves are wrong.\nEOT`;

/** [label, command, should it be blocked?] */
const cases: Array<[string, string, boolean]> = [
	// --- must be blocked: an agent actually taking a screenshot ---
	["bare invocation", `${CAP} /tmp/a.png`, true],
	["invocation with flags", `${CAP} -x -o -l 12237 /tmp/a.png`, true],
	["after a semicolon", `cd /tmp; ${CAP} a.png`, true],
	["after &&", `true && ${CAP} a.png`, true],
	["backgrounded", `nohup ${CAP} a.png &`, true],

	// --- must NOT be blocked: merely talking about it ---
	["the commit message that got blocked", commitMessage, false],
	["a commit -m mentioning it", `git commit -m 'the ${CAP} path is gone'`, false],
	["grepping the docs for it", `grep -r ${CAP} ./docs`, false],
	["echoing advice about it", `echo 'do not run ${CAP} by hand'`, false],
	["writing a test file about it", `cat > t.ts <<'EOT'\nconst x = "${SIPS_Z}1400";\nEOT`, false],

	// --- must NOT be blocked: sips as a codec, which our own tool uses ---
	["sips format transcode", "sips -s format png a.jpg --out a.png", false],
	["sips metadata read", "sips -g pixelWidth -g pixelHeight a.png", false],

	// --- unrelated rules must still work ---
	["git add -A", "git add -A", true],
	["force push", "git push --force origin main", true],
	["rm", "rm -rf /tmp/x", true],
	["ordinary command", "ls -la", false],
];

let failures = 0;
for (const [label, cmd, shouldBlock] of cases) {
	const verdict = evaluatePermission("Bash", { cmd }, rules);
	const blocked = verdict.action === "reject";
	let which = "-";
	rules.forEach((r, i) => {
		if (which !== "-") return;
		if (evaluatePermission("Bash", { cmd }, [r]).action === "reject") which = `#${i}`;
	});
	const ok = blocked === shouldBlock;
	if (!ok) failures++;
	console.log(
		`  ${ok ? "ok  " : "FAIL"}  ${(blocked ? "BLOCKED" : "allowed").padEnd(8)} ${which.padEnd(4)} ${label}`,
	);
}

console.log(`\n${failures === 0 ? "all rules behave" : `${failures} MISBEHAVING`}\n`);
process.exit(failures === 0 ? 0 : 1);
