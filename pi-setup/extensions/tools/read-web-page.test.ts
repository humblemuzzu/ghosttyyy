import { afterAll, describe, expect, test } from "bun:test";
import { createReadWebPageTool, staticFetchNote } from "./read-web-page";

const longPage = `<html><body><main>${Array.from({ length: 3000 }, (_, i) => `<p>para ${i}</p>`).join("\n")}</main></body></html>`;
const scriptPage = `<html><body><p>Hello static.</p><script src="/a.js"></script><script>1</script></body></html>`;
const accentPage = `<html><body><p>${"é".repeat(200_000)}</p></body></html>`;

const server = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		const body = path === "/long" ? longPage : path === "/scripts" ? scriptPage : accentPage;
		return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
	},
});
afterAll(() => server.stop(true));

const tool = createReadWebPageTool() as any;
const read = async (path: string) => {
	const r = await tool.execute("w", { url: `http://127.0.0.1:${server.port}${path}` }, undefined, undefined, {});
	return r.content[0].text as string;
};

describe("read_web_page", () => {
	test("a long page keeps its middle — no silent line-window cut before conversion", async () => {
		const text = await read("/long");
		expect(text).toContain("para 0");
		expect(text).toContain("para 1500");
		expect(text).toContain("para 2999");
	});

	test("every result says it is a static fetch and counts the scripts that did not run", async () => {
		const text = await read("/scripts");
		expect(text).toContain("Hello static.");
		expect(text).toEndWith(
			"[static fetch: 2 <script> tag(s) were not run, so content they build is missing — screenshot with url renders the page]",
		);
	});

	test("multibyte text split across network chunks decodes cleanly", async () => {
		expect(await read("/accents")).not.toContain("\uFFFD");
	});

	test("a page without scripts is reported as complete", () => {
		expect(staticFetchNote("<p>x</p>")).toBe("[static fetch: the page has no <script> tags, so this is its full content]");
	});
});
