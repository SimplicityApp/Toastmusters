---
id: reauth-landing
title: Re-auth landing, the approved-before mark, the reconnect page and "You're reconnected" (#96)
status: draft
covers:
  - worker/reconnect.js
  - apps/web/src/pages/Reconnect.jsx
  - apps/web/src/pages/OAuthRedirect.jsx
automated:
  - worker/reconnect.test.js
  - worker/routing.test.js
  - e2e/web.reconnect.spec.js
  - apps/web/src/pages/Reconnect.test.jsx
  - apps/web/src/pages/OAuthRedirect.test.jsx
needs:
  - dev deployed (npm run cf:deploy:dev)
  - a browser profile with no cookies for www.timer-dev.simple-tech.app, signed in to zoom.us (human, before the run)
  - a Zoom account that has already approved the dev app's current scopes, so Zoom answers /add-to-zoom without a consent screen (if it shows one, the user clicks Allow)
  - the Zoom desktop client signed in to the same account
  - for RL-03, a second browser profile with no cookies for www.timer-dev.simple-tech.app
  - for RL-04, a second Zoom account (B) in the authenticated state, in a meeting with the owner (docs/ZOOM_AUTH_AND_REDIRECTS.md, "Reaching the authenticated state deliberately"), and npx wrangler tail --env dev open
verified_at: never
verified_on: never
---

# Re-auth landing, the approved-before mark, the reconnect page and "You're reconnected" (#96)

When a user adds the app from our site, Zoom sends the browser to
`/oauth/redirect?code=…` with no `state`. The Worker answers with a `302` to
`/oauth/redirect?welcome=new`, or `?welcome=back` when the request already carried the mark,
and sets the mark:

`tt_approved=1; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` (host-only)

`?welcome=back` shows "You're reconnected"; anything else shows today's "Zoom app installed
successfully" page. The cookie is `HttpOnly`, so `document.cookie` never shows it: read it in
DevTools (Application → Cookies → `https://www.timer-dev.simple-tech.app`) or on the Network
entry for the `/oauth/redirect?code=…` request. To start over, delete the cookie there.

A bare `/` on the web host from a browser that carries the mark gets a `302` to `/reconnect`,
the page that explains why Zoom sent the user here. Any query string (the reconnect page's own
"Go to the homepage" is `/?home`, marketing links carry `?utm_…`), any other path, an unmarked
browser and the `zoom.` host are left alone. The design assumes Zoom lands a user whose
approval lapsed on that bare `/` of the dev web host (`WEB_ORIGIN`). RL-04 checks that
assumption.

## Purpose
Catches an install landing that leaves Zoom's one-time code in the address bar, a browser that
is never marked (so a returning user can never be recognised), a mark that page JavaScript can
read or that expires within days, a re-add greeted as a first install, and an "Open in Zoom"
button that launches the production app from a dev build. Also catches a marked browser that
still gets the marketing homepage at `/`, a visitor who can't leave the reconnect page (a loop
back from "Go to the homepage" or a reload), a broken Zoom sidebar on the `zoom.` host, and
Zoom landing lapsed users somewhere the redirect never fires. The unit tests prove the rules;
only the deployed Worker, a real Zoom authorize round trip and the real client show them end to
end.

## Steps

### RL-01 · auto · A first add lands on ?welcome=new and marks the browser
Do: in the unmarked browser profile, open `https://www.timer-dev.simple-tech.app/add-to-zoom`.
If Zoom shows its consent screen instead of returning at once, the user clicks Allow (human).
Expect: the address bar settles on `https://www.timer-dev.simple-tech.app/oauth/redirect?welcome=new`
with no `code` in it. The page shows "Zoom app installed successfully" and both demo videos.
The browser now holds `tt_approved` = `1` for `www.timer-dev.simple-tech.app` only: HttpOnly,
Secure, SameSite Lax, no Domain, expiring about one year from now.
Evidence: final URL (`osascript`, see gotchas.md); DevTools cookie row; the Network entry for
`/oauth/redirect?code=…` is a `302` with `Location: …?welcome=new`,
`Set-Cookie: tt_approved=1; … Max-Age=31536000 …` and `Cache-Control: no-store`. PostHog
`zoom_app_installed` with `source: oauth_redirect`, `welcome: new`, and no `has_code`.
`contact:zoom:<uid>` is still written in KV (CC-01).

### RL-02 · auto · A re-add in the same browser says "You're reconnected"; Open in Zoom launches the dev app
Do: in the same profile, open `https://www.timer-dev.simple-tech.app/add-to-zoom` again. On the
page it lands on, click **Open in Zoom**.
Expect: the address bar settles on `…/oauth/redirect?welcome=back`. The page shows "You're
reconnected", the line "Your agendas, roles and reports are exactly where you left them.", an
**Open in Zoom** button and an **Open Zoom in browser** link, and no demo videos. **Open in
Zoom** points at `https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink`
(the dev app id) and opens the dev app in the Zoom client, possibly through
`marketplace.zoom.us/z/<token>` first.
Evidence: final URL; screenshot of the card; the button's `href`; PostHog `zoom_app_installed`
with `welcome: back`; `reqs.sh` shows the app loading from `zoom.timer-dev.simple-tech.app`.

### RL-03 · auto · A marked browser's bare / opens the reconnect page; /?home and the zoom host do not
Do: in the profile marked in RL-01, open `https://www.timer-dev.simple-tech.app/`. On the page
it lands on, click **Go to the homepage**, then reload. In the same profile, open
`https://zoom.timer-dev.simple-tech.app/`. Last, in the second (unmarked) profile, open
`https://www.timer-dev.simple-tech.app/`.
Expect: the marked profile's address bar settles on
`https://www.timer-dev.simple-tech.app/reconnect`, and the page shows "Welcome back", "Reconnect
Toastmusters Timer to Zoom" and an **Approve in Zoom** button. The homepage never paints first:
the Worker answers `/` with a redirect, not a document. **Go to the homepage** lands on `/?home`
and shows the homepage, and the reload stays on `/?home` with the homepage. The `zoom.` host
shows the Zoom timer app, not the reconnect page. The unmarked profile gets the homepage at `/`,
with no redirect.
Evidence: final URLs (`osascript`, see gotchas.md). In the marked profile, the Network entry for
`/` sends `tt_approved=1` and gets a `302` with `Location: https://www.timer-dev.simple-tech.app/reconnect`
and `Cache-Control: no-store`, and no `text/html` response for `/`. The `/?home` reload is a
`200`. PostHog `$pageview` for `/reconnect`. Cross-check without a browser:
`curl -sI -H 'Cookie: tt_approved=1' https://www.timer-dev.simple-tech.app/` gives the `302`;
the same against `/?home` and against `https://zoom.timer-dev.simple-tech.app/` gives `200`.

### RL-04 · human · Record where Zoom opens the browser after a guest approves the app
Do: start `npx wrangler tail --env dev`. As account B, in the `authenticated` state, open the dev
app in the meeting from the App Launcher. In the app's "Approve Toastmusters Timer in Zoom"
modal, click **Approve in Zoom**, then approve in Zoom's own prompt (human). If Zoom opens a
browser tab, record its first URL before clicking anything. B is now `authorized`. To run this
step again, remove the app from B's account (Marketplace → Manage → Added Apps).
Expect: the result is a record, not a pass on the page. Write down the exact host, path and
query Zoom opened, or "no browser". The design assumes `https://www.timer-dev.simple-tech.app/`
with no query: a bare `/` on the dev web host. In a browser marked in RL-01, that URL settles on
`/reconnect` as in RL-03. Any other landing breaks that assumption, and must be raised before
release. Examples: the production host `https://www.timer.simple-tech.app/` (seen once, on
2026-09-25, see docs/ZOOM_AUTH_AND_REDIRECTS.md), a path other than `/`, or a query string. In
those cases the dev mark is never sent, and the reconnect page cannot appear. If the modal
opened the install URL in the browser instead (`zoom_reconnect_clicked` with `fallback: true`),
record that too. That is the browser fallback, which lands on `/oauth/redirect?welcome=…`, not
`/`.
Evidence: the URL as recorded, plus the browser history entry for the tab (the first URL,
before any redirect). The `wrangler tail` lines in the minute after approval: a `GET /` on
`www.timer-dev.simple-tech.app`, or none at all if Zoom opened another host. A screenshot of the
tab. The debug log's `Asked Zoom to prompt the user to add the app` line.

## Not covered
- The redirect rules (back or new, the `zoom.` host left alone, cookie attributes, the code
  dropped; for `/`, only a bare `/` with the mark): `worker/reconnect.test.js` and
  `worker/routing.test.js`, which also prove the apex and legacy host redirects run first.
- What each `?welcome=` value renders in a plain browser, the reconnect page's copy and links,
  and homepage → "Reconnect it" → `/reconnect` → "Go to the homepage" → `/?home`:
  `e2e/web.reconnect.spec.js`, `apps/web/src/pages/Reconnect.test.jsx`.
- Web sign-in never writing the mark (a signed `state` goes to the sign-in callback):
  `worker/routing.test.js`.
- Browsers that added the app before the mark existed, or a different browser: they get
  "installed successfully" on their next re-add, and the plain homepage at `/`, by design. The
  homepage's "Already use the Zoom app? Reconnect it" line is their way to the reconnect page.
- What the Zoom client does with a lapsed user's click on the app itself (as opposed to the
  guest-mode approve in RL-04): Zoom offers no way to force a lapsed grant on demand. A scope
  change takes 90 days to lapse (docs/ZOOM_AUTH_AND_REDIRECTS.md).
