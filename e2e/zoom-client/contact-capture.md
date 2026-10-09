---
id: contact-capture
title: Zoom email and name capture (#83)
status: draft
covers:
  - apps/zoom-app/src/components/ContactCapture.jsx
  - apps/zoom-app/src/components/ContactCaptureCard.jsx
  - apps/zoom-app/src/utils/contactCapture.js
  - apps/zoom-app/src/utils/zoomSdk.js
  - worker/contact.js
  - worker/user-data.js
automated:
  - apps/zoom-app/src/components/ContactCapture.test.jsx
  - apps/zoom-app/src/utils/contactCapture.test.js
  - worker/contact.test.js
  - worker/user-data.test.js
  - worker/zoom-webhook.test.js
needs:
  - dev deployed, contact_capture flag on (dev FLAGS_FORCE=1)
  - authorize and onAuthorized in the dev app's API list
  - wrangler access to the PROFILES KV namespace (dev)
  - in a meeting, an account that has not approved the updated scopes
verified_at: never
verified_on: never
---

# Zoom email and name capture (#83)

Migrated from `docs/ZOOM_TEST_PLAN.md` Step 1d (and the contact checks in P1 and Step 5).
The Worker saves `{ email, firstName, lastName, updatedAt }` under `contact:zoom:<uid>` in
`PROFILES` KV from three doors: in-client `authorize`, browser install/re-add, web sign-in.
Read the record with
`npx wrangler kv key get --binding PROFILES --env dev --remote 'contact:zoom:<uid>'`;
delete it to start over. Find `<uid>` as in the auth-identity spec.

## Purpose
Catches a consent flow that never fires or fires mid-speech, a "Stay in touch" card that
nags after Not now, a record that is not saved or not purged on uninstall, and an SDK
`authorize` call the real client rejects (mocked SDKs cannot show this).

## Steps

### CC-01 · auto · Browser door saves the contact
Do: after a fresh install or a re-add from `https://www.timer-dev.simple-tech.app/add-to-zoom`,
read the KV key. Reload the success page.
Expect: record exists with your Zoom email and name. The reload re-sends a spent code, fails
harmlessly, and changes nothing.
Evidence: KV value before and after the reload.

### CC-02 · auto · In-client authorize, automatic
Do: delete the KV key and the webview `localStorage` key `tt_contact_capture:<uid>`. Open the
app in a meeting and leave the timer idle.
Expect: about 2.5 s later the app calls `authorize`. Nothing is shown if the scopes were
already approved; otherwise Zoom's consent screen opens. With a speech running, nothing happens
until it stops.
Evidence: debug log shows the `authorize` call; `reqs.sh` shows `POST /api/zoom/contact`.

### CC-03 · human · Approve Zoom's consent screen
Do: approve the consent screen from CC-02.
Expect: the KV key exists again; PostHog has `contact_capture_prompted` and
`contact_capture_saved`, both `source: auto`.
Evidence: KV value; PostHog events.

### CC-04 · auto · Known contact is not re-asked
Do: close and reopen the app.
Expect: `/api/zoom/session` answers `contactKnown: true`; `authorize` is not called.
Evidence: `reqs.sh` session response; debug log has no `authorize`.

### CC-05 · human · Skip leads to the card
Do: delete the KV and `localStorage` keys, use an account that has not approved the updated
scopes, open the app, let the consent screen open, close it without approving (or wait two
minutes).
Expect: `contact_capture_skipped` (`source: auto`). At the next idle moment a card titled
"Stay in touch with Toastmusters Timer" appears at the bottom with Approve in Zoom, Not now
and a close button. Zoom's screen does not open again by itself, on this load or later ones.
Evidence: PostHog event; screenshot of the card.

### CC-06 · auto · Card hides during a speech
Do: with the card showing, start a speech, then stop it.
Expect: the card disappears at once on start and returns about 2.5 s after the timer stops.
Evidence: screenshots before, during and after.

### CC-07 · auto · Not now snoozes for a week
Do: click Not now (or the close button), then reopen the app.
Expect: card goes; `contact_capture_dismissed` with `source: card`;
`tt_contact_capture:<uid>` is `{"mode":"card","nextAt":<now + 7 days>}`; reopening does not
show the card. Setting `nextAt` to `0` brings it back.
Evidence: `localStorage` value; PostHog event.

### CC-08 · human · Approve from the card
Do: click Approve in Zoom on the card and approve.
Expect: card goes; KV key exists; `contact_capture_saved` with `source: card`; the
`localStorage` key is gone. Skipping Zoom's screen from the card instead pushes the card out
a week.
Evidence: KV value; PostHog event; `localStorage`.

### CC-09 · human · Web sign-in door saves the contact
Do: sign in on the website (Step P1 flow) with the KV key deleted.
Expect: the record exists after sign-in.
Evidence: KV value.

### CC-10 · human · Uninstall purges the contact
Do: remove the app from Zoom (run last, it removes the app).
Expect: `wrangler tail --env dev` logs `Purged user data on deauthorization: <uid>` with
`"contactDeleted":true`; the `contact:zoom:<uid>` and `profile:zoom:<uid>` keys are gone.
Billing records (`entitlement:zoom:<uid>`, Stripe links) are kept on purpose.
Evidence: tail output; `kv key get` finds nothing.

## Not covered
- Zoom clients older than the one that supports `authorize` / `onAuthorized`.
- Accounts where the admin blocks the scopes.
