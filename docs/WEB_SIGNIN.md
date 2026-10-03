# Sign in with Zoom (web app)

The Zoom app never shows a sign-in: Zoom hands it an encrypted app context and
the Worker reads the user's `uid` from that. A plain browser has no such
context, so the web app at `/timer/app` signs in **with Zoom** (OAuth). The Worker
exchanges the code, reads the same Zoom user id, and mints the same kind of
session token into an HttpOnly cookie. One identity, two doors: a Pro plan
bought inside Zoom is Pro on the web with nothing to link.

## Flow

```
/api/auth/zoom/start?returnTo=/timer/app
  → signed state (nonce, purpose, returnTo, 10-min expiry) + tt_oauth nonce cookie
  → 302 https://zoom.us/oauth/authorize?...&redirect_uri=<WEB_ORIGIN>/oauth/redirect&state=…
Zoom consent → 302 /oauth/redirect?code=…&state=…
  Worker: state verified + nonce cookie matches → POST zoom.us/oauth/token
        → GET api.zoom.us/v2/users/me → id → 30-day session token
        → Set-Cookie tt_session (HttpOnly; Secure; SameSite=Lax; host-only)
        → 302 <WEB_ORIGIN>/timer/app
/api/me re-issues the cookie when it is older than a day (sliding session).
POST /api/auth/logout clears it.
```

`/oauth/redirect` is shared with the Marketplace **Add** (install) flow, which
sends no `state`. Only a request carrying a state the Worker signed is treated
as a sign-in; everything else falls through to the SPA's install-success page.
A session is never set without a valid state and matching nonce cookie.

## What must be true in the Zoom Marketplace app

1. **Redirect URL** `https://www.timer.simple-tech.app/oauth/redirect` (prod)
   and `https://www.timer-dev.simple-tech.app/oauth/redirect` (dev) — already
   registered for the install flow. Must equal `WEB_ORIGIN + /oauth/redirect`.
2. **Scope** for `GET /v2/users/me`: `user:read:user` (granular) — or
   `user:read` on a classic-scope app. Without it the callback fails with
   `reason=profile` and nobody can sign in on the web.

   Adding a scope does not cut existing users off at once: Zoom keeps their
   current authorization working for 90 days, then the refresh token expires
   and they re-consent (see `ZOOM_AUTH_AND_REDIRECTS.md`). Dev testers should
   re-run the authorize URL in `docs/ZOOM_TEST_PLAN.md` right away so the new
   scope is exercised. Add it once, together with the listing update for Pro,
   and submit for re-review in one go.
3. Confirm once, on dev, that `users/me.id` equals the `uid` the app context
   carries (sign in on the web, then compare the PostHog person id with the
   one the Zoom app reports). Both are documented as the Zoom user id.

## Hosts

The cookie is host-only and the redirect URI is fixed, so sign-in always lands
on `WEB_ORIGIN` (the canonical web host) whichever host the user started from.

That is also why **`/api/auth/zoom/start` redirects to `WEB_ORIGIN` when it is
reached on any other host**. The Worker serves several (the apex of each domain,
and `timer-dev.toastmusters.com` alongside `timer-dev.simple-tech.app`), and the
start route runs ahead of the apex→www redirect in `worker/index.js`. Without the
hand-off, a sign-in begun anywhere else set its `tt_oauth` nonce cookie on *that*
host, the callback on `WEB_ORIGIN` never received it, and the flow failed with
`reason=state_mismatch` — silently, on any page but `/account`. Local http is
exempt, because `wrangler dev` rewrites the Host header to the first configured
route.
When the domain migration makes `timer.toastmusters.com` canonical, change
`WEB_ORIGIN` in `wrangler.jsonc` and add that redirect URL in the Marketplace.

## Security notes

- Confidential client, server-side exchange: PKCE is not needed; signed state
  plus nonce cookie is the binding.
- Cookie requests pass CSRF checks in `worker/auth.js` `readSession`:
  `Sec-Fetch-Site` must be same-origin/none when present, and mutating requests
  with an `Origin` must match the host. Bearer requests skip these (no ambient
  credential).
- Zoom access/refresh tokens are never stored. Nothing calls Zoom on the
  user's behalf after sign-in.
- Session tokens carry only `uid`, `iat`, `exp`. No email, no name.

## Testing on dev

1. Deploy dev, open `https://www.timer-dev.simple-tech.app/timer/app`, click
   **Sign in with Zoom** in the top bar, allow.
2. You land back on `/timer/app`; the top bar shows **Account** (or **Pro**).
   PostHog now shows the person `zoom:<uid>` with `surface: web`.
3. Change a timing rule; `wrangler tail --env dev` shows `PUT /api/profile`
   (200 if Pro or unenforced, 402 otherwise). Open the Zoom app on dev: the rule
   is there.
4. `/account`: plan, Manage billing, Sign out. `?signin=failed&reason=…` is
   shown there, and by `SignInFailureNotice` above every other route — the
   header's sign-in link carries whatever page it was clicked from as
   `returnTo`, so a failure can come back anywhere.
5. Start a sign-in from a non-canonical host (the apex, or the toastmusters.com
   dev host). It should hand off to `WEB_ORIGIN` and complete.
