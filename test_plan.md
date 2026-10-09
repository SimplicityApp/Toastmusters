# Toastmaster Timer — Zoom App Test Plan

**Moved to [`docs/ZOOM_TEST_PLAN.md`](docs/ZOOM_TEST_PLAN.md).**

That is the plan submitted to Zoom — `docs/ZOOM_RELEASE_NOTES.md` links to it by
URL — and it is the only one kept current.

## Why this file is a pointer

It used to hold a second, older copy of the same plan, under the same title. The
copy drifted, and three of its claims had become untrue in ways that matter for
the Marketplace data-handling questionnaire:

- *"This app does not require user authentication or login."* The website now has
  **Sign in with Zoom**, and Pro is tied to a Zoom user id.
- *"All data is stored locally in the browser… No data is stored on external
  servers."* A Pro subscriber's settings and card artwork sync through our
  Worker, a club's meeting archive and brand kit are stored server-side, and a
  billing email address is stored for anyone who buys Pro. See
  `docs/ZOOM_LISTING_PRO.md` → *What is stored*, which declares all three.
- Its capability table listed `videoFilter` and `shareApp` only. The app also
  uses `setVirtualBackground`, `setVirtualForeground`, `removeVirtualForeground`,
  `getUserContext`, `promptAuthorize`, `getMeetingParticipants` and `openUrl`.

Answering Zoom from this file would have contradicted the listing. One plan, one
place, is the fix. The old content is in git history if you need it.
