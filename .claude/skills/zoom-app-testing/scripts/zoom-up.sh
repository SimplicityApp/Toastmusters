#!/bin/zsh
# zoom-up.sh — get Zoom running with a meeting open, so a run never stops to ask "is Zoom open?".
# Launches zoom.us, starts the test meeting, waits for the "Zoom Meeting" window. Opening
# Toastmasters Timer from Apps is still a panel click (snap.sh + click.sh).
# Meeting: ZOOM_TEST_PMI / ZOOM_TEST_PWD from the environment or ../meeting.local (gitignored by
# *.local; the repo is public, never commit them). Joining your own PMI while signed in starts it
# as host. Without a PMI it presses Zoom's Start Meeting shortcut (⌃⌘V) in the Zoom window.
# Exit 0 = meeting open, 2 = needs the user (sign-in, Mac in use), 1 = anything else.
source "$(dirname "$0")/_env.sh"
LOCAL="$(dirname "$0")/../meeting.local"
[ -f "$LOCAL" ] && source "$LOCAL"

windows() { osascript -e 'tell application "System Events" to tell process "zoom.us" to get name of every window' 2>/dev/null; }
in_meeting() { [[ "$(windows)" == *"Zoom Meeting"* ]]; }
has_window() { [ -n "$(windows)" ]; }
front() { osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'; }
wait_for() { local n=$1; shift; for _ in {1..$n}; do "$@" && return 0; sleep 1; done; return 1; }

in_meeting && { echo "✅ Zoom meeting already open"; exit 0; }

if ! pgrep -x zoom.us >/dev/null; then
  open -a zoom.us || { echo "❌ could not launch zoom.us"; exit 1; }
  wait_for 40 has_window || { echo "❌ Zoom launched but showed no window in 40 s"; exit 1; }
  sleep 3
fi
w=$(windows)
if [[ "$w" == *"Sign In"* || "$w" == *"Sign in"* || "$w" == *"Login"* ]]; then
  echo "⏸ Zoom wants a sign-in — a human step. Windows: $w"; exit 2
fi

if [ -n "$ZOOM_TEST_PMI" ]; then
  open "zoommtg://zoom.us/join?action=join&confno=${ZOOM_TEST_PMI}${ZOOM_TEST_PWD:+&pwd=$ZOOM_TEST_PWD}"
else
  osascript -e 'tell application "zoom.us" to activate'; sleep 1
  f=$(front)
  [ "$f" = "zoom.us" ] || { echo "⏸ frontmost app is '$f', not Zoom — the user may be on the Mac. Not typing."; exit 2; }
  cliclick kd:cmd,ctrl t:v ku:cmd,ctrl
fi

if wait_for 40 in_meeting; then
  echo "✅ Zoom meeting open. Next: snap.sh, then Apps → Toastmasters Timer."
  exit 0
fi
echo "❌ no meeting window after 40 s. Windows: $(windows)"
echo "   Snap the screen: a sign-in or an audio/camera prompt may be waiting."
exit 1
