#!/bin/zsh
# capture-timeline.sh [--start X,Y] --region x,y,w,h <secs:label> …
# Optionally clicks X,Y (e.g. START), then screenshots the region at each offset, logging each.
# Run with run_in_background for anything longer than a few seconds.
D="$(dirname "$0")"; start=""; region=""
while [[ "$1" == --* ]]; do case $1 in --start) start=$2; shift 2;; --region) region=$2; shift 2;; esac; done
[ -z "$region" ] && { echo "--region x,y,w,h required"; exit 1; }
r=(${(s:,:)region})
[ -n "$start" ] && { "$D/click.sh" "$start" || exit 3; }
t0=$(date +%s)
for pair in "$@"; do s=${pair%%:*}; n=${pair#*:}
  while [ $(( $(date +%s) - t0 )) -lt $s ]; do sleep 1; done
  "$D/snap.sh" "t${s}s-$n" $r >/dev/null
done
echo captured
