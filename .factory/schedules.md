# Scheduled runs

Two stations run on a clock instead of a label. Both are set up by hand, once; they create
persistent jobs on your accounts, so the factory doesn't create them itself.

## Daily Zoom run (this Mac)

The Zoom station needs this Mac, the Zoom client and the camera, so it runs as a **local**
scheduled task in the Claude desktop app (Code → Scheduled), daily at 17:00, during the
user's break. The live task is `factory-zoom-daily`
(`~/.claude/scheduled-tasks/factory-zoom-daily/SKILL.md`); keep this copy in step with it.

It does nothing unless an open PR is labelled `needs:zoom-test`, and it only starts between
16:55 and 17:30: if the app was closed or the Mac asleep at 17:00, the app runs the task at
the next launch, and the time check ends it so it never takes the Mac while the user works.
If the user comes back mid-run, `click.sh` refuses and the run stops and cleans up.

Prompt:

```text
Run the Toastmusters factory's Zoom station on this Mac. This is an unattended daily run at 17:00, while the user is usually on a break. Work alone; don't wait for replies.

1. Time window. Run `date +%H%M`. If it is before 1655 or after 1730, the Mac was asleep or the app was closed at 17:00: end with one line ("skipped: started at HH:MM"). Never take the Mac outside this window.

2. Anything to do? Run `env -u GITHUB_TOKEN gh pr list -R SimplicityApp/Toastmusters --state open --json number,labels --jq '[.[] | {number, labels: [.labels[].name]}]'`. End with one line, touching nothing, if no PR has `needs:zoom-test`, or if any PR has `zoom:testing` (another run holds the lock).

3. Set up in /Users/szhang/Project/ToastMusters. cd there. It is the user's only checkout, so you must put it back exactly as you found it.
   - Note the current branch (`git branch --show-current`; if that prints nothing, note `git rev-parse HEAD`).
   - Note whether Zoom is running (`pgrep -x zoom.us`).
   - If `git status --porcelain` prints anything, run `git stash push -u -m "factory zoom <today's date>"` and note it.
   - `git fetch origin && git switch --detach origin/dev`.

4. Run the station. Read these files from disk and follow them: `CLAUDE.md`, `.factory/README.md`, then `.claude/skills/factory-zoom/SKILL.md` with the argument `next`. When it says so, read and follow `.claude/skills/zoom-app-testing/SKILL.md` and `.claude/skills/factory-report/SKILL.md`. Read them as files: this session may have started before those skills were checked out, so their slash commands may not exist.
   - Post the take-the-Mac notice and wait 60 s, as the skill says. The user may be at the Mac.
   - If `click.sh` refuses, the user is back: do the skill's step 5 (remove `zoom:testing`, comment that the run is waiting), then go to step 5 below.
   - Skip human-only steps and sign-in prompts as the skill says, and list them. Don't wait for an answer.
   - When a PR finishes, start the next PR labelled `needs:zoom-test` only if it is before 17:45 and the last run didn't fail.

5. Clean up, always, including after a failure or a refusal:
   - Stop the helpers you started: `pkill -f "caffeinate -d -t 14400"`, `pkill -f tail.sh`.
   - `git checkout wrangler.jsonc`. If you changed ENTITLEMENT_ENFORCE or FLAGS_FORCE for a run, redeploy with `npm run cf:deploy:dev` so dev is back to the committed values. Never leave ENTITLEMENT_ENFORCE "1" on dev.
   - Leave the Zoom meeting you started. Quit Zoom if it wasn't running in step 3.
   - Switch back to the branch (or commit) you noted. If you stashed, find your stash by its message in `git stash list` and pop that one, never another. If the pop conflicts, leave the stash in place and say so.

6. Report in at most four lines: each PR and its result (ready-for-review, sent back to build, stuck, or waiting), anything that needs the user, and anything left changed.

Rules: use `env -u GITHUB_TOKEN gh` for every gh call (the shell's GITHUB_TOKEN is a work account that can't write to this repo). Never read `.env`. Never merge, push to dev or master, or deploy production.
```

## Weekly ideation (cloud)

A Claude Code routine (`/schedule` in the CLI, or claude.ai/code/routines) on this repo,
Mondays at 09:00, with the PostHog connector added at claude.ai/customize/connectors:

> Run /factory-ideate in SimplicityApp/Toastmusters. Draft at most 5 issues labelled `idea`.
> Never add `factory:ready`.
