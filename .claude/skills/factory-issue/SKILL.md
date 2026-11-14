---
name: factory-issue
description: Turn a bug or feature idea into a factory-ready GitHub issue (problem, evidence, Given/When/Then acceptance criteria, surfaces, risk, out of scope) labelled `idea`. Use for "/factory-issue <idea>", "make an issue for …", "file this as an issue", or when the user describes a bug or feature to track.
argument-hint: "<the idea in a sentence or two>"
---

# Write a factory-ready issue

The plan station refuses issues without testable acceptance criteria, so this skill's job is
to make an idea plannable. Read `.factory/README.md` for the labels.

1. **Existing issue?** `scripts/factory/gh.sh issue list --state all --search "<keywords>"`.
   If one covers it, add what's new as a comment there instead and stop.
2. **Locate it in the code.** Find the components, Worker routes and shared modules involved,
   and the Zoom-client spec whose `covers` includes them (`e2e/zoom-client/INDEX.md`).
3. **Evidence, if cheap.** PostHog counts (if the `posthog` MCP is connected), user quotes,
   an issue comment, a reproduction. Numbers with their date range, or "none yet".
4. **Body**, exactly these sections:

   ```markdown
   ## Problem
   Who hits it, what they see, why it matters. 2–4 lines.

   ## Evidence
   ## Acceptance criteria
   - AC-1: Given …, when …, then …   (observable; one per user-visible behaviour)
   ## Surfaces
   zoom-app | web | worker | table-topics | shared — and the covering Zoom-client spec, or "none"
   ## Risk
   low | high — high when it touches billing, auth, entitlements, env flags or production data
   ## Out of scope
   ```

5. **Create.** Title `<area>: <what is wrong / what users get>`, the style of #90 and #105.
   `scripts/factory/gh.sh issue create --title … --body-file … --label idea` plus `bug` or
   `enhancement`.
6. **Report** the link. Don't add `factory:ready`: promoting is the human's gate. If the user
   said to start it now, run `/factory <n>` (their words are the promotion).

The repo is public: no secrets, customer names, emails, club names or revenue in an issue.
