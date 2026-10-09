#!/bin/zsh
# new-run.sh <name> ["<one-line context>"]
# Creates test-runs/<date>-<name>/ (git-excluded), makes it the active run, writes the run.md header.
source "$(dirname "$0")/_env.sh"
[ -z "$1" ] && { echo "usage: new-run.sh <name> [context]"; exit 1; }
R="$ROOT/test-runs/$(date +%Y-%m-%d)-$1"
mkdir -p "$R/shots" "$BIN"
grep -qx "test-runs/" "$ROOT/.git/info/exclude" 2>/dev/null || echo "test-runs/" >> "$ROOT/.git/info/exclude"
echo "$R" > "$ROOT/test-runs/.current"
if [ ! -f "$R/run.md" ]; then
cat > "$R/run.md" <<HDR
# Test run — $1 ($(date '+%Y-%m-%d %H:%M %Z'))

${2:-}

Every entry is appended the moment it happens, so a run that dies mid-step still leaves its trail.
Screenshots: \`shots/\` (full resolution; \`.view.png\` = downscaled copy you can open quickly). Server log: \`tail.jsonl\` (raw \`wrangler tail --format json\`).

Legend: ✅ pass · ❌ fail · ⚠️ pass with finding · ⏭ skipped · ▶️ action · ℹ️ note

## Log
HDR
fi
echo "$R"
