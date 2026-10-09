#!/bin/zsh
# preflight.sh [--kv <namespace-id>] — check every precondition an unattended Zoom run needs.
# Prints ✅/❌ per item with the fix. Exit 1 if any blocker fails.
source "$(dirname "$0")/_env.sh"
KV=""; [ "$1" = "--kv" ] && KV=$2
fail=0; ok(){ echo "✅ $1"; }; bad(){ echo "❌ $1"; echo "   fix: $2"; fail=1; }; warn(){ echo "⚠️  $1"; [ -n "$2" ] && echo "   note: $2"; }
T=$(mktemp -t zt).png
screencapture -x "$T" 2>/dev/null && [ -s "$T" ] && ok "Screen Recording (screencapture works)" \
  || bad "screencapture fails ('could not create image from display')" "System Settings → Privacy & Security → Screen & System Audio Recording → enable Claude, then quit & reopen Claude"
rm -f "$T"
if ! command -v cliclick >/dev/null; then bad "cliclick missing" "brew install cliclick"
elif cliclick p 2>&1 | grep -q "Accessibility privileges not enabled"; then
  real=$(readlink -f "$(command -v cliclick)"); cc=$(ps -o comm= -p $PPID 2>/dev/null)
  bad "Accessibility not granted to the process that sends clicks" "System Settings → Privacy & Security → Accessibility → + → ⌘⇧G and add $real (the file picker cannot select the Homebrew symlink) AND the Claude Code binary ($(ps -o comm= -p $(ps -o ppid= -p $PPID) 2>/dev/null | head -1)); then quit & reopen Claude"
else ok "cliclick + Accessibility"; fi
v=$(node -v 2>/dev/null); [[ "$v" == v2[2-9]* ]] && ok "Node $v (wrangler needs ≥22)" || bad "Node $v on PATH" "install Node 22 via nvm; _env.sh picks it up automatically"
if (cd "$ROOT" && npx wrangler whoami 2>&1) | grep -qE "logged in|Account ID"; then ok "wrangler authenticated"; else bad "wrangler not authenticated" "set CLOUDFLARE_API_TOKEN in .env or run npx wrangler login"; fi
if [ -n "$KV" ]; then
  (cd "$ROOT" && npx wrangler kv key list --namespace-id "$KV" --remote --prefix zzz 2>&1) | grep -q "Authentication error" \
    && bad "token cannot read KV $KV" "dash.cloudflare.com/profile/api-tokens → edit token → add Account · Workers KV Storage · Edit" || ok "KV readable ($KV)"
fi
if pgrep -x zoom.us >/dev/null; then
  wins=$(osascript -e 'tell application "System Events" to tell process "zoom.us" to get name of every window' 2>/dev/null)
  [[ "$wins" == *"Zoom Meeting"* ]] && ok "Zoom meeting window open" || bad "Zoom running but no meeting window ($wins)" "start or join a meeting and open the app in the Apps panel"
else bad "Zoom not running" "open Zoom, start a meeting, open the app"; fi
[ "$(defaults read ZoomChat webview.context.menu 2>/dev/null)" = "1" ] && ok "Zoom webview inspector enabled" \
  || warn "Zoom webview inspector off" "optional: defaults write ZoomChat webview.context.menu true, restart Zoom (right-click → Inspect gives DOM/localStorage)"
disp=$(system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution|Main Display" | tr -s ' ' | paste -sd ' ' -)
ok "Displays: $disp"; echo "   (snap.sh records its own point→pixel mapping; re-snap after any display change)"
pmset -g assertions 2>/dev/null | grep -q "PreventUserIdleDisplaySleep.*1" && ok "display kept awake" \
  || warn "nothing keeps the Mac awake" "request keep-awake (ccd_host request_keep_awake, until session_idle) and run 'caffeinate -d -t 14400' in the background"
[ -n "$RUN" ] && ok "active run: ${RUN#$ROOT/}" || warn "no active run yet" "new-run.sh <name>"
exit $fail
