// compare pi-tui visibleWidth vs actual tmux rendered width per test token
import { execSync } from "node:child_process";

const TUI_PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui";
const { visibleWidth } = await import(`${TUI_PKG}/dist/utils.js`);

const tokens = [
  ["ascii", "hello"],
  ["cjk", "日本語"],
  ["hindi word", "यह"],
  ["hindi matra", "हिंदी"],
  ["conjunct", "क्त्र"],
  ["conjunct2", "श्र"],
  ["hindi sentence", "जिसमें"],
  ["arabic", "هذا"],
  ["arabic word2", "بالكامل"],
  ["combining", "e\u0301a\u0300"],
  ["zalgo", "z\u0351\u036b\u0343a\u0344"],
  ["emoji", "🚀"],
  ["emoji vs16", "❤️"],
  ["warn vs16", "⚠️"],
  ["warn bare", "⚠"],
  ["frown bare", "☹"],
  ["zwj family", "👨‍👩‍👧‍👦"],
  ["flag", "🇺🇸"],
  ["fraction", "½"],
  ["arrow", "→"],
  ["bolt", "⚡"],
  ["thai", "ที่"],
  ["korean", "한글"],
  ["tamil", "தமிழ்"],
  ["bengali", "বাংলা"],
];

const SESSION = "width-test";
execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`, { shell: "/bin/bash" });
execSync(`tmux new-session -d -s ${SESSION} -x 100 -y 30 'sleep 300'`);

function tmuxWidth(s) {
  const b64 = Buffer.from(`\r\x1b[K${s}`).toString("base64");
  execSync(`tmux send-keys -t ${SESSION} -H 15`, { shell: "/bin/bash" }); // no-op ctrl-o? skip
  // print without shell interpretation: use display-message? simpler: printf via run-shell into the pane tty
  return 0;
}

// better: write directly to the pane tty
const tty = execSync(`tmux display -p -t ${SESSION} '#{pane_tty}'`).toString().trim();
import fs from "node:fs";

console.log("token".padEnd(16), "pi-tui", "tmux");
for (const [name, s] of tokens) {
  fs.writeFileSync(tty, `\r\x1b[K${s}`);
  execSync("sleep 0.05");
  const x = parseInt(execSync(`tmux display -p -t ${SESSION} '#{cursor_x}'`).toString().trim(), 10);
  const w1 = visibleWidth(s);
  const mark = w1 === x ? "" : "   <-- MISMATCH";
  console.log(name.padEnd(16), String(w1).padEnd(6), String(x) + mark);
}
execSync(`tmux kill-session -t ${SESSION}`);
