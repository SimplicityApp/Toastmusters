# Sourced by every helper. Resolves the repo, the active run folder and Node 22.
ROOT="$(git -C "$(dirname "${(%):-%x}")" rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${(%):-%x}")/../../../.." && pwd)"
RUN="$(cat "$ROOT/test-runs/.current" 2>/dev/null)"
BIN="$ROOT/test-runs/.bin"
# Wrangler refuses Node < 22; a fresh shell after sleep/restart may default to 20.
for n in "$HOME"/.nvm/versions/node/v2[2-9]*/bin /opt/homebrew/opt/node@2[2-9]/bin; do
  [ -x "$n/node" ] && { export PATH="$n:$PATH"; break; }
done
need_run() { [ -n "$RUN" ] && [ -d "$RUN" ] || { echo "No active run — start one with new-run.sh <name>" >&2; exit 1; }; }
