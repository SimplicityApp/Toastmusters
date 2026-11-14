---
name: factory-implement
description: Factory sub-station "implement". Make an approved plan's oracle tests pass with the smallest change that fits the surrounding code, without touching the oracle tests. Use for "/factory-implement <n>"; normally run by factory-build.
argument-hint: <issue number>
---

# Sub-station: implement

**In:** the plan and `.factory/oracles/<n>.json` on `factory/<n>-*`.
**Out:** implementation commits; oracle tests and `npm test` green.

1. Read the plan, the oracle json and the oracle tests. Read any PR comment reporting a
   failed Zoom run: that failure is part of the job.
2. **Implement the plan's approach.** Smallest change that meets the criteria. Match the
   surrounding code's naming, comment density and idioms. No drive-by refactors.
3. **Loop** until green: the oracle tests first, then `npm test`.
4. **Never edit an oracle file.** The guard refuses it and CI fails the PR. If an oracle test
   looks wrong (it contradicts the plan, or no correct code can pass it), stop: comment on
   the PR with the assertion and why, add `factory:stuck`, end.
5. **Keep the other layers current** (CLAUDE.md "Tests"): a behaviour change the oracle didn't
   foresee still updates its Zoom-client spec steps.
6. **Commit** in the repo's style, `fix(<area>): …` or `feat(<area>): …`, with a body that
   says why, the way recent commits do. Push.
7. **Comment** on the PR: `**implement** —` what changed and where, in one paragraph.
