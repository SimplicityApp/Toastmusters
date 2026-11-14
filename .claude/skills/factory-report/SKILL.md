---
name: factory-report
description: Factory station "report". Write a factory PR's completion report into its body (why, what changes, security, production impact, testing, real-Zoom evidence, not verified, look here first), mark it ready for review and label it ready-for-review. Use for "/factory-report <n>"; normally run at the end of factory-zoom.
argument-hint: <issue number>
---

# Station: report

**In:** a factory PR whose Zoom run is done (or that no Zoom-client spec covers).
**Out:** the PR body as the report, PR out of draft, label `ready-for-review`.

1. **Gather:** the issue, the plan, `.factory/oracles/<n>.json`, `git diff --stat
   origin/dev...HEAD`, `scripts/factory/gh.sh pr checks <pr>`, every station comment on the
   PR, and the run's `test-runs/<run>/run.md` (steps ✅/❌/⏭, deployed version, request-log
   and localStorage evidence).
2. **Write the body** in the shape of `.github/pull_request_template.md`, the way PR #128
   reads: Why from the issue's problem and evidence; What changes behaviour first; Testing
   with real counts; Evidence from `run.md`, quoting non-pixel proof (request lines, KV,
   localStorage) since screenshots stay local in `test-runs/`; Not verified listing every ⏭
   and anything else not run; Look here first with 1–3 file:line links to the hunks most
   worth a human's read (riskHigh paths first).
3. **Publish:** `scripts/factory/gh.sh pr edit <pr> --body-file …`, `gh.sh pr ready <pr>`,
   add `ready-for-review`.
4. **Tell the human** in one or two lines: the PR link, then what failed or needs them first.
