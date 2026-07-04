#!/bin/bash
# run harness2 (DSR-verified) in tmux
set -e
PHASE="${1:-A}"
W="${2:-145}"
H="${3:-40}"
SESSION="dsr-$PHASE"
OUT="/tmp/pi-render-repro/dsr-tmux-$PHASE.txt"
rm -f "$OUT"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$W" -y "$H" "clear; PHASE=$PHASE OUT=$OUT node /tmp/pi-render-repro/harness2.mjs 2>/tmp/pi-render-repro/dsr-stderr-$PHASE.log; sleep 1"
for i in $(seq 1 120); do
  [ -f "$OUT" ] && break
  sleep 0.5
done
tmux kill-session -t "$SESSION" 2>/dev/null || true
if [ -f "$OUT" ]; then head -20 "$OUT"; else echo "TIMEOUT"; cat /tmp/pi-render-repro/dsr-stderr-$PHASE.log | head; fi
