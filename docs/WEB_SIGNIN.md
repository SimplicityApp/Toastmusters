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
   `reason=scope_not_granted` and nobody can sign in on the web (see
   [Why a sign-in failed](#why-a-sign-in-failed)).

   Adding a scope does not cut existing users off at once: Zoom keeps their
   current authorization working for 90 days, then the refresh token expires
   and they re-consent (see `ZOOM_AUTH_AND_REDIRECTS.md`). Dev testers should
   re-run the authorize URL in `docs/ZOOM_TEST_PLAN.md` right away so the new
   scope is exercised. Add it once, together with the listing update for Pro,
   and submit for re-review in one go.
3. Confirm once, on dev, that `users/me.id` equals the `uid` the app context
   carries (sign in on the web, then compare the PostHog person id with the
   one the Zoom app reports). Both are documented as the Zoom user id.

## Why a sign-in failed

The Worker cannot render a page, so every failure after the state check is a
302 back to `returnTo` with `?signin=failed&reason=<key>`. The web app turns the
key into copy (`apps/web/src/utils/signinFailure.js`); an unknown key shows the
generic "Sign-in did not finish" line.

| `reason` | Cause |
|---|---|
| `state_mismatch` | The `tt_oauth` nonce cookie is missing or differs (expired link, other host) |
| `denied` | The user declined Zoom's consent screen (`error=access_denied`) |
| `no_code` | Zoom came back with no `code` for any other reason |
| `not_configured` | `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` missing |
| `exchange` | The token exchange failed, or returned no access token |
| `scope_not_granted` | `/users/me` failed **because the user-read permission is missing** |
| `profile` | `/users/me` failed for any other reason (bad or expired token, outage), or answered without an `id` |
| `session` | The session token could not be minted |
| `network` | Anything threw (network, unparseable response) |

`scope_not_granted` is told apart from `profile` by either of two signals, and
neither one ever blocks a sign-in whose `/users/me` call succeeds:

- **The granted scopes.** The token response's `scope` is a string that names
  none of `user:read:user`, `user:read:user:admin`, `user:read` or
  `user:read:admin`. An absent `scope` is "unknown", not "missing": one report
  says it can lag a Marketplace change.
- **Zoom's error.** `code: 4711`, or a message containing "does not contain
  scope" (Zoom has also been seen sending that message with `code: 104`). A bad
  or expired token is `401` with `code: 124` and stays `profile`.

The answer Zoom really gives a scope-less token is not documented, so the
Worker logs it: `wrangler tail` shows
`Zoom users/me failed: <status> <code|-> <token-scope,error-code|no-scope-signal>`.
The token is never logged.

### Server-side events

Every callback that gets past the state check (that is, every `failed(reason)`
and every success) records exactly one outcome to PostHog from the Worker, so
the two counts together are every sign-in that reached Zoom's callback. An ad
blocker cannot hide these.

| Event | When | Properties |
|---|---|---|
| `web_signin_succeeded` | A session was minted | — |
| `web_signin_failed` | Any `failed(reason)` | `reason`, plus `zoom_status` (and `zoom_code` from `/users/me`) when a Zoom call failed |
| `zoom_scope_not_granted` | `reason=scope_not_granted`, in addition to `web_signin_failed` | `zoom_status`, `zoom_code`, `scope_signal: token_scope \| error_code \| both` |

- Every event carries `surface: 'web'` and `$process_person_profile: false`:
  they are counters and never create a PostHog person.
- `distinct_id` is `zoom:<uid>` on success (the id the clients identify as) and
  `signin:<nonce>` on failure, one per attempt, since a failure never learns
  the Zoom id.
- The capture runs under `ctx.waitUntil`, so the redirect never waits on
  PostHog, and a capture failure is logged and swallowed. With no
  `POSTHOG_API_KEY` nothing is sent. The helper is `worker/posthog.js`, shared
  with the Zoom webhook.

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
   PostHog now shows the person `zoom:<uid>` with `surface: web`, and one
   `web_signin_succeeded` event from the Worker. `wrangler tail --env dev`
   shows no `Zoom users/me failed` line.
3. Change a timing rule; `wrangler tail --env dev` shows `PUT /api/profile`
   (200 if Pro or unenforced, 402 otherwise). Open the Zoom app on dev: the rule
   is there.
4. `/account`: plan, Manage billing, Sign out. `?signin=failed&reason=…` is
   shown there, and by `SignInFailureNotice` above every other route — the
   header's sign-in link carries whatever page it was clicked from as
   `returnTo`, so a failure can come back anywhere.
5. Start a sign-in from a non-canonical host (the apex, or the toastmusters.com
   dev host). It should hand off to `WEB_ORIGIN` and complete.
