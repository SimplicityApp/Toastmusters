# Gotchas from real runs

Each of these cost time in the 2026-09-28 Club Pro run. Grouped by where they bite.

## macOS setup
- **Screen Recording** off → `screencapture` prints "could not create image from display".
  Enable for Claude, then quit & reopen Claude.
- **Accessibility** is checked against the binary that posts events, not the Claude app you
  see. Add the real `cliclick` file (`readlink -f $(which cliclick)`, e.g.
  `/opt/homebrew/Cellar/cliclick/5.1/bin/cliclick` — the picker can't select the Homebrew
  symlink; use ⌘⇧G or drag from `open -R`) **and** the Claude Code binary
  (`~/Library/Application Support/Claude/claude-code/<version>/claude.app` — quote the space;
  re-add after Claude updates). Restart Claude.
- **Sleep** kills everything: tail stream, scratchpad files, even the Zoom meeting. Keep the
  display awake for the whole run.
- After a session restart the shell may default to **Node 20**; wrangler refuses it. The
  scripts prepend Node 22 automatically.
- The **main display can change** between sessions (external monitor unplugged/replugged).
  Never reuse coordinates from an earlier session — re-snap; `to-pt.sh` uses each shot's own
  mapping.

## Zoom client
- **The user may come back mid-run.** In the smoke test a click aimed at Zoom's REPORT tab
  landed in the user's Chrome window, which had come to the front. `click.sh` now refuses
  unless Zoom is frontmost; treat a refusal as "the user is here" and stop.
- **Archive upload stuck in the outbox:** the real trigger is **the page loaded with an empty
  outbox**, not a Mac sleep (the sleep in the 2026-09-28/29 runs was a coincidence). App
  start's empty drain left `drainOutbox`'s in-flight flag holding a settled promise, so FINISH,
  the retry timer and the wake triggers all did nothing until ⋯ → Refresh app, and the panel
  showed "1 speech waiting to upload". Bug-plan #2, fixed after PR #74. To test it, load the
  page fresh with an empty outbox, then FINISH. Refresh the app first so the panel runs the
  new build. Prove a missing upload three ways: no POST in `reqs.sh`, the speech absent from
  `GET /api/club/meetings/<id>`, and the device strip or `toastmaster_club_outbox` still
  holding it. The tail alone is not proof.
- The first click into the sidebar often **only focuses** it (you'll see a hover tooltip);
  click again. Worse while a Zoom dialog is pending. `click.sh --activate` does both.
- **Dropdowns / toggles**: single click only — a double click opens and closes them.
- **Page Down doesn't scroll** the webview and cliclick can't scroll → `scroll.sh`.
- Zoom opens external links through `marketplace.zoom.us/z/<token>`; for hosts not on the
  app's Domain Allow List it stops at "Accessing Untrusted Web Site". Read the final URL with
  `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`
  after a few seconds.
- **⋯ → Refresh app** reloads the webview (a cold start: runs start-up drains/refreshes).
  It also resets the selected Timing Role.
- The overlay **camera preview can show people in the room** — crop shots to the panel when
  the video isn't what you're testing.
- The Zoom *web* client does not run Zoom Apps.

## Web app / browsers
- Claude in Chrome ref-clicks sometimes don't register on this app's buttons (START, Save);
  if the state didn't change, click by coordinate from a fresh screenshot.
- The built-in browser pane hidden → viewport 0×0 → clicks fail; `navigate`, `get_page_text`
  and page JS still work. To change a React `<select>` from JS, use the native value setter
  + a bubbling `change` event.
- Pressing Escape in the speaker-name field can clear it.
- Don't click **Copy image / Copy link** unless asked — it overwrites the user's clipboard;
  verify the PNG via the share response / `og:image` instead.
- A web session is **host-scoped**: signing in on `timer-dev.toastmusters.com` doesn't sign
  you in on `www.timer-dev.simple-tech.app`.

## Cloudflare / evidence
- `wrangler tail` needs ~10 s to connect after (re)start and has dropped at least one
  request — confirm with `probe.sh`, and back important claims with client-side evidence.
- `wrangler kv key get` can return the **previous** value for ~60 s after a write.
- A deploy can print "No access to the specified resource" for `/workers/routes` when the
  token lacks Zone · Workers Routes. The version still goes live; check
  `wrangler deployments list` and curl the host.
- Workers Logs (observability) need the token to have Workers Observability · Read.

## Judgement calls the user has made
- Zoom background dialogs: answer and continue (see SKILL.md §4).
- PostHog club survey after FINISH: intended.
- Dev "Add to Zoom" pointing at the production app: known, low priority.
