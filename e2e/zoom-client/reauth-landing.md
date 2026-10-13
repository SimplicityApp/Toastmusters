---
id: reauth-landing
title: Re-auth landing, the approved-before mark and "You're reconnected" (#96)
status: draft
covers:
  - worker/reconnect.js
  - apps/web/src/pages/OAuthRedirect.jsx
automated:
  - worker/reconnect.test.js
  - worker/routing.test.js
  - e2e/web.reconnect.spec.js
  - apps/web/src/pages/OAuthRedirect.test.jsx
needs:
  - dev deployed (npm run cf:deploy:dev)
  - a browser profile with no cookies for www.timer-dev.simple-tech.app, signed in to zoom.us (human, before the run)
  - a Zoom account that has already approved the dev app's current scopes, so Zoom answers /add-to-zoom without a consent screen (if it shows one, the user clicks Allow)
  - the Zoom desktop client signed in to the same account
verified_at: never
verified_on: never
---

# Re-auth landing, the approved-before mark and "You're reconnected" (#96)

When a user adds the app from our site, Zoom sends the browser to
`/oauth/redirect?code=…` with no `state`. The Worker answers with a `302` to
`/oauth/redirect?welcome=new`, or `?welcome=back` when the request already carried the mark,
and sets the mark:

`tt_approved=1; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` (host-only)

`?welcome=back` shows "You're reconnected"; anything else shows today's "Zoom app installed
successfully" page. The cookie is `HttpOnly`, so `document.cookie` never shows it: read it in
DevTools (Application → Cookies → `https://www.timer-dev.simple-tech.app`) or on the Network
entry for the `/oauth/redirect?code=…` request. To start over, delete the cookie there.

## Purpose
Catches an install landing that leaves Zoom's one-time code in the address bar, a browser that
is never marked (so a returning user can never be recognised), a mark that page JavaScript can
read or that expires within days, a re-add greeted as a first install, and an "Open in Zoom"
button that launches the production app from a dev build. The unit tests prove the rules; only
the deployed Worker, a real Zoom authorize round trip and the real client show them end to end.

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

## Not covered
- The redirect rules (back or new, the `zoom.` host left alone, cookie attributes, the code
  dropped): `worker/reconnect.test.js` and `worker/routing.test.js`.
- What each `?welcome=` value renders in a plain browser: `e2e/web.reconnect.spec.js`.
- Web sign-in never writing the mark (a signed `state` goes to the sign-in callback):
  `worker/routing.test.js`.
- Browsers that added the app before the mark existed, or a different browser: they get
  "installed successfully" on their next re-add, by design.
- Where Zoom lands a lapsed user, and what a marked browser sees there: added as their own
  steps when that part of #96 ships.
