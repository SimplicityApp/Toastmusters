---
name: zoom-app-testing
description: Drive the real Zoom desktop client (plus the web app and Worker logs) to run Toastmusters Timer manual test plans end to end, with screenshots and a timestamped run log as proof. Use this whenever the user wants to test, verify, QA, smoke-test or "click through" the Zoom app or a feature on dev/staging inside Zoom — e.g. "test the dev branch in my Zoom client", "run the club pro test plan", "check the badge on real video", "verify FINISH uploads", "automate the manual testing" — even if they don't say "skill" or name cliclick. Also use it to plan which steps of a test plan can run unattended versus which need the user.
---

# Zoom app testing (Toastmusters Timer)

You are standing in for a human tester: moving the real mouse in the Zoom client, reading
screenshots, and proving each result from the server and the device. The user will review
your work later — often after you've run unattended — so **the run log is the deliverable**,
not your chat messages.

Everything here was learned the hard way in a real run (see `references/gotchas.md`). Read
that file before your first click in a session; it saves roughly an hour of recovery.

Scripts live in `.claude/skills/zoom-app-testing/scripts/` (call them by full path; call that
directory `$S` below). Project facts — hosts, Worker name, KV ids, CLI, test plans — are in
`references/toastmusters.md`.

## 1. Plan before touching anything

Take the test plan the user points at (e.g. the `06-…-test-plan` / `docs/ZOOM_TEST_PLAN.md`)
and split every step into:

- **auto** — you can act *and* verify it (Zoom clicks, web app, API, KV, logs).
- **human** — only the user may do it (list below).

Then **reorder** so the human steps collapse into as few sittings as possible — typically
one before (sign-ins, consent, checkout), one in the middle (things that must happen after
your first block, e.g. a Stripe cancel), one at the end. Respect data dependencies (a club
must exist before activation; a "never paid" account must be tested before it checks out).
Show the user this order and get a yes before starting. `references/planning.md` has the
worked Club Pro example.

**Human-only, always:** Zoom sign-in and OAuth consent ("Allow" on an app authorization),
typing passwords, entering card numbers on a deployed (non-localhost) host, sending messages
(Zoom chat, WhatsApp, Slack, email), Stripe dashboard/portal cancel or renew, toggling Wi-Fi
(it would cut your own connection), changing System Settings. Outward-facing actions the user
can pre-approve once as a list: deploys, flipping `ENTITLEMENT_ENFORCE`, KV edits, `club-cli`
writes.

## 2. Preflight and start the run

```bash
$S/preflight.sh --kv <dev PROFILES namespace id>   # fix every ❌ before continuing
$S/new-run.sh <short-name> "<plan, branch, deployed version, gate value>"
```

Then start, each with `run_in_background: true`:
- `$S/tail.sh` — Worker log into the run folder (auto-reconnects).
- `caffeinate -d -t 14400` — keeps the display on; also request keep-awake
  (`request_keep_awake`, `until: "session_idle"`) if the tool exists. A sleeping Mac killed
  the first run for two hours.

Confirm the capture is live with `$S/probe.sh` before any step whose proof is a request.
Write run artifacts only under `test-runs/` — never the scratchpad, which is wiped when the
session restarts.

## 3. The per-step loop

For every step:

1. `$S/zoom-front.sh` if another app may be covering Zoom.
2. `$S/snap.sh <step>-<what> [x y w h]` → Read the returned `.view.png`.
3. Get click points with `$S/to-pt.sh <view.png> <vx> <vy>` — never eyeball-scale; view
   pixels are not screen points (Retina × downscale × region offset).
4. Act: `$S/click.sh X,Y` (add `--activate` in the Zoom panel when a first click only
   highlights), `cliclick t:"text"`, `cliclick kp:return`, `$S/scroll.sh X,Y -10`.
   `click.sh` refuses (exit 3) unless Zoom is the frontmost app. A refusal — or a screenshot
   showing some other app over Zoom — means **the user is using the Mac**: stop, say what you
   were about to do, and wait for them to hand it back. Never "fix" it by forcing Zoom to the
   front mid-task, and never fire a test click at arbitrary coordinates (a click at 10,10
   opens the Apple menu). Typing (`cliclick t:`) has no guard, so check the frontmost app
   yourself before typing.
5. Re-snap and verify. **Prefer evidence that doesn't depend on reading pixels:**
   `$S/reqs.sh 5` (route + status), the club/state API, `localStorage` via a page script, KV
   (`$S/w.sh kv key get …`; allow ~60 s after a write — reads are cached).
6. `$S/log.sh "<✅|❌|⚠️|⏭> Step N — what you saw, with the numbers"` and
   `$S/reqs.sh 6 --log` for the server lines — **immediately**, before the next step. A run
   that dies mid-way must still show what passed.

Long waits (a speech through green/yellow/red): `$S/capture-timeline.sh --start X,Y --region
x,y,w,h 8:blue 36:green 50:yellow 66:red` in the background, then Read the shots.

Before calling something a bug, get **client-side** proof too: the server log alone once
missed a request. E.g. an upload is only "stuck" if `localStorage` still holds the entry and
the UI says so; replay the same request by hand to split client fault from server fault.

## 4. Zoom's own dialogs are part of the meeting — answer them

"Allow Toastmasters Timer to access your virtual backgrounds…", "…wants to reset your virtual
background to none", and similar Zoom prompts are normal. Click through (either answer is
fine for the reset one — that flow is covered elsewhere) and continue. Leaving one open
captures input and silently breaks every later panel click. This is different from app
*authorization* consent (OAuth), which stays human-only.

The PostHog "Which club are you from?" survey after FINISH is intentional — dismiss with
**Not now**, don't report it.

## 5. Which surface for what

| Surface | Drive with | Notes |
|---|---|---|
| Zoom client (sidebar app, video, Zoom dialogs) | cliclick + `snap.sh` | The only way to test the SDK bridge and the real video frame |
| Signed-in web session (console, `/account`, uploads) | Claude in Chrome | Reliable clicks, `file_upload`, page JS; uses the user's own cookies |
| Second device / guest | built-in browser pane | Separate cookies. **Hidden pane = 0×0 viewport: clicks fail**; use navigate + page JS only |
| Server truth | `reqs.sh`, `w.sh`, `club-cli` | Assertions, not navigation |

The Zoom web client cannot run Zoom Apps; a second Zoom *participant* needs a second
computer. Most "machine B" steps work fine with the web app as the second device.

## 6. KV edits and teardown

Before editing any record: save it (`w.sh kv key get … > $RUN/<name>-backup.json`), log the
edit, and restore from the backup when the step is done. At the end:

- Append a `## Summary` to `run.md`: failures (with cause if traced), findings, passed steps,
  not-run steps and why, anything left changed (gate value, test data).
- Stop your background helpers (`pkill -f "caffeinate -d -t 14400"`, `pkill -f tail.sh`) —
  mention that a stopped capture is intentional when its notification arrives.
- Remind the user of anything still flipped (e.g. `ENTITLEMENT_ENFORCE: "1"` refuses sync for
  other dev testers) and ask before reverting/redeploying.

## 7. Reporting back

Link `test-runs/<run>/run.md`. Lead with what failed and why, then findings, then what passed
in one line, then exactly what you need from the user next. Don't restate the whole log.
