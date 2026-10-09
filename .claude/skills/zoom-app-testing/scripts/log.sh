#!/bin/zsh
# log.sh "<markdown text>" — timestamped line appended to run.md right now.
source "$(dirname "$0")/_env.sh"; need_run
print -r -- "- \`$(date '+%H:%M:%S')\` $*" >> "$RUN/run.md"
