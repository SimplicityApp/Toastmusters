# Clubs — codes, roles, rotation, lapse

Pro is sold as **one Pro account for your whole club**. A club is the thing that
makes that true: a second credential any device can activate with a short code,
carrying the club's shared presets, brand kit and meeting archive onto whoever
happens to be timing tonight.

The person who pays is rarely the person who times. Everything below follows
from that one fact.

## A club is a second credential

A request carries up to two independent things, either of which may be absent:

```
Authorization: Bearer <sessionToken>   → uid      (absent for a guest)
X-Club:        <clubToken>             → clubId   (absent until activated)
```

`clubToken` is minted by `POST /api/club/activate`, HMAC-signed with
`SESSION_SIGNING_KEY` (the same construction as `worker/session-token.js`),
valid 24 hours, cached in `localStorage` under `toastmaster_club`, and re-minted
by the once-a-day `GET /api/club`.

Either credential entitles: `resolveAccess(env, {uid, clubId})` in
`worker/entitlements.js` grants if the user's own subscription **or** the club
says yes. The club is read at request time and is **never** written into
`entitlement:zoom:<uid>` — that is what makes leaving or lapsing take effect on
the very next call, with nothing to reconcile.

A guest with no Zoom identity can activate a code and gets everything club-level.
They have no personal sync, because there is no identity to sync against.

## Codes

`DTSP-7K2QM9` — a four-character club-derived prefix plus six Crockford base32
characters (`I`, `L`, `O` and `U` are absent so nobody misreads one over the
phone). All the entropy is in the suffix: the prefix is derived from the club's
name and is therefore guessable.

Typed codes are normalised (`worker/club-admin.js#normalizeCode`): upper-cased,
spaces and dashes stripped, and `O`/`I`/`L` folded onto `0`/`1`/`1`, so a code
copied out of a WhatsApp message still resolves.

Activation is rate-limited (`CLUB_ACTIVATE_LIMITER`, 10 per minute per IP) and
**every failure is the same failure** — unknown, revoked and lapsed codes all
return `400 {error:'invalid_code'}`, so probing cannot confirm a club exists.
That is also the one line of copy the apps show: *"That code isn't active. Check
with your club officer."*

## Access attaches to a device; authorization attaches to a person

Activation is anonymous by design, so the two concerns are keyed separately:

| Record | Written when | Is the unit of |
|---|---|---|
| `club-device:<clubId>:<deviceId>` | every activation | access, and revocation |
| `club-member:<clubId>:zoom:<uid>` | activation carrying a uid | authorization (the role) |

Roles live only on member records, which makes **"you cannot grant editing
rights to an anonymous device"** true by construction.

| | admin | editor | member / guest device |
|---|---|---|---|
| Club presets, brand kit, archive | yes | yes | yes |
| "Share with my club" (publish) | yes | yes | no |
| Roster, grant/revoke, kit editor | yes | no | no |
| Billing | yes | no | no |

The buyer becomes the first `admin` in the same step that mints the club.

Revocation is enforced on **writes** (`verifiedClubId()` reads the device record
on every append, publish and gated `PUT`), not on reads: the token is HMAC-only
so that sending it on every request stays cheap. A revoked device loses the
ability to publish, append or consume quota immediately, and loses read access
when its 24-hour token expires.

## What arrives on a device

```
POST /api/club/activate  { code }             → { clubToken, ...clubState }
GET  /api/club           X-Club: <clubToken>  → { ...clubState }   re-mints the token
```

```
clubState = {
  ver,                                       ← bumped ONLY by a publish or a kit edit
  club:    { id, name },
  kit:     { name, logoUrl, primaryColor, showOnCards, showOnReports } | null,
  presets: { rules, order, hiddenBuiltins, publishedBy, publishedAt } | null,
  badge:   { x, y, scale },                  ← the club's default placement
  timezone,
  role,                                      ← this caller's role, or null
  plan, entitled, status, currentPeriodEnd, cancelAtPeriodEnd, source
}
```

The split down the middle is the point. Content is versioned and replaces a
device's copy **only when `ver` moves**, so a daily refresh never clobbers a
timer's list. Plan and `entitled` carry no version and are applied every time,
because a club can lapse with nothing having been written.

Refreshes happen **on app start, at most once a day**. A failed refresh leaves
the cache in place and the device stays Pro, so a lapse can never land
mid-meeting.

### Device-local keys (none of these are `SYNCED_KEYS`)

```
toastmaster_club                    { clubToken, ver, club, kit, badge, plan, … }
toastmaster_club_presets            the club's published list
toastmaster_preset_source           'club' | 'personal'
toastmaster_club_badge              this device's badge move, if it made one
toastmaster_club_outbox             finished speeches not yet uploaded
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

## KV inventory

All in the `PROFILES` namespace, alongside the entitlement and Stripe prefixes.

```
club:<clubId>                          { name, code, ver, kit, stripeCustomerId,
                                         billingEmail, plan, status,
                                         currentPeriodEnd, cancelAtPeriodEnd,
                                         timezone, createdAt }
club-by-code:<CODE>                    <clubId>
club-by-customer:<cus_id>              <clubId>
club-by-email:<address>                <clubId>        ← the magic link's only lookup
club-pending:<cus_id>                  { uid, clubName, email, stripeCustomerId,
                                         checkoutSessionId, paidAt }
club-presets:<clubId>                  { rules, order, hiddenBuiltins, badge,
                                         publishedBy, publishedAt }
club-device:<clubId>:<deviceId>        { label, uid|null, activatedAt, lastSeenAt, revokedAt }
club-member:<clubId>:zoom:<uid>        { role, displayName, addedAt, revokedAt }
club-magic:<token>                     { clubId, email, exp }      15-minute TTL
meeting:<clubId>:<invTs>:<meetingId>   { title, date, startedAt, speeches?: [...] }
   ↳ KV metadata                       { speeches, overtime, title }
speech:<clubId>:<meetingId>:<speechId> one finished speech, before compaction
report-share:<token>                   { clubId, meetingId }
report-share-by-meeting:<clubId>:<id>  <token>         ← so a re-share reuses the address

R2 (CARD_ASSETS)
club/<clubId>/<hash>                   the club logo — served publicly, immutable
club/<clubId>/r-<token>.png            a shared report's OG preview image
```

`invTs` is an inverted timestamp so `list({prefix:'meeting:<clubId>:'})` comes
back newest-first with no sorting, and the metadata carries the counts so the
History list costs exactly one operation.

## Routes

```
POST /api/club/activate                   public, rate-limited
GET  /api/club                            X-Club
PUT  /api/club/presets                    X-Club + uid, role admin|editor
POST /api/club/meetings/<id>/speeches      X-Club, + device revocation read
GET  /api/club/meetings                   X-Club
GET  /api/club/meetings/<id>              X-Club
POST /api/club/meetings/<id>/share         X-Club
GET  /api/club/roster                     admin
POST /api/club/members/<uid>/role         admin
POST /api/club/devices/<id>/revoke        admin
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

Payment parks the raw material; a human mints the record. See
[BILLING.md](./BILLING.md#turning-a-payment-into-a-club) for the full flow.

```bash
node scripts/club-cli.mjs pending --env dev
node scripts/club-cli.mjs create  --env dev --pending cus_123 --tz America/Toronto
node scripts/club-cli.mjs show    --env dev --code DTSP-7K2QM9
```

Automating creation means calling the same `createClubFromPending()` from
`worker/stripe-webhook.js`. That is deliberately a one-line change.

## Rotating a code

Rotation is the lever a leaked code needs.

```bash
node scripts/club-cli.mjs rotate --env dev --club <clubId>
```

It writes the new `club-by-code:`, deletes the old one, bumps `ver`, and
**revokes every device record**. Bumping `ver` alone would not do it: `ver` moves
on every routine publish, so treating a stale one as a forgery would lock the
whole club out for a day after a preset change. Revoking the devices bites on
the very next write instead.

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

- **Grace.** Everything still works. Every club device shows a dismissible
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

Then clear `toastmaster_club`'s `lastRefreshAt` (or wait a day) and reload.

## Analytics

`club_code_activated` · `club_code_rejected` · `club_left` ·
`club_presets_published` · `club_presets_reset` · `club_presets_forked` ·
`club_admin_opened` · `club_role_changed` · `club_access_revoked` ·
`brand_badge_moved` · `meeting_ended` · `report_shared` ·
`report_history_viewed` · `club_grace_banner_shown` · `club_lapsed_shown`

All carry `club_id` and `surface` (`zoom` or `web`). The existing
`upgrade_prompt_shown` carries `plan_source` in `subscription | grant | club`,
which is what lets the upgrade funnel tell buyers from activated timers.
