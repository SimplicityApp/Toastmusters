# Meeting polls: vote for Best Table Topics Speaker and Best Evaluator

**Labels:** `enhancement`

## Summary

Most Toastmasters meetings end with a vote for the best Table Topics speech and the best Table Topics evaluation, usually among 3 speakers and 3 evaluators. Clubs run this today by hand or with a separately set-up Zoom poll. The timer app already knows who spoke in each role, so it can build the ballot and run the vote.

**Plan:** Pro only. Free users see the feature with the upgrade prompt, like other Pro features.

## Requirements

### Ballot

- **Default ballot:** two categories, **Table Topics Speech** and **Table Topics Evaluation**, with 3 candidate slots each.
- **Add or remove categories**, and **add or remove candidates** within a category (no fixed count of 3).
- **The category is a role.** It is picked from the same role list as timing: the built-in roles plus the club's custom roles. Example: change "Table Topics Speech" to "Standard Speech", or to a custom role.
- **Create a new role from the poll screen.** It is added to the timing roles too, with default timing rules (`DEFAULT_CUSTOM_RULES`), the same as creating it in Edit Rules.

### Candidates

- **Auto-filled** from the speakers timed under that role in this meeting (the `name` / `role` fields of the meeting's reports). Example: everyone timed as "Table Topics Speech" becomes a candidate in that category.
- The host can **add, remove or rename** candidates before opening the poll, for example a speaker who was not timed, or a typo.
- If nobody has been timed in that role yet, the category shows the default empty slots to fill in.

### Results

- Votes are **anonymous**.
- **Anyone can vote for themselves.** No self-vote check.
- Whoever runs the poll sees counts privately, as they arrive.
- They close the poll, then **reveal only the winner of each category**, optionally on the Stage view.
- **Ties produce multiple winners:** everyone with the top count in a category is announced as a winner.
- Results are saved with the meeting report, and in the club's meeting archive when the user is in a club.

### Saved poll template (per club)

The poll *setup* is saved, so whoever is Timer or Vote Counter that week gets the club's ballot ready-made.

**Saved in the template:**
- Categories (roles) and their order.
- Default number of candidate slots per category.
- Optional display wording per category, for example "Best Table Topics Speaker" instead of the role name.
- Behaviour options: post the voting link to chat automatically, show winners on the Stage view, how long the voting link stays open.

**Not saved in the template:**
- Candidates: auto-filled per meeting from who was timed.
- Votes: they belong to one meeting. Only the results (winners per category, with counts) are kept, in the meeting report and the club archive.

**How it is shared:**
- **Club:** same flow as the club's timing presets. A club admin or editor publishes the template, which bumps the club version. Every member's device picks it up on the next refresh. Members can still edit the ballot for a single meeting without changing the club's template.
- **No club:** a Pro user's own template is saved and synced across their devices with their other settings.
- **Lapsed plan:** the template stays stored but unused, like the presets, and comes back on renewal.

## How participants vote

Two ways to vote. Web-link voting is the default because it works for every club; the native Zoom poll is an extra for hosts on eligible meetings.

### A. Web-link voting (default, always available)

1. The app opens the poll and posts a voting link to the meeting chat (`sendMessageToChat`), with a "copy link" fallback.
2. Participants vote in a browser or on their phone. Nothing to install, and no Zoom sign-in or app authorization needed.
3. Votes go to our Worker. The app shows live counts to whoever runs the poll.
4. Close and reveal as described under Results.

**Why the default:** works when the person running the poll (Timer or Vote Counter) is not the meeting host, works on free Zoom accounts and instant meetings, keeps live results in our app, and needs no new Zoom poll scopes.

**Needs:**
- Worker endpoints: create poll, get ballot, cast vote, read results (owner only), close poll.
- Storage for polls and votes, and a way to deliver live counts (polling an endpoint is enough at first).
- **One vote per device per category.** Use a random device token stored in the browser, checked server-side. This is good enough for a club vote, not proof against someone deliberately voting twice; say so in the UI help text.
- An unguessable poll ID in the link, an expiry (for example, 24 hours), and no personal data in the URL.
- Add `sendMessageToChat` to the app's requested capabilities, as an optional API.

### B. Native Zoom poll (extra, only when the app user is the host)

Offer "Create as Zoom poll" only when the meeting qualifies. The app turns the same ballot into a Zoom meeting poll (`POST /meetings/{meetingId}/polls`), one single-choice question per category.

**Zoom's limits, to show in the UI:**
- **Only for the meeting's host:** the poll is created on the host's meeting with the host's own authorization. Hidden for co-hosts and participants.
- **Host needs Pro or higher**, with polling enabled in their Zoom settings.
- **Scheduled meetings only.** Instant meetings don't support polls.
- **The host launches the poll and shares results in Zoom's own poll window.** Zoom's API does not return results during the meeting, so our app cannot show live counts or reveal winners for a native poll.
- Results are available through the API only **after the meeting ends** (`GET /past_meetings/{meetingId}/polls`), after a processing delay of a few minutes. We can attach them to the report afterwards, as a best effort.

**Needs:**
- New OAuth scopes for creating polls and reading poll results, which means a new Zoom app review.
- Eligibility checks before offering the option (host role, meeting type), with a clear message when it doesn't apply.

**Suggested split:** ship A first. B can be a separate follow-up issue, since it depends on Zoom's review.

## Decisions

- **Plan:** Pro only.
- **Ties:** multiple winners. Everyone tied for the top count in a category wins.
- **Self-voting:** allowed.
- **Saved setup:** the poll template is saved per club and published like the timing presets, with a personal template for Pro users without a club.

## Acceptance criteria

- [ ] Polls are available to Pro users only; free users get the upgrade prompt.

- [ ] A new poll defaults to Table Topics Speech and Table Topics Evaluation, 3 slots each.
- [ ] Categories and candidates can be added and removed. A category's role can be changed to any timing role, including custom roles.
- [ ] A role created from the poll screen appears in the timing roles with default rules.
- [ ] Candidates are auto-filled from this meeting's timed speakers in that role, and can be edited.
- [ ] Web voting works from a browser without Zoom sign-in. One vote per device per category is enforced by the server.
- [ ] Live counts are visible only to whoever runs the poll. Winners are revealed per category, and results are saved with the report and the club archive.
- [ ] A tie for the top count announces every tied candidate as a winner.
- [ ] A club admin or editor can publish the poll template; other members' devices get it on the next refresh. A one-meeting edit does not change the club's template.
- [ ] A Pro user without a club has a personal template that syncs across their devices.
- [ ] (B) "Create as Zoom poll" appears only for the host on an eligible meeting, creates one question per category, and explains Zoom's limits.
