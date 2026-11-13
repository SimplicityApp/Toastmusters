---
name: factory-build
description: Factory station "build". After the human adds plan:approved, apply the plan review, then run oracle → implement → verify, each in a fresh subagent, ending at needs:zoom-test. Use for "/factory-build <n>" or when scripts/factory/state.mjs says next is build.
argument-hint: <issue number>
---

# Station: build

**In:** the factory PR for `<n>` labelled `plan:approved` by a factory actor.
**Out:** oracle tests, the implementation, green checks, label `needs:zoom-test`.

1. `node scripts/factory/state.mjs <n>`. Go on only if `next` is `build`. Check out its
   `branch` and pull.
2. **Apply the review.** Read the plan and every comment on the PR: inline comments
   (`scripts/factory/gh.sh api repos/{owner}/{repo}/pulls/<pr>/comments`) and PR comments.
   Answers from a factory actor replace the defaults under Open questions. If they change the
   approach, edit the plan and commit `plan(#<n>): apply review`. A comment saying a Zoom
   run failed means this is a second round: the fix goes in step 4b.
3. Remove `plan:review` from the PR.
4. **Run each sub-station in its own subagent** (fresh context: agents lose the thread on
   long runs). Give each only the issue number and the plan path; they read the rest.
   a. `factory-oracle` — skip when `.factory/oracles/<n>.json` exists.
   b. `factory-implement`
   c. `factory-verify`
   Read each one's PR comment before starting the next. If one added `factory:stuck`, stop.
5. Done when `factory-verify` has added `needs:zoom-test`.
