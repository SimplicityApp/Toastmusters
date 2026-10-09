#!/bin/zsh
# reqs.sh [N] [--log] — last N Worker requests (UTC): time method path status [logs] [exceptions].
# --log also copies them into run.md as evidence. Static assets are filtered out.
source "$(dirname "$0")/_env.sh"; need_run
# Split the concatenated pretty-printed records ourselves: a single malformed record (a reconnect
# mid-write) used to stop jq there, silently hiding every later request.
out=$(python3 -c '
import json, sys
s = sys.stdin.read(); d = json.JSONDecoder(); i = 0
while True:
    j = s.find("{", i)
    if j < 0: break
    try:
        o, i = d.raw_decode(s, j); print(json.dumps(o))
    except ValueError:
        i = j + 1
' < "$RUN/tail.jsonl" | jq -rc 'select(.event.request?) | [(.eventTimestamp/1000|strftime("%H:%M:%S")), .event.request.method, (.event.request.url|sub("https://[^/]+";"")), ((.event.response.status // .outcome)|tostring), ([.logs[]?.message[]?|tostring]|join(" | ")), ([.exceptions[]?.message]|join(" | "))] | join("  ")' 2>/dev/null | grep -vE '/assets/|\.(png|jpg|svg|ico|js|css|webmanifest|woff2?)(\?|  )' | tail -${1:-15})
echo "$out"
[ "$2" = "--log" ] && { print -r -- "  - server log (UTC):"; echo "$out" | sed 's/^/    - `/; s/$/`/'; } >> "$RUN/run.md"
true
