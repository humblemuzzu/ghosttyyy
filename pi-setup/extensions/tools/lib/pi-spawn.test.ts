/**
 * piSpawn argv tests — what the child process is ACTUALLY launched with.
 *
 * WHY ARGV AND NOT THE CONSTANTS
 *
 * every interesting failure at this seam is invisible from the tool file. the
 * model a sub-agent runs on is decided here, not in `chad.ts`: piSpawn copies
 * the PARENT's model whenever the parent is not anthropic, so a pin that is
 * merely written down in a const would be silently overridden for exactly the
 * sessions it matters most in. same class of bug as pi 0.84's #7327, which took
 * out every sub-agent while every unit test stayed green — AGENTS.md's update
 * workflow says it outright: grep our own CLI call sites, an import-level audit
 * cannot see a change in the flags we pass.
 *
 * so these tests run the real piSpawn against a stub `pi` that records its argv.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSpawn } from "./pi-spawn";

let dir: string;
let stub: string;
let argvOut: string;

const ARGV_ENV = "PI_SPAWN_TEST_ARGV_OUT";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-spawn-test-"));
	stub = join(dir, "pi-stub.sh");
	argvOut = join(dir, "argv.txt");
	writeFileSync(
		stub,
		[
			"#!/bin/sh",
			"{",
			'  for a in "$@"; do echo "ARG:$a"; done',
			'  echo "ENV:PI_BASH_READ_ONLY=${PI_BASH_READ_ONLY:-}"',
			'  echo "ENV:PI_SUBAGENT_TOOLS=${PI_SUBAGENT_TOOLS:-}"',
			`} > "$${ARGV_ENV}"`,
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(stub, 0o755);
	process.env.PI_BIN = stub;
	process.env[ARGV_ENV] = argvOut;
});

afterAll(() => {
	delete process.env.PI_BIN;
	delete process.env[ARGV_ENV];
	rmSync(dir, { recursive: true, force: true });
});

interface Launch {
	args: string[];
	env: Record<string, string>;
	/** value that follows `flag`, or undefined when the flag is absent. */
	valueOf(flag: string): string | undefined;
}

async function launch(config: Record<string, unknown>): Promise<Launch> {
	writeFileSync(argvOut, "");
	await piSpawn({
		cwd: dir,
		task: "noop",
		...(config as any),
	});
	const lines = readFileSync(argvOut, "utf-8").split("\n").filter(Boolean);
	const args = lines.filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
	const env: Record<string, string> = {};
	for (const line of lines.filter((l) => l.startsWith("ENV:"))) {
		const [key, ...rest] = line.slice(4).split("=");
		env[key] = rest.join("=");
	}
	return {
		args,
		env,
		valueOf(flag: string) {
			const index = args.indexOf(flag);
			return index === -1 ? undefined : args[index + 1];
		},
	};
}

describe("pinModel: the model survives every parent", () => {
	const PINNED = "deepseek/deepseek-v4-flash";

	test("anthropic parent — pinned model is used verbatim", async () => {
		const run = await launch({
			model: PINNED,
			pinModel: true,
			parentModel: "anthropic/claude-opus-5",
		});
		expect(run.valueOf("--model")).toBe(PINNED);
	});

	test("NON-anthropic parent — pinned model still wins (the whole point)", async () => {
		// without pinModel this is the branch that assigns `resolvedModel =
		// config.parentModel`, turning a chad launched from a kimi session into
		// a kimi agent with nothing failing anywhere.
		for (const parentModel of [
			"kimi-code/kimi-for-coding",
			"sakana/fugu-ultra",
			"deepseek/deepseek-v4-pro",
			"llama-local/LFM2.5-2.6B",
		]) {
			const run = await launch({ model: PINNED, pinModel: true, parentModel });
			expect(run.valueOf("--model")).toBe(PINNED);
		}
	});

	test("no parent context at all — pinned model is not re-qualified", async () => {
		// the unpinned no-parent branch prepends `anthropic/` to a bare id; a
		// pinned id is already provider-qualified and must pass through untouched.
		const run = await launch({ model: PINNED, pinModel: true });
		expect(run.valueOf("--model")).toBe(PINNED);
	});
});

describe("inheritance is unchanged for everyone else", () => {
	test("non-anthropic parent still overrides a claude model", async () => {
		const run = await launch({
			model: "claude-sonnet-5",
			parentModel: "kimi-code/kimi-for-coding",
		});
		expect(run.valueOf("--model")).toBe("kimi-code/kimi-for-coding");
	});

	test("anthropic parent still provider-qualifies a bare id", async () => {
		const run = await launch({
			model: "claude-opus-4-6",
			parentModel: "anthropic/claude-opus-5",
		});
		expect(run.valueOf("--model")).toBe("anthropic/claude-opus-4-6");
	});
});

describe("thinkingLevel", () => {
	test("is passed as its own flag", async () => {
		const run = await launch({
			model: "deepseek/deepseek-v4-flash",
			pinModel: true,
			thinkingLevel: "high",
		});
		expect(run.valueOf("--thinking")).toBe("high");
	});

	test("is absent when not asked for, so the child keeps its own default", async () => {
		const run = await launch({ model: "deepseek/deepseek-v4-flash", pinModel: true });
		expect(run.args).not.toContain("--thinking");
	});
});

describe("readOnlyBash", () => {
	test("sets the env var the child's bash tool reads", async () => {
		const run = await launch({
			model: "deepseek/deepseek-v4-flash",
			pinModel: true,
			readOnlyBash: true,
			builtinTools: ["read", "bash"],
		});
		expect(run.env.PI_BASH_READ_ONLY).toBe("1");
	});

	test("is absent by default — every other sub-agent keeps a normal bash", async () => {
		const run = await launch({ model: "claude-sonnet-5", builtinTools: ["read", "bash"] });
		expect(run.env.PI_BASH_READ_ONLY).toBe("");
	});
});

describe("tool allowlist still reaches the child both ways", () => {
	test("--tools and PI_SUBAGENT_TOOLS are fed by the same list", async () => {
		const run = await launch({
			model: "deepseek/deepseek-v4-flash",
			pinModel: true,
			builtinTools: ["read", "grep"],
			extensionTools: ["read", "web_search", "glob"],
		});
		// glob -> find aliasing and dedupe happen once, at this seam
		expect(run.valueOf("--tools")).toBe("read,grep,web_search,find");
		expect(run.env.PI_SUBAGENT_TOOLS).toBe("read,grep,web_search,find");
	});
});

/*
 * STALL WATCHDOG
 *
 * a sub-agent is headless: there is no Esc, so a frozen child is
 * indistinguishable from a busy one until someone walks back to the laptop.
 * measured: a delegate sat wedged for 2h22m overnight while the parent waited
 * on `proc`.
 *
 * these run the real piSpawn against stub children that either go silent or
 * keep printing. the stubs matter more than usual here — the property under
 * test is "does the parent notice silence", which no unit-level assertion on
 * constants can reach.
 */

/** write an executable stub child and return its path. */
function writeStub(name: string, body: string[]): string {
	const file = join(dir, name);
	writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
	chmodSync(file, 0o755);
	return file;
}

/** run piSpawn against `bin` with a given stall window, restoring env after. */
async function withChild(
	bin: string,
	stallSec: string,
	config: Record<string, unknown> = {},
): Promise<{ exitCode: number; stopReason?: string; errorMessage?: string; ms: number }> {
	const prevBin = process.env.PI_BIN;
	const prevStall = process.env.PI_SPAWN_STALL_SEC;
	process.env.PI_BIN = bin;
	process.env.PI_SPAWN_STALL_SEC = stallSec;
	const started = Date.now();
	try {
		const r = await piSpawn({ cwd: dir, task: "noop", ...(config as any) });
		return { exitCode: r.exitCode, stopReason: r.stopReason, errorMessage: r.errorMessage, ms: Date.now() - started };
	} finally {
		if (prevBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = prevBin;
		if (prevStall === undefined) delete process.env.PI_SPAWN_STALL_SEC; else process.env.PI_SPAWN_STALL_SEC = prevStall;
	}
}

describe("stall watchdog", () => {
	test("kills a child that produces no output at all", async () => {
		const bin = writeStub("silent.sh", ["sleep 60"]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBe("stalled");
		expect(run.exitCode).toBe(1);
		expect(run.ms).toBeLessThan(15000);
	}, 30000);

	test("force-release: a killed child holding stdout still returns on the grace timer", async () => {
		// this stub's `sleep` inherits stdout, so killing the shell does NOT close
		// the pipe and `proc.on("close")` never fires — the exact reason killing is
		// not the same as being released. without FORCE_RELEASE_MS this returned at
		// 60s (the sleep's own length) despite the watchdog firing correctly at 1s.
		const bin = writeStub("silent-pipe.sh", ["sleep 60"]);
		const run = await withChild(bin, "1");
		// stall window 1s + 10s grace, and emphatically NOT the 60s the child wanted
		expect(run.ms).toBeGreaterThanOrEqual(10_000);
		// tight: the grace is its own timer, so it does not round up to a watchdog tick
		expect(run.ms).toBeLessThan(14_000);
		expect(run.stopReason).toBe("stalled");
	}, 40000);

	test("an RPC child that finished its turns is released on the grace timer too", async () => {
		// the RPC kill paths (kill_after_turn / kill_after_error) are the happy
		// path: the child DID its work. before this they set no killedAt, so a
		// stuck pipe made them wait out the whole stall window instead of 10s.
		// stall is set to 60s here purely so that regression would be visible as a
		// >60s run rather than hiding behind a short window.
		const turn = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"end_turn"}}';
		const bin = writeStub("rpc-done.sh", [`echo '${turn}'`, `echo '${turn}'`, "sleep 60"]);
		const run = await withChild(bin, "60", { followUp: "second turn" });
		// ~10s grace. before the dedicated release timer this landed at 20s (the
		// watchdog tick for a 60s window); before killedAt it would be 60s+.
		expect(run.ms).toBeLessThan(14_000);
		expect(run.stopReason).not.toBe("stalled");
	}, 60000);

	test("the release backstop works even with the stall watchdog disabled", async () => {
		// PI_SPAWN_STALL_SEC=0 removes the interval entirely, but an aborted or
		// turn-complete child must still be released from a stuck pipe.
		const turn = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"end_turn"}}';
		const bin = writeStub("rpc-nostall.sh", [`echo '${turn}'`, `echo '${turn}'`, "sleep 60"]);
		const run = await withChild(bin, "0", { followUp: "second turn" });
		expect(run.ms).toBeGreaterThanOrEqual(10_000);
		expect(run.ms).toBeLessThan(14_000);
	}, 40000);

	test("the message says RELAUNCH, never resume", async () => {
		// pi restores a session verbatim and only trims a trailing assistant
		// message on stopReason "error"/"length", NOT "toolUse" — so a child killed
		// mid-tool-call leaves a tool_use with no tool_result and replaying it is a
		// provider 400. telling the model to resume would be telling it to do
		// something that cannot work.
		const bin = writeStub("silent2.sh", ["sleep 60"]);
		const run = await withChild(bin, "1");
		expect(run.errorMessage).toMatch(/no output for/);
		expect(run.errorMessage).toMatch(/cannot be resumed/);
		expect(run.errorMessage).toMatch(/Launch a fresh one/);
		expect(run.errorMessage).not.toMatch(/\bresume it\b/i);
	}, 30000);

	test("does NOT kill a child that keeps emitting events", async () => {
		// the events piSpawn ignores (tool_execution_update, message_update) are
		// exactly the ones that prove liveness, which is why the watchdog watches
		// raw bytes rather than parsed events.
		const bin = writeStub("chatty.sh", [
			'for i in 1 2 3 4 5 6 7 8; do echo \'{"type":"tool_execution_update"}\'; sleep 0.4; done',
		]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	test("stderr-only output also counts as liveness", async () => {
		const bin = writeStub("chatty-err.sh", [
			"for i in 1 2 3 4 5 6; do echo noise >&2; sleep 0.4; done",
		]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	test("a child that finishes quickly is untouched and leaks no timer", async () => {
		// if the interval were not cleared in `finally`, this test file would hang
		// rather than exit.
		const bin = writeStub("quick.sh", ["echo hi", "exit 0"]);
		const run = await withChild(bin, "1");
		expect(run.exitCode).toBe(0);
		expect(run.stopReason).toBeUndefined();
		expect(run.ms).toBeLessThan(5000);
	}, 30000);

	test("PI_SPAWN_STALL_SEC=0 disables it", async () => {
		const bin = writeStub("silent3.sh", ["sleep 2", "echo done"]);
		const run = await withChild(bin, "0");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	test("a spawn failure resolves without the watchdog surviving it", async () => {
		// proc.on("error") is the other resolve path; the timer is cleared in
		// `finally`, which covers both.
		const run = await withChild(join(dir, "does-not-exist"), "1");
		expect(run.exitCode).toBe(1);
		expect(run.stopReason).toBeUndefined();
		expect(run.ms).toBeLessThan(5000);
	}, 30000);

	test("default window is 15 minutes when the env var is absent", async () => {
		const prev = process.env.PI_SPAWN_STALL_SEC;
		delete process.env.PI_SPAWN_STALL_SEC;
		const prevBin = process.env.PI_BIN;
		process.env.PI_BIN = writeStub("quick2.sh", ["echo hi", "exit 0"]);
		try {
			// a 2s child must not trip a 15m window
			const r = await piSpawn({ cwd: dir, task: "noop" });
			expect(r.stopReason).toBeUndefined();
		} finally {
			if (prev !== undefined) process.env.PI_SPAWN_STALL_SEC = prev;
			if (prevBin !== undefined) process.env.PI_BIN = prevBin;
		}
	}, 30000);
});
