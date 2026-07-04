// compare pi-tui's internal model (last H lines) vs tmux capture (visible pane)
import fs from "node:fs";

const PHASE = process.argv[2] || "A";
const model = JSON.parse(fs.readFileSync(`/tmp/pi-render-repro/model-${PHASE}.json`, "utf8"));
const capture = fs.readFileSync(`/tmp/pi-render-repro/capture-${PHASE}.txt`, "utf8").split("\n");

const stripAnsi = (s) =>
  s.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
   .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
   .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const H = model.height;
const expected = model.lines.slice(-H).map((l) => stripAnsi(l).replace(/\s+$/, ""));
// tmux capture-pane trims trailing blank lines; pad
const actual = capture.map((l) => l.replace(/\s+$/, ""));
while (actual.length < expected.length) actual.push("");

console.log(`phase=${PHASE} width=${model.width} height=${H} modelLines=${model.lines.length} fullRedraws=${model.fullRedraws}`);
let mismatches = 0;
for (let i = 0; i < expected.length; i++) {
  const e = expected[i] ?? "";
  const a = actual[i] ?? "";
  if (e !== a) {
    mismatches++;
    if (mismatches <= 12) {
      console.log(`MISMATCH row ${i}:`);
      console.log(`  model : ${JSON.stringify(e.slice(0, 120))}`);
      console.log(`  screen: ${JSON.stringify(a.slice(0, 120))}`);
    }
  }
}
console.log(mismatches === 0 ? "MATCH — no desync" : `${mismatches} mismatched rows`);
