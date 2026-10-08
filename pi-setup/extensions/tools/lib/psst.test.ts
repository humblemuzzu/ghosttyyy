import { describe, expect, test } from "bun:test";
import { scrubToolResult } from "./psst";

const scrub = (text: string) => text.replaceAll("hunter2", "<scrubbed>");

describe("scrubToolResult", () => {
	test("scrubs structuredContent too — returning content alone would drop it", () => {
		const out = scrubToolResult(
			{
				content: [{ type: "text", text: "$ env\n\npw=hunter2" }],
				structuredContent: { output: "pw=hunter2\n", nested: [{ v: "hunter2" }], exit_code: 0, truncated: false },
			},
			scrub,
		);
		expect(out!.content[0].text).toBe("$ env\n\npw=<scrubbed>");
		expect(out!.structuredContent).toEqual({
			output: "pw=<scrubbed>\n",
			nested: [{ v: "<scrubbed>" }],
			exit_code: 0,
			truncated: false,
		});
	});

	test("leaves images untouched and omits structuredContent when the tool had none", () => {
		const image = { type: "image", data: "hunter2", mimeType: "image/png" };
		const out = scrubToolResult({ content: [image, { type: "text", text: "hunter2" }] }, scrub);
		expect(out!.content[0]).toBe(image);
		expect(out!.content[1].text).toBe("<scrubbed>");
		expect("structuredContent" in out!).toBe(false);
	});

	test("a result with nothing to scrub is left alone", () => {
		expect(scrubToolResult({ content: [] }, scrub)).toBeUndefined();
	});
});
