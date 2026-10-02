# Planning a run: auto blocks vs human sittings

Goal: the user sits down as few times as possible, and each of your blocks runs unattended.

## Method
1. Tag every plan step **auto** or **human** (SKILL.md §1 lists human-only actions).
2. Draw dependencies: what must exist first (deploy → club → activation), what state an
   account must be in (guest before authorized; never-paid before checkout), what must happen
   between two checks (cancel between "active" and "lapsed").
3. Pull every human step as early as its dependencies allow; batch the rest into the fewest
   later sittings. Put your verification of a human action in the next auto block.
4. Name the blocks (A0 me → H0 you → A1 me → H1 you …) with rough durations and show them.
5. Collect one up-front approval list for outward-facing actions (deploys, gate flips, KV
   edits, CLI writes). Ask again only for anything not on it.

## Worked example — Club Pro plan (06), gate "1"
- **A0 (me, 3 min):** deploy, start tail, baseline background-file count.
- **H0 (you, 20 min):** permissions; re-authorize the dev app on A; sign in to the web
  session; start the meeting with camera; *checkout with a club name* (or, for an existing
  subscriber, nothing — A1 starts with "Set up my club").
- **A1 (me, ~90 min):** create/verify club, activation (lower-case code), rate limit,
  presets publish → second device, badge on video in all colours, archive + restart +
  two devices, end & share + OG tags, console roster, grace via KV (backup/restore),
  regression sweep.
- **H1 (you, 20 min):** offline speech (Wi-Fi), chat paste of the /r/ link, magic link,
  sign-in from each host, authorize the second account, cancel the subscription.
- **A2 (me, ~35 min):** verify H1 via logs; lapse (period end → past) and renewal; refusals
  (403/402) with the signed-in never-paid account; roles/revocation; demote/restore via KV.
- **H2 (you, 5 min):** empty-name checkout on the second account; reactivate the subscription.
- **A3 (me, 10 min):** verify, revert gate, redeploy, rotate codes, summary.

Coverage trade-offs to state up front: a device that becomes Pro at checkout can't show
"Upgrade"; the web app substitutes for a second Zoom participant except for Zoom guest mode.
