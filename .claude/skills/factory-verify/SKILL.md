---
name: factory-verify
description: Factory sub-station "verify". Run every automated check, review the diff in a fresh context against the plan and a test-gaming rubric, fix what fails (bounded retries), flag risk, wait for CI, and hand the PR to the Zoom station with needs:zoom-test. Use for "/factory-verify <n>"; normally run by factory-build.
argument-hint: <issue number>
---

# Sub-station: verify

**In:** an implemented `factory/<n>-*` branch.
**Out:** label `needs:zoom-test`, or `factory:stuck` after `maxFixAttempts` rounds
(`.factory/config.json`).

1. **Checks:** `npm test`, `npm run test:e2e`, `npm run test:specs`,
   `node scripts/factory/check-oracle.mjs`, `npm run build`. Fix failures in the code, never
   in an oracle test. Each fix round is a commit `fix(#<n>): …` and counts as one attempt.
2. **Review** in a fresh subagent given only the plan, `git diff origin/dev...HEAD` and this
   rubric. It reports findings; you fix them (each round counts as an attempt):
   - every AC has a test that fails without the change;
   - no test gaming: `.skip`/`.only`/`todo`, weakened or deleted assertions, updated
     snapshots, `expect(true)`, mocking the unit under test, test-only branches in app code;
   - nothing outside the plan's scope; no debug leftovers, secrets or `.env` reads;
   - CLAUDE.md rules: covering Zoom-client specs updated, step IDs never renumbered.
3. **Risk.** If the diff touches a `config.json` `riskHigh` path, add `risk:high`.
4. **CI.** Push, then `scripts/factory/gh.sh pr checks <pr> --watch` (give up after
   ~25 min and treat it as a failure).
5. **Hand off.** Add `needs:zoom-test`, remove `plan:approved`. Comment `**verify** —` with
   the check results, the review findings and how each was fixed.

Out of attempts: comment with what still fails and the last error output, add
`factory:stuck`, end.
