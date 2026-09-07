# Toastmaster Timer — Zoom App Test Plan

**App:** Toastmaster Timer (Development)
**Dev Client ID:** `kgpoX2A6TY2BvdctzK9iw`
**Webhook Endpoint:** `https://www.timer-dev.simple-tech.app/api/zoom/webhook`

---

## Prerequisites

- Zoom Desktop Client 5.17.0+
- A Zoom account (free or paid)
- Ability to start or join a Zoom meeting
- Camera/webcam connected (required for virtual background feature)

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

> **Re-run this step whenever the app's scopes or capabilities change in the
> Marketplace.** Zoom drops the old grant: the app still opens from your Apps
> list, but `getUserContext()` reports `authenticated` instead of `authorized`,
> the app context carries no `uid`, and identity/sync silently stay off. In
> Marketplace this is the **Local Test → Add app → Authorization URL** link.
> "Preview app" does not authorize.

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

## Step 2: Verify the App Appears in Zoom

1. Open the Zoom Desktop Client
2. Click **Apps** in the left sidebar (or bottom toolbar)
3. Find **Toastmaster Timer** in your installed apps list
4. Click the app to open it in the sidebar — it should load `https://www.timer.simple-tech.app` (the current temporary production home URL, pending Zoom's approval of the subdomain change)

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
