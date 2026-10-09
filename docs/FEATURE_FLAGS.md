# Feature flags — releasing Pro, clubs and web sign-in

A release flag answers one question: **is this code path switched on yet?** It
is not entitlement. Whether someone is paying stays in
`worker/entitlements.js`, and a flag never grants Pro to anyone. A flag only
decides whether unfinished work is visible at all. That lets the work merge to
`master` dark, be turned on for named accounts in production without a deploy,
and then be widened.

PostHog owns the flag definitions and the targeting, so a flag is flipped in its
dashboard. The Worker (`worker/flags.js`) owns the evaluation and the fallback.
The browser never asks PostHog about a flag.

## How it fits together

```
POST /api/zoom/session  (Zoom app, once per app load)
GET  /api/me?flags=1    (web app identity call, once per page load)
  → resolveFlags(env, { uid })
      FLAGS_FORCE "1" / "0"      → every flag on / off, PostHog not asked
      no POSTHOG_API_KEY         → FLAG_FALLBACKS
      edge cache hit (60 s)      → cached answer
      POST https://us.i.posthog.com/flags?v=2  { api_key, distinct_id }
        ok                       → declared keys only, cached 60 s
        any failure              → FLAG_FALLBACKS (not cached)
  → { …, flags: { pro, contact_capture } }
  → packages/shared/flags.js (setFlags, known = true) → useFlag(key) → UI

Server gates: flagEnabled(env, key, { uid }) → bare 404 when off
```

- **Distinct id.** `zoom:<uid>`, the same id both apps already identify with in
  PostHog. One condition therefore targets a person in the Zoom app and on the
  web at once. A caller with no uid (a Zoom guest, a signed-out browser, a club
  device with no Zoom identity) is asked about as the literal id `anonymous`.
- **Once per session.** Only the two identity calls resolve flags.
  `refreshEntitlement` and `waitForPro` poll bare `GET /api/me`, which carries
  no `flags` and makes no PostHog request. The client store has no polling and
  no focus listener, so a flag never changes under someone mid-meeting.
- **Never fails closed.** A timeout (1.5 s), a 5xx, a malformed body, a network
  error or a `quotaLimited` answer all return the checked-in `FLAG_FALLBACKS`.
  A failure is logged as `flags: falling back to checked-in values: …` and is
  not cached, so the next session retries.
- **The key.** `/flags` takes the public project key, which is the existing
  `POSTHOG_API_KEY` secret that `worker/zoom-webhook.js` already uses for
  capture. There is no new secret. The Worker calls PostHog's ingestion host
  directly, not the browser's `e.simple-tech.app` proxy.
- **UI gating.** `useFlag(key)` returns `{ enabled, known }`, shaped like
  `useEntitlement`. A gated control renders only when
  `flagsKnown && enabled`, so it never appears and then vanishes. A whole web
  page is gated at its route instead, with `<FlagGate flag="pro">` in
  `apps/web/src/App.jsx`: the page is not mounted until the flag is known and
  on, and is the not-found view while it is off.

## The flags

There are two flags, `pro` and `contact_capture`, declared in `FLAG_FALLBACKS`
in `worker/flags.js`, each with a `removeBy` date in a comment. Both fallbacks
are `false`: the safe value, not the current one. **Both must exist in PostHog
before they can be turned on in production**; until then the fallback applies.

`contact_capture` gates one thing: the Zoom app asking Zoom for an
authorization code (`zoomSdk.authorize`) so the Worker can save the user's Zoom
email and name (`apps/zoom-app/src/components/ContactCapture.jsx`,
`worker/contact.js`). It is a UI-only gate. `POST /api/zoom/contact` is not
gated, because without the flag the app never has a code to send. The browser
doors that save the same record (install/re-add and web sign-in) are not
flagged at all. It is also an example of [a Zoom capability that is approved
but dark](#zoom-capabilities-approved-but-dark): the app needs `authorize` and
`onAuthorized` from the Marketplace as well as the flag. To try it in
production, create `contact_capture` in PostHog and target yourself as in
[Turning a flag on](#turning-a-flag-on-for-yourself-in-production); the
measured funnel is in `docs/ZOOM_LISTING_PRO.md`.

`pro` covers billing, web sign-in and clubs. They are all Pro features that
launch together, so one switch covers them.

| Surface | 404 / hidden while `pro` is off (or, in the UI, unknown) | Never gated |
|---|---|---|
| Billing | `POST /api/billing/checkout`, `POST /api/billing/portal` (after the session check, so no session is still 401). Zoom: the Footer **Upgrade**/**Pro** button and the **Upgrade to Pro** link in Card images, which are the Upgrade modal's only doors. Both apps: **Manage billing** on the club banner. Web: the plan section on `/account` | `GET /api/billing/checkout-status`, the Stripe webhook, the success/cancel pages, entitlement itself |
| Web sign-in | `GET /api/auth/zoom/start`. A sign-in callback on `/oauth/redirect` falls through to the install page instead, so Marketplace installs keep working. Web: **Sign in** in the account menu, the signed-out card on `/account` | `POST /api/auth/logout` |
| Clubs | `/api/club/activate`, `/create`, `/magic-link` and `/manage`, whatever the method, checked before anything else so even an unauthenticated create is 404. Zoom: the code field and **Set up my club**, inside the Upgrade modal. Web: the setup card and code field on `/account`; `/club/admin`, `/club/manage` and `/pro/:code` are the not-found view (`FlagGate`) | `GET /api/club` (the daily refresh), presets, `meetings/*` (including queued speeches), the admin routes, `manage/signout`, `/api/club-assets/*` |

A refusal is a bare 404, the same as any unknown URL. The reason is logged
server-side only, as `flag off: pro <route>`, so it shows in
`wrangler tail` and nowhere on the wire.

### Caveats

- **Turning `pro` off stops new club joins, not existing clubs.** A blanket 404
  would evict club devices: `refreshClub` reads a 404 from `GET /api/club` as a
  spent credential and leaves the club, and the speech outbox drops a queued
  speech on any 4xx. So only the doors are gated. A device that already holds a
  club token keeps its club, its presets and its archive. A true kill switch
  for existing clubs is out of scope.
- **A club device with no Zoom identity resolves as `anonymous`.** The club
  doors read a session when one rides along (the Zoom app's bearer, a web
  cookie), and otherwise use the anonymous position. So a guest device, a
  signed-out browser on `/pro/:code`, and a mailed admin link opened without a
  web session all follow the **everyone** condition, not your per-account one.
  Single-account targeting of clubs only works from an identified session.
- **Web sign-in is effectively everyone-or-nobody.** The person signing in is
  signed out by definition, so the start and the callback are both evaluated as
  `anonymous`. Targeting `zoom:<your-uid>` alone never shows you the link. To
  try it in production, add a condition for `distinct_id` = `anonymous` at
  100%, sign in, then remove it. The session lasts 30 days, and while it
  exists the web app resolves `pro` under your uid. During that window (plus up
  to 60 s of cache) every signed-out visitor and Zoom guest is on the anonymous
  position too: they see the sign-in link, and the doors into a club
  (`/pro/:code`, the code field, a mailed admin link) open for them. Billing
  does not, because checkout needs a session and is evaluated by uid.
- **Guests never join a partial rollout.** Every uid-less caller shares the one
  `anonymous` id, so a percentage rollout puts all of them in or all of them
  out together. Treat the anonymous position as on only at 100%.

## Finding your uid

- **PostHog → Persons**, search `zoom:`. The Zoom app identifies as
  `zoom:<uid>` on every identified load (see Step 1b of
  [ZOOM_TEST_PLAN.md](./ZOOM_TEST_PLAN.md)). This works even while `pro` is
  dark.
- **`GET /api/me`** in a browser signed in on the web app. The first field is
  `uid`. Add `?flags=1` to also see what the Worker resolved for you.

Use the part after `zoom:` as the uid. PostHog conditions use the full
`zoom:<uid>`.

## Turning a flag on for yourself in production

1. PostHog (the project `POSTHOG_API_KEY` belongs to) → **Feature flags** →
   **New feature flag**. The key must be exactly the one in `FLAG_FALLBACKS`
   (`pro`). Boolean, not multivariate.
2. Release conditions:

   ```text
   Condition 1:  distinct_id  is any of  zoom:<your-uid>, zoom:<tester-uid>   → 100%
   Condition 2:  everyone                                                     →   0%   ← widen this
   ```

3. Save. A fresh app load or page load picks it up within about 60 s (the
   per-id edge cache, per Cloudflare location). An already-open Zoom webview or
   page keeps the answer it loaded with until it reloads.
4. Check it: the Zoom app shows **Upgrade**, or `GET /api/me?flags=1` shows
   `"pro": true`. A second account still sees nothing.

**Widening** is Condition 2: raise the percentage, then set it to 100% for
everyone. Guests and signed-out visitors follow Condition 2 only, and only
reliably at 100% (see the caveats).

**Turning it off** needs no build: set Condition 2 to 0% and remove Condition 1,
or disable the flag. New sessions go dark within about 60 s. A flag missing
from PostHog, or a PostHog outage, falls back to `false`, which is the same as
off.

## `FLAGS_FORCE` per environment

`FLAGS_FORCE` short-circuits PostHog entirely, in the same way
`ENTITLEMENT_ENFORCE` differs between the two `wrangler.jsonc` blocks. It is
declared in both blocks, because `vars` are not inherited.

| Value | Effect |
|---|---|
| `"1"` | Every declared flag on. No PostHog request. |
| `"0"` | Every declared flag off. No PostHog request. |
| `""` or unset | Ask PostHog (or the fallbacks, if `POSTHOG_API_KEY` is missing). |

| Where | Value | Why |
|---|---|---|
| Production (top-level `vars`) | `""` | Always asks PostHog. `worker/flags.test.js` fails if this is ever `"1"`, which would light up every dark feature at once. |
| Dev (`env.dev.vars`) | `"1"` | Dev works with everything on and spends none of the free quota. Set `"0"` to see the dark path, or `""` to test the real PostHog round trip. Restore `"1"` and redeploy afterwards. |
| Local (`npm run cf:dev`) | set in `.dev.vars` | `wrangler dev` runs **without** `--env dev`, so it reads the production block (`""`). With no `POSTHOG_API_KEY` in `.dev.vars` every flag is at its fallback, so every gated feature is hidden. Put `FLAGS_FORCE=1` in `.dev.vars` to see them, or `FLAGS_FORCE=0` to check the dark path. `.dev.vars` overrides `vars`. |

**Dev and prod share one PostHog project**, and a `zoom:<uid>` is the same id in
both. So while dev's `FLAGS_FORCE` is cleared, a condition that targets you
turns the feature on for you in production too. Keep dev on `"1"` except while
testing the round trip.

Changing `FLAGS_FORCE` on a deployed Worker is a redeploy
(`npm run cf:deploy:dev`). Flipping a flag in PostHog is not.

## Adding a flag

1. Declare it in `FLAG_FALLBACKS` (`worker/flags.js`) as `false`, with a
   comment saying what it gates and a `removeBy` date.
2. Gate the server first. Put `flagEnabled(env, '<key>', { uid }, ctx)` in the
   endpoint and answer `notFound()` when it is off, with a
   `console.log('flag off: <key>', route)`. Do not gate an endpoint whose 404
   a client reads as a final answer (see the caveat about existing clubs).
3. Gate the UI with `useFlag('<key>')`, rendering only when
   `known && enabled`, beside any entitlement `known` gate already there. Gate a
   whole web page at its route with `<FlagGate flag="<key>">` instead of inside
   the page.
4. Add the endpoint to the gated-endpoint table in `worker/flags.test.js`, in
   both positions, and give each gated component a test for "hidden while
   unknown", "hidden when off" and "shown when on".
5. Create the flag in PostHog before you rely on it. Until it exists, the
   fallback (`false`) applies everywhere.

`worker/flags.test.js` scans `worker/**/*.js` and `apps/*/src/**/*.{js,jsx}`
(excluding tests). It fails if the code reads a key that `FLAG_FALLBACKS` does
not declare, or if `FLAG_FALLBACKS` declares a key nothing reads.

## Retiring a flag

The order matters, and no test can check the PostHog side:

1. In PostHog, set the flag to everyone at 100% and let it run.
2. **Delete the code reference and ship it to production.** Remove the key from
   `FLAG_FALLBACKS`, every `useFlag`/`flagEnabled` call for it, and its rows in
   `worker/flags.test.js`. The source scan makes you do these together.
3. **Then delete the PostHog flag.**

The other way round, a released feature goes dark: while code still reads the
key, a deleted PostHog flag falls back to `false`. A PostHog flag left behind
after the code is gone is harmless, because nothing reads it.

Do not retire a flag by changing its fallback to `true`. The test that every
fallback is `false` refuses that.

## Zoom capabilities: approved but dark

Adding an API under **Features → Zoom App SDK → Add APIs** propagates to every
client on its next `config()`, with no re-consent (see
[ZOOM_AUTH_AND_REDIRECTS.md](./ZOOM_AUTH_AND_REDIRECTS.md#what-forces-users-to-re-consent--and-what-does-not)).
Without a flag, the feature that uses it lights up for everyone the moment Zoom
approves. With one, the release moment is ours:

1. Add the capability to `USED_SDK_APIS` in `apps/zoom-app/src/utils/zoomSdk.js`
   and call it through the usual `isApiAvailable` path. Always request it: until
   Zoom grants it, it lands in `unsupportedApis` and the feature degrades as any
   other missing capability does. Do not make the `config()` list depend on a
   flag, because that would weaken the `USED_SDK_APIS` source-scan test.
2. Declare a flag for the feature and wrap its UI in `useFlag`, as in
   [Adding a flag](#adding-a-flag). Merge to `master` dark.
3. Submit to Zoom and add the API in the Marketplace whenever it suits you.
4. When Zoom approves, the capability is available but the feature stays dark.
   Target yourself in PostHog, check it in the real client, then widen.
5. Retire the flag once it has been on for everyone for a while.

A capability granted mid-session becomes available at once, because
`handleMyUserContextChange` re-runs `configureZoomSdk()`. The feature still
follows the flag the webview loaded with. That is correct, but worth knowing
while debugging.

## Testing

```bash
source ~/.nvm/nvm.sh && nvm use 22
npx vitest run worker/flags.test.js   # resolver, FLAGS_FORCE, cache, gates, source scan, wrangler guard
npm test                              # the whole workspace
```

Run the tests under **Node 22**. Node 26 breaks jsdom `localStorage` for the
whole suite. No CI runs these tests; they only run when someone types
`npm test`.

The end-to-end check on dev, against the real PostHog:

1. Create the `pro` flag in PostHog as in
   [Turning a flag on for yourself](#turning-a-flag-on-for-yourself-in-production).
2. Clear `FLAGS_FORCE` in `env.dev.vars` and `npm run cf:deploy:dev`.
3. In the real Zoom client, your account sees **Upgrade** and a second account
   does not. Toggle the flag in PostHog: a fresh app load reflects it within
   about 60 s.
4. Restore `FLAGS_FORCE` to `"1"` and redeploy.
