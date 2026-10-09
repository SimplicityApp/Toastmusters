# Zoom Marketplace listing — Pro plan update

Submit together with the `user:read:user` scope (web sign-in). One re-review.

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
- `user:read:user` — read the user's Zoom id after "Sign in with Zoom" on the
  website, so the same person has the same settings and plan on the web. We read
  and store the Zoom **user id only**; we do not read or store a name, an email
  address or any other profile field from this scope.

## What is stored, for the data-handling questionnaire

Previous versions of this document said "No email or profile data is stored".
That is **no longer true**, and the change has to be declared:

- **A billing email address is stored** for anyone who buys Pro. It is the
  address the buyer enters on Stripe's own checkout page, saved against their
  Stripe customer id so the club's admin console can be reached by a mailed
  sign-in link after the officer who bought it has moved on. It never comes from
  Zoom, and it is never read from a Zoom scope.
- **Timing reports are stored server-side** for a club that has Pro: speaker
  name as typed by the timer, role, duration and any comment, in the club's own
  archive. Free devices keep reports on the device only, exactly as before.
- Still unchanged: the Zoom user id is an opaque identifier, participant names
  read from a meeting are used in the app and never sent to our servers, and card
  numbers are never seen by us.

The privacy policy (`apps/zoom-app/public/privacy.html`) carries all three.

## Links Zoom asks for

- Privacy policy: https://www.timer.simple-tech.app/privacy (updated Sep 27, 2026 — billing email, club records, club report archive)
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
