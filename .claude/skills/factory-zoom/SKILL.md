---
name: factory-zoom
description: Factory station "zoom" (this Mac only). Take the dev lock, deploy a factory PR's branch to dev, run the Zoom-client specs its diff touches in the real Zoom client with the zoom-app-testing skill, record the evidence, restore dev, then run factory-report. Use for "/factory-zoom <n>", the night-shift scheduled run, or when scripts/factory/state.mjs says next is zoom.
argument-hint: <issue number> | next
---

# Station: zoom

**In:** a factory PR labelled `needs:zoom-test`. **Out:** a real-Zoom `run.md`, specs
re-verified, then `factory-report`. Needs this Mac: `cliclick`, the Zoom client, the camera.

1. **Pick.** `next` → the oldest open factory PR labelled `needs:zoom-test`
   (`node scripts/factory/state.mjs --queue`, `inFlight`). Then
   `node scripts/factory/state.mjs <n>`: go on only if `next` is `zoom`.
2. **Lock.** One Mac, one Zoom client, one dev host. If any open PR has `zoom:testing`, end
   (busy). Otherwise add `zoom:testing` to this PR.
3. **Which specs.** Check out the branch, pull, `node scripts/factory/stop-gate.mjs --hits`.
   None → note "no Zoom-client spec covers this change" and skip to step 7.
4. **Deploy.** Apply each spec's `needs` (flag values) to `env.dev.vars` in `wrangler.jsonc`
   without committing, then `npm run cf:deploy:dev`. Note the version id it prints.
5. **Run** the specs with the `zoom-app-testing` skill, run name `<date>-<n>-<slug>`: its
   preflight, `zoom-up.sh`, the take-the-Mac notice, the per-step loop, `run.md`. A `human`
   step is ⏭ with its reason, listed under "Needs you" in `run.md`. If `click.sh` refuses,
   the user is on the Mac: remove `zoom:testing`, comment that the run is waiting, end.
6. **Restore and record.** `git checkout wrangler.jsonc`; if a flag was flipped, run
   `npm run cf:deploy:dev` again so dev is back to the branch's committed values. Set each
   spec's `verified_at` (sha tested), `verified_on`, `status: current` (or `stale` on a
   failure), update `INDEX.md`, `npm run test:specs`, commit
   `test(zoom-client): verify <specs> on <sha> (#<n>)`, push.
7. **Unlock and route.** Remove `zoom:testing` and `needs:zoom-test`.
   - All ✅/⏭ → run `factory-report`.
   - Any ❌ → comment `**zoom** —` with the failing step IDs, what was seen, and the evidence,
     then add `plan:approved` to send it back to build. If this is the second Zoom failure on
     this PR, add `factory:stuck` instead.
