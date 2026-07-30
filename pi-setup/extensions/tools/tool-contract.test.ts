/**
 * tool-contract tests — the tool spec must be self-describing and internally
 * consistent, so a model never has to read our source to learn how to call us.
 *
 * WHY THIS FILE EXISTS
 *
 * measured, in a cold session: asked to launch two librarians and one oracle,
 * the model first ran `ls` on the tools directory, then grepped for
 * "parameters|Type.Object|Type.String", then read librarian.ts and oracle.ts —
 * roughly eight discovery calls before any real work, and it would have done
 * the same in every new session.
 *
 * it behaved correctly. the spec was contradictory:
 *   - the wire schema said `required: []` while the parameter description said
 *     "REQUIRED." models treat JSON Schema `required` as machine-truth and
 *     prose as advisory, so the contradiction made the whole spec suspect.
 *   - librarian's description discussed "what repositories you want to
 *     understand" while exposing no repository parameter, even though the seven
 *     github tools beside it all take one.
 *
 * these tests encode the fix as invariants. they are deliberately generic: any
 * tool added later is held to the same contract.
 */

import { describe, expect, test } from "bun:test";
import { createLibrarianTool, normalizeRepositories } from "./librarian";
import { createOracleTool } from "./oracle";
import { createDelegateTool } from "./delegate";
import { createFinderTool } from "./finder";
import { createCodeReviewTool } from "./code-review";

type AnyTool = {
	name: string;
	description: string;
	parameters: { properties?: Record<string, any>; required?: string[] };
};

/** the five sub-agent tools, i.e. everything that spawns a child pi session. */
const SUB_AGENT_TOOLS: Array<[string, AnyTool]> = [
	["librarian", createLibrarianTool() as any],
	["oracle", createOracleTool() as any],
	["delegate", createDelegateTool() as any],
	["finder", createFinderTool() as any],
	["code_review", createCodeReviewTool() as any],
];

/** the primary input each sub-agent tool cannot run without. */
const PRIMARY_PARAM: Record<string, string> = {
	librarian: "query",
	oracle: "task",
	delegate: "prompt",
	finder: "query",
	code_review: "diff_description",
};

describe("tool contract: schema and prose must agree", () => {
	for (const [name, tool] of SUB_AGENT_TOOLS) {
		test(`${name}: primary parameter is required in the schema`, () => {
			const primary = PRIMARY_PARAM[name];
			expect(tool.parameters.required ?? []).toContain(primary);
			expect(tool.parameters.properties?.[primary]?.type).toBe("string");
		});

		test(`${name}: no parameter claims "REQUIRED" in prose`, () => {
			// the exact contradiction that sent the model to our source. a
			// parameter is required by being in `required`, never by shouting.
			const proseHits = Object.entries(tool.parameters.properties ?? {})
				.filter(([, schema]) => /\bREQUIRED\b/.test(String((schema as any)?.description ?? "")))
				.map(([param]) => param);
			expect(proseHits).toEqual([]);
		});

		test(`${name}: description carries a literal Example: call`, () => {
			expect(tool.description).toMatch(/Example:\s*\w+\(\{/);
		});

		test(`${name}: the Example names the tool and its primary parameter`, () => {
			const example = tool.description.slice(tool.description.indexOf("Example:"));
			expect(example).toContain(`${name}({`);
			expect(example).toContain(`${PRIMARY_PARAM[name]}:`);
		});

		test(`${name}: every optional parameter says so or explains itself`, () => {
			// an optional parameter with no description is undiscoverable, which
			// is the same failure in a quieter form.
			for (const [param, schema] of Object.entries(tool.parameters.properties ?? {})) {
				const description = String((schema as any)?.description ?? "");
				expect(description.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("tool contract: librarian exposes repositories as structured input", () => {
	const librarian = createLibrarianTool() as any;

	test("a repository parameter exists", () => {
		// its absence, while the description talked about repositories, is what
		// made the model disbelieve the schema and read the file.
		expect(librarian.parameters.properties?.repository).toBeDefined();
	});

	test("repository accepts several repos", () => {
		expect(librarian.parameters.properties.repository.type).toBe("array");
		expect(librarian.parameters.properties.repository.items?.type).toBe("string");
	});

	test("repository is optional — a query may name repos in prose", () => {
		expect(librarian.parameters.required ?? []).not.toContain("repository");
	});
});

describe("normalizeRepositories tolerates what models actually send", () => {
	test("a proper array passes through, trimmed", () => {
		expect(normalizeRepositories(["  owner/repo ", "b/c"])).toEqual(["owner/repo", "b/c"]);
	});

	test("a bare string becomes one entry", () => {
		expect(normalizeRepositories("owner/repo")).toEqual(["owner/repo"]);
	});

	test("a JSON-stringified array is parsed", () => {
		// the exact shape that made pi-tasks' array parameters unusable.
		expect(normalizeRepositories('["a/b","c/d"]')).toEqual(["a/b", "c/d"]);
	});

	test("a malformed JSON-looking string is kept whole rather than dropped", () => {
		expect(normalizeRepositories('["a/b"')).toEqual(['["a/b"']);
	});

	test("empty, null and non-string members are dropped", () => {
		expect(normalizeRepositories(null)).toEqual([]);
		expect(normalizeRepositories(undefined)).toEqual([]);
		expect(normalizeRepositories("   ")).toEqual([]);
		expect(normalizeRepositories([1, null, "a/b", "  "])).toEqual(["a/b"]);
	});
});

describe("tool contract: grammar sampling stays opt-in", () => {
	test("no sub-agent tool declares constrainedSampling", () => {
		// pi-ai's "exactly one required string property" rule only binds tools
		// that opt in (resolveGrammarConstrainedSampling returns early without a
		// `constrainedSampling` field). apply_patch opts in; these must not, or
		// adding a second required parameter would start throwing at request time.
		for (const [name, tool] of SUB_AGENT_TOOLS) {
			expect((tool as any).constrainedSampling, `${name} must not opt in`).toBeUndefined();
		}
	});
});
