#!/bin/zsh
# tail.sh [worker] — append `wrangler tail --format json` to the run's tail.jsonl.
# Run with run_in_background. Reconnects if the stream drops (sleep, network blip).
source "$(dirname "$0")/_env.sh"; need_run
W="${1:-toastmaster-timer-dev}"
while true; do
  (cd "$ROOT" && npx wrangler tail "$W" --format json) >> "$RUN/tail.jsonl" 2>&1
  echo "{\"_note\":\"tail reconnect $(date -u +%FT%TZ)\"}" >> "$RUN/tail.jsonl"; sleep 5
done
