# Zoom authorization states, `promptAuthorize`, and where redirects land

What a day of testing established about how the Zoom client treats this app's
users, when it grants `promptAuthorize`, which URL each "add / approve" path
lands on, and how to put a test account into each state on purpose. Read this
before touching `ZoomConnectionNotice`, the install link, or Step 1c of
`ZOOM_TEST_PLAN.md`.

## The three auth states

`getUserContext().status` — the value `resolveConnectionState` decides from —
has three values. `config()`'s `auth.status` is typed as two but the real
client returns all three; log both (`Zoom SDK configured` and the
`getUserContext:` line beneath it).

| status | Meaning | What the app does |
|---|---|---|
| `unauthenticated` | Not signed into Zoom at all. A true guest, in the client's **basic mode**. | Nothing. Not the organizer; `promptAuthorize` is refused anyway (`disabled_for_basic_mode`). |
| `authenticated` | Signed into Zoom, has **not** added the app (or the grant lapsed). Zoom asks permission on every `setVirtualBackground`. | `CONNECTION_UNAUTHORIZED`: amber banner + "Approve in Zoom" modal. |
| `authorized` | Added the app and consented to the current scopes. | Nothing — the healthy state. |

## `promptAuthorize` is contextual, not a capability grant

Every other API in `USED_SDK_APIS` is granted or refused by the Marketplace
API list. `promptAuthorize` is refused by the **client, per state**: it walks a
user *up* the ladder (sign in → add the app), so for an `authorized` user there
is nothing to prompt and the client lists it in `unsupportedApis`.

Consequences:

- **27/28 with only `promptAuthorize` missing is the healthy, fully-authorized
  panel.** It is not misconfigured.
- Enabling it in the Marketplace changes nothing for an authorized user. It
  appears in the granted set exactly when the user is `authenticated`, which is
  exactly when the notice needs it, because `configureZoomSdk()` re-runs on
  `onMyUserContextChange`.
- After a successful approval it goes **back** to refused in the second
  `Zoom SDK configured` line — that flip is the proof the flow completed.

## The two paths behind "Approve in Zoom"

`approveInZoom()` in `ZoomConnectionNotice.jsx`:

1. **In-client consent** — `promptZoomAuthorize()` resolves `true`, the log
   says `Asked Zoom to prompt the user to add the app`, the modal closes and
   **our code opens no URL**. Zoom shows its own consent inside the client.
   Where the user lands afterwards is decided entirely by the app's
   **Marketplace configuration**, not by anything the app passes.
2. **Browser fallback** — the client refused `promptAuthorize` (log:
   `promptAuthorize not granted by this client; falling back…`) or the call
   threw. The app opens `installUrl()` in the system browser.

### Where the browser fallback's URL comes from

`installUrl()` resolves, in order:

1. `<meta name="zoom-install-url">`, stamped into the shell per request by the
   Worker (`fetchZoomShell`) from `ZOOM_CLIENT_ID` + `WEB_ORIGIN` — the same
   values its OAuth callback uses, built by `zoomAuthorizeUrl()` in
   `worker/auth.js`. The client accepts it only if its origin equals
   `ZOOM_AUTHORIZE_URL`'s (one shared constant in `packages/shared/appLinks.js`).
2. `VITE_ZOOM_OAUTH_REDIRECT`, inlined by Vite **at build time** from the root
   `.env` of whichever machine ran `npm run build`. A Cloudflare dashboard
   variable of that name is inert: Worker bindings never reach the bundle, and
   `wrangler deploy` deletes dashboard-only vars (no `keep_vars`).
3. `ZOOM_INSTALL_URL` (the production app), from the shared package.

Hosting matters for which layer wins:

| Host | Served by | Stamp? | Fallback link |
|---|---|---|---|
| `zoom.timer-dev.simple-tech.app` | Cloudflare Worker `--env dev` | yes — dev client id, `timer-dev` redirect | whatever the deploying machine had in `.env` |
| `zoom.timer.simple-tech.app` (prod) | Vercel | no | build-time value = production app |

Verify a deployment in one line — the stamp is applied with or without the
`x-zoom-app-context` header:

```bash
curl -s https://zoom.timer-dev.simple-tech.app/ | grep -o '<meta name="zoom-install-url"[^>]*>'
```

The marketing site's "Add to Zoom" (`Landing.jsx`, `Footer.jsx`,
`ReviewPromptModal.jsx`) still reads `VITE_ZOOM_OAUTH_REDIRECT` at build time
and is **not** stamped.

## What forces users to re-consent — and what does not

| Change in the Marketplace | Effect on existing grants |
|---|---|
| Add / remove an API under **Features → APIs** | None. Propagates on the next `config()`; the user stays `authorized`. Verified by enabling `onShareScreen` + `getMeetingView` live. |
| Add / remove an **OAuth scope** | Existing authorization keeps working for **90 days**, then the refresh token expires and the user re-authorizes ([Zoom: updating published apps](https://developers.zoom.us/docs/distribute/published-apps/updating/)). An *Optional* scope never forces anything. Not immediate — verified by adding a scope and staying `authorized`. |
| Redirect URL / allow list | None. |

So neither "change a capability" nor "add a scope" is a way to reach
`authenticated` for testing. See the next section.

## Reaching the `authenticated` state deliberately (guest-mode testing)

There is no link, listing or deeplink that opens the app for a non-owner
without adding it — deeplinks fall back to the install page, and Local Test →
Add App authorizes. The only door is **another signed-in Zoom account in the
same meeting**, which needs two concurrent sessions (a phone, or a second
desktop instance per [Zoom's testing guide](https://developers.zoom.us/docs/zoom-apps/guides/testing/)).

Setup (unpublished app; owner **A**, guest **B** = a free account that never
adds the app):

1. Marketplace → the dev app → **Features**: enable **Guest Mode** *and*
   **Guest Mode Testing**.
2. On any Mac that will be B: `defaults write ZoomChat enableGuestModeTesting true`,
   then fully quit Zoom. With the flag **off**, a dev app refuses guests
   outright: *"You are not allowed to use this Zoom App in guest mode…"*
   ([Zoom staff: required until the app is published](https://devforum.zoom.us/t/guest-mode-error-in-unpublished-app/77031)).
3. A starts a meeting and opens the timer; B joins signed in.

Which door B uses decides the state, and it is not the same on every client:

| B opens the app… | Desktop 7.2.x (flag on) | iPhone |
|---|---|---|
| from A's **in-meeting invitation** (`invitationId` in the config log) | `unauthenticated`, basic mode, `promptAuthorize` refused | `authenticated` |
| from the **App Launcher / Apps panel** (no `invitationId`) | `authenticated`, `promptAuthorize` granted | `authenticated` |

Zoom also caches the auth state for the meeting session: signing in or out
mid-meeting is not seen until leave-and-rejoin
([forum](https://devforum.zoom.us/t/recently-signed-out-users-unable-to-access-guest-mode-until-they-rejoin-the-meeting/71147)).
Sign in **before** joining.

To re-run the flow after B has approved once, remove the app from B's account
(Marketplace → Manage → Added Apps) and reopen from the launcher.

## Known dev-only quirk: in-client consent on the dev app lands on production

Observed 2026-09-25, desktop 7.2.2, B `authenticated`, dev app: after
`Asked Zoom to prompt the user to add the app` and approval, the browser
opened `https://www.timer.simple-tech.app/` (the **root** of the production
host). Established:

- Our code opened nothing (path 1 above).
- `wrangler tail --env dev` saw **no request at all** reach `timer-dev`
  afterwards — no callback, no reload.
- The dev app's **Development** OAuth Redirect URL *is*
  `https://www.timer-dev.simple-tech.app/oauth/redirect`. The landing URL is
  in neither the redirect field nor the allow list, so a third Marketplace
  field decides it (Home URL / Direct Landing URL, or the production
  credentials' redirect being used for an in-client add on an unpublished
  app). The production `/oauth/redirect` route does not bounce to `/`, so the
  landing was direct.

Not fixed on purpose: only the developer ever installs the dev app, and the
stamped browser fallback — the path real users hit on a client that refuses
`promptAuthorize` — is verified to point at dev. If it ever matters, try in
this order: remove the stray `https://www.timer.simple-tech.app/oauth/redirect`
entry from the dev app's allow list and enable **Use Strict Mode for Redirect
URLs**; check the dev app's Home URL and Direct Landing URL; re-run with the
Worker tail open to see whether a code ever reaches `timer-dev`.

## Reading the debug panel

| Log line | Means |
|---|---|
| `"unsupportedApis":[…,"promptAuthorize",…]` with `auth.status: authorized` | Healthy. Nothing to prompt. |
| `Client refused: … onShareScreen …` then `Subscribed to onShareScreen` | The guard used `typeof zoomSdk.x === 'function'`, which every client passes; the subscription is dead. Use `isApiAvailable`. |
| `disabled_for_basic_mode` | The user is `unauthenticated`; expected refusals. |
| `Asked Zoom to prompt the user to add the app` | In-client consent ran; any redirect after this is Marketplace config, not app code. |
| `promptAuthorize not granted by this client; falling back…` | Browser fallback; the URL is `installUrl()` — check the stamp. |
| `User context changed; Zoom now reports the user as authorized` after a second `Zoom SDK configured` | Approval completed; `promptAuthorize` should now be refused again. |
