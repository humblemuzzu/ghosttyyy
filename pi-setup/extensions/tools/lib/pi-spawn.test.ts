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
