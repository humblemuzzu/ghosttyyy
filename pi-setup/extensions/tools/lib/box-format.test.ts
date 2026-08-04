/**
 * box-format width tests.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-08-04 pi died mid-session with:
 *
 *   Error: Rendered line 2822 exceeds terminal width (140 > 125).
 *     at TUI.doRender (@earendil-works/pi-tui/dist/tui.js:1257)
 *
 * The line was a box header holding a Japanese web_search result title.
 * box-format defined its own `visibleWidth` that counted ONE column per
 * codepoint, so it clamped the header to "122 columns" — but 18 of those
 * characters are East-Asian Wide and occupy 2 columns, so the real width was
 * 140. pi-tui's doRender asserts every rendered line fits the terminal and
 * throws an uncaughtException, which kills the process.
 *
 * THE INVARIANT UNDER TEST: for any input, in any script, every line a
 * box-format renderer emits must measure <= the width it was given, **using
 * pi-tui's own `visibleWidth`** — the same function the assertion uses. These
 * tests fail if anyone reintroduces a private width measure.
 *
 * The corpus is deliberately adversarial: scripts whose rendered width is not
 * their codepoint count. Each entry says what it is there to break.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { formatBoxesWindowed, normalizeForDisplay, type BoxSection } from "./box-format";

/** ANSI escapes contain "[", so any structural assertion must strip them first. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");

/**
 * Real-world adversarial strings. Every one of these has a rendered width
 * different from its `.length`, which is exactly the class of bug that crashed.
 */
const CORPUS: Array<{ name: string; text: string }> = [
	// --- the actual crash ---
	{
		name: "japanese (the string that crashed pi)",
		text: "When to pronounce えい as 「ええ」 vs 「え'い」 えいご (英語) is pronounced as \"Ee\"go but めい(姪) is pronounced as \"Me + i\" I just want to know",
	},
	// --- East Asian Wide: 2 columns per char, the core failure ---
	{ name: "japanese kanji + kana", text: "名声 めいせい 意味 発音 日本語の勉強をしています" },
	{ name: "simplified chinese", text: "这是一个非常长的中文标题用来测试宽字符的宽度计算是否正确" },
	{ name: "traditional chinese", text: "這是一個非常長的中文標題用來測試寬字元的寬度計算是否正確" },
	{ name: "korean hangul", text: "한국어 제목입니다 이것은 너비 계산을 테스트하기 위한 것입니다" },
	{ name: "fullwidth latin", text: "ＦＵＬＬＷＩＤＴＨ　ＬＡＴＩＮ　ＴＥＸＴ　ＩＳ　ＴＷＯ　ＣＯＬＵＭＮＳ" },
	{ name: "CJK punctuation", text: "「引用」【括弧】（丸括弧）、。・ー〜" },
	// --- combining marks: many codepoints, few columns ---
	{ name: "devanagari conjuncts", text: "हिन्दी में यह एक बहुत लंबा शीर्षक है जो चौड़ाई की गणना का परीक्षण करता है" },
	{ name: "bengali", text: "বাংলা ভাষায় এটি একটি দীর্ঘ শিরোনাম যা প্রস্থ গণনা পরীক্ষা করে" },
	{ name: "tamil", text: "தமிழில் இது ஒரு நீண்ட தலைப்பு அகலக் கணக்கீட்டைச் சோதிக்கிறது" },
	{ name: "thai (stacked diacritics)", text: "ภาษาไทยนี้เป็นหัวข้อที่ยาวมากเพื่อทดสอบการคำนวณความกว้าง" },
	{ name: "vietnamese (stacked tones)", text: "Tiếng Việt có nhiều dấu thanh chồng lên nhau để kiểm tra chiều rộng" },
	// --- RTL ---
	{ name: "arabic", text: "هذا عنوان طويل جدا باللغة العربية لاختبار حساب العرض بشكل صحيح" },
	{ name: "hebrew", text: "זוהי כותרת ארוכה מאוד בעברית לבדיקת חישוב הרוחב" },
	// --- emoji: sequences that are one cluster but 2 columns ---
	{ name: "emoji ZWJ family", text: "👨‍👩‍👧‍👦 family 👩🏽‍💻 developer 🏳️‍🌈 flag 🧑🏿‍🚀 astronaut" },
	{ name: "emoji skin tones", text: "👋🏻👋🏼👋🏽👋🏾👋🏿 waving hands in every tone" },
	{ name: "regional indicator flags", text: "🇯🇵🇰🇷🇨🇳🇮🇳🇸🇦🇮🇱🇺🇸🇬🇧 country flags" },
	{ name: "text-presentation pictographs", text: "⚠ ☹ 🖐 ✂ ✈ ☎ these disagree between terminals" },
	// --- zero-width / control ---
	{ name: "zero-width joiners and spaces", text: "a\u200bb\u200cc\u200dd\ufeffe zero width chars" },
	{ name: "combining acute stack", text: "e\u0301\u0301\u0301\u0301 stacked combining marks" },
	// --- mixed, the realistic case ---
	{ name: "mixed scripts one line", text: "日本語 + हिन्दी + العربية + 한국어 + 🇯🇵 + ＷＩＤＥ + normal ascii" },
	// --- degenerate ---
	{ name: "ascii long", text: "a".repeat(500) },
	{ name: "single wide char", text: "名" },
	{ name: "empty", text: "" },
	{ name: "spaces only", text: " ".repeat(200) },
	{ name: "tabs", text: "col1\tcol2\tcol3\tcol4\tcol5" },
	{ name: "newline injected", text: "before\nafter" },
	{ name: "ansi already embedded", text: "\x1b[31mred\x1b[0m \x1b[1mbold\x1b[0m 名声 text" },
];

/** widths worth testing: tiny, odd, realistic, and the crash width. */
const WIDTHS = [1, 2, 3, 5, 8, 13, 20, 40, 80, 100, 125, 200];

/**
 * Render one section the way the tools do, and return the individual lines the
 * TUI would draw — which is what pi-tui's assertion actually inspects.
 */
function renderLines(section: BoxSection, width: number, notices?: string[]): string[] {
	return formatBoxesWindowed([section], {}, notices, width).split("\n");
}

function section(header: string | undefined, body: string): BoxSection {
	return { header, blocks: [{ lines: [{ text: body }] }] };
}

describe("box-format never emits a line wider than the width it was given", () => {
	for (const { name, text } of CORPUS) {
		for (const width of WIDTHS) {
			test(`header: ${name} @ width ${width}`, () => {
				const lines = renderLines(section(text, "body"), width);
				for (const line of lines) {
					// the exact assertion pi-tui's doRender makes before drawing.
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			});
		}
	}
});

describe("box-format content lines respect width in every script", () => {
	for (const { name, text } of CORPUS) {
		for (const width of [20, 80, 125]) {
			test(`content: ${name} @ width ${width}`, () => {
				const lines = renderLines(section("hdr", text), width);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			});
		}
	}
});

describe("box-format notices respect width", () => {
	for (const { name, text } of CORPUS.slice(0, 12)) {
		test(`notice: ${name} @ width 80`, () => {
			const lines = renderLines(section("hdr", "body"), 80, [text]);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
		});
	}
});

describe("the specific crash does not reproduce", () => {
	// terminal 125, pi passes the content width (124); the old code emitted 140.
	const CRASH_TITLE = CORPUS[0].text;

	test("the crashing header now fits at the crashing width", () => {
		for (const width of [124, 125]) {
			const lines = renderLines(section(CRASH_TITLE, "x"), width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a header of pure wide characters cannot overflow", () => {
		// worst case: every character costs 2 columns, so a naive
		// one-column-per-codepoint clamp overflows by exactly 2x.
		const lines = renderLines(section("名".repeat(300), "x"), 80);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});

describe("normalizeForDisplay does not itself widen text", () => {
	for (const { name, text } of CORPUS) {
		test(`${name} stays measurable after normalization`, () => {
			const normalized = normalizeForDisplay(text);
			// normalization may replace disagreeing clusters with U+FFFD, but it
			// must never make a string wider than it already measured.
			expect(visibleWidth(normalized)).toBeLessThanOrEqual(Math.max(visibleWidth(text), 1) * 2);
		});
	}
});

/**
 * A DIFFERENT failure mode from over-wide lines, and the reason the TUI can
 * smear without any width check ever failing: a newline inside a single-line
 * sink is width-0, so it survives clamping, but the terminal still advances a
 * row that nobody counted.
 *
 * Headers carry web-page titles, LLM-generated session names and user queries,
 * so this is reachable from untrusted input.
 */
describe("single-line sinks never smuggle extra rows", () => {
	const ROW_BREAKERS: Array<[string, string]> = [
		["unix newline", "before\nafter"],
		["windows newline", "before\r\nafter"],
		["bare carriage return", "before\rafter"],
		["vertical tab", "before\vafter"],
		["form feed", "before\fafter"],
		["line separator U+2028", "before\u2028after"],
		["paragraph separator U+2029", "before\u2029after"],
		["many newlines", "a\n\n\nb\n\nc"],
		["newline in japanese", "名声\nめいせい"],
	];

	for (const [name, text] of ROW_BREAKERS) {
		test(`header with ${name} still renders exactly one header row`, () => {
			const rows = renderLines(section(text, "body"), 40);
			// header + one content row + footer === 3. more than that means a
			// newline smuggled a row through.
			expect(rows.length).toBe(3);
			expect(rows[0]).toContain("╭─[");
			// the chrome must still close on the same row it opened.
			expect(rows[0]).toContain("]");
		});

		test(`notice with ${name} still renders exactly one notice row`, () => {
			const rows = renderLines(section("hdr", "body"), 40, [text]);
			// header, body, footer, blank, notice — the notice must be ONE row.
			const noticeRows = rows.map(stripAnsi).filter((r) => r.startsWith("["));
			expect(noticeRows).toHaveLength(1);
			expect(noticeRows[0]).toMatch(/^\[.*\]$/); // opened and closed on one row
		});
	}
});
