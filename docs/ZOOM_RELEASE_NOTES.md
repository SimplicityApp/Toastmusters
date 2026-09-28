# Zoom App Release Notes

## Release Notes for User

Timer + Camera no longer fills your computer with saved backgrounds. Previously, while a speech was running, the app baked the count-up readout into the virtual background and pushed a new image every second — and the Zoom client saves every custom background it is handed to disk, so long meetings left thousands of one-second background files on the organizer's machine. The readout now travels on its own transparent virtual-foreground layer over your video, and the color background stays one of four fixed images. Nothing accumulates: the foreground layer replaces itself and is removed automatically when the meeting ends.

Reauthorizing grants the app the two new permissions this needs (set/remove virtual foreground). On clients that decline them, Timer + Camera shows the color signal without the count-up rather than falling back to the old disk-filling behavior.

If earlier versions already left timer backgrounds on your machine, remove them in Zoom under Settings → Background & effects (the app has no API to delete saved backgrounds on your behalf).

Test plan: https://github.com/SimplicityApp/Toastmusters/blob/master/docs/ZOOM_TEST_PLAN.md

## Marketplace checklist for this submission

Add these APIs under Features → Zoom App SDK → Add APIs before submitting, or every client will refuse them and the count-up will not show in Timer + Camera:

- `setVirtualForeground`
- `removeVirtualForeground`

## Previous release

We've added automatic meeting detection to Toastmaster Timer. The app now receives Zoom webhook events when your meeting starts or ends, enabling future improvements like auto-start, session tracking, and smarter reporting. We've also added data compliance handling to properly manage your data if you ever uninstall the app.

Reauthorizing grants the app permission to receive these meeting lifecycle events. No additional personal data is collected — all timer data continues to be stored locally in your browser.
