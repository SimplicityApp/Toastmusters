# Zoom Marketplace listing — Pro plan update

Submit together with the `user:read:user` scope (web sign-in). One re-review.

## Pricing disclosure (listing → Pricing)

Free plan: the full timer — speech timing, agenda, roles, reports, timing
cards on your video, virtual backgrounds. No account, no sign-in.

Pro plan (paid, per Zoom user, monthly or yearly, billed by Stripe outside
Zoom): your timing rules, roles, agenda and display options follow you to
every computer you run a meeting from, in Zoom and on the web; your custom
card artwork is backed up and synced. Cancel any time. Prices at checkout.

## Description paragraph to add

> **Pro (optional):** Run meetings from more than one computer? Pro keeps your
> setup the same everywhere — timing rules, roles, agenda, display options and
> your own card artwork — in Zoom and at timer.simple-tech.app. The timer itself
> stays free.

## Scopes / capabilities to declare and justify

- `getAppContext` — recognise a returning user (already granted).
- `user:read:user` — read the user's Zoom id after "Sign in with Zoom" on the
  website, so the same person has the same settings and plan on the web.
  No email or profile data is stored.

## Links Zoom asks for

- Privacy policy: https://www.timer.simple-tech.app/privacy (updated Sep 8, 2026)
- Terms of use with billing and refunds: https://www.timer.simple-tech.app/terms-of-use
- Support: https://www.timer.simple-tech.app/support

## Test instructions for the reviewer

1. Open the app in a meeting. The footer shows **Upgrade**.
2. Upgrade → Monthly opens Stripe Checkout in the system browser (test mode
   on the dev app: card 4242 4242 4242 4242).
3. Back in Zoom the footer flips to **Pro** within a minute; **Pro** →
   **Manage billing** opens the Stripe portal to cancel.
4. Nothing in the timer is behind the paywall.
