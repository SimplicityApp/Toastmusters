#!/bin/zsh
# zoom-front.sh — bring the Zoom meeting window to the front and print its bounds (points).
# Other apps (Claude, Chrome) cover Zoom after every hand-off; run this before each Zoom action batch.
osascript -e 'tell application "zoom.us" to activate' -e 'delay 0.4' \
  -e 'tell application "System Events" to tell process "zoom.us"' \
  -e 'if exists window "Zoom Meeting" then perform action "AXRaise" of window "Zoom Meeting"' \
  -e 'set out to ""' -e 'repeat with w in windows' \
  -e 'set out to out & (name of w) & " @ " & (item 1 of (position of w as list)) & "," & (item 2 of (position of w as list)) & " " & (item 1 of (size of w as list)) & "x" & (item 2 of (size of w as list)) & linefeed' \
  -e 'end repeat' -e 'return out' -e 'end tell'
