# Billing — Pro plan, Stripe, entitlements

Pro = **one Pro account for your whole club**: the club's shared timing presets,
its brand kit on cards and reports, its meeting archive, and the buyer's own
settings and card artwork synced between devices. The timer is free, always.
Bought per Zoom user, monthly or yearly, billed by our own Stripe account (not
Zoom's Marketplace billing, which is US-only).

The subscription is attached to the buyer; the **club** is what the rest of the
timers get, and it is a separate credential entirely. See
[CLUBS.md](./CLUBS.md) for the club model. This document covers the money.

## How it fits together

```
Zoom app ── POST /api/zoom/session ──▶ Worker ── uid + entitlement
   │                                       ▲
   │ Upgrade → POST /api/billing/checkout  │  Stripe webhook
   ▼                                       │  POST /api/stripe/webhook
System browser: Stripe Checkout ──────────▶ Stripe ───────┘
   │
   └─ redirected to WEB_ORIGIN/billing/success (asks GET /api/billing/checkout-status)
Zoom app polls GET /api/me until plan === 'pro'
```

- Identity: the Zoom `uid` from the decrypted app context (`worker/session.js`).
- Entitlement: `worker/entitlements.js`. Stored in the `PROFILES` KV namespace
  under `entitlement:zoom:<uid>`; hand grants under `grant:zoom:<uid>`;
  Stripe links under `stripe:customer:<cus_id>` / `stripe:customer-by-uid:zoom:<uid>`;
  processed webhook ids under `stripe:event:<evt_id>` (30-day TTL);
  payments waiting to become a club under `club-pending:<cus_id>`.
  Bind a namespace as `ENTITLEMENTS` to move them; no code change.
- Club records live in the same namespace under their own prefixes — `club:`,
  `club-by-code:`, `club-by-customer:`, `club-by-email:`, `club-presets:`,
  `club-device:`, `club-member:`, `club-magic:`, `meeting:`, `speech:`,
  `report-share:`. The full inventory is in
  [CLUBS.md](./CLUBS.md#kv-inventory).
- Gate: `PUT /api/profile` and `PUT /api/assets/*` answer `402 upgrade_required`
  for free users. GET stays open so a lapsed user keeps their data.
  `resolveAccess()` grants if the buyer's own subscription **or** the `X-Club`
  credential says yes, so an activated club device passes the same gate.
- Grace: `past_due` keeps Pro for 7 days after the period end; `canceled` keeps
  Pro until the paid period ends. The identical rules govern a club, so grace and
  lapse behave the same whether the money is attached to a person or to a club.
- `ENTITLEMENT_ENFORCE="0"` (dev) lets everyone through while still reporting
  `plan: "free"`, so the Upgrade button shows and Checkout can be tested.

## One-time Stripe setup (dashboard)

Do this in **test mode** first, then repeat in live mode.

1. Product "Toastmasters Timer Pro" with two recurring prices. Set their
   **lookup keys** to exactly `pro_monthly` and `pro_yearly`. The code finds
   prices by these keys; no price ids live in the repo.
2. Customer portal (Settings → Billing → Customer portal): enable cancel and
   payment-method update.
3. Webhook endpoint: `https://<WEB_ORIGIN>/api/stripe/webhook` with events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`. Copy its signing secret (`whsec_…`).
4. Optional: enable Stripe Tax, then set var `STRIPE_AUTOMATIC_TAX` to `"1"`.

## Secrets and vars

```bash
# dev (test keys)
npx wrangler secret put STRIPE_SECRET_KEY --env dev
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
# prod (live keys)
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Vars are in `wrangler.jsonc` per environment: `WEB_ORIGIN`,
`ENTITLEMENT_ENFORCE`, `STRIPE_AUTOMATIC_TAX`. Local: `.dev.vars`.

## Comping a user (owner, testers)

```bash
# forever
npx wrangler kv key put --binding PROFILES --env dev 'grant:zoom:<uid>' '{"reason":"owner"}'
# until a date (epoch ms)
npx wrangler kv key put --binding PROFILES --env dev 'grant:zoom:<uid>' '{"reason":"beta","exp":1790000000000}'
# revoke
npx wrangler kv key delete --binding PROFILES --env dev 'grant:zoom:<uid>'
```

Drop `--env dev` for production.

## Testing on dev

1. Set the dev secrets above (test mode) and deploy: `npm run cf:deploy:dev`.
2. In the Zoom app (dev), Footer → **Upgrade** → Monthly. A Stripe test page
   opens in the browser. Pay with `4242 4242 4242 4242`.
3. The success page says "You are on Pro". Within ~10 s the Zoom app flips to
   **Pro** and pushes its settings (`PUT /api/profile` → 200 in `wrangler tail --env dev`).
4. Stripe dashboard → the customer → cancel the subscription. On the next
   `customer.subscription.updated`/`deleted`, the app stays Pro until the period
   end, then reads `402` on pushes and shows Upgrade again.
5. Use Stripe **test clocks** to advance time through renewal, `past_due`, and
   cancellation without waiting a month.
6. `node scripts/club-cli.mjs pending --env dev` shows the payment waiting for a
   club, with the name typed at checkout and the email Stripe collected. Mint it
   with `create --pending <cus_id>` and paste the code into a second device's
   Upgrade modal.
7. Hand-edit the club record to `past_due` / `canceled` to walk a club device
   through grace and lapse — see
   [CLUBS.md](./CLUBS.md#grace-and-lapse).

## Turning a payment into a club

Checkout carries two facts nothing else knows: what the buyer called their club,
and an address to reach them at. Payment is the only moment both naturally
exist, so the webhook persists them instead of leaving them in Stripe for
someone to dig out later.

```
POST /api/billing/checkout  { interval, clubName? }
  metadata:                    { uid, club_name? }
  subscription_data.metadata:  { uid, club_name? }

on checkout.session.completed
  rememberCustomer(uid, cus);  writeEntitlement(uid, …)          ← as before
  put club-pending:<cus_id> { uid, clubName, email: customer_details.email,
                              stripeCustomerId, checkoutSessionId, paidAt }
```

`clubName` is **optional and never blocks checkout**: an empty field mints a club
called `Club 7K2QM9`, which an officer renames from the console. The field is
capped at 80 characters, because Stripe rejects the whole Checkout session over a
metadata value past 500.

Nothing is queued for a customer who already owns a club (`club-by-customer:` is
checked first), so a buyer re-subscribing after a lapse does not create a second
club for an operator to mint by mistake.

A human then turns each pending payment into a club:

```bash
# what is waiting
node scripts/club-cli.mjs pending --env dev

# mint one — name, uid, billing address and customer id all come from the record
node scripts/club-cli.mjs create --env dev --pending cus_123 --tz America/Toronto
```

`create --pending` writes `club:`, `club-by-code:`, `club-by-customer:`,
`club-by-email:` and a `club-member:` record making the buyer the first admin,
then clears the pending key. It prints the code and the `/pro/<code>` link to
mail to the buyer. Flags override the record, so a typo in the buyer's club name
is `--name "Correct Name"` rather than a KV edit.

The CLI calls a plain `createClubFromPending()` (`worker/club-admin.js`).
Automating creation later means calling that same function from the webhook —
one line, no logic to re-derive.

## Zoom Marketplace listing

Zoom requires a free version to remain (it does) and the listing to disclose
paid features. Update the listing text when Pro ships, alongside the privacy
policy (`apps/zoom-app/public/privacy.html`) and a terms/refund page.

**The listing is review-gated and needs lead time.** `docs/ZOOM_LISTING_PRO.md`
used to justify the `user:read:user` scope with "No email or profile data is
stored", and `club-pending:` makes that untrue: the buyer's billing address is
stored so the club's admin console can be reached by a mailed link after the
original officer has moved on. Both that document and the privacy policy are
updated; the Marketplace listing itself has to be re-submitted **before** this
ships, not alongside it.
