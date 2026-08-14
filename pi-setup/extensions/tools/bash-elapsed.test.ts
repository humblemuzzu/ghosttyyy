// bash `[took Ns]` notice. guards: `endedAt ??= Date.now()` ran on every
// renderResult, stamping the end on the first streaming update -> always 0.0s.

import { describe, it, expect, afterEach } from "bun:test";
import { createBashTool } from "./bash";

const tool: any = createBashTool();
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** one tool row: shared state across renderCall/renderResult, as pi does it */
function row() {
	const state: any = {};
	let callOut = "";
	const rendered: string[] = [];
	const ctx = (extra: any = {}) => ({
		state,
		invalidate: () => {},
		lastComponent: undefined,
		...extra,
	});

	return {
		state,
		call(executionStarted: boolean) {
			const component = { setText: (t: string) => (callOut = t) };
			tool.renderCall({ cmd: "sleep 5", timeout: 30 }, theme, {
				...ctx({ lastComponent: component }),
				executionStarted,
			});
			return callOut;
		},
		result(opts: { isPartial: boolean; isError?: boolean; text?: string }) {
			rendered.length = 0;
			const container = {
				clear: () => {},
				addChild: (c: any) => rendered.push(typeof c.render === "function" ? c.render(80) : c.text),
			};
			const content =
				opts.text === undefined ? [] : [{ type: "text", text: opts.text }];
			tool.renderResult(
				{ content },
				{ expanded: false, isPartial: opts.isPartial },
				theme,
				{ ...ctx({ lastComponent: container }), isError: opts.isError ?? false },
			);
			return String(rendered.join("\n"));
		},
	};
}

const live: any[] = [];
afterEach(() => {
	for (const s of live.splice(0)) if (s.interval) clearInterval(s.interval);
});

describe("bash elapsed time", () => {
	it("does not stamp the end on a streaming update — the 0.0s bug", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, text: "some output" });
		expect(r.state.endedAt).toBeUndefined();
	});

	it("stamps the end on the final result", () => {
		const r = row();
		r.call(true);
		r.result({ isPartial: false, text: "some output" });
		expect(r.state.endedAt).toBeGreaterThan(0);
	});

	it("reports the real duration, not 0.0s", () => {
		const r = row();
		r.call(true);
		r.state.startedAt = Date.now() - 2_500;
		expect(r.result({ isPartial: false, text: "out" })).toContain("took 2.5s");
	});

	// the backdated test above never renders a partial, which is where the end
	// was stamped — so only this one catches the original bug.
	it("measures the whole run across streaming updates", async () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		await Bun.sleep(60);
		r.result({ isPartial: true, text: "working" });
		await Bun.sleep(300);
		const out = r.result({ isPartial: false, text: "done" });
		const took = Number(out.match(/took ([\d.]+)s/)![1]);
		expect(took).toBeGreaterThanOrEqual(0.3);
	});

	it("measures from execution start, not from first output", () => {
		const r = row();
		r.call(true);
		const started = r.state.startedAt;
		expect(started).toBeGreaterThan(0);
		// output arrives later; the clock must not restart
		r.result({ isPartial: true, text: "late output" });
		expect(r.state.startedAt).toBe(started);
	});

	it("does not start the clock before execution starts", () => {
		const r = row();
		r.call(false);
		expect(r.state.startedAt).toBeUndefined();
	});

	it("ticks while running and stops when done", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, text: "working" });
		expect(r.state.interval).toBeDefined();
		r.result({ isPartial: false, text: "done" });
		expect(r.state.interval).toBeUndefined();
	});

	it("says 'elapsed' while running and 'took' when finished", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		expect(r.result({ isPartial: true, text: "working" })).toContain("elapsed ");
		expect(r.result({ isPartial: false, text: "done" })).toContain("took ");
	});

	it("times a command that produced no output at all", () => {
		const r = row();
		r.call(true);
		r.state.startedAt = Date.now() - 3_000;
		const out = r.result({ isPartial: false, text: "(no output)" });
		expect(out).toContain("(no output)");
		expect(out).toContain("took 3.0s");
	});

	it("times a result with no content block", () => {
		const r = row();
		r.call(true);
		r.state.startedAt = Date.now() - 1_000;
		expect(r.result({ isPartial: false })).toContain("took 1.0s");
	});

	it("stops the clock on an error even while partial", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, isError: true, text: "boom" });
		expect(r.state.endedAt).toBeGreaterThan(0);
		expect(r.state.interval).toBeUndefined();
	});

	// /new or /resume can drop the row mid-command, orphaning the ticker.
	it("self-clears an orphaned ticker past its deadline", async () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, text: "working" });
		expect(r.state.interval).toBeDefined();

		r.state.deadline = Date.now() - 1; // simulate the deadline passing
		await Bun.sleep(1_200); // one tick
		expect(r.state.interval).toBeUndefined();
	});

	it("gives the ticker a deadline past the longest declared timeout", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, text: "working" });
		expect(r.state.deadline).toBeGreaterThan(Date.now() + 600_000);
	});

	// the deepseek-peak class: a throw in a timer callback is process.exit(1).
	// the deadline test above only bounds a leak; this covers the crash.
	it("survives a render context that throws, and stops rather than retrying", async () => {
		const state: any = {};
		let calls = 0;
		const container = { clear: () => {}, addChild: () => {} };
		tool.renderCall({ cmd: "sleep 5", timeout: 30 }, theme, {
			state,
			executionStarted: true,
			lastComponent: { setText: () => {} },
		});
		tool.renderResult({ content: [{ type: "text", text: "working" }] }, { expanded: false, isPartial: true }, theme, {
			state,
			lastComponent: container,
			isError: false,
			invalidate: () => {
				calls++;
				throw new Error("stale render context");
			},
		});
		expect(state.interval).toBeDefined();

		// if the throw escaped the callback, bun reports an unhandled error here
		await Bun.sleep(2_200);
		expect(calls).toBe(1); // stopped after the first throw, did not retry
		expect(state.interval).toBeUndefined();
	});

	it("does not hold the process open", () => {
		const r = row();
		live.push(r.state);
		r.call(true);
		r.result({ isPartial: true, text: "working" });
		// unref'd: a timer must never be the reason pi cannot exit
		expect(r.state.interval.hasRef?.()).toBe(false);
	});

	it("shows no timing when the clock never started", () => {
		const r = row();
		expect(r.result({ isPartial: false, text: "out" })).not.toContain("took");
	});

	it("does not re-stamp the end on a later re-render (ctrl+o)", () => {
		const r = row();
		r.call(true);
		r.result({ isPartial: false, text: "out" });
		const ended = r.state.endedAt;
		r.result({ isPartial: false, text: "out" });
		expect(r.state.endedAt).toBe(ended);
	});
});
