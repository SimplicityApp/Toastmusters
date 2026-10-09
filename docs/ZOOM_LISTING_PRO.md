# Zoom Marketplace listing — Pro plan update

Submit together with the `user:read:user` scope (web sign-in, and saving each
user's Zoom email and name) and the `authorize` / `onAuthorized` SDK APIs. One
re-review. The operator steps are in [Before submitting](#before-submitting).

## Pricing disclosure (listing → Pricing)

Free plan: the full timer — speech timing, agenda, roles, reports, timing
cards on your video, virtual backgrounds. No account, no sign-in.

Pro plan (paid, per Zoom user, monthly or yearly, billed by Stripe outside
Zoom): one Pro account for a whole Toastmasters club. The club's shared timing
presets arrive on every timer's device; the club's name, logo and colour render
on the timing cards and on the timing report; every meeting is saved to the
club's archive and can be shared as a branded image or link. The buyer's own
timing rules, roles, agenda and display options also follow them between
computers, and their custom card artwork is backed up. Cancel any time. Prices
at checkout.

## Description paragraph to add

> **Pro (optional):** One Pro account for your whole club. Your club's timing
> presets and branding arrive on every timer's device — they enter a short club
> code once, no sign-in needed — and every meeting is saved to your club's
> archive and shareable in one tap. Your own setup also follows you between
> computers, in Zoom and at timer.simple-tech.app. The timer itself stays free.

## Scopes / capabilities to declare and justify

- `getAppContext` — recognise a returning user (already granted).
- `user:read:user` — read the user's own Zoom profile (`GET /v2/users/me`) at
  three moments: after "Sign in with Zoom" on the website, after the app is
  added or re-added from a browser, and when the app asks Zoom for an
  authorization code inside the client. Justification text:

  > We use this scope to read the signed-in user's Zoom user ID, email address,
  > first name and last name. The user ID gives the same person the same
  > settings and plan on our website as in the Zoom app. The email address and
  > name are stored against that user ID so we can email the user about the
  > app: important changes, new features and occasional requests for feedback.
  > Every such email includes an opt-out. We read no other profile field, we
  > never show these details to other users, we do not share or sell them, and
  > we delete them when the user removes the app and Zoom tells us not to keep
  > their data. We do not store Zoom access or refresh tokens.

- `authorize` (Zoom Apps SDK) — ask Zoom, from inside the client, for an OAuth
  authorization code with PKCE. It is silent for a user who has already
  approved the app's scopes, and shows Zoom's own consent screen to one who has
  not. The app hands the code to our server, which exchanges it, checks that it
  belongs to the same Zoom user as the app session, and saves that user's email
  and name as above. It runs only while no speech is being timed. A user who
  skips Zoom's screen never sees it unprompted again: they are offered the same
  approval through a dismissible in-app card, at most once a week. A save that
  fails is retried after a week, not on every open.
- `onAuthorized` (Zoom Apps SDK) — receive the authorization code that
  `authorize` produces. Events whose `state` this page did not send are ignored.

## What is stored, for the data-handling questionnaire

Previous versions of this document said "No email or profile data is stored".
That is **no longer true**, and the change has to be declared:

- **A billing email address is stored** for anyone who buys Pro. It is the
  address the buyer enters on Stripe's own checkout page, saved against their
  Stripe customer id so the club's admin console can be reached by a mailed
  sign-in link after the officer who bought it has moved on. It is kept
  separately from the Zoom account email below and is not used for marketing.
- **The Zoom account email, first name and last name are stored** for every
  user who adds or re-adds the app from a browser, approves the app's
  `authorize` request inside the client, or signs in on the website. They are
  read from `GET /v2/users/me` under `user:read:user` and stored in Cloudflare
  KV under `contact:zoom:<uid>` as `{ email, firstName, lastName, updatedAt }`.
  The purpose is emailing the user about the app, with an opt-out in every
  email. No endpoint returns the record; the app learns only whether one
  exists. An empty or invalid email from Zoom is never stored over a good one.
  When Zoom sends `app_deauthorized` with `user_data_retention: "false"`, the
  record is deleted together with the synced settings and card artwork.
- **Timing reports are stored server-side** for a club that has Pro: speaker
  name as typed by the timer, role, duration and any comment, in the club's own
  archive. Free devices keep reports on the device only, exactly as before.
- Still unchanged: the Zoom user id is an opaque identifier, participant names
  read from a meeting are used in the app and never sent to our servers, and card
  numbers are never seen by us.

The privacy policy (`apps/zoom-app/public/privacy.html`) carries all of these.

## Links Zoom asks for

- Privacy policy: https://www.timer.simple-tech.app/privacy (updated Oct 4, 2026 — Zoom account email and name, email opt-out, deletion on uninstall; Sep 27, 2026 — billing email, club records, club report archive)
- Terms of use with billing and refunds: https://www.timer.simple-tech.app/terms-of-use
- Support: https://www.timer.simple-tech.app/support

## Test instructions for the reviewer

1. Open the app in a meeting. The footer shows **Upgrade**.
2. Upgrade → Monthly opens Stripe Checkout in the system browser (test mode
   on the dev app: card 4242 4242 4242 4242).
3. Back in Zoom the footer flips to **Pro** within a minute; **Pro** →
   **Manage billing** opens the Stripe portal to cancel.
4. Nothing that was in the free timer is behind the paywall. Pro adds club-level
   features on top: shared presets, club branding on cards and reports, and the
   club archive.
5. To see the club layer without paying, ask us for a test club code and enter it
   under **Upgrade → "Already on Pro through your club?"**. It works with no
   sign-in at all.
6. To see the `authorize` request, open the app with an account that has added
   it but has not yet approved the updated scopes, and leave the timer idle for
   a few seconds. Zoom's consent screen opens. Close it without approving (or
   leave it for two minutes): at the next idle moment a card titled **Stay in touch with Toastmusters Timer**
   appears at the bottom of the app, with **Approve in Zoom** and **Not now**.
   Starting a speech hides it. Approving saves the contact, and the app does
   not ask again.

## Before submitting

Operator steps. None of them is a code change.

1. **Add the APIs.** In the Marketplace, on both the dev and the production
   app, **Features → Zoom App SDK → Add APIs**: add `authorize` and
   `onAuthorized`. Until Zoom grants them, `isApiAvailable('authorize')` is
   false and the app never asks (see "Zoom capabilities: approved but dark" in
   [FEATURE_FLAGS.md](./FEATURE_FLAGS.md)).
2. **Check the Home URL.** The Worker exchanges an in-client code with
   `ZOOM_APP_HOME_URL` as the `redirect_uri`, and Zoom requires it to be the
   app's Home URL exactly, on the OAuth allow list. `wrangler.jsonc` sets it to
   `https://zoom.timer.simple-tech.app` (production) and
   `https://zoom.timer-dev.simple-tech.app` (`env.dev`). If either Marketplace
   app uses a different Home URL, change the variable, not the Marketplace.
   If the exchange still answers 400 on dev, the PKCE method is the next
   suspect: `PKCE_METHOD` in `apps/zoom-app/src/utils/zoomSdk.js` is `'plain'`
   (Zoom's docs) and switches to `'S256'` in one line.
3. **Create the `contact_capture` flag in PostHog.** The in-client path is
   behind the `contact_capture` release flag (`FLAG_FALLBACKS` in
   `worker/flags.js`, fallback `false`). Until the flag exists in PostHog,
   production never asks. Dev has `FLAGS_FORCE: "1"`, so it is always on
   there. Create it as a boolean flag with exactly that key, target yourself
   first, then widen, as in
   [FEATURE_FLAGS.md](./FEATURE_FLAGS.md#turning-a-flag-on-for-yourself-in-production).
   The browser doors (install/re-add and web sign-in) are not flagged and save
   the contact as soon as the scope is granted.
4. **Ship the privacy policy first.** The updated `privacy.html` must be live
   before the scope update is approved, because the install door saves the
   contact the moment Zoom starts returning it.
5. **Submit the scope update** with the justification above and the release
   notes below. Existing users keep their current grant for 90 days and then
   re-authorize; the in-client `authorize` request reaches most of them before
   that.
6. **Release notes for users** (the "Release Notes for User" field, which Zoom
   emails to subscribers):

   > Toastmusters Timer now asks Zoom for your email address and name, so we
   > can email you about important changes, new features and the occasional
   > request for feedback. Every email has an opt-out, and the details are
   > deleted if you remove the app and choose not to let us keep your data.
   > The timer itself is unchanged.

The in-client funnel is measured in PostHog with `contact_capture_prompted`,
`contact_capture_skipped`, `contact_capture_saved` (with `late: true` when the
code arrived after the 2-minute wait) and `contact_capture_dismissed` (the
card's **Not now** or close button). Each carries `source: auto | card`.
Operators read saved records with
`npx wrangler kv key list --binding PROFILES --prefix contact:zoom:` (add
`--env dev --remote` for dev).
