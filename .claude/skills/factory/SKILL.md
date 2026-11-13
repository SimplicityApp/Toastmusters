---
name: factory
description: Run the Toastmusters factory on a GitHub issue — move it through plan, build (oracle tests, implementation, verification), the real-Zoom test and the report, stopping only at a human gate (promote, plan approval, merge). Use for "/factory 90", "/factory next", "run the factory on #N", "work on issue N end to end", or "pick up the next issue".
argument-hint: <issue number> | next
---

# Factory orchestrator

Read `.factory/README.md` first: labels, conventions, artifacts, trust. This skill only
routes; each station's skill does the work.

## Loop

1. **Which issue.** `next` → `node scripts/factory/state.mjs --queue` and take `pick`. If it
   is null, say why (WIP limit reached, or nothing labelled `factory:ready`) and end.
2. **Where it is.** `node scripts/factory/state.mjs <n>`.
3. **`next` is set** → run that station's skill with the issue number, then go back to 2:

   | `next` | Skill |
   |---|---|
   | `plan` | `factory-plan` |
   | `build` | `factory-build` |
   | `zoom` | `factory-zoom` (it runs `factory-report` at the end) |

4. **`gate` is set** → end the turn with one line for the human:
   - `promote`: if the user named this issue in chat, that is the promotion. Add
     `factory:ready` (`scripts/factory/gh.sh issue edit <n> --add-label factory:ready`) and
     go back to 2. Otherwise say it isn't promoted.
   - `plan`: link the PR and list the plan's open questions with their defaults.
   - `merge`: link the PR, its "Not verified" list and its "Look here first" hunks.
   - `stuck`: link the last station comment that explains the failure.
5. **`busy`** → say which station holds it and end.

Continue across stations without asking: CLAUDE.md "Standing approvals" covers every step
between gates. The gates are the only planned stops. Don't re-run a station that already
failed in this session; a second failure means `factory:stuck`.

When `next` is `zoom` but this machine can't drive Zoom (no `cliclick`, or `CI` is set),
leave `needs:zoom-test` in place and end: the Mac's scheduled run picks it up.
