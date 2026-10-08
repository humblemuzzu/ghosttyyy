/**
 * read-only bash policy for research sub-agents.
 * allowlist that fails closed — an unrecognised command is refused and named.
 * a command name is not a capability: flags can write (WRITE_FLAGS /
 * POSITIONAL_OUTPUT). accepted hole: an allowed binary talked into writing
 * by a flag form not listed here.
 */

/** env var that turns the policy on. set by piSpawn for read-only sub-agents. */
export const READ_ONLY_BASH_ENV = "PI_BASH_READ_ONLY";

export interface ReadOnlyVerdict {
	allowed: boolean;
	/** why it was refused, phrased for the agent that has to act on it. */
	reason?: string;
}

export function isReadOnlyBash(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[READ_ONLY_BASH_ENV] === "1";
}

// --- the allowlist ---

/**
 * commands that cannot write on their own. awk/perl/python3/node are out
 * (`system()`, `-c`/`-e`). anything added must be checked for output/exec flags.
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
	// read + list
	"ls", "cat", "bat", "head", "tail", "wc", "nl", "sort", "uniq", "cut", "tr",
	"column", "tree", "stat", "file", "du", "df", "basename", "dirname",
	"realpath", "readlink", "pwd", "cd",
	// search
	"rg", "grep", "egrep", "fgrep", "zgrep", "find", "fd", "ag", "ack",
	// inspect + transform (gated below — several of these can write)
	"jq", "yq", "sed", "xxd", "od", "strings", "base64",
	"shasum", "md5", "md5sum", "sha1sum", "sha256sum", "cksum",
	"diff", "comm", "cmp",
	// environment + trivia
	"echo", "printf", "date", "env", "printenv", "whoami", "hostname", "uname",
	"which", "type", "id", "sleep", "true", "false", "test", "man", "ps", "lsof",
	// gated below
	"git", "curl",
]);

/** git subcommands that cannot change anything. */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"log", "show", "diff", "status", "blame", "annotate", "grep", "shortlog",
	"ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "describe",
	"cat-file", "reflog", "whatchanged", "count-objects", "check-ignore",
	"symbolic-ref", "var", "verify-commit", "merge-base", "name-rev",
]);

/**
 * read subcommands whose EXTRA operand turns them into a write.
 *
 * `git symbolic-ref HEAD` queries; `git symbolic-ref HEAD refs/heads/x`
 * repoints HEAD, which is a branch switch by another name. the flag-based
 * checks cannot see it because both arguments are bare refs. found in review.
 */
const GIT_OPERAND_LIMIT: Record<string, number> = {
	"symbolic-ref": 1,
};

/**
 * git subcommands that read OR write depending on their arguments.
 *
 * `bareIsRead` is per-subcommand and not a default, because the two groups
 * genuinely differ: bare `git remote` lists remotes, bare `git stash` PUSHES a
 * stash and changes the working tree.
 */
const GIT_MIXED_SUBCOMMANDS: Record<string, { bareIsRead: boolean; readForms: string[] }> = {
	remote: { bareIsRead: true, readForms: ["-v", "--verbose", "show", "get-url"] },
	branch: {
		bareIsRead: true,
		readForms: [
			"--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose",
			"--show-current", "--contains", "--merged", "--no-merged", "--points-at",
			"--sort", "--format",
		],
	},
	tag: {
		bareIsRead: true,
		readForms: ["--list", "-l", "-n", "--contains", "--points-at", "--sort", "--format", "--merged"],
	},
	notes: { bareIsRead: true, readForms: ["list", "show"] },
	submodule: { bareIsRead: true, readForms: ["status", "summary"] },
	stash: { bareIsRead: false, readForms: ["list", "show"] },
	worktree: { bareIsRead: false, readForms: ["list"] },
	config: { bareIsRead: false, readForms: ["--get", "--get-all", "--get-regexp", "--list", "-l"] },
};

/** argument tokens that make ANY git invocation a mutation. */
const GIT_MUTATING_TOKENS: ReadonlySet<string> = new Set([
	"-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force", "--add",
	"--unset", "--unset-all", "--replace-all", "--edit", "--amend",
	"add", "rename", "remove", "rm", "set-url", "set-head", "prune", "push",
	"pop", "apply", "drop", "clear", "create", "save", "update", "init", "deinit",
	// `git reflog delete` / `git reflog expire` prune the very history a human
	// would use to recover from a destructive command. found in review.
	"delete", "expire",
	// `git diff --output=<file>` really does write a file.
	"-o", "--output", "--output-directory",
	// `git grep -O` opens every match in a pager, i.e. runs a command.
	"-O", "--open-files-in-pager",
]);

/**
 * flags that make an otherwise-read-only command write a file or run another
 * command. every one of these was verified by running it on this machine.
 *
 * a command name is not a capability — this map is the correction for having
 * believed otherwise. anything added to ALLOWED_COMMANDS gets checked here.
 */
const WRITE_FLAGS: Record<string, readonly string[]> = {
	// verified: `sort -o out in` creates out
	sort: ["-o", "--output"],
	// verified: macOS `base64 -o out -i in` creates out
	base64: ["-o", "--output"],
	// tree -o FILE writes its listing to a file
	tree: ["-o"],
	// yq edits in place, exactly like sed -i
	yq: ["-i", "--inplace"],
	// verified: `fd -x CMD` executes CMD per match — an arbitrary-exec vector
	fd: ["-x", "-X", "--exec", "--exec-batch"],
	// ripgrep's --pre runs a preprocessor command on every file it opens
	rg: ["--pre", "--hostname-bin"],
	// same class, for the greps that might be installed instead
	ag: ["--pager", "-P"],
	ack: ["--pager"],
	/*
	 * verified: `man -P "sh -c 'touch f; cat'" ls` creates f. man's pager is NOT
	 * tty-gated the way git's is, so it fires even with stdout piped — which is
	 * always, here. found in review.
	 */
	man: ["-P", "--pager"],
	// -K reads a config file that can itself specify `output = FILE`
	curl: [
		"-o", "-O", "--output", "--remote-name", "--create-dirs", "-T", "--upload-file",
		"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form",
		"-X", "--request", "--dump-header", "-D", "-c", "--cookie-jar", "--trace",
		"--trace-ascii", "-K", "--config",
	],
};

/**
 * commands whose SECOND positional operand is an output file.
 *
 * verified: `uniq in out` and `xxd in out` both create `out`. counting bare
 * operands needs the value-taking flags, or `xxd -l 64 file` reads as two
 * operands and a legitimate read gets refused.
 */
const POSITIONAL_OUTPUT: Record<string, { maxOperands: number; valueFlags: readonly string[] }> = {
	uniq: { maxOperands: 1, valueFlags: ["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"] },
	xxd: { maxOperands: 1, valueFlags: ["-l", "-s", "-c", "-g", "-o", "-seek"] },
};

/** find primaries that execute or delete rather than report. */
const FIND_WRITE_PRIMARIES: ReadonlySet<string> = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls",
	// GNU-only; BSD find rejects it outright. listed for portability.
	"-fprint0",
]);

// --- scanning ---

interface Scan {
	/** each command position found in the line, including inside `$( )`. */
	segments: string[];
	/** redirection targets that are not /dev/null or an fd duplicate. */
	badRedirects: string[];
}

const SEPARATORS = new Set([";", "\n", "|", "&"]);

/**
 * quote-aware walk. `grep "a > b" f` is not a redirect; unquoted `rg x->y` is.
 */
export function scanCommand(cmd: string): Scan {
	const segments: string[] = [];
	const badRedirects: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let i = 0;

	const push = () => {
		if (current.trim()) segments.push(current.trim());
		current = "";
	};

	while (i < cmd.length) {
		const ch = cmd[i];

		if (quote) {
			if (ch === "\\" && quote === '"') {
				current += ch + (cmd[i + 1] ?? "");
				i += 2;
				continue;
			}
			/*
			 * DOUBLE quotes do not suppress command substitution; SINGLE quotes do.
			 * dropping quote state after `$(` / `` ` `` fails closed.
			 */
			if (quote === '"' && ((ch === "$" && cmd[i + 1] === "(") || ch === "`")) {
				push();
				quote = null;
				i += ch === "`" ? 1 : 2;
				continue;
			}
			if (ch === quote) quote = null;
			current += ch;
			i++;
			continue;
		}

		if (ch === "\\") {
			current += ch + (cmd[i + 1] ?? "");
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			i++;
			continue;
		}

		// command substitution opens a fresh command position. `(` and `{`
		// grouping is deliberately NOT unwrapped: the group's first word then
		// reads as `(rm` or `{`, which is not allowlisted, so it fails closed.
		if (ch === "$" && cmd[i + 1] === "(") {
			push();
			i += 2;
			continue;
		}
		// PROCESS SUBSTITUTION runs a command too, and the enclosing command can
		// be a perfectly innocent one. verified: `diff <(touch f) x` creates f,
		// and before this branch existed the scanner saw only `diff`.
		if (ch === "<" && cmd[i + 1] === "(") {
			push();
			i += 2;
			continue;
		}
		if (ch === "`") {
			push();
			i++;
			continue;
		}

		if (SEPARATORS.has(ch)) {
			// `&>` is a redirection, not a separator; let the `>` branch see it.
			if (ch === "&" && cmd[i + 1] === ">") {
				i++;
				continue;
			}
			push();
			i++;
			continue;
		}

		if (ch === ">") {
			const target = readRedirectTarget(cmd, i);
			if (!target.allowed) badRedirects.push(target.text);
			i = target.next;
			continue;
		}

		current += ch;
		i++;
	}

	push();
	return { segments, badRedirects };
}

/**
 * classify the redirection starting at `>`.
 *
 * `2>&1` and friends duplicate a descriptor and touch no file. `/dev/null` is
 * the one destination that discards rather than stores, and every real command
 * line uses it, so refusing it would make the guard unusable.
 */
function readRedirectTarget(cmd: string, start: number): { allowed: boolean; text: string; next: number } {
	let i = start;
	while (cmd[i] === ">") i++;
	if (cmd[i] === "|") i++; // `>|` — clobber override
	if (cmd[i] === "&") {
		// `>&2`, `2>&1`: fd duplication. `>&file` writes, so require digits.
		let j = i + 1;
		let digits = "";
		while (j < cmd.length && /\d/.test(cmd[j])) {
			digits += cmd[j];
			j++;
		}
		if (digits.length > 0 && (j >= cmd.length || /[\s;|&)]/.test(cmd[j]))) {
			return { allowed: true, text: `>&${digits}`, next: j };
		}
	}
	while (cmd[i] === " " || cmd[i] === "\t") i++;
	let target = "";
	while (i < cmd.length && !/[\s;|&)]/.test(cmd[i])) {
		target += cmd[i];
		i++;
	}
	const cleaned = target.replace(/^["']|["']$/g, "");
	return { allowed: cleaned === "/dev/null", text: target || "(empty)", next: i };
}

/** split a segment into words, quote-aware, with quotes stripped. */
export function splitWords(segment: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let started = false;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				current += segment[++i] ?? "";
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === "\\") {
			current += segment[++i] ?? "";
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) words.push(current);
	return words;
}

/** drop leading `VAR=value` assignments and modifiers to reach the real command. */
function stripPrefixes(words: string[]): string[] {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "!" || word === "time" || word === "nice") {
			i++;
			continue;
		}
		break;
	}
	return words.slice(i);
}

// --- per-command gates ---

function checkGit(args: string[]): ReadOnlyVerdict {
	const flagged = args.find((arg) => GIT_MUTATING_TOKENS.has(arg) || arg.startsWith("--output="));
	const subcommand = args.find((arg) => !arg.startsWith("-"));

	if (!subcommand) {
		return { allowed: false, reason: "`git` with no subcommand" };
	}
	// operand limits are checked BEFORE the read-subcommand shortcut: the
	// subcommands that need one (symbolic-ref) are on the read list, and an
	// early return there would skip the check entirely.
	const operandLimit = GIT_OPERAND_LIMIT[subcommand];
	if (operandLimit !== undefined) {
		const operands = args
			.slice(args.indexOf(subcommand) + 1)
			.filter((arg) => !arg.startsWith("-"));
		if (operands.length > operandLimit) {
			return {
				allowed: false,
				reason: `\`git ${subcommand}\` with ${operands.length} operands writes the ref`,
			};
		}
	}

	if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
		// even a read subcommand writes with --output (git diff --output=<file>).
		if (flagged) return { allowed: false, reason: `\`git ${subcommand}\` with \`${flagged}\`` };
		return { allowed: true };
	}

	const mixed = GIT_MIXED_SUBCOMMANDS[subcommand];
	if (!mixed) {
		return { allowed: false, reason: `\`git ${subcommand}\` can modify the repository` };
	}

	const rest = args.slice(args.indexOf(subcommand) + 1);
	if (rest.length === 0) {
		return mixed.bareIsRead
			? { allowed: true }
			: { allowed: false, reason: `bare \`git ${subcommand}\` is not read-only` };
	}
	if (flagged) return { allowed: false, reason: `\`git ${subcommand}\` with \`${flagged}\`` };

	const hasReadForm = rest.some((arg) =>
		mixed.readForms.some((form) => arg === form || arg.startsWith(`${form}=`)),
	);
	return hasReadForm
		? { allowed: true }
		: {
				allowed: false,
				reason: `\`git ${subcommand}\` needs one of ${mixed.readForms.join(", ")} to be read-only`,
			};
}

function checkSed(args: string[]): ReadOnlyVerdict {
	// -i, -i.bak, --in-place, and short bundles like -ni all edit in place.
	const flagged = args.find(
		(arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(arg),
	);
	if (flagged) return { allowed: false, reason: `\`sed ${flagged}\` edits in place` };

	/*
	 * sed's own `w` command writes a file from INSIDE the script, with no flag
	 * involved: `sed -n '1w out'` and `sed 's/a/b/w out'` both create `out`
	 * (verified). two targeted shapes rather than a bare /w\s/, which would
	 * refuse an innocent `s/a w b/x/`.
	 */
	const script = args.filter((arg) => !arg.startsWith("-"));
	const writesFile = script.find(
		(arg) => /\/[a-zA-Z0-9]*[wW]\s+\S/.test(arg) || /(^|[;{}])\s*[0-9$,~+/]*\s*[wW]\s+\S/.test(arg),
	);
	if (writesFile) {
		return { allowed: false, reason: "`sed` script writes a file with its `w` command" };
	}

	/*
	 * GNU sed's `e` command and `s///e` flag execute the pattern space as a
	 * shell command. BSD sed (this machine) has neither and errors out, so this
	 * is a portability guard: it costs nothing here and matters the day this
	 * runs on Linux or against `gsed`.
	 */
	const executes = script.find(
		(arg) => /\/[a-zA-Z0-9]*e(\s|;|$)/.test(arg) || /(^|[;{}])\s*[0-9$,~+/]*\s*e(\s|$)/.test(arg),
	);
	return executes
		? { allowed: false, reason: "`sed` script executes a command with its `e` command" }
		: { allowed: true };
}

/** a flag-form output/exec vector on a command that otherwise only reads. */
function checkWriteFlags(name: string, args: string[]): ReadOnlyVerdict {
	const flags = WRITE_FLAGS[name];
	if (!flags) return { allowed: true };
	const flagged = args.find((arg) =>
		flags.some((flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))),
	);
	return flagged
		? { allowed: false, reason: `\`${name} ${flagged}\` writes a file or runs a command` }
		: { allowed: true };
}

/** a second bare operand that is really an output file (`uniq in out`). */
function checkPositionalOutput(name: string, args: string[]): ReadOnlyVerdict {
	const rule = POSITIONAL_OUTPUT[name];
	if (!rule) return { allowed: true };

	let operands = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			// skip this flag's value so `xxd -l 64 f` counts one operand, not two
			if (rule.valueFlags.includes(arg)) i++;
			continue;
		}
		operands++;
	}
	return operands > rule.maxOperands
		? {
				allowed: false,
				reason: `\`${name}\` with ${operands} file operands — the second one is an output file`,
			}
		: { allowed: true };
}

function checkFind(args: string[]): ReadOnlyVerdict {
	const flagged = args.find((arg) => FIND_WRITE_PRIMARIES.has(arg));
	return flagged
		? { allowed: false, reason: `\`find ${flagged}\` runs or deletes` }
		: { allowed: true };
}

function checkEnv(args: string[]): ReadOnlyVerdict {
	// `env` alone prints the environment; `env FOO=1 rm x` runs a command this
	// scanner cannot see, so anything past assignments is refused.
	const flagged = args.find((arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
	return flagged
		? { allowed: false, reason: `\`env\` running \`${flagged}\`` }
		: { allowed: true };
}

// --- entry point ---

/**
 * decide whether a whole command line is read-only.
 *
 * every command position must pass; one bad segment refuses the line, because a
 * pipeline runs all of them.
 */
export function evaluateReadOnlyCommand(cmd: string): ReadOnlyVerdict {
	const { segments, badRedirects } = scanCommand(cmd);

	if (badRedirects.length > 0) {
		return {
			allowed: false,
			reason: `writes to \`${badRedirects[0]}\` (only \`>/dev/null\` and fd duplication like \`2>&1\` are allowed)`,
		};
	}

	for (const segment of segments) {
		const words = stripPrefixes(splitWords(segment));
		if (words.length === 0) continue;

		// `/usr/bin/rm` and `rm` are the same command.
		const name = words[0].split("/").pop() ?? words[0];
		const args = words.slice(1);

		if (!ALLOWED_COMMANDS.has(name)) {
			return { allowed: false, reason: `\`${name}\` is not a read-only command` };
		}

		// flag-form and operand-form vectors apply to any command that has them.
		const flagVerdict = checkWriteFlags(name, args);
		if (!flagVerdict.allowed) return flagVerdict;
		const operandVerdict = checkPositionalOutput(name, args);
		if (!operandVerdict.allowed) return operandVerdict;

		let verdict: ReadOnlyVerdict = { allowed: true };
		if (name === "git") verdict = checkGit(args);
		else if (name === "sed") verdict = checkSed(args);
		else if (name === "find" || name === "fd") verdict = checkFind(args);
		else if (name === "env") verdict = checkEnv(args);

		if (!verdict.allowed) return verdict;
	}

	return { allowed: true };
}

/** the refusal the agent reads. names the cause and the way forward. */
export function readOnlyRefusal(reason: string | undefined, cmd: string): string {
	return [
		`read-only session: ${reason ?? "command is not allowed"}.`,
		"",
		`command: ${cmd}`,
		"",
		"This sub-agent researches and reports; it does not change anything.",
		"Do not route around this with awk, an interpreter, or a subshell.",
		"Name the command you wanted and why in your final report, and let the main agent run it.",
	].join("\n");
}
