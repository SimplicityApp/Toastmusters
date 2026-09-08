# Billing — Pro plan, Stripe, entitlements

Pro = settings that follow the user between devices + custom card artwork sync.
The timer is free, always. Individual plan, monthly or yearly, billed by our own
Stripe account (not Zoom's Marketplace billing, which is US-only).

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
  processed webhook ids under `stripe:event:<evt_id>` (30-day TTL).
  Bind a namespace as `ENTITLEMENTS` to move them; no code change.
- Gate: `PUT /api/profile` and `PUT /api/assets/*` answer `402 upgrade_required`
  for free users. GET stays open so a lapsed user keeps their data.
- Grace: `past_due` keeps Pro for 7 days after the period end; `canceled` keeps
  Pro until the paid period ends.
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

## Zoom Marketplace listing

Zoom requires a free version to remain (it does) and the listing to disclose
paid features. Update the listing text when Pro ships, alongside the privacy
policy (`apps/zoom-app/public/privacy.html`: Stripe as payment processor,
subscription status stored against the Zoom user id) and a terms/refund page.
