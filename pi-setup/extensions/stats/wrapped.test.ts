import { expect, test } from "bun:test";
import { bg, bold, fg } from "./draw";
import { ansiToHtml } from "./wrapped";

test("truecolor and bold runs become spans; text is escaped", () => {
	const line = `${bold(fg([1, 2, 3], "a<b"))} & ${bg([4, 5, 6], "c")}`;
	expect(ansiToHtml([line])).toBe('<span style="color:rgb(1,2,3);font-weight:700">a&lt;b</span> &amp; <span style="background:rgb(4,5,6)">c</span>');
});

test("a reset clears every style and other escapes are dropped", () => {
	expect(ansiToHtml([`${fg([9, 9, 9], "x")}\x1b[0m\x1b[2Ky\x1b]8;;http://x\x07z`, "plain"])).toBe('<span style="color:rgb(9,9,9)">x</span>yz\nplain');
});
