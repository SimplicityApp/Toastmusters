#!/bin/zsh
# w.sh <wrangler args…> — wrangler from the repo root on Node 22.
source "$(dirname "$0")/_env.sh"; cd "$ROOT" && npx wrangler "$@"
