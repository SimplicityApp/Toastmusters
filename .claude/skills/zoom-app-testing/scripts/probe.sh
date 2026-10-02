#!/bin/zsh
# probe.sh [host] — send a marker request and confirm tail.sh recorded it (the capture can lag ~10 s after (re)connect).
source "$(dirname "$0")/_env.sh"; need_run
H="${1:-https://www.timer-dev.simple-tech.app}"; m="probe=$(date +%s)"
curl -s -o /dev/null "$H/api/me?$m"
for i in {1..10}; do grep -q "$m" "$RUN/tail.jsonl" && { echo "✅ tail is live"; exit 0; }; sleep 2; done
echo "❌ tail did not record the probe — check tail.sh output"; exit 1
