#!/bin/zsh
# zoom-down.sh — the last step of a run: end the test meeting and quit Zoom.
# A closed Zoom is the user's signal that the run is over and the Mac is theirs again; a Zoom
# left open makes them wait or guess. Run it after the summary is written and the helpers are
# stopped, then say in chat that Zoom is closed.
# Not for a run that paused because the user took the Mac: leave Zoom as it is then.
# Exit 0 = Zoom is not running, 1 = it would not quit.
HERE="${0:A:h}"   # captured here: inside a function, zsh's $0 is the function's name
source "$HERE/_env.sh"
note() { [ -n "$RUN" ] && [ -d "$RUN" ] && "$HERE/log.sh" "$1"; echo "$1"; }
running() { pgrep -x zoom.us >/dev/null; }
gone_within() { for _ in {1..$1}; do running || return 0; sleep 1; done; ! running; }

running || { note "ℹ️ Teardown — Zoom was not running."; exit 0; }

# Zoom 7.2.5 ignored the Apple Event quit (2026-11-14) and SIGTERM closed it cleanly, ending
# the meeting. The meeting is the test PMI with nobody else in it, so nothing is lost.
osascript -e 'tell application "zoom.us" to quit' >/dev/null 2>&1
gone_within 5 && { note "ℹ️ Teardown — Zoom quit."; exit 0; }
pkill -TERM -x zoom.us
gone_within 10 && { note "ℹ️ Teardown — Zoom quit (SIGTERM; meeting ended)."; exit 0; }
pkill -KILL -x zoom.us
gone_within 5 && { note "ℹ️ Teardown — Zoom quit (SIGKILL; meeting ended)."; exit 0; }
note "❌ Teardown — Zoom is still running; quit it by hand."
exit 1
