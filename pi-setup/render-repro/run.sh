#!/bin/bash
# run harness in a fresh tmux session, wait for completion, capture ground truth
set -e
PHASE="${1:-A}"
W="${2:-145}"
H="${3:-40}"
SESSION="pi-repro-$PHASE"

rm -f /tmp/pi-render-repro/done /tmp/pi-render-repro/model.txt
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$W" -y "$H" "PHASE=$PHASE node /tmp/pi-render-repro/harness.mjs 2>/tmp/pi-render-repro/stderr-$PHASE.log"

# wait for done marker (max 60s)
for i in $(seq 1 120); do
  [ -f /tmp/pi-render-repro/done ] && break
  sleep 0.5
done

if [ ! -f /tmp/pi-render-repro/done ]; then
  echo "TIMEOUT — harness did not finish"
  tmux capture-pane -t "$SESSION" -p > /tmp/pi-render-repro/capture-$PHASE.txt || true
  cat /tmp/pi-render-repro/stderr-$PHASE.log
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  exit 1
fi

sleep 0.5
# capture visible pane (what the terminal actually shows)
tmux capture-pane -t "$SESSION" -p > /tmp/pi-render-repro/capture-$PHASE.txt
# capture with full history too
tmux capture-pane -t "$SESSION" -p -S - > /tmp/pi-render-repro/capture-full-$PHASE.txt
cp /tmp/pi-render-repro/model.txt /tmp/pi-render-repro/model-$PHASE.json
tmux kill-session -t "$SESSION"
echo "done: capture-$PHASE.txt + model-$PHASE.json"
