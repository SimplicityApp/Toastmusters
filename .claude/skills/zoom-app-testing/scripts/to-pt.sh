#!/bin/zsh
# to-pt.sh <shot.view.png> <vx> <vy>  -> "X,Y" screen points for cliclick.
# Coordinates you read off a .view.png are NOT screen points (Retina + downscale + region offset).
j="${1%.view.png}.json"; [ -f "$j" ] || { echo "no sidecar $j" >&2; exit 1; }
jq -r --argjson vx "$2" --argjson vy "$3" '((.w/.viewW) as $k | "\((.x + $vx*$k)|round),\((.y + $vy*$k)|round)")' "$j"
