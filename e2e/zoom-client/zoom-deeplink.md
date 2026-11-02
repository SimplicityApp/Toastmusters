---
id: zoom-deeplink
title: "Open in Zoom" deeplink launches the right app
status: draft
covers:
  - packages/shared/appLinks.js
  - apps/web/src/pages/Landing.jsx
  - apps/web/src/pages/Reconnect.jsx
  - apps/web/src/pages/OAuthRedirect.jsx
  - apps/web/src/pages/BillingSuccess.jsx
automated:
  - packages/shared/__tests__/appLinks.test.js
  - apps/web/src/pages/Landing.test.jsx
  - apps/web/src/pages/OAuthRedirect.test.jsx
needs:
  - dev deployed (VITE_ZOOM_OAUTH_REDIRECT is set by `npm run cf:deploy:dev`)
  - in a meeting, dev app closed in the panel before DL-02
verified_at: never
verified_on: never
---

# "Open in Zoom" deeplink launches the right app

`zoomAppDeeplink()` builds `https://marketplace.zoom.us/zoomapp/<id>/context/meeting/target/launch/deeplink`
from the `client_id` of the build's install URL, on the assumption that a Zoom app's id is its
OAuth client id. Unit tests prove the string; only Zoom can say the link launches an app.

## Purpose
Catches a link that is well formed but that Zoom's Marketplace does not resolve, or that opens
the wrong app (production from a dev page, or the reverse).

## Steps

### DL-01 · auto · Page carries this build's client id
Do: open the dev landing page and read its "Add to Zoom" href, then follow "Reconnect it" to
`/reconnect` and read "Approve in Zoom" and "Already approved? Open in Zoom" (page JS). Since #96
the landing page links to `/reconnect` instead of carrying the deeplink itself.
Expect: both use the dev client id (`kgpoX2A6TY2BvdctzK9iw`); no `DsFHK5sNQs2_VFyeQky2sg`.
Evidence: the hrefs.

### DL-02 · auto · Zoom resolves the link
Do: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' <deeplink>` for the page's link,
and for the production link as a control. Then close the app in the meeting panel (⋯ → Close
current app), open the link, and look at the result.
Expect: production: a 302 to `zoom.us/launch/zoomapp/<token>` and the Zoom client opens the
app; a 200 "Oops, The application is not found" is a failure. Dev: a 200 "not found" is
expected, because the dev app has no Marketplace app page, so its deeplink never resolves; only
DL-01 (the dev id is in the link) can pass there.
Evidence: curl output for both ids; screenshot of the panel.
Last run (2026-10-13): production 302, dev 200 "not found" (expected on dev, see above).
Dev result reconfirmed 2026-11-01.

### DL-03 · auto · Production link unchanged
Do: with `VITE_ZOOM_OAUTH_REDIRECT` unset, or the production client id, read the link.
Expect: exactly the link used before the change (`.../zoomapp/DsFHK5sNQs2_VFyeQky2sg/...`).
Evidence: `appLinks.test.js`; curl 302.

## Not covered
- The "Open in Zoom" buttons on `/oauth/redirect` and `/billing/success` (they need a real
  install and a Stripe return); they share `zoomAppDeeplink()` with the landing page.
- Where Zoom shows its "Open Zoom?" browser prompt, which depends on the browser.
