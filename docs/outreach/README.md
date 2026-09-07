# Club Outreach List — Toastmaster Timer

Built 2026-08-31 from PostHog usage data + Toastmasters directory research.
Master data: [clubs-outreach.csv](clubs-outreach.csv) (~118 clubs).

## Weekly focus lists

| Week | File | Clubs | Selection rule |
|---|---|---|---|
| 2026-09-03 | [clubs-outreach-week-2026-09-03.csv](clubs-outreach-week-2026-09-03.csv) | 26 | All P0 (confirmed users) + P1 in the three anonymous-usage clusters + Montreal P1 + EU P1 with a published email. Adds `why_this_week`, `pitch_angle`, `contact_channel`, and `status`/`sent_date`/`reply_notes` tracking columns. |

## Segments

| Segment | Count | Angle |
|---|---|---|
| 1. Existing users (survey-confirmed) | 4 | Follow-up: how's the app experience? Ask for review/referral. |
| 2. Likely users (anonymous usage clusters) | 32 | "Someone in your club/area is already using us" — Mauritius (D114, ~15 users), Kansas City metro (D209), Honolulu (D49). |
| 3. Montreal / District 61 (home turf) | 41 | Local founder story; offer to visit in person. Incl. Ottawa/Gatineau bonus. |
| 4. EU (budget, unexplored) | 42 | Online/hybrid clubs first; D59/D95/D107/D109/D231. |
| 5. John's list | pending | To be provided. |

## Guest-visit plan (pivot 2026-09-07)

Email reply rate was low, so the plan is to show up as a guest instead.
[guest-visits-week-2026-09-07.csv](guest-visits-week-2026-09-07.csv) has, for each of the 26 focus
clubs, the schedule verified on the club's own site / toastmasters.org, the Montreal-time slot,
the next meeting date, and the Zoom link if published (else how to request it). Sorted: joinable
this week with a public link, then this week but link-on-request, then in-person-only, then off-week.

## Key facts learned

- **Directory format labels are unreliable — don't filter on them.** 3 of our 4
  survey-confirmed users (Malabar, Jacaranda, Sapphire City) are listed as in-person clubs.
  Either the listings are stale or in-person clubs use the web timer on a laptop/projected
  screen instead of paper cards. Format is a soft prioritization signal only; in-person
  clubs get the "replace your paper timing cards" pitch.
- Most clubs publish NO email — the reliable channel is the Toastmasters contact form:
  `toastmasters.org/Find-a-Club/{club-number}/contact-club` (exists for every club).
- The Find-a-Club API returns club contact emails not shown on pages:
  `toastmasters.org/api/sitecore/FindAClub/Search?q=...&latitude=..&longitude=..&radius=..`
  (raw JSON for Mauritius/Leawood/Honolulu saved during research).
- District corrections: Mauritius = **D114**; Kansas City = **D209** (old D22 renumbered);
  Central/Eastern EU = **D231** (new, July 2026 realignment, not yet on toastmasters.org maps).
- easy-speak's `tmclub.eu/meetonline.php` lists ~120 online/hybrid continental-EU clubs — the
  best EU prospecting source.
- toastmastersd108.org is domain-hijacked — never link it.

## Outreach hooks worth using

- **Moderator Club (Montreal)**: their site says online participation is broken ("technical
  issues with Microsoft Teams") — perfect pitch.
- **Manila user** reported the pause-reset bug we just fixed; **Denpasar user** requested the
  mirrored-logo card fix (now in the working tree). Both anonymous — consider an in-app
  changelog/"we fixed it" banner instead of email.
- MS Teams clubs (Quartier International MTL, West Coastmasters SE): pitch that the web timer
  works in any browser, not just Zoom.
- Advanced clubs (Beyond Words, Club avancé international, Advanced Speakers 59, Vliegende
  Hollanders) — members are officers in many other clubs; one adoption seeds many.

## Caveats

- Only publicly published emails were collected; several are personal addresses of officers —
  use judgment and reference where the address was published.
- EU meeting times captured as CE(S)T from easy-speak; verify DST offset before scheduling.
- Rows flagged "unverified" in the CSV notes should be confirmed in the first email.
