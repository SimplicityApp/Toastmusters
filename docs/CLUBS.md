# Clubs — codes, roles, rotation, lapse

Pro is sold as **one Pro account for your whole club**. A club is the thing that
makes that true: the owner (the account that pays) shares a short code, up to 3
other Zoom accounts join with it, and the club's shared presets, brand kit and
meeting archive follow each of those accounts to every computer and browser it
signs in on (#167). Membership is never stored per device.

The person who pays is rarely the person who times. Everything below follows
from that one fact.

## A club belongs to Zoom accounts

Every club request carries the caller's session and nothing else:

```
Authorization: Bearer <sessionToken>   → uid   (the Zoom app; minted from Zoom's app context)
Cookie: tt_session=<sessionToken>      → uid   (the web app, after "Sign in with Zoom")
```

The account's club is found from the uid alone. `club-of:zoom:<uid>` → `{ clubId,
at }` is a single-valued index (an account is in one club at a time), and
`memberClub(env, uid)` in `worker/club-admin.js` reads it, then the club record
and the member row under it. A missing, blocked or legacy revoked row is no club,
and a dangling index is deleted on the way past. Every route that needs a club
asks `memberClub`: the refresh, leave, presets, cards, meetings, share, assets,
profile, the console's Zoom door, `/api/zoom/session` and `/api/me`. That last
pair is what puts the club on the entitlement at the first paint, so Pro follows
the account with no code typed.

Either grant entitles: `resolveAccess(env, {uid, clubId})` in
`worker/entitlements.js` grants if the user's own subscription **or** the club
says yes. The club is read at request time and is **never** written into
`entitlement:zoom:<uid>` — that is what makes leaving, removal or lapsing take
effect on the very next call, with nothing to reconcile.

There is no club token, no `X-Club` header and no `club-device:` record any
more. Joining needs a Zoom account that approved the app: signed out of Zoom the
Pro panel asks the user to sign in, in guest mode it offers Zoom's Approve and
sends the typed code once the approval lands, and a signed-out browser is sent
through "Sign in with Zoom", which comes back to `/pro/<CODE>` and joins.

## Codes

`DTSP-7K2QM9` — a four-character club-derived prefix plus six Crockford base32
characters (`I`, `L`, `O` and `U` are absent so nobody misreads one over the
phone). All the entropy is in the suffix: the prefix is derived from the club's
name and is therefore guessable.

Typed codes are normalised (`worker/club-admin.js#normalizeCode`): upper-cased,
spaces and dashes stripped, and `O`/`I`/`L` folded onto `0`/`1`/`1`, so a code
copied out of a WhatsApp message still resolves.

Activation is rate-limited (`CLUB_ACTIVATE_LIMITER`, 10 per minute per IP),
needs a session (`401 sign_in_required`, checked before the code is looked up),
and **every refusal of the code itself is the same failure** — unknown, rotated
and lapsed codes, and a code entered by a blocked account, all return
`400 {error:'invalid_code'}`, so probing cannot confirm a club exists or that
someone was blocked. That is the one line of copy the apps show for it: *"That
code isn't active. Check with your club officer."* The refusals a person can act
on say so:

| Answer | When | Copy |
|---|---|---|
| `409 already_in_club` + `clubName` | the account is in another club | "You're already in <club>. Leave it to join another club." |
| `409 full` + `placesUsed`, `placesTotal` | the 3 places are taken | "This club's Pro is full (3 of 3). Ask the person who shared the code to free a place." |
| `503 try_again` | the place counter can't be reached; nobody joined | the network message |

## Places, the owner, roles

| Record | Written when | Holds |
|---|---|---|
| `club-member:<clubId>:zoom:<uid>` | a join, or club creation for the owner | `{ role, displayName, addedAt }`, or `{ displayName, blockedAt, blockedBy }` for a blocked account |
| `club-of:zoom:<uid>` | the same moment | `{ clubId, at }` |

**The owner** is the account that pays: `ownerUid` on the club record (a record
from before it is matched through `stripe:customer:<cus>`). The owner is an
admin, takes none of the places, and nobody — from either console door — can
remove, block, demote or leave for them (`409 owner`). They end the club by
cancelling the subscription. A club minted by hand with no known owner keeps the
last-admin rule (`409 last_admin`) as its only guard.

**Places.** The code admits up to **3 accounts besides the owner**. The count is
kept by `ClubPlaces` (`worker/club-places.js`), a SQLite-backed Durable Object,
one per club (`idFromName(clubId)`), holding the set of uids that hold a place.
A claim checks and adds on an in-memory set with no `await` between, so two
people who type the code at the same moment cannot make a 4th place; KV alone
could not, because it has no transaction and its list lags writes. The object
seeds itself once from the live member rows the first time it is used. Activate
claims the place before it writes the row and the index (and takes both back, then
the place, if a write fails); leave, Remove and Block release it before they delete
the row, and claim it back if the delete fails, so a live member always holds a
place and a 503 changes nothing. Re-entering the code as a
member, or as the owner, takes nothing. `placesUsed` is shown to admins only,
beside the code.

**Leave, Remove, Block.**

- *Leave* (the member, from either app, after a confirm): the row, the index and
  the place go. Everywhere the account is signed in loses the club at its next
  open. It can join again with the code.
- *Remove* (an admin, the console's role select, after a confirm): the same, and
  likewise reversible by the account itself while a place is free.
- *Block* (an admin, the row's "…" menu, after a confirm): the row becomes
  `{ displayName, blockedAt, blockedBy }`, the index and the place go, and the code
  refuses that account (`invalid_code`) until an admin presses **Unblock**, which
  deletes the row. Unblocking does not put anyone back.

Roles live only on member rows:

| | admin | editor | member |
|---|---|---|---|
| Club presets, brand kit, card set, archive | yes | yes | yes |
| "Share with my club" (presets, card set) | yes | yes | no |
| Remove the card set | yes | no | no |
| Roster, roles, Remove, Block, kit editor | yes | no | no |
| Billing | yes | no | no |

## What arrives on a device

```
POST /api/club/activate  { code }   session   → { ...clubState, placesUsed }
GET  /api/club                      session   → { ...clubState }   404 no_club for a non-member
```

```
clubState = {
  ver,                                       ← bumped ONLY by a publish or a kit edit
  club:    { id, name },
  kit:     { name, logoUrl, primaryColor, showOnCards, showOnReports } | null,
  presets: { rules, order, hiddenBuiltins, publishedBy, publishedAt } | null,
  badge:   { x, y, scale },                  ← the club's default placement
  cards:   { label, images: { color: sha256 }, publishedBy, publishedAt } | null,
  timezone,
  role,                                      ← this caller's role, or null
  isOwner,                                   ← the owner sees no Leave
  code, shareUrl, placesUsed, placesTotal,   ← admins only; null/absent for everyone else
  plan, entitled, status, currentPeriodEnd, cancelAtPeriodEnd, source
}
```

The split down the middle is the point. Content is versioned and replaces a
device's copy **only when `ver` moves**, so a refresh never clobbers a
timer's list. Plan and `entitled` carry no version and are applied every time,
because a club can lapse with nothing having been written.

The device's copy belongs to the account it was read for, and it is applied only
once identity has resolved (`syncClubWithIdentity`, `packages/shared/club.js`):

| Identity | What happens |
|---|---|
| signed in, the session says there is a club | `GET /api/club` on every open; the answer replaces the copy |
| signed in, the session says there is none | the copy is forgotten (no leave POST) |
| signed in as a different account | the copy is forgotten first |
| session unreachable, Zoom says the app is authorized | the copy is kept and its Pro applied (offline) |
| signed out, or guest mode | the copy is forgotten, never applied |

No club request goes out before the session exists, and nothing club-shaped is
applied before the first paint. A failed refresh leaves the copy in place, so a
lapse can never land mid-meeting; a `401`/`403`/`404` forgets it.

### Device-local keys (none of these are `SYNCED_KEYS`)

```
toastmaster_club                    { uid, ver, club, kit, badge, role, isOwner, plan, … }
toastmaster_club_presets            the club's published list
toastmaster_preset_source           'club' | 'personal'
toastmaster_club_cards              the club's card set: label and image hashes
toastmaster_card_source             'club' | 'own'
toastmaster_club_badge              this device's badge move, if it made one
toastmaster_club_outbox             finished speeches not yet uploaded (kept on a 401 or
                                    with no session yet; sent once there is one; each
                                    carries its clubId and is dropped unsent if the
                                    device is in another club by then)
toastmaster_club_grace_dismissed    the day the renewal reminder was dismissed
```

The club's list must never touch `toastmaster_role_rules` and friends: those
**are** `SYNCED_KEYS`, and writing a club's presets into them would push the
club's list into the buyer's *personal* profile and from there onto every other
device they own. Because the personal keys are simply never written while a club
is active, "the device's own presets are kept aside untouched" costs nothing —
leaving or lapsing is a key deletion, not a restore.

## Presets: a switch, not a blend

A club device runs one list or the other. The switch is per device and its
opening position is derived: a device that has never customised anything opens
on the club's list; a device with its own presets keeps them. Editing the club's
list asks once, then forks it into the timer's own keys
(`packages/shared/clubPresets.js`).

## Card set: a switch, like presets

A club can publish one set of timing-card artwork. An admin or editor presses
**Share with my club** on one of their own custom sets in **Card Images**; the
images go to `club-card/<clubId>/<hash>` and the set to `club-cards:<clubId>`, and
`ver` moves. Every club device downloads what it is missing into IndexedDB
(`packages/shared/clubCards.js`), so the card-switch path never waits on the
network.

Which set shows follows the preset rule: a device that never chose cards of its
own opens on the club's set; one that did keeps its own, with the club's one tap
away in the picker. Choosing in the picker moves `toastmaster_card_source`
explicitly. A lapsed or left club drops the set from the picker and the device
shows its own choice again; nothing is deleted. An admin can take the set down
from the console.

Publishing prunes images no set names any more, sparing uploads newer than 15
minutes so a second publisher's uploads survive until their own publish lands.

## KV inventory

All in the `PROFILES` namespace, alongside the entitlement and Stripe prefixes.

```
club:<clubId>                          { name, code, ver, kit, stripeCustomerId,
                                         billingEmail, plan, status,
                                         currentPeriodEnd, cancelAtPeriodEnd,
                                         timezone, ownerUid, createdAt }
club-by-code:<CODE>                    <clubId>
club-by-customer:<cus_id>              <clubId>
club-by-email:<address>                <clubId>        ← the magic link's only lookup
club-pending:<cus_id>                  { uid, clubName, email, stripeCustomerId,
                                         checkoutSessionId, paidAt }
club-presets:<clubId>                  { rules, order, hiddenBuiltins, badge,
                                         publishedBy, publishedAt }
club-cards:<clubId>                    { label, images: { color: sha256 },
                                         publishedBy, publishedAt }
club-member:<clubId>:zoom:<uid>        { role, displayName, addedAt }
                                       | { displayName, blockedAt, blockedBy }   ← blocked
club-of:zoom:<uid>                     { clubId, at }   ← the account's one club
club-magic:<token>                     { clubId, email, exp }      15-minute TTL
meeting:<clubId>:<invTs>:<meetingId>   { title, date, startedAt, speeches?: [...] }
   ↳ KV metadata                       { speeches, overtime, title }
speech:<clubId>:<meetingId>:<speechId> one finished speech, before compaction
report-share:<token>                   { clubId, meetingId }
report-share-by-meeting:<clubId>:<id>  <token>         ← so a re-share reuses the address

Durable Object (CLUB_PLACES, class ClubPlaces, one per club)
holders                                [uid, …]   the accounts holding a place

R2 (CARD_ASSETS)
club/<clubId>/<hash>                   the club logo — served publicly, immutable
club/<clubId>/r-<token>.png            a shared report's OG preview image
club-card/<clubId>/<hash>              a card set image — private, never under club/
                                       (which /api/club-assets serves to anyone)
```

`invTs` is an inverted timestamp so `list({prefix:'meeting:<clubId>:'})` comes
back newest-first with no sorting, and the metadata carries the counts so the
History list costs exactly one operation.

## Routes

```
POST /api/club/activate                   session, rate-limited
GET  /api/club                            session (member)
POST /api/club/leave                      session (member; not the owner)
PUT  /api/club/presets                    session, role admin|editor
PUT  /api/club/cards/<hash>               session, role admin|editor (one image)
PUT  /api/club/cards                      session, role admin|editor (the set)
GET  /api/club/cards/<hash>               session (member), or an admin's console session
DELETE /api/club/cards                    admin
POST /api/club/meetings/<id>/speeches      session (member)
GET  /api/club/meetings                   session (member)
GET  /api/club/meetings/<id>              session (member)
POST /api/club/meetings/<id>/share         session (member)
GET  /api/club/roster                     admin   people, the place count, the blocked
POST /api/club/members/<uid>/role         admin   role, or `revoked` to remove
POST /api/club/members/<uid>/block        admin   { blocked: true|false }
POST /api/club/members/<uid>/name         admin
PUT  /api/club/kit                        admin
POST /api/club/magic-link                 public, rate-limited, ALWAYS 200
GET  /api/club/manage?t=<token>           consumes the magic token
GET  /api/club-assets/<clubId>/<name>     public, immutable, no auth
GET  /r/<token>                           Worker-rendered report page, noindex
```

Web-only surfaces: `/pro/<code>` (the officer's shareable link), `/club/admin`
(the console) and `/club/manage` (where a mailed link lands). None of these can
open inside the Zoom sidebar, which is why the Zoom app does not know they exist.

## Creating a club

A club is minted by `createClubForSubscriber()` in `worker/club-create.js`, which
has exactly two callers so that "create a club" cannot mean two different things:

| Caller | When |
|---|---|
| `worker/stripe-webhook.js` | `checkout.session.completed` — the club exists before the buyer goes looking for it |
| `POST /api/club/create` | a subscriber who has no club presses **Set up my club**, on either surface |

Both are **idempotent on the Stripe customer**. `club-by-customer:<cus>` is the
guard; `club-creating:<cus>` is a 60-second advisory lock that closes the common
window (a double-click, or the webhook and the button racing). KV has no
compare-and-set, so after writing, the customer index is re-read: a club that
lost the race is deleted and the winner is returned.

Who may mint one:

- `source === 'subscription'` — the person who pays. Yes.
- `source === 'unenforced'` — a deployment with `ENTITLEMENT_ENFORCE=0` (dev).
  Yes, and still only with a Stripe customer id, so a dev club has real billing
  behind it. Without this the endpoint would be untestable on dev, which is the
  only place it can safely be tested.
- `source === 'grant'` — a comp. **No.** Grants are hand-written by an operator
  and so are the clubs that go with them, through the CLI.
- A club member riding someone else's code — **no**. The gate reads the user's
  own entitlement record, not the combined `resolveAccess`.

The club inherits `status`, `currentPeriodEnd` and `cancelAtPeriodEnd` from the
buyer's entitlement record rather than assuming `active`, so a club minted during
a grace period lapses on the date the buyer was actually told.

### The CLI, now a fallback

The operator path still exists for the exception: creation is wrapped so that a
failure never costs the sale, and only then is `club-pending:<cus>` written. A
row in `pending` is now a real failure rather than every sale.

```bash
node scripts/club-cli.mjs pending --env dev
node scripts/club-cli.mjs create  --env dev --pending cus_123 --tz America/Toronto
node scripts/club-cli.mjs show    --env dev --code DTSP-7K2QM9
```

## Reading the code

`club.code` is the club's password, so `buildClubState` returns it — with the
`/pro/<code>` share link and the place count — **only when the caller's role is
`admin`**. Everyone else, editors included, gets `null`, and a demoted officer
loses them on their next refresh.

It is returned on the ordinary club refresh rather than only from the web
console, because the officer who has to share the code is often working inside
Zoom and the console is a browser-only page.

## Rotating a code

Rotation is the lever a leaked code needs.

```bash
node scripts/club-cli.mjs rotate --env dev --club <clubId>
```

It writes the new `club-by-code:`, deletes the old one and bumps `ver`. The old
code admits nobody from then on; everyone already in the club is in by account,
so every member, role and block stays as it was.

After the #167 deploy, members who joined before the index existed need it
written once (it also deletes legacy `revokedAt` rows and reports an account in
two clubs):

```bash
node scripts/club-cli.mjs backfill-club-of --env dev            # dry run
node scripts/club-cli.mjs backfill-club-of --env dev --apply
```

## Grace and lapse

The server has carried this policy since before clubs existed
(`subscriptionGrantsAccess`, `worker/entitlements.js`), and clubs run through
exactly the same rules:

| Status | Entitled until |
|---|---|
| `active`, `trialing` | always |
| `past_due` | `currentPeriodEnd` + 7 days |
| `canceled` | `currentPeriodEnd` |
| anything else | not entitled |

The device follows that in three stages (`clubLifecycle()`,
`packages/shared/club.js`):

- **Grace.** Everything still works. Every member's timer shows a dismissible
  banner above the tabs — *"Downtown Speakers' Pro ends in 5 days. Ask your club
  admin to renew."* — with a "Manage billing" action for admins only. Dismissal
  is **for today**: the reminder returns each day until the club renews or lapses.
- **Lapsed.** On the next app start the badge, report header, auto-save, sharing
  and History disappear; the club's presets are replaced by the built-ins plus
  whatever this device had customised before it activated; the Footer reads
  "Upgrade". The upgrade modal names the club and keeps the code field; the rules
  editor explains why the club's presets are gone.
- **Renewal.** The next refresh restores presets, kit, badge default and archive
  with nothing re-entered and no re-activation.

**Nothing is hard-deleted.** Not the club record, not its kit, not its presets,
not its archive, and not the device's cached club — which is exactly why the
device still knows which club to re-check.

Hand-editing a dev club to exercise all three:

```bash
# grace: five days left
npx wrangler kv key put --binding PROFILES --env dev 'club:<clubId>' \
  '{"name":"Downtown Speakers","code":"DTSP7K2QM9","ver":1,"status":"past_due","currentPeriodEnd":<now - 2 days>}'
# lapsed: push the period end into the past
#   "status":"canceled","currentPeriodEnd":<any past ms>
# renewed: back to "status":"active"
```

Then close and reopen the timer: the club is re-read on every open.

## Analytics

`club_code_activated` · `club_code_rejected` · `club_left` ·
`club_presets_published` · `club_presets_reset` · `club_presets_forked` ·
`club_admin_opened` · `club_role_changed` · `club_access_revoked` ·
`club_member_blocked` · `club_member_unblocked` ·
`brand_badge_moved` · `meeting_ended` · `report_shared` ·
`report_history_viewed` · `club_grace_banner_shown` · `club_lapsed_shown`

All carry `club_id` and `surface` (`zoom` or `web`). Since #167:

- `club_code_activated` carries `places_used` (from the server's answer) and
  `via` (`typed`, `link`, `approved` or `pending`); `is_guest` is gone, since a
  guest can no longer join.
- `club_code_rejected.reason` is the server's `error`, plus `full`,
  `already_in_club`, `sign_in_required` (the client's own check, or the server's)
  and `approve_required` (decided on the client, before anything is sent).
- `club_access_revoked` is the console's Remove; `club_member_blocked` and
  `club_member_unblocked` are Block and Unblock.

The existing `upgrade_prompt_shown` carries `plan_source` in
`subscription | grant | club`, which is what lets the upgrade funnel tell buyers
from club members.
