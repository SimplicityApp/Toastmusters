# Scheduled runs

Two stations run on a clock instead of a label. Both are set up by hand, once; they create
persistent jobs on your accounts, so the factory doesn't create them itself.

## Zoom night shift (this Mac)

The Zoom station needs this Mac, the Zoom client and the camera, so it runs as a **local**
scheduled task in the Claude desktop app: Code → Scheduled → New task → Local, working
folder this repo, nightly at 02:00.

Prompt:

> The user is away; skip the 60-second notice before taking the Mac. In
> /Users/szhang/Project/ToastMusters, stash any uncommitted work with a named
> `git stash push -u -m "night shift <date>"` and note the current branch. Run
> `/factory-zoom next` until no open PR is labelled `needs:zoom-test` or a run fails. Then
> switch back to the noted branch and pop that stash.

The Mac must be awake and logged in at 02:00 with Zoom signed in. Wake it with
`sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` (needs your password).

## Weekly ideation (cloud)

A Claude Code routine (`/schedule` in the CLI, or claude.ai/code/routines) on this repo,
Mondays at 09:00, with the PostHog connector added at claude.ai/customize/connectors:

> Run /factory-ideate in SimplicityApp/Toastmusters. Draft at most 5 issues labelled `idea`.
> Never add `factory:ready`.
