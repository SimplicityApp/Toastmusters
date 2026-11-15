# Meeting polls: vote for Best Table Topics Speaker, Best Speaker, and Best Evaluator (#80)

## Problem
Clubs end most meetings by voting for the best Table Topics speaker, best speaker and best
evaluator. Today they count votes by hand or set up a Zoom poll separately, even though the
timer already knows who spoke in each role. #80 asks for a Pro-only ballot built from this
meeting's timed speakers. Running a poll is Pro; voting is free. Votes come in three ways,
shipped together: in the Zoom app after "Invite everyone" (the primary path, review Q3), a web
link `/vote/<id>` (the backup), and a native Zoom poll (host only), whose results are fetched
after the meeting. Club and personal templates hold the ballot setup. Winners show on the
Report tab, the report image and the shared `/r/` page.

**Review applied (2026-11-15).** Q1 Durable Object. Q2 Zoom app only. Q3 in-Zoom voting with a
verified Zoom identity first, web link as backup with a per-poll-and-IP limiter (~120/min,
fails open). Q4 the dev Marketplace app has every scope, SDK API, webhook and Guest Mode
Testing, so MP-04 and the Zoom-poll and invite steps run for real. Q5 native results are
fetched after the meeting with a short-lived encrypted refresh token. Q6 winners on the
report image and `/r/`. Q7 owner is the creating uid. Q8 zero votes means no winner.

## Findings
The earlier spec `docs/issues/meeting-polls.md` (38cc6e8) proposed splitting A and B. The
issue overrides that: A and B ship together (decided 2026-11-13). No code exists yet:
`git log -S` finds nothing for poll, vote or ballot, and nothing calls `sendMessageToChat`.

**Client (Zoom app)**
- **Tabs:** the tab list is `apps/zoom-app/src/components/NavTabs.jsx:8-12`. Tabs are
  lazy-loaded and rendered at `App.jsx:13-15,38-40`. Web: `apps/web/src/components/NavTabs.jsx:5-9`
  and `pages/TimerApp.jsx:114-118`.
- **Reports:** `toastmaster_reports` (`packages/shared/storage.js:20`). Each entry is
  `{speechId, name, role, duration, color, comments, disqualified, finishedAt}`
  (`addReport`, zoom `TimerContext.jsx:539-552`). "This meeting" means the reports since the
  last Clear, plus the club archive's `meetingId`
  (`deriveMeetingId`, `packages/shared/clubArchive.js:218`).
- **Roles:** the built-ins `Table Topics Speech`, `Standard Speech` and `Table Topics
  Evaluation` are defined at `packages/shared/timingRules.js:3-12`. `DEFAULT_CUSTOM_RULES` is
  at `:17`. `roleOptions` is at zoom `TimerContext.jsx:166-174`.
- **Adding a role:** `addRoleRules(role, rules)` is at `:597-609`. Edit Rules adds a role
  through `ensureForked` first (`EditRulesModal.jsx:265-276`, `clubPresets.js:232`). Without
  that call, a club device writes the role to personal keys while the club's list stays
  active.
- **Pro gating:** `useEntitlement()` returns `isPro` (`hooks/useEntitlement.js:19-28`).
  `useSoundsAccess()` (`hooks/useSounds.js:32-39`) is the pattern for
  `{usable, lockReason: 'pro'|'unreleased'}`. `UpgradeModal source=…` is at
  `components/UpgradeModal.jsx:92`, used as in `SoundsModal.jsx:43-115`.
- **Stage view:** `components/TimerStage.jsx` is a React DOM overlay, mounted from
  `LiveTab.jsx:980-1009` and shared with `shareApp`/`appPopout`. A winners panel there is
  plain React, with no canvas work.
- **SDK capabilities:** they come from `USED_SDK_APIS` (`utils/zoomSdk.js:78-109`).
  `zoomSdk.test.js:1351-1355` checks the list against the `zoomSdk.*` calls in both
  directions.
- **SDK state:** `getUserContext` gives `role` (`readZoomUserSummary`, `:2260-2280`).
  `getMeetingContext` is not used yet.
- **Settings sync:** the allowlist is `SYNCED_KEYS` (`packages/shared/profileMerge.js:28-43`).
  Keys must be written through `persist` (`storage.js:7-16`) or the sync never sees them.
- **Club template precedent:**
  - Publish: `publishPresets` → `PUT /api/club/presets` (`clubPresets.js:251`,
    `worker/club-presets.js:132-187`). The handler checks session, club, entitled and
    admin/editor, writes `club-presets:<id>`, then bumps `club:<id>.ver`.
  - Members: `refreshClub` (`packages/shared/club.js:868`, `:906-914`) saves the new
    versioned content when `ver` changes. `buildClubState` (`worker/club.js:179-218`)
    returns it.
  - Lapsed plan: `clubPresetsAvailable()` returns false when the club is not entitled
    (`clubPresets.js:71-76`).
  - Newest analogue: club cards (`worker/club-cards.js:154-219`, 25536fe).
- **Club archive:**
  - Storage: `meeting:<clubId>:…` headers and `speech:<clubId>:<meetingId>:<speechId>`
    keys (`worker/club-meetings.js:19-30`).
  - Caveat: `compactMeeting` (`:178-185`) and `readMeeting` (`:393-402`) copy only the fields
    they list. A `polls` field in the header would be dropped, so results need their own key
    and must be merged in both places.
  - Client upload goes through the outbox (`recordSpeech`, `clubArchive.js:281`).

**Worker**
- **Routing:** API routes are an if-chain at `worker/index.js:136-232`. On the `zoom.` host,
  `routeAssets` turns every path into the Zoom app (`:371-377`), so the voting link must
  use the `www.` host.
- **Public page precedent:** `/r/<token>` (`index.js:309-311`, `club-share.js:31,48-70,351-391`)
  is a Worker-rendered page with an unguessable 16-character token, `noindex` and a real 404.
  `ROOT_CSP` (`index.js:21-22`) already allows a same-origin form plus inline script.
- **Storage:** only KV `PROFILES` and R2 `CARD_ASSETS` exist (`wrangler.jsonc:79-95`). There
  is no D1 and no Durable Object.
  - KV has no compare-and-swap, and `list()` is eventually consistent for about 60 s across
    edges.
  - So a KV tally made right after Close can miss the last votes, which would make the
    revealed winner wrong.
- **Auth:** `readSession` returns `{uid}` (`auth.js:110-122`). Pro is checked with
  `resolveAccess(...).entitled`, which returns 402 `upgrade_required` (`profile.js:69-73`).
  Release flags are listed in `FLAG_FALLBACKS` (`worker/flags.js:27-45`), and `flags.test.js`
  catches drift.
- **Zoom REST:**
  - No scopes are set in code; they live in the Marketplace config.
  - `exchangeZoomCode` (`auth.js:411-436`) drops the refresh token. No user token is stored.
  - The only in-client code flow is PKCE through `zoomSdk.authorize`, in contact capture
    (`worker/contact.js:20,143-185`).
  - Zoom's `mid` reaches the Worker as a string (`zoom-context.js:133`). Zoom documents
    `mid` as the meeting UUID, but `POST /meetings/{meetingId}/polls` takes the numeric
    meeting ID, so the client sends `getMeetingContext().meetingID`.
- **Verified identity (Q3):** `decryptAppContext(value, ZOOM_CLIENT_SECRET)`
  (`zoom-context.js:95`) returns `{uid, mid, typ, exp}` or null. Guests decrypt fine with
  `uid: null`. The client reads the context with `readAppContext()` (`zoomSdk.js:2215`) and
  sends it in the body, as `/api/zoom/session` does (`session.js:72`).
- **Webhook (Q5):** `meeting.started` / `meeting.ended` are only sent to PostHog today
  (`zoom-webhook.js:142-152`). The payload has `object.id` (numeric) and `object.uuid`.
- **Secrets:** `SESSION_SIGNING_KEY` is deliberately separate from `ZOOM_CLIENT_SECRET`
  (`session-token.js:14-16`). Crypto uses `node:crypto` (nodejs_compat).
- **Shared page and image (Q6):** `/r/<token>` renders from the club meeting record
  (`club-share.js:237,351`), so polls merged into `readMeeting` reach it. The PNG is drawn
  client-side by `packages/shared/reportImage.js` from the reports list.
- **Invite (Q3):** `sendAppInvitationToAllParticipants` is in `@zoom/appssdk` and not used
  yet. It carries no payload, so the invited app must find the poll itself.

**Tests and specs**
- No Zoom-client spec covers `App.jsx`, `NavTabs.jsx`, `ReportTab.jsx`, `TimerStage.jsx`,
  `club-presets` or `club-meetings`.
- `zoomSdk.js` is covered by `timer-core` and `contact-capture`.
- `packages/shared/club.js` and `main.jsx` are covered by `club-card-sets`.
- `TimerContext.jsx` is covered by `timer-core` and `agenda-import`.
- Playwright stubs `**/api/zoom/session` for Pro with `page.route`
  (`e2e/zoom.timer-sounds.spec.js:7-29`).
- `e2e/zoom.timer-flow.spec.js:125` walks through the tabs, so it changes when a tab is added.

## Approach
This is one PR, as the issue requires. It is built in the commit order below so a reviewer
can read it in layers. Everything sits behind a new release flag `polls` (default `false`),
and the native Zoom poll has its own flag `polls_zoom`. That flag stays off in production
until Zoom approves the new scopes.

1. **Shared logic** (`packages/shared/polls.js`, pure functions):
   - `defaultBallot()`: Table Topics Speech, Standard Speech and Table Topics Evaluation,
     3 empty slots each.
   - `ballotFromTemplate(template, reports, roleNames)`: each category's candidates are the
     distinct `name`s from this meeting's reports in its role, in timing order. A category
     with none gets `slots` empty entries.
   - `normalizeTemplate`, with the keys `categories[{role, label?, slots}]` and
     `options{postToChat, showOnStage, expiryHours}`.
   - `winners(counts)`: everyone tied at the top count wins, and a category with zero votes
     has no winner.
   - Storage keys:
     - `toastmaster_poll_template`: personal, added to `SYNCED_KEYS`.
     - `toastmaster_club_poll_template`: the club copy, saved by `refreshClub` when `ver`
       changes.
     - `toastmaster_poll_draft`: this meeting's edited ballot, local only.
     - `toastmaster_poll_results`: local, cleared with the reports.
   - `activePollTemplate()` returns the club template when `clubPresetsAvailable()`, else
     the personal one, else the default. A one-meeting edit only writes the draft.
2. **Worker** (`worker/polls.js`, plus a Durable Object `PollRoom` with one instance per
   poll):
   - Routes:
     - `POST /api/polls` (session + Pro) creates the poll. Body: `{ballot, expiryHours,
       context}`. The owner's `context` is decrypted and its `mid` is recorded as the poll's
       meeting; with no verifiable `mid` the poll still works by link only. It also writes
       KV `poll-by-mid:<sha256(mid)>` → id (TTL = expiry) so invited participants can find
       it. Returns a 16-character Crockford id (the `/r/` token code); expiry defaults to
       24 h. The ballot holds candidate names and labels only.
     - `POST /api/polls/current` (public): body `{context}`. Decrypts it and returns the
       open poll's ballot for that `mid`, or 404. This is how an invited app finds the poll.
     - `GET /api/polls/<id>/ballot` (public).
     - `POST /api/polls/<id>/votes` (public): body `{choices{catIndex:candIndex}, context?,
       device?}`. The voter key and path are decided server-side:
       - `context` decrypts with a `uid` and its `mid` matches the poll → key `uid:<hash>`,
         path `zoom`;
       - `context` decrypts with no `uid` (guest) and a matching `mid` → key from `device`,
         path `guest`;
       - a `context` whose `mid` doesn't match → 403 `wrong_meeting`; an undecryptable
         context → 400;
       - no `context` (the web link) → key from `device`, path `link`, behind the limiter.
       The DO refuses a category this key already voted in (409). Keys are stored hashed.
     - `GET /api/polls/<id>/results` (owner only): `{counts, byPath{zoom,guest,link},
       status, zoom?}`.
     - `POST /api/polls/<id>/close` (owner only). It returns `{counts, byPath, winners}`
       and deletes the `poll-by-mid` index.
   - **Link limiter:** `POLL_VOTE_LIMITER` (`unsafe.bindings` ratelimit, like
     `CLUB_ACTIVATE_LIMITER`), key `<pollId>:<ip>`, 120 per 60 s, only on the `link` path.
     A limiter error lets the vote through.
   - The DO keeps strongly consistent counts, so the totals at Close are final. It deletes
     its storage with an alarm at expiry.
   - `GET /vote/<id>` on the `www.` host is a Worker-rendered page, like `/r/`. It has
     `noindex` and a device token in `localStorage`. Its help text says one vote per device
     is not proof against deliberate double voting.
   - It shows a closed or expired message and a real 404.
3. **Club template:**
   - Route: `PUT /api/club/poll-template`, built on the `requirePublisher` checks from
     `club-cards.js`. The handler stores `club-poll-template:<id>` and bumps `ver`.
   - Delivery: `buildClubState` returns `pollTemplate`, and `refreshClub` saves it.
   - Lapsed plan: the key stays stored but unused, the same as presets.
4. **Archive:**
   - Client: Close appends `{pollId, closedAt, categories[{role, label, counts, winners}]}`
     to the local results. For a club device it also queues them through the outbox.
   - Worker: `POST /api/club/meetings/<id>/polls` (club token, like speeches) writes
     `poll:<clubId>:<meetingId>:<pollId>`. `readMeeting` and `compactMeeting` merge it.
   - Each stored category keeps `byPath` counts beside the totals.
   - **Report image (Q6):** `reportImage.js` draws a "Winners" block (one row per category,
     tied names joined) under the speeches when results exist; `reportImageHeight` grows
     with it.
   - **Shared page (Q6):** `renderSharePage` shows the meeting's poll winners per category
     from `meeting.polls`. A category with no votes shows "No votes".
5. **Zoom app UI:** a **POLL** tab after REPORT (`components/PollTab.jsx`). It is hidden
   unless `flag('polls')`. On a free plan, setup is locked with `UpgradeModal source="polls"`,
   but the voting view is not (Q3).
   - **Vote view (any plan, `components/PollVote.jsx`):** on load and when the POLL tab
     opens, the app calls `POST /api/polls/current` with its app context. If a poll is open
     for this meeting and this device isn't its owner, the app shows a "Vote now" banner and
     the POLL tab opens on the ballot. The vote is sent with the context (path `zoom` or
     `guest`). After voting: "Thanks, your vote is in", with no counts.
   - **Setup:**
     - Category rows with a role select of `roleOptions`, an optional label, and
       add/remove category.
     - Candidates per category: add, remove, rename.
     - "New role…" goes through `ensureForked` → `addRoleRules(name, DEFAULT_CUSTOM_RULES)`
       → `role_added`, the same as Edit Rules.
     - "Save as my template". An admin or editor also gets "Publish to club".
   - **Open:**
     - Creates the poll (sending the owner's app context) and shows the link with Copy.
     - **"Invite everyone"** calls `sendAppInvitationToAllParticipants`. It is the primary
       action; a failure shows a toast pointing at the link.
     - Posts the link to chat with `sendMessageToChat` when `postToChat` is on. If that
       fails it falls back to Copy with a toast.
     - Add `sendMessageToChat`, `sendAppInvitationToAllParticipants` and
       `getMeetingContext` to `USED_SDK_APIS` as optional.
   - **Live:** counts every 5 s while the tab is open (`GET results`), shown only in this
     sidebar, with a small "in Zoom / guest / link" split.
   - **Close & reveal:**
     - Winners per category. Ties show every tied name.
     - "Show on Stage" sets a winners panel in `TimerStage.jsx`. It only shows the poll
       owner's own Stage.
     - The results card appears on ReportTab.
6. **Native Zoom poll (B):** "Create as Zoom poll" shows only when `flag('polls_zoom')` and
   `getUserContext().role === 'host'`.
   - **Click:** `zoomSdk.authorize` (PKCE, as in contact capture) runs, then
     `POST /api/polls/zoom` with `{code, verifier, meetingId}`.
   - **Worker:** exchanges the code, then calls `GET /meetings/{id}`. It refuses `type 1`
     (instant) with a clear reason, then calls `POST /meetings/{id}/polls` with one
     single-choice question per category. The request may also carry `pollId` so the native
     poll is linked to the app poll.
   - **Results after the meeting (Q5):**
     - `exchangeZoomCode` gains an option to return the refresh token (default unchanged:
       dropped).
     - The refresh token is encrypted with AES-256-GCM under a key derived by HKDF-SHA256
       from `SESSION_SIGNING_KEY` with info `toastmusters/zoom-poll-refresh/v1` (no new
       secret; rotating the signing key just orphans pending fetches). It is stored only in
       that poll's `PollRoom` DO, with the numeric meeting id and the meeting UUID from
       `GET /meetings/{id}`. KV `zoom-poll-by-meeting:<numericId>` → pollId, TTL 24 h.
     - `meeting.ended` in `zoom-webhook.js` looks up that key and tells the DO; the DO sets
       an alarm 5 min later (Zoom's processing delay). The alarm refreshes the token, calls
       `GET /past_meetings/{uuid}/polls` (UUID double-encoded when it starts with `/` or
       contains `//`), stores the results in the poll as `zoom`, and **deletes the token**.
       An empty or 404 answer retries at +15 min and +60 min, then gives up and deletes the
       token. Every path deletes the token by 24 h after creation at the latest.
     - The rotated refresh token Zoom returns is never stored beyond that one call.
     - The owner's client reads `zoom` from `GET results` (Report tab, on open) and merges
       it into local results; on a club device it queues the archive upload (step 4).
       Poll storage for a native poll lives 7 days so the owner can collect the results.
   - **Copy:** the UI states Zoom's limits. Only the host can use it. It needs Zoom Pro and
     polling turned on, and only works on scheduled meetings. The host launches the poll and
     shares results in Zoom's own window; the app shows the results after the meeting.
   - **Scopes:** `meeting:write:poll`, `meeting:read:meeting`,
     `meeting:read:list_poll_results` (added to the dev app; prod needs a Marketplace review).
7. **Docs:** `docs/CLUBS.md` (template, archive key, events), `docs/FEATURE_FLAGS.md` and
   `docs/ZOOM_TEST_PLAN.md` P5 (Pro list plus the new scopes for the reviewer).
8. **Analytics:** `poll_opened`, `poll_invite_sent`, `poll_vote_cast` (Worker, with `path`
   and no person data), `poll_closed`, `poll_template_published`, `zoom_poll_created` and
   `zoom_poll_results_fetched`.

**Rejected**
- KV-only votes: a tally right after Close can miss the last votes because KV is eventually
  consistent.
- D1: needs a migrations directory and gives nothing a per-poll DO doesn't.
- A web link as the only vote path: one vote per device is easy to game; a verified Zoom
  `uid` is the stronger key (Q3). The link stays as the backup.
- A per-IP limit of 30/min: it would refuse a hybrid club voting from one room's Wi-Fi.
- A new secret for the refresh-token key: HKDF from `SESSION_SIGNING_KEY` keeps the keys
  separate without a deploy-time secret step.
- Keeping the refresh token after the fetch: it is deleted right after, 24 h at the latest.
- Rendering the vote page in the web SPA: the page would load the whole web bundle on a
  phone, while `/r/` already shows the Worker-HTML pattern.
- A `results` field on the meeting header: it would be dropped by compaction.

## Acceptance criteria
- AC-1: Given a free plan with `polls` on, when the POLL tab opens, then the setup is locked
  and "Upgrade to Pro" opens the upgrade modal. The Worker answers `POST /api/polls` with 402.
  Voting is never locked: a free-plan participant can vote (AC-14).
- AC-2: Given no template, when a new poll is set up, then it has Table Topics Speech,
  Standard Speech and Table Topics Evaluation, 3 slots each.
- AC-3: Categories and candidates can be added and removed. A category's role can be set to
  any entry in `roleOptions`, custom roles included.
- AC-4: A role created from the poll screen appears in `roleOptions` with
  `DEFAULT_CUSTOM_RULES`. On a club device it goes through `ensureForked`, as in Edit Rules.
- AC-5: Given reports with speakers timed as Table Topics Speech, when the ballot is built,
  then those names, deduplicated in timing order, are that category's candidates. A category
  with nobody timed shows its empty slots. Candidates can be renamed, added and removed
  before opening.
- AC-6: Given an open poll, when someone opens `/vote/<id>` in a browser with no Zoom
  sign-in, then they see the ballot and can vote. A second vote from the same device token in
  the same category gets 409, and the counts are unchanged. Unknown or expired ids get 404.
  A closed poll refuses votes. Link votes are limited per poll and IP to 120 per minute
  (429 beyond); if the limiter throws, the vote is accepted.
- AC-7: Results are readable only by the poll's owner; other sessions get 403 and
  anonymous callers get 401. The vote page never shows counts. The owner's tab updates counts
  while the poll is open.
- AC-8: When the owner closes the poll, then each category shows only its winners, and every
  candidate tied at the top count is a winner. "Show on Stage" puts the winners on the
  owner's Stage view.
- AC-9: Closed results appear on the Report tab. For a club device they are stored under the
  club meeting and returned by `GET /api/club/meetings/<id>`, including after compaction.
- AC-10: An admin or editor publishes the template. A member's device gets it on the next
  `refreshClub`. Editing the ballot for one meeting changes neither the club template nor the
  member's stored copy. A member gets 403 on publish. On a lapsed club the template stays
  stored but is not used.
- AC-11: A Pro user without a club saves a personal template that syncs through
  `/api/profile` (`toastmaster_poll_template` in `SYNCED_KEYS`).
- AC-12: Opening a poll posts the voting link to chat with `sendMessageToChat` when
  `postToChat` is on, and always shows Copy link. A failed post falls back to Copy with a
  toast. `sendMessageToChat` is an optional capability.
- AC-13 (B): "Create as Zoom poll" shows only for the host with `polls_zoom` on, and explains
  Zoom's limits. On an instant meeting the Worker refuses, and the app says why. On a
  scheduled meeting it creates one single-choice question per category, with the candidates
  as answers. The host's refresh token is stored only encrypted (AES-GCM), only in that
  poll's DO, never in KV or logs.
- AC-14 (in-Zoom vote): Given an open poll created in meeting M, when a participant in M
  opens the app (any plan, including free and guest), then the app finds the poll through
  `POST /api/polls/current` and shows the ballot. A signed-in participant's vote is keyed by
  their verified `uid`: a second vote in the same category from the same Zoom account, even
  on another device, gets 409. A guest's vote is keyed by device token. A context whose `mid`
  isn't M gets 403; an undecryptable context gets 400. Each vote records its path
  (`zoom`/`guest`/`link`), and the owner's results show counts split by path.
- AC-15 (invite): The owner's "Invite everyone" calls `sendAppInvitationToAllParticipants`;
  a refusal or error shows a toast pointing at Copy link. The API is an optional capability
  in `USED_SDK_APIS`, as is `getMeetingContext`.
- AC-16 (native results, Q5): Given a native poll created for meeting N, when Zoom sends
  `meeting.ended` for N, then 5 min later the DO refreshes the token, fetches
  `GET /past_meetings/{uuid}/polls`, stores per-question answer counts as the poll's `zoom`
  results and deletes the token. Empty/404 retries at +15 and +60 min, then deletes the
  token. With no `meeting.ended`, the token is deleted 24 h after creation. The owner's
  Report tab then shows those results and, on a club device, archives them.
- AC-17 (Q6): Given a meeting with closed poll results, the report image draws a Winners
  block (ties joined, "No votes" for an empty category) and the shared `/r/` page lists each
  category's winners. Without poll results both look exactly as today.

## Test list
| AC | Unit | Playwright | Zoom-client (NEW spec `meeting-polls`) |
|---|---|---|---|
| AC-1 | `PollTab.test.jsx`, `worker/polls.test.js` (402), `gating.test.js` | `zoom.meeting-polls` (free plan, locked) | MP-01 |
| AC-2 | `packages/shared/__tests__/polls.test.js` | `zoom.meeting-polls` | MP-02 |
| AC-3 | `PollTab.test.jsx` | `zoom.meeting-polls` | MP-03 |
| AC-4 | `PollTab.test.jsx` (ensureForked + addRoleRules) | — | MP-03 |
| AC-5 | `polls.test.js` (`ballotFromTemplate`) | `zoom.meeting-polls` (seeded reports) | MP-02 |
| AC-6 | `worker/polls.test.js` (DO, double vote, expiry, closed), `routing.test.js` (`/vote/`), `csp.test.js` | `zoom.meeting-polls` (vote page against routed API) | MP-05 (human: second device votes) |
| AC-7 | `worker/polls.test.js` (401/403) | — | MP-06 |
| AC-8 | `polls.test.js` (`winners`, ties), `PollTab.test.jsx`, `TimerStage.test.jsx` | `zoom.meeting-polls` | MP-07, MP-08 (Stage on real share) |
| AC-9 | `club-meetings.test.js`, `clubArchive.test.js` | — | MP-09 |
| AC-10 | `worker/club-poll-template.test.js`, `club.test.js` (`pollTemplate` in state), `packages/shared` club refresh test | — | MP-10, MP-11 |
| AC-11 | `profileMerge.test.js` | — | MP-12 |
| AC-12 | `zoomSdk.test.js` (USED_SDK_APIS), `PollTab.test.jsx` | — | MP-04 (human: confirm the chat message, since it sends a message) |
| AC-13 | `worker/polls-zoom.test.js` (fetch mocked; token encrypted, not in KV), `PollTab.test.jsx` (host only) | — | MP-13, MP-14 (Zoom authorization prompt; real, the dev app has the scopes) |
| AC-14 | `worker/polls.test.js` (context paths, uid de-dupe across devices, wrong `mid`, guest), `PollVote.test.jsx` (free plan not locked) | `zoom.meeting-polls` (vote view with a stubbed `current`) | MP-15 (open poll found in the owner's own meeting), MP-16 (human: a second participant votes in Zoom), MP-17 (human: a guest votes; setup has `defaults write ZoomChat enableGuestModeTesting true`) |
| AC-15 | `zoomSdk.test.js` (USED_SDK_APIS), `PollTab.test.jsx` (invite + failure toast) | — | MP-15 (human: confirm the invite reaches the second participant and opens the app) |
| AC-16 | `worker/polls-zoom.test.js` (alarm, retries, token deleted on every path, UUID encoding), `zoom-webhook.test.js` (`meeting.ended` → DO) | — | MP-18 (end the meeting, results appear on Report after the delay) |
| AC-17 | `reportImage.test.js` (winners block, height), `club-share.test.js` (winners on `/r/`) | — | MP-19 (report image and `/r/` show winners) |

Existing specs to update:
- `e2e/zoom.timer-flow.spec.js:125`: the tab walk.
- `timer-core`: `zoomSdk.js` capabilities, a re-run with no step change.
- `club-card-sets`: `club.js` and `main.jsx` refresh, a re-run with no step change.
- `INDEX.md`: add `meeting-polls` to the table and the run order, after `club-card-sets`.
- Any existing spec whose `covers` lists `zoom-webhook.js`, `reportImage.js`,
  `club-share.js` or `ReportTab.jsx`: review its steps for the winners block (re-run only
  if no step changes).
- `meeting-polls` setup: the dev app's SDK Status in the Debug Panel (as CC-00) shows
  `sendMessageToChat`, `getMeetingContext`, `sendAppInvitationToAllParticipants`,
  `authorize`, `onAuthorized` and `promptAuthorize` granted; a scheduled (not instant) test
  meeting for MP-13/MP-14/MP-18; the guest device runs
  `defaults write ZoomChat enableGuestModeTesting true` and restarts Zoom.

## Risk
**High.**
- New public, unauthenticated write endpoints (votes, `polls/current`) and a new storage
  primitive (a Durable Object binding plus migration in `wrangler.jsonc`, both envs).
- **A stored Zoom credential (Q5):** the host's refresh token is kept for up to 24 h,
  encrypted with AES-256-GCM under an HKDF key from `SESSION_SIGNING_KEY`, in that poll's
  DO only. It is deleted right after the results fetch, after the last retry, or by 24 h,
  whichever comes first. It is never logged or returned to a client.
- Votes trust Zoom's encrypted app context for identity and meeting match; a forged or
  replayed context fails `decryptAppContext` (expiry is enforced there).
- `meeting.ended` webhook now does work beyond analytics; it still answers within Zoom's 3 s
  (the DO call is in `ctx.waitUntil`).
- New Zoom OAuth scopes and SDK APIs, and a Marketplace re-review before `polls_zoom` can be
  on in production.
- Changes to the club state payload, archive compaction, the report image and `/r/`.

riskHigh paths touched:
- `wrangler.jsonc` (the DO binding and migration, plus `POLL_VOTE_LIMITER`).
- `worker/flags.js` (`polls` and `polls_zoom`).
- `worker/auth.js`: `exchangeZoomCode` gains an opt-in to return the refresh token; every
  existing caller keeps dropping it.
- `worker/zoom-webhook.js`: `meeting.ended` forwards to the poll DO.

Mitigations:
- Both flags default off.
- The native poll stays dark in production until Zoom approves the scopes.
- No personal data in the vote URL or the stored votes: uids and device tokens are hashed
  in the DO.
- Expiry deletes poll storage; the token has its own shorter deadline.

Size: the largest factory PR so far, at roughly 40–50 files. The commit order above keeps it
reviewable.

## Open questions
All answered by ShuhaoZQGG on the PR (2026-11-14); kept here as the record.
- Q1. Vote storage → **Durable Object**, one `PollRoom` per poll.
- Q2. Web app → **Zoom app only** in this PR; shared code and the Worker serve both.
- Q3. Rate limit → **in-Zoom voting with a verified identity is the primary path**; the web
  link is the backup, limited per poll and IP to ~120/min, failing open.
- Q4. Marketplace → **done on the dev app** (scopes, SDK APIs, webhooks, Guest Mode Testing).
  Run MP-04, MP-13–MP-18 for real; ⏭ only for a setting that is still missing at the run.
- Q5. Native results → **in this PR**, short-lived encrypted refresh token, triggered by
  `meeting.ended` after a delay.
- Q6. Report image and `/r/` → **show winners** in this PR.
- Q7. Owner → **the creating uid**.
- Q8. Zero votes → **"No votes", no winner**.
