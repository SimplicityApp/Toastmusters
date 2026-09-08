# Sign in with Zoom (web app)

The Zoom app never shows a sign-in: Zoom hands it an encrypted app context and
the Worker reads the user's `uid` from that. A plain browser has no such
context, so the web app at `/app` signs in **with Zoom** (OAuth). The Worker
exchanges the code, reads the same Zoom user id, and mints the same kind of
session token into an HttpOnly cookie. One identity, two doors: a Pro plan
bought inside Zoom is Pro on the web with nothing to link.

## Flow

```
/api/auth/zoom/start?returnTo=/app
  → signed state (nonce, purpose, returnTo, 10-min expiry) + tt_oauth nonce cookie
  → 302 https://zoom.us/oauth/authorize?...&redirect_uri=<WEB_ORIGIN>/oauth/redirect&state=…
Zoom consent → 302 /oauth/redirect?code=…&state=…
  Worker: state verified + nonce cookie matches → POST zoom.us/oauth/token
        → GET api.zoom.us/v2/users/me → id → 30-day session token
        → Set-Cookie tt_session (HttpOnly; Secure; SameSite=Lax; host-only)
        → 302 <WEB_ORIGIN>/app
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

   Adding a scope invalidates every existing user's grant: they re-consent on
   next open (Zoom prompts them), and dev testers must re-run the authorize URL
   in `docs/ZOOM_TEST_PLAN.md`. Add it once, together with the listing update
   for Pro, and submit for re-review in one go.
3. Confirm once, on dev, that `users/me.id` equals the `uid` the app context
   carries (sign in on the web, then compare the PostHog person id with the
   one the Zoom app reports). Both are documented as the Zoom user id.

## Hosts

The cookie is host-only and the redirect URI is fixed, so sign-in always lands
on `WEB_ORIGIN` (the canonical web host) whichever host the user started from.
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

1. Deploy dev, open `https://www.timer-dev.simple-tech.app/app`, click
   **Sign in with Zoom** in the top bar, allow.
2. You land back on `/app`; the top bar shows **Account** (or **Pro**).
   PostHog now shows the person `zoom:<uid>` with `surface: web`.
3. Change a timing rule; `wrangler tail --env dev` shows `PUT /api/profile`
   (200 if Pro or unenforced, 402 otherwise). Open the Zoom app on dev: the rule
   is there.
4. `/account`: plan, Manage billing, Sign out. `?signin=failed&reason=…` is
   shown when the callback could not finish.
