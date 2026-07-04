// measure ACTUAL cursor advance for test tokens in the current terminal via DSR
import fs from "node:fs";

const OUT = process.env.OUT || "/tmp/pi-render-repro/dsr-widths.txt";
const TUI_PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui";
const { visibleWidth } = await import(`${TUI_PKG}/dist/utils.js`);

const tokens = [
  ["ascii", "hello"],
  ["hindi word", "यह"],
  ["hindi matra i", "हि"],
  ["hindi matra ii", "दी"],
  ["hindi full", "हिंदी"],
  ["conjunct ktra", "क्त्र"],
  ["conjunct shra", "श्र"],
  ["candrabindu", "जाँ"],
  ["matra aa", "जा"],
  ["standalone aa", "\u093e"],
  ["standalone i", "\u093f"],
  ["pra", "प्र"],
  ["cjk", "日本語"],
  ["rocket", "🚀"],
  ["zwj family", "👨‍👩‍👧‍👦"],
  ["heart vs16", "❤️"],
  ["hand", "🖐"],
  ["warn bare", "⚠"],
  ["frown bare", "☹"],
  ["flag", "🇺🇸"],
  ["thai", "ที่"],
  ["thai am", "น้ำ"],
  ["korean", "한글"],
  ["tamil", "தமிழ்"],
  ["bengali", "বাংলা"],
  ["arabic", "هذا"],
  ["combining e", "e\u0301"],
  ["skin tone x", "x🏻"],
  ["check", "✓"],
  ["cross", "✕"],
];

process.stdin.setRawMode(true);
process.stdin.resume();

let buf = "";
let resolver = null;
process.stdin.on("data", (d) => {
  buf += d.toString("latin1");
  const m = /\x1b\[(\d+);(\d+)R/.exec(buf);
  if (m && resolver) {
    buf = "";
    const r = resolver;
    resolver = null;
    r({ row: +m[1], col: +m[2] });
  }
});
function cursor() {
  return new Promise((res) => {
    resolver = res;
    process.stdout.write("\x1b[6n");
    setTimeout(() => { if (resolver) { resolver = null; res(null); } }, 1000);
  });
}

const lines = [];
for (const [name, s] of tokens) {
  process.stdout.write("\r\x1b[K");
  const before = await cursor();
  process.stdout.write(s);
  const after = await cursor();
  if (!before || !after) { lines.push(`${name}: DSR fail`); continue; }
  const actual = after.col - before.col + (after.row - before.row) * 999; // wrap would show huge
  const w = visibleWidth(s);
  lines.push(`${name.padEnd(16)} pi-tui=${w} actual=${actual}${w !== actual ? "   <-- MISMATCH" : ""}`);
}
process.stdout.write("\r\x1b[K");
fs.writeFileSync(OUT, lines.join("\n") + "\n");
process.exit(0);
