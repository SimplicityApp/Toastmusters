---
name: factory-oracle
description: Factory sub-station "oracle". Write failing tests from an approved plan's acceptance criteria, before any implementation, and record them in .factory/oracles/<n>.json so the implementer can't change them. Use for "/factory-oracle <n>"; normally run by factory-build.
argument-hint: <issue number>
---

# Sub-station: oracle

**In:** an approved `.factory/plans/<n>-*.md` on `factory/<n>-*`.
**Out:** one commit with failing tests and `.factory/oracles/<n>.json`.

1. **Write a test for every AC** at the layer the plan's Test list names:
   - unit (vitest) beside the code, the style of the file's existing tests;
   - Playwright (`e2e/web.*` / `e2e/zoom.*`) for UI in a plain browser;
   - Zoom-client spec: edit the covering spec's steps, or add steps with the next free ID
     (never renumber), and set `status: stale`. `factory-zoom` runs these later.
2. **Test behaviour through public interfaces** (rendered output, exported functions, HTTP
   responses), so a correct implementation can't fail for an incidental reason.
3. **Prove they fail for the right reason.** Run each new unit and e2e test: it must fail on
   its assertion, not on an import error or typo. Existing tests must still pass. Run
   `npm run test:specs`.
4. **Record the oracle** last, after the tests are final: `.factory/oracles/<n>.json` =
   `{ "issue": <n>, "files": [every unit/e2e test file you created or changed] }`. Leave the
   spec `.md` files out: `factory-zoom` must update their `verified_at`. From here the
   PreToolUse guard refuses edits to these files.
5. **Commit** the tests, spec edits and json together: `test(#<n>): oracle for AC-1…AC-k`.
   Push.
6. **Comment** on the PR: `**oracle** —` each test and how it fails now.
