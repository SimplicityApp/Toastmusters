# Meeting polls: vote for Best Table Topics Speaker, Best Speaker, and Best Evaluator (#80)

## Problem
Clubs end most meetings by voting for the best Table Topics speaker, best speaker and best
evaluator. Today they count votes by hand or set up a Zoom poll separately, even though the
timer already knows who spoke in each role. #80 asks for a Pro-only ballot built from this
meeting's timed speakers. It has two ways to vote, shipped together: a web link (the default)
and a native Zoom poll (host only). Club and personal templates hold the ballot setup.

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
     - `POST /api/polls` (session + Pro) creates the poll. It returns a 16-character
       Crockford id (the `/r/` token code) and expires after `expiryHours` (default 24).
       The ballot holds candidate names and labels only.
     - `GET /api/polls/<id>/ballot` (public).
     - `POST /api/polls/<id>/votes` (public): body `{device, choices{catIndex:candIndex}}`.
       The DO refuses a category this device already voted in.
     - `GET /api/polls/<id>/results` (owner only).
     - `POST /api/polls/<id>/close` (owner only). It returns `{counts, winners}`.
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
5. **Zoom app UI:** a **POLL** tab after REPORT (`components/PollTab.jsx`). It is hidden
   unless `flag('polls')`. A free plan sees the tab locked, with `UpgradeModal source="polls"`.
   - **Setup:**
     - Category rows with a role select of `roleOptions`, an optional label, and
       add/remove category.
     - Candidates per category: add, remove, rename.
     - "New role…" goes through `ensureForked` → `addRoleRules(name, DEFAULT_CUSTOM_RULES)`
       → `role_added`, the same as Edit Rules.
     - "Save as my template". An admin or editor also gets "Publish to club".
   - **Open:**
     - Creates the poll and shows the link with Copy.
     - Posts to chat with `sendMessageToChat` when `postToChat` is on. If that fails it
       falls back to Copy with a toast.
     - Add `sendMessageToChat` to `USED_SDK_APIS` as optional.
   - **Live:** counts every 5 s while the tab is open (`GET results`), shown only in this
     sidebar.
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
     single-choice question per category. It **stores no token**.
   - **Copy:** the UI states Zoom's limits. Only the host can use it. It needs Zoom Pro and
     polling turned on, and only works on scheduled meetings. The host launches the poll and
     shares results in Zoom's own window, so the app shows no live counts and no reveal.
   - **Scopes:** add `meeting:write:poll` and `meeting:read:meeting` in the Marketplace
     (a human step; see Q4).
7. **Docs:** `docs/CLUBS.md` (template, archive key, events), `docs/FEATURE_FLAGS.md` and
   `docs/ZOOM_TEST_PLAN.md` P5 (Pro list plus the new scopes for the reviewer).
8. **Analytics:** `poll_opened`, `poll_vote_cast` (Worker, no person data), `poll_closed`,
   `poll_template_published` and `zoom_poll_created`.

**Rejected**
- KV-only votes: a tally right after Close can miss the last votes because KV is eventually
  consistent.
- D1: needs a migrations directory and gives nothing a per-poll DO doesn't.
- Storing Zoom refresh tokens to fetch native poll results after the meeting: this adds
  stored credentials and a purge path for a best-effort feature. It is listed as follow-up.
- Rendering the vote page in the web SPA: the page would load the whole web bundle on a
  phone, while `/r/` already shows the Worker-HTML pattern.
- A `results` field on the meeting header: it would be dropped by compaction.

## Acceptance criteria
- AC-1: Given a free plan with `polls` on, when the POLL tab opens, then the setup is locked
  and "Upgrade to Pro" opens the upgrade modal. The Worker answers `POST /api/polls` with 402.
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
  A closed poll refuses votes.
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
  as answers. No Zoom token is stored.

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
| AC-13 | `worker/polls-zoom.test.js` (fetch mocked), `PollTab.test.jsx` (host only) | — | MP-13, MP-14 (human: Zoom authorization; blocked until the scopes are approved) |

Existing specs to update:
- `e2e/zoom.timer-flow.spec.js:125`: the tab walk.
- `timer-core`: `zoomSdk.js` capabilities, a re-run with no step change.
- `club-card-sets`: `club.js` and `main.jsx` refresh, a re-run with no step change.
- `INDEX.md`: add `meeting-polls` to the table and the run order, after `club-card-sets`.

## Risk
**High.**
- New public, unauthenticated write endpoints (votes) and a new storage primitive (a Durable
  Object binding plus migration in `wrangler.jsonc`, both envs).
- New Zoom OAuth scopes and a Marketplace re-review for B.
- Changes to the club state payload and archive compaction.

riskHigh paths touched:
- `wrangler.jsonc` (the DO binding and migration, plus the vote rate limiter).
- `worker/flags.js` (`polls` and `polls_zoom`).
- `worker/auth.js` is reused for `exchangeZoomCode` (code-exchange only; refresh tokens are
  still discarded).

Mitigations:
- Both flags default off.
- B stays dark until review.
- No personal data in the vote URL or the stored votes: device tokens are hashed in the DO.
- Expiry deletes poll storage.

Size: the largest factory PR so far, at roughly 30–40 files. The commit order above keeps it
reviewable.

## Open questions
- Q1. **Vote storage:** the plan uses a Durable Object per poll (new `wrangler.jsonc`
  binding) for exact counts at Close. Is a new DO binding OK, or do you prefer KV with a
  ~60 s "counting…" delay after Close?
  *Default: Durable Object.*
- Q2. **Web app:** ship the POLL tab in the Zoom app only, with the web app getting it in a
  follow-up? The vote page and Worker serve both apps.
  *Default: Zoom app only in this PR. Shared code and the Worker are written for both.*
- Q3. **Vote rate limit:** add a per-IP limiter on `POST /votes` (a new `unsafe.bindings`
  entry, like `CLUB_ACTIVATE_LIMITER`)?
  *Default: yes, 30 votes per minute per IP, failing open.*
- Q4. **Zoom scopes (B):** someone with Marketplace access has to add `meeting:write:poll`
  and `meeting:read:meeting` and submit for review. The Zoom station can't test MP-13/MP-14
  until the dev app has them.
  *Default: B ships behind `polls_zoom` (off), and those steps are marked ⏭ with
  `needs:zoom-test`.*
- Q5. **Native poll results after the meeting** (`GET /past_meetings/{id}/polls`): this needs
  a stored refresh token.
  *Default: not in this PR; file it as a follow-up issue.*
- Q6. **Report image and shared `/r/` page:** should they show the winners too?
  *Default: no. Results show on the Report tab and in the archive API. The PNG and the shared
  page come in a follow-up.*
- Q7. **Who runs the poll:** only the device that created it sees counts and can close it.
  A Vote Counter on another device would have to create the poll themselves.
  *Default: yes, the owner is the creating user (uid).*
- Q8. **Proposed:** a category with zero votes shows "No votes" and has no winner.
  *Default: as stated.*
