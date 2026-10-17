---
id: zoom-deeplink
title: "Open in Zoom" deeplink launches the right app
status: draft
covers:
  - packages/shared/appLinks.js
  - apps/web/src/pages/Landing.jsx
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
Do: open the dev landing page and read the "Open in Zoom" and "Add to Zoom" hrefs (page JS).
Expect: both use the dev client id (`kgpoX2A6TY2BvdctzK9iw`); no `DsFHK5sNQs2_VFyeQky2sg`.
Evidence: the hrefs.

### DL-02 · auto · Zoom resolves the link
Do: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' <deeplink>` for the page's link,
and for the production link as a control. Then close the app in the meeting panel (⋯ → Close
current app), open the link, and look at the result.
Expect: a 302 to `zoom.us/launch/zoomapp/<token>` and the Zoom client opens the app (dev shows
the BETA badge). A 200 "Oops, The application is not found" is a failure.
Evidence: curl output for both ids; screenshot of the panel.
Last run (2026-10-13): production 302, dev 200 "not found". FAIL for dev.

### DL-03 · auto · Production link unchanged
Do: with `VITE_ZOOM_OAUTH_REDIRECT` unset, or the production client id, read the link.
Expect: exactly the link used before the change (`.../zoomapp/DsFHK5sNQs2_VFyeQky2sg/...`).
Evidence: `appLinks.test.js`; curl 302.

## Not covered
- The "Open Zoom app" button on `/oauth/redirect` and `/billing/success` (they need a real
  install and a Stripe return); they share `zoomAppDeeplink()` with the landing page.
- Where Zoom shows its "Open Zoom?" browser prompt, which depends on the browser.
