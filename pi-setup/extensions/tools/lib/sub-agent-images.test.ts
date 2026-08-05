/**
 * A sub-agent's screenshots have to reach the caller, and must not cost
 * anything when there are none.
 */

import { describe, expect, test } from "bun:test";
import { collectSubAgentImages, subAgentResult } from "./sub-agent-render";

const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
const toolResult = (...content: any[]) => ({ role: "toolResult", toolCallId: "t", content }) as any;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as any;

describe("collectSubAgentImages", () => {
	test("a run with no images costs nothing", () => {
		expect(collectSubAgentImages([assistant("done"), toolResult({ type: "text", text: "ok" })])).toEqual(
			[],
		);
	});

	test("an empty transcript is fine", () => {
		expect(collectSubAgentImages([])).toEqual([]);
	});

	test("picks images out of tool results", () => {
		const got = collectSubAgentImages([
			assistant("looking"),
			toolResult(image("AAAA"), { type: "text", text: "captured" }),
		]);
		expect(got).toHaveLength(1);
		expect(got[0]!.data).toBe("AAAA");
		expect(got[0]!.mimeType).toBe("image/png");
	});

	test("keeps the MOST RECENT images, in order", () => {
		const got = collectSubAgentImages(
			[
				toolResult(image("first")),
				toolResult(image("second")),
				toolResult(image("third")),
				toolResult(image("fourth")),
			],
			2,
		);
		// the last look is the one that justified the conclusion
		expect(got.map((i) => i.data)).toEqual(["third", "fourth"]);
	});

	test("several images inside one tool result are kept in order", () => {
		const got = collectSubAgentImages([toolResult(image("a"), image("b"), image("c"))], 3);
		expect(got.map((i) => i.data)).toEqual(["a", "b", "c"]);
	});

	test("the cap is respected and a zero cap disables it entirely", () => {
		const many = Array.from({ length: 30 }, (_, i) => toolResult(image(`i${i}`)));
		expect(collectSubAgentImages(many, 2)).toHaveLength(2);
		expect(collectSubAgentImages(many, 5)).toHaveLength(5);
		expect(collectSubAgentImages(many, 0)).toEqual([]);
	});

	test("non-image and malformed parts are ignored rather than crashing", () => {
		const got = collectSubAgentImages([
			toolResult({ type: "image" }), // no data
			toolResult({ type: "image", data: "" }), // empty data
			toolResult({ type: "text", text: "not an image" }),
			{ role: "assistant", content: [image("notfromatoolresult")] } as any,
			toolResult(image("real")),
		]);
		expect(got.map((i) => i.data)).toEqual(["real"]);
	});

	test("a mime type other than png survives", () => {
		const got = collectSubAgentImages([toolResult(image("j", "image/jpeg"))]);
		expect(got[0]!.mimeType).toBe("image/jpeg");
	});
});

describe("subAgentResult", () => {
	const details = { usage: { cost: 0.01 } } as any;

	test("with no images the shape is exactly what it always was", () => {
		const r = subAgentResult("answer", details);
		expect(r.content).toHaveLength(1);
		expect(r.content[0]).toEqual({ type: "text", text: "answer" });
	});

	test("images come BEFORE the text", () => {
		// the model should see the picture before it reads the claim about it
		const r = subAgentResult("answer", details, false, [image("X") as any]);
		expect(r.content[0]!.type).toBe("image");
		expect(r.content[1]!.type).toBe("text");
	});

	test("an error result still carries its images", () => {
		const r = subAgentResult("it broke", details, true, [image("X") as any]);
		expect(r.isError).toBe(true);
		expect(r.content.some((c: any) => c.type === "image")).toBe(true);
	});
});
