# Toastmaster Timer — Zoom App Test Plan

**App:** Toastmaster Timer (Development)
**Dev Client ID:** `kgpoX2A6TY2BvdctzK9iw`
**Webhook Endpoint:** `https://www.timer-dev.simple-tech.app/api/zoom/webhook`

| | Dev | Production |
|---|---|---|
| Zoom app (sidebar) | `https://zoom.timer-dev.simple-tech.app` | `https://zoom.timer.simple-tech.app` |
| Web app & marketing site | `https://www.timer-dev.simple-tech.app` | `https://www.timer.simple-tech.app` |

The two are one Cloudflare Worker routed by host. A path such as `/club/admin`
belongs to the **web** host — the `zoom.` host routes every path back to the
sidebar app, which is why the app opens its console in the system browser rather
than in place.

Steps 1–6 cover the free timer and are unchanged. **Steps P1–P7 cover the Pro
plan, clubs and web sign-in**, and are the new surface in this submission; run
them after Step 3b.

---

## Prerequisites

- Zoom Desktop Client 5.17.0+
- A Zoom account (free or paid)
- Ability to start or join a Zoom meeting
- Camera/webcam connected (required for virtual background feature)
- **For Steps P1–P7:** a browser, and a Stripe test card (`4242 4242 4242 4242`,
  any future expiry and CVC). The dev app runs Stripe in test mode; no real
  money moves.

---

## Step 1: Authorize the Development App

1. Open the following OAuth authorization URL in a browser:
   ```
   https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect
   ```
2. Log in to Zoom if prompted
3. Review the permissions and click **Allow**
4. You should be redirected to:
   `https://www.timer-dev.simple-tech.app/oauth/redirect`
5. Verify the redirect page loads with a success message ("You're all set!")

> **This submission adds the `user:read:user` scope** (it backs "Sign in with
> Zoom" on the website — see Step P1). Re-authorize before testing, or the
> callback fails with `reason=scope_not_granted` and nobody can sign in on the
> web (Step P1b shows what that looks like).
>
> **Re-run this step after an OAuth scope change, within 90 days.** Zoom keeps
> the old grant working for 90 days after a scope change and only then expires
> it; adding or removing an API under Features → APIs never touches the grant
> at all (see `ZOOM_AUTH_AND_REDIRECTS.md`). Once a grant has lapsed the app
> still opens from your Apps list, but `getUserContext()` reports
> `authenticated` instead of `authorized`, the app context carries no `uid`,
> and identity/sync silently stay off. In Marketplace this is the **Local Test
> → Add app → Authorization URL** link. "Preview app" does not authorize.

---

## Step 1b: Verify Identity and Settings Sync

Requires Step 1 to be done with the current scopes.

1. Open the app in a meeting.
2. In PostHog, find the person `zoom:<uid>`. Its properties must show
   `zoom_identified: true`, `is_zoom_guest: false`, `zoom_auth_status: authorized`.
   If you see `is_zoom_guest: true` with `zoom_auth_status: authenticated`, redo Step 1.
3. Run `npx wrangler tail --env dev` and change a timing rule. Within ~2 s a
   `PUT /api/profile` must return `200` (the `Authorization` value shows as
   `REDACTED` in the tail; that is expected).
4. Open the app on a second machine: the rule must be there.
5. Upload a card image on one machine; on the other, `GET /api/assets/<hash>`
   returns `200` and the artwork appears.
6. Join as an unauthenticated guest: the app must work normally and make no
   `/api/profile` calls.

---

## Step 1c: Verify the Guest-Mode Notice

The failure this catches: a user who is signed into Zoom but has not added
the app — or whose grant lapsed 90 days after a scope change — is
`authenticated` rather than `authorized`. The app opens as before, but the
Zoom client asks the user's permission on every `setVirtualBackground` call —
an "Allow" dialog on every color change. The app must notice and offer the
in-client fix.

1. Put a second account into the `authenticated` state. Changing a capability
   or a scope does **not** do this; follow "Reaching the `authenticated` state
   deliberately" in `ZOOM_AUTH_AND_REDIRECTS.md` (guest-mode testing on, a
   guest account in the same meeting, opened from the App Launcher — not from
   the invitation, which gives `unauthenticated` on desktop). Then open the
   app in the meeting as that account.
2. Expected: an amber banner at the top reads "Zoom asks permission on every
   color change until you approve this app", and a modal titled "Approve
   Toastmusters Timer in Zoom" opens once per session. The PostHog event
   `zoom_connection_degraded` carries `connection_state: unauthorized`.
3. Start a speech in Timer + Camera: confirm the "Allow" dialog on each color
   change, which is the symptom.
4. Click **Approve in Zoom**. Expected: Zoom's own add-the-app prompt opens
   inside the client (no browser tab), our modal closes, the banner stays.
5. Approve the app. Expected: the banner disappears, a toast says "Approved.
   Zoom will stop asking permission for background changes", the debug log
   shows `User context changed; Zoom now reports the user as authorized` after
   a second `Zoom SDK configured` line, and PostHog records `zoom_reauthorized`.
6. Start another speech: no "Allow" dialog on color changes. Clearing the
   background at the end still confirms once; that dialog is Zoom's and stays.
7. On a client that refuses `promptAuthorize` (older desktop, or the
   capability not yet granted in the Marketplace), the button must open the
   OAuth URL in the browser instead and log `promptAuthorize not granted`.

---

## Step 1d: A grant that drops mid-session

The open-time check above only runs once. This step checks that a grant Zoom
drops while the panel is already open raises the same notice without a
reload, and that the modal waits until the speech is over.

1. Open the app in a meeting as an `authorized` user, using the two-account
   setup from "Reaching the `authenticated` state deliberately" in
   `ZOOM_AUTH_AND_REDIRECTS.md`. No banner shows.
2. Start a speech, then drop the grant while the timer runs (remove the app
   for that account in the Marketplace, or switch it to the guest-mode
   account's state as that section describes).
3. Expected, if the client fires `onMyUserContextChange` on the drop: the
   debug log shows `User context changed; Zoom now reports the user as
   authenticated`, and the amber banner appears at once with **Approve in
   Zoom**. No modal covers the running timer.
4. Click **Stop**. Expected: the "Approve Toastmusters Timer in Zoom" modal
   opens now, unless it was already closed once in this Zoom session, in which
   case only the banner stays.
5. PostHog shows `zoom_connection_degraded` with `connection_state:
   unauthorized` and `detected: mid_session`. The Step 1c open-time event
   carries `detected: on_open`.
6. Approve as in Step 1c, steps 4–5: the banner clears with the "Approved"
   toast and `zoom_reauthorized`.
7. If nothing appears in step 3 and the log shows no `User context changed`
   line, the client did not fire the event on a drop. That is not a bug in the
   app: the drop is caught at the next open, as before. Record the result,
   with the date and client version, in the status-contract assumptions in
   `ZOOM_AUTH_AND_REDIRECTS.md`.

---

## Step 2: Verify the App Appears in Zoom

1. Open the Zoom Desktop Client
2. Click **Apps** in the left sidebar (or bottom toolbar)
3. Find **Toastmaster Timer** in your installed apps list
4. Click the app to open it in the sidebar — it should load the Zoom app host
   (`https://zoom.timer.simple-tech.app` in production,
   `https://zoom.timer-dev.simple-tech.app` on dev). The `www.` host is the
   website, not the sidebar app.

---

## Step 3: Test Core Timer Functionality

1. Start or join a Zoom meeting
2. Open the Toastmaster Timer app from the sidebar
3. Enable your camera (video must be on for virtual backgrounds to work)
4. In the **Live** tab, select a speech type (e.g. "Table Topics: 1–1.5–2 min")
5. Click **Start** to begin the timer
   - Verify the virtual background changes to **green**
   - Verify the elapsed time appears over the video and counts up once per second (drawn as a virtual foreground layer, not baked into the background)
6. Wait for the yellow threshold — verify the background changes to **yellow**
7. Wait for the red threshold — verify the background changes to **red**
8. Click **Finish** — verify the background is removed/reset and the count-up readout disappears
9. After the meeting, check **Settings → Background & effects** in the Zoom client
   - Verify the timer added at most the four fixed color backgrounds — **no** per-second backgrounds with timestamps baked in (earlier builds saved one image per second of speech)

### Step 3b: Timer survives the app being closed

Zoom keeps the app running when you go back to **My Apps** (the back arrow), so the timer and the card keep going there. Closing the app (the **X** / "Close app") kills the webview; the timer state is saved so a reopen picks the clock back up.

1. Start a speech as in Step 3 and let it run for ~10 seconds
2. Close the app entirely (not the back arrow), wait ~5 seconds, then reopen it from the sidebar
   - Verify a toast says the timer resumed, the elapsed time includes the seconds the app was closed, and the count-up on the card continues from there
   - Verify the card color matches the current elapsed time (e.g. if the yellow threshold passed while closed, the card is yellow on reopen)
3. Repeat with the timer **paused**: pause, close, reopen
   - Verify it comes back paused at the same elapsed time, and **Continue** carries on from there
4. Click **Reset**, close, and reopen
   - Verify the app boots at 00:00 with no toast: nothing is restored after a reset or a finish
5. A saved session older than an hour is ignored, so yesterday's forgotten timer never puts a red card on your face at the start of the next meeting

---

# Pro, clubs and web sign-in

New in this submission. The free timer above is unchanged and nothing that was
free has moved behind the paywall — Pro adds a **club** layer on top.

The unit of Pro is a club, not a person: one subscription, a short code the club
shares, and every device that enters it gets the club's timing presets, branding,
meeting archive and share links. A timer entering a code needs no Zoom account
and no sign-in at all, which is Step P4 and the claim most worth checking.

> **On the dev app `ENTITLEMENT_ENFORCE` is `0`**, so paid features are open to
> everyone and a refusal (HTTP 402) never fires. That is deliberate — it lets a
> reviewer see the whole Pro surface without paying. It also means Steps P6 and
> P7 cannot show a *lapse* on dev as shipped; see the note in each.
>
> **On the dev app `FLAGS_FORCE` is `"1"`**, so every release flag
> (`pro`) is on and the whole surface below is visible. Production asks
> PostHog instead, and there all of it stays hidden, with its endpoints
> answering 404, until `pro` is turned on.
> See [FEATURE_FLAGS.md](./FEATURE_FLAGS.md).

---

## Step P1: Sign in with Zoom on the website

1. In a browser, open `https://www.timer-dev.simple-tech.app/timer/app`.
2. Top bar → **Sign in with Zoom** → **Allow**.
   - Expected: you land back on `/timer/app`, the top bar now reads **Account** (or
     **Pro**), and `GET /api/me` returns `200` with your Zoom user id.
   - This is the only thing `user:read:user` is used for. We read and store the
     Zoom **user id** and nothing else — no name, no email address.
3. Repeat starting from `https://timer-dev.simple-tech.app/timer/app` (no `www.`).
   - Expected: identical result. Sign-in begun on any host this app serves is
     handed to the canonical host first, so it completes wherever it started.
4. Decline the Zoom consent screen instead of allowing it.
   - Expected: you return to the page you started from and a banner names the
     reason. A sign-in that fails must never look like one that never happened.
   - The banner offers **Sign in again**. Click it and allow this time: you land
     on the same page with no `signin`/`reason` params and no banner.

## Step P1b: A sign-in without the user-read permission

The failure this catches: Zoom completes the sign-in but the token lacks
`user:read:user`, so the Worker cannot read who this is. It must be named as a
missing permission, with a way to fix it, and never look like an outage. This
step also records what Zoom really answers for a scope-less token, which Zoom
does not document. Run it on **dev only**, and restore the scope afterwards.

1. In the Marketplace, open the dev app → **Scopes** and remove
   `user:read:user`. Save.
2. Run `npx wrangler tail --env dev` in a terminal.
3. In a browser, open `https://www.timer-dev.simple-tech.app/` and **Sign in
   with Zoom** → **Allow**. (If you land signed in with no failure, Zoom reused
   the old grant: remove the dev app under **Manage → Added Apps**, re-run the
   Step 1 authorize URL, and try again.)
   - Expected: you return to the landing page with
     `?signin=failed&reason=scope_not_granted`. The amber strip says Zoom signed
     you in but didn't give Toastmusters Timer permission to see your account,
     and offers **Sign in again**, **Manage in Zoom** and **Why does Zoom ask?**.
   - The tail shows `Zoom users/me failed: <status> <code> <signals>`. **Record
     the status, code and signals here** with the date; they are expected to be
     `400 4711 token-scope,error-code`, but that is inferred from forum reports,
     not documented. If the signals read `no-scope-signal`, the Worker is
     misclassifying the failure as `profile`: stop and fix `classifyProfileFailure`
     in `worker/auth.js`.
   - PostHog shows, from the Worker, one `web_signin_failed` with
     `reason: scope_not_granted` and one `zoom_scope_not_granted` carrying
     `zoom_status`, `zoom_code` and `scope_signal`. From the browser it shows
     `signin_failure_shown` with `reason: scope_not_granted, surface: banner`.
4. Open `/account?signin=failed&reason=scope_not_granted`: the same message and
   three actions appear inline on the dark card, and the strip does not appear
   as well. PostHog records `signin_failure_shown` with `surface: account`.
5. Click **Manage in Zoom**: a new tab opens on your added apps in the Zoom App
   Marketplace (**Manage → Added Apps**), and PostHog records
   `zoom_manage_app_clicked`. If it lands anywhere else, fix
   `ZOOM_MANAGE_APPS_URL` in `packages/shared/appLinks.js`.
6. Click **Why does Zoom ask?**: a new tab opens on the support page, scrolled
   to "Why does Zoom ask permission to see my account…", and PostHog records
   `signin_help_clicked`.
7. Add `user:read:user` back to the dev app, save, and click **Sign in again**.
   - Expected: Zoom shows its consent screen again (or, if it reuses the old
     grant and the failure repeats, remove and re-add the app from **Manage in
     Zoom** first). After allowing, you land on the landing page with no failure
     params and no banner, and PostHog shows `web_signin_succeeded`.

## Step P2: Buy Pro from inside Zoom

Stripe is in test mode on the dev app. Use card `4242 4242 4242 4242`.

1. Open the app in a meeting. The footer reads **Upgrade**.
2. Tap **Upgrade**.
   - Expected: the pitch is the club — shared presets, branding, archive — with
     **Monthly** and **Yearly**, an optional club-name field, and below them
     *"Already on Pro through your club?"* with a code field.
3. Type a club name (optional) and tap **Monthly**.
   - Expected: Stripe Checkout opens in the **system browser**. Zoom's webview
     does not run payment forms, so checkout never happens inside the sidebar.
4. Complete the payment, then return to Zoom.
   - Expected: within about a minute the modal flips to *"You're on Pro"* on its
     own. **I have paid, refresh** forces the check if you do not want to wait.

## Step P3: Set up the club, and get the code to share

The club itself is created by the purchase. This step puts *this device* on it
and shows you the code.

1. Still in the Upgrade modal after Step P2, find the **Set up my club** card
   and tap the button. (A name field is offered; it is optional.)
   - Expected: the card becomes the club **code** (`DTSP-7K2QM9` shape) and an
     **invite link** (`/pro/<code>`), each with a **Copy** button, plus
     **Manage your club**.
   - The same button is what a subscriber who bought Pro *before* this version
     presses — for them it mints the club as well. Either way it is safe to
     press twice: you get the same club back, never a second one.
2. Tap **Manage your club**.
   - Expected: the officer's console opens in the **system browser** on the
     `www.` host, showing the roster, roles and brand kit. It is a web page by
     design — an officer reading a roster is not in a meeting.
3. The same card appears on the website at `/account`. Confirm the code matches.

## Step P4: Join a club with the code — no sign-in

This is the path most club members take, and it needs no Zoom account at all.

1. On a second machine, join the meeting with a different Zoom account and open
   the app **without** adding it (open it from the App Launcher, so it runs as a
   guest).
2. **Upgrade** → *"Already on Pro through your club?"* → enter the code → **Activate**.
   - Enter it in lower case and without the dash. Expected: accepted — a code
     read out over a phone call has to work.
   - Expected: the footer switches to **Pro**, naming the club.
3. Confirm this device is **not** shown the club code or the invite link.
   - Expected: only an admin sees them. The code is the club's password.
4. Enter a code that does not exist.
   - Expected: *"That code isn't active. Check with your club officer."*
     Unknown, revoked and lapsed codes all answer the same way on purpose.
5. Open the invite link from Step P3 in a browser instead.
   - Expected: it activates that browser on load and then tells a Zoom timer
     where to type the same code.

## Step P5: What Pro adds

On a club device, in a meeting with the camera on:

1. **Branding** — start a speech. Expected: the club's logo and colour appear on
   the timing card, in all three overlay modes, and never cover the time readout.
2. **Shared presets** — **Edit Timing Rules** shows the club's list, named. As an
   admin, **Share with my club** publishes; a member does not get that button.
   Editing the club's list asks first, then makes this device its own copy.
3. **Archive** — finish two speeches, open **Report**. Expected: *"Saved to
   &lt;club&gt;"*, and **History** lists them. Turn wifi off, time a speech:
   expected *"1 speech waiting to upload"* — never a false claim of success.
4. **Share** — **End meeting & share** produces a branded image and a link.
   Paste the link into Zoom chat: expected a preview card, and the page opens
   for someone with no club and no account.
5. Confirm on a **free** device that none of the above appears, and that the
   timer is otherwise identical.

## Step P6: Manage or cancel billing

1. **Upgrade** (now **Pro**) → **Manage billing**.
   - Expected: the Stripe customer portal opens in the system browser. Cancel
     there.
2. Expected on the club: the subscription's state reaches the club, so a
   cancellation ends the club's Pro at the end of the paid period rather than
   immediately, and a failed payment keeps it for seven days behind a warning
   banner.
   - **Not observable on dev as shipped** (`ENTITLEMENT_ENFORCE: "0"` keeps
     everything entitled). Verified by automated tests and by the internal
     manual plan, which flips the flag.

## Step P7: The week of warning before Pro ends

Whoever is timing is rarely whoever pays, so the warning goes to both.

1. With a club whose payment has failed or whose cancellation is pending, open
   the app.
   - Expected: an amber banner above the tabs, on **every** device in the club —
     *"&lt;club&gt;'s Pro ends in N days."* An admin also gets **Manage billing**;
     a member is told to ask their admin.
   - Dismissing it is for the day only; it returns tomorrow.
2. Everything still works during the warning period — badge, presets, archive,
   sharing. Confirm that, not just the banner.
3. After it ends: branding, archive, sharing and the club's presets go, the
   device keeps its own presets, and the footer returns to **Upgrade** naming
   the club that ended. **Nothing is deleted** — renewing restores all of it with
   nothing re-entered and no re-activation.
4. A lapse never lands mid-meeting: the club is re-checked at app start only.
   - **Steps 1–3 are not observable on dev as shipped**; see the note under
     Step P6.

---

## What this plan does not cover

The deep club run — two machines, badge placement on a real video frame, the
outbox surviving a webview teardown, roster and role changes, the mailed admin
link, and the lapse/renewal cycle with the entitlement gate switched on — is in
the internal manual plan, which assumes a deployed dev branch and `wrangler
tail`. Steps P1–P7 above are the reviewer-facing subset.

---

## Step 4: Test Webhook Events — Meeting Start/End

These events are logged server-side (PostHog analytics). To confirm they fire:

1. With the app installed, **start a Zoom meeting**
   - Expected: `meeting.started` webhook fires to `https://www.timer-dev.simple-tech.app/api/zoom/webhook`
2. **End the Zoom meeting**
   - Expected: `meeting.ended` webhook fires to the same endpoint
3. **Verification:** The developer can confirm receipt in PostHog at `https://us.i.posthog.com` (no visible UI change for the reviewer — these are analytics-only events)

---

## Step 5: Test App Deauthorization Webhook

1. In the Zoom Desktop Client, go to **Settings → Zoom Apps → Manage**
2. Find **Toastmaster Timer** and click **Remove / Uninstall**
3. Confirm removal
   - Expected: `app_deauthorized` webhook fires; Zoom compliance data-deletion API is called; event logged in PostHog
4. Verify the app no longer appears in your installed apps list

---

## Step 6: Re-install (Optional — Clean Slate)

Use the same OAuth URL from Step 1 to reinstall the dev app and confirm the full cycle works end-to-end.

---

## Webhook Endpoint Reference

| Event | Endpoint |
|---|---|
| `meeting.started` | `POST https://www.timer-dev.simple-tech.app/api/zoom/webhook` |
| `meeting.ended` | `POST https://www.timer-dev.simple-tech.app/api/zoom/webhook` |
| `app_deauthorized` | `POST https://www.timer-dev.simple-tech.app/api/zoom/webhook` |

All events share the same endpoint and are differentiated by the `event` field in the JSON body. Signature verification uses HMAC-SHA256 with the app's webhook secret.
