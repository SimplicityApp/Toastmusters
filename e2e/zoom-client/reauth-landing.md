---
id: reauth-landing
title: Re-auth landing, the approved-before mark, the reconnect page and "You're reconnected" (#96)
status: current
covers:
  - worker/reconnect.js
  - worker/old-web-host.js
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
verified_at: 3955a0a
verified_on: 2026-11-25
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
the page that explains why Zoom sent the user here. Any query string (marketing links carry
`?utm_…`), any other path, an unmarked browser and the `zoom.` host are left alone.

The reconnect page has three ways home, all a full page load to `/?home`: the header logo, the
header's **Homepage** link and **Go to the homepage** under the buttons. From a marked browser,
`/?home` gets a `302` to `/` that sets a second cookie, the dismissal:

`tt_reconnect_dismissed=1; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` (host-only)

With it, a bare `/` is the homepage again, so a healthy user is not sent back to the reconnect
page on every visit. The next install landing clears it (`Max-Age=0`). The design assumes Zoom lands a user whose
approval lapsed on that bare `/` of the dev web host (`WEB_ORIGIN`). RL-04 checks that
assumption.

## Purpose
Catches an install landing that leaves Zoom's one-time code in the address bar, a browser that
is never marked (so a returning user can never be recognised), a mark that page JavaScript can
read or that expires within days, a re-add greeted as a first install, and an "Open in Zoom"
button that launches the production app from a dev build. Also catches a marked browser that
still gets the marketing homepage at `/`, a visitor who can't leave the reconnect page (a loop
back from "Go to the homepage" or a reload), a visitor sent back to the reconnect page on every
visit after leaving it once, a broken Zoom sidebar on the `zoom.` host, and
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

Last run (2026-11-01, dev f30c40a): PASS. Cookie attributes not read (no DevTools); the mark was proven by
`/` redirecting. PostHog `zoom_app_installed` had `source: oauth_redirect`, `welcome: new`, no
`has_code`. KV contact: inconclusive (one record, unchanged since 2026-10-13; a skipped capture
logs nothing).

### RL-02 · auto · A re-add in the same browser says "You're reconnected"; Open in Zoom carries this build's app id
Do: in the same profile, open `https://www.timer-dev.simple-tech.app/add-to-zoom` again. On the
page it lands on, click **Open in Zoom**.
Expect: the address bar settles on `…/oauth/redirect?welcome=back`. The page shows "You're
reconnected", the line "Your agendas, roles and reports are exactly where you left them.", an
**Open in Zoom** button and an **Open Zoom in browser** link, and no demo videos. **Open in
Zoom** points at `https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink`
(the dev app id). On dev the link answers "The application is not found": the dev app has no
Marketplace app page, so its deeplink never resolves (zoom-deeplink DL-02). That is expected and
not a failure. The launch itself is checked on production, where the same button opens the
app in the Zoom client, possibly through `marketplace.zoom.us/z/<token>` first.
Evidence: final URL; screenshot of the card; the button's `href`; PostHog `zoom_app_installed`
with `welcome: back`; `reqs.sh` shows the app loading from `zoom.timer-dev.simple-tech.app`.

Last run (2026-11-01, dev f30c40a): PASS. The deeplink answered "The application is not found", as
expected on dev. PostHog `zoom_app_installed` had `welcome: back`.

### RL-03 · auto · A marked browser's bare / opens the reconnect page; leaving for the homepage sticks
Do: in the profile marked in RL-01, open `https://www.timer-dev.simple-tech.app/`. On the page
it lands on, check the header, then click **Go to the homepage**, then reload. Then open
`https://www.timer-dev.simple-tech.app/` again. In the same profile, open
`https://zoom.timer-dev.simple-tech.app/`. Last, in the second (unmarked) profile, open
`https://www.timer-dev.simple-tech.app/`.
Expect: the marked profile's address bar settles on
`https://www.timer-dev.simple-tech.app/reconnect`, and the page shows "Welcome back", "Reconnect
Toastmusters Timer to Zoom" and an **Approve in Zoom** button. The homepage never paints first:
the Worker answers `/` with a redirect, not a document. The header shows the logo and a
**Homepage** link, both pointing at `/?home`. **Go to the homepage** shows the homepage, and the
reload keeps it. Since #98 the old web host's public pages live on the main site, so the
homepage is `https://www.timer-dev.toastmusters.com/`. The second visit to the bare `/` also
lands on the main site's homepage, not on `/reconnect`: leaving once sticks. The unmarked
profile's `/` 301s to `https://www.timer-dev.toastmusters.com/`. The `zoom.` host shows the Zoom
timer app, not the reconnect page.
Evidence: final URLs (`osascript`, see gotchas.md). In the marked profile, the Network entry for
the first `/` sends `tt_approved=1` and gets a `302` with
`Location: https://www.timer-dev.simple-tech.app/reconnect` and `Cache-Control: no-store`, and
no `text/html` response for `/`, never a `301` to the main site. The `/?home` entry gets a `302`
to `/` with `Set-Cookie: tt_reconnect_dismissed=1; … Max-Age=31536000 …`; the second `/` sends
both cookies and gets a `301` to the main site. PostHog `$pageview` for `/reconnect`, and
`cta_clicked` with `cta: home`, `page: /reconnect`. Cross-check without a browser:
`curl -sI -H 'Cookie: tt_approved=1' https://www.timer-dev.simple-tech.app/` gives the `302` to
`/reconnect`; the same against `/?home` gives the `302` to `/` with the dismissal cookie; with
`Cookie: tt_approved=1; tt_reconnect_dismissed=1`, `/` gives a `301` to the main site; against
`https://zoom.timer-dev.simple-tech.app/` a `200`. Without the cookie, `/` gives a `301` with
`Cache-Control: no-store` (a cached one would hide the reconnect page once the browser is marked).
To see the reconnect page again in this profile, rerun RL-02 (a re-add clears the dismissal) or
delete `tt_reconnect_dismissed` in DevTools.

Last run (2026-11-01, dev f30c40a): PASS. The unmarked check used curl, not a second profile. PostHog
`$pageview` for `/reconnect` recorded. That run predates #98 (`/?home` and the unmarked `/` were
still `200` here); rerun after #98 reaches dev.
Reviewed 2026-11-02 against the master sync: `/tutorials` joined the moved pages; `/` and
`/reconnect` are unchanged, so no step changes.
Last run (2026-11-25, dev 3955a0a, PR #176): PASS. Browser half in the built-in browser pane, marked
through the install landing with a fake `code` (the pane was not signed in to Zoom; the mark
does not depend on the code exchange). `/` → `/reconnect`; logo, **Homepage** and **Go to the
homepage** all `/?home`; each one, after a re-add, led to the main site's homepage and a second
bare `/` stayed there. A re-add (`?welcome=back`) brought `/reconnect` back. The curl
cross-check matched every line above, plus the landing's `tt_reconnect_dismissed=; Max-Age=0`.
PostHog `cta_clicked` `cta: home` with `location` `hero`, `header` and `logo`. Unmarked `/`
by curl only.

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
On dev this step cannot show the reconnect page: Zoom finishes an in-meeting add of the
development credentials on the production web host's root, not on `timer-dev` (one Marketplace
app, two credential sets; nothing on the Development tab changes it). Accepted as a dev-only
limit. The real check is one production run after release: a guest or lapsed account approves
in a meeting, in a browser that installed the app on production before, and lands on `/reconnect`.

Last run (2026-11-01, dev f30c40a): as expected on dev. B approved from the Apps panel; the
browser opened `https://www.timer.simple-tech.app` and no request reached `timer-dev`
(same as 2026-09-25, docs/ZOOM_AUTH_AND_REDIRECTS.md).

## Notes
- Reviewed after merging dev (2026-11-01): dev only swapped the demo video on the landing and
  install pages; no step changes.

## Not covered
- The redirect rules (back or new, the `zoom.` host left alone, cookie attributes, the code
  dropped; for `/`, only a bare `/` with the mark): `worker/reconnect.test.js` and
  `worker/routing.test.js`, which also prove the apex and legacy host redirects run first.
- The dismissal rules (only a marked `/?home` writes it, no loop once written, a re-add clears
  it): `worker/reconnect.test.js` and `worker/routing.test.js`.
- What each `?welcome=` value renders in a plain browser, the reconnect page's copy and links
  (header logo and **Homepage** included), and homepage → "Reconnect it" → `/reconnect` →
  "Go to the homepage" → `/?home`:
  `e2e/web.reconnect.spec.js`, `apps/web/src/pages/Reconnect.test.jsx`.
- Web sign-in never writing the mark (a signed `state` goes to the sign-in callback):
  `worker/routing.test.js`.
- Browsers that added the app before the mark existed, or a different browser: they get
  "installed successfully" on their next re-add, and the plain homepage at `/`, by design. The
  homepage's "Already use the Zoom app? Reconnect it" line is their way to the reconnect page.
- What the Zoom client does with a lapsed user's click on the app itself (as opposed to the
  guest-mode approve in RL-04): Zoom offers no way to force a lapsed grant on demand. A scope
  change takes 90 days to lapse (docs/ZOOM_AUTH_AND_REDIRECTS.md).
