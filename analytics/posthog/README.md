# PostHog timing analysis

Reusable queries for how clubs actually perform against Toastmasters timing rules.

| File | What it does |
|---|---|
| `speech_timing.sql` | One row per completed speech, bucketed against the role's red + grace thresholds. Save this in PostHog as a view named `speech_timing`. |
| `speech_timing_summary.sql` | Per-role rollup: how often speeches pass the red card, and how often they blow through grace. Reads the view. |

## Saving the view in PostHog

1. Open the [SQL editor](https://us.posthog.com/project/295629/sql).
2. Paste `speech_timing.sql`, run it, then **Save as view** and name it `speech_timing`.
3. `speech_timing_summary.sql` then runs directly against it.

Creating the view via the MCP connector needs the `warehouse_view:write` scope
(and `insight:write` / `dashboard:write` to save charts). The current personal
API key has none of those — add them and the view can be created and updated
without leaving the terminal.

## Reading the buckets

- `under_minimum` — never reached the green minimum. Mostly aborted timers and
  people testing the app, **not** short speeches. Always exclude.
- `within_limits` — finished green or yellow. On time.
- `in_grace` — past the red card but inside `graceAfterRed`. **Not** a
  disqualification; in a contest this speech still counts.
- `over_time` — past red + grace. Disqualifiable.
- `runaway` — over 3x the maximum. A timer left running after the speech ended.

`past_red` and `over_time` are different claims. Most speeches that see a red
card recover inside grace, so reporting "went over time" from `final_status='red'`
alone materially overstates the problem.

## What gets excluded, and why

The view filters three populations before any analysis:

| Exclusion | Rule | Why |
|---|---|---|
| Bots | `$virt_is_bot != true` | Crawlers and automation. A virtual property computed at query time — PostHog's taxonomy warning about it is a false alarm; it resolves correctly. |
| Non-production hosts | `$host` allowlist | `localhost:*`, `*-dev.*`, `*.vercel.app`, `*.workers.dev`, and the Table Topics domains are not the timer in real meetings. |
| Developer devices | person has **ever** hit a non-production host | Catches dev identities by behaviour, not geography. Excluding Quebec outright would wrongly drop real District 61 users. |

The host list is an **allowlist, not a denylist** — a new dev subdomain can't leak
in silently. The tradeoff: when a new *production* host goes live during the
domain migration, add it here or its traffic silently disappears from the view.

Measured impact of the filters (2026-09-08): Standard Speech `under_minimum`
dropped 183 → 115 and Short Roles 54 → 29, but real speeches went only 92 → 91.
The developer noise was almost entirely aborted timers, so the headline
percentages are unaffected.

## Caveats

- Thresholds are the **defaults** from `packages/shared/timingRules.js`. Clubs can
  edit their own in the app; those are classified against standard times anyway.
- `Custom` is dominated by app testing (a third of its rows are runaways). Exclude
  it from anything published.
- `person_id` counts devices, not people — one user on two browsers counts twice.
- The developer exclusion is all-or-nothing per person: a genuine user who once
  opened a `-dev` URL is dropped entirely. Rare, and safer than the alternative.
