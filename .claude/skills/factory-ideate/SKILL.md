---
name: factory-ideate
description: Factory ideation. Read product signals (PostHog usage, errors, surveys and feedback; recent GitHub issues and comments) and draft 3–5 evidence-backed, factory-ready issues labelled idea for the human to promote. Use for "/factory-ideate", "what should we build or fix next", "find bugs in the data", or the weekly ideation routine.
---

# Ideation

Turns signals into `idea` issues. It never promotes: the human picks what enters the factory
by adding `factory:ready`.

1. **Signals**, last 14 days against the 14 before. Skip a source that isn't connected and
   say so in the summary.
   - **PostHog** (`posthog` MCP, US project 295629): trends for `timer_started` and the
     Table Topics `tt_*` events; error tracking, top issues by users affected; `survey sent`
     responses for the feedback and club surveys (`docs/POSTHOG_SURVEYS.md`); speech timing
     via the `speech_timing` view (`analytics/posthog/README.md`) when it exists. Look for
     drops, spikes, errors many users hit, and repeated feedback themes.
   - **GitHub**: issues and comments opened in the window
     (`scripts/factory/gh.sh issue list --search "created:>=<date>"`), and open issues with
     the most comments or reactions.
2. **Dedupe** against open issues; add new evidence to an existing issue as a comment.
3. **Choose 3–5**: strongest evidence relative to the size of the change. A bug many users
   hit beats a feature one user asked for. Say why each was chosen in one line.
4. **Draft each** with the `factory-issue` skill (its template and labels). The Evidence
   section carries the numbers, the date range and the query or link that produced them.
5. **Summary**: a table of the drafted issues (link, one-line why, evidence) and the signals
   that were checked but produced nothing.

The repo is public: aggregate numbers only. No person, email, club name or Zoom account id
from PostHog goes into an issue.
