#!/bin/zsh
# snap.sh <name> [x y w h]   (points; omit the region for the whole main display)
# Saves shots/<HHMMSS>-<name>.png (full res) + .view.png (≤1600 px, what you Read)
# + .json sidecar so to-pt.sh can turn a spot on the view image back into click points.
source "$(dirname "$0")/_env.sh"; need_run
f="$RUN/shots/$(date +%H%M%S)-$1.png"
if [ -n "$5" ]; then x=$2 y=$3 w=$4 h=$5; screencapture -x -R$x,$y,$w,$h "$f"
else
  b=$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr -d ' ')
  x=0 y=0 w=${${b#*,*,}%%,*} h=${b##*,}; screencapture -x -m "$f"
fi
[ -s "$f" ] || { echo "screencapture failed — Screen Recording permission?" >&2; exit 1; }
v="${f%.png}.view.png"; sips -Z 1600 "$f" --out "$v" >/dev/null
vw=$(sips -g pixelWidth "$v" | awk '/pixelWidth/{print $2}')
printf '{"x":%s,"y":%s,"w":%s,"h":%s,"viewW":%s}\n' $x $y $w $h $vw > "${f%.png}.json"
print -r -- "  - screenshot: [shots/${f:t}](shots/${f:t})" >> "$RUN/run.md"
echo "$v"
