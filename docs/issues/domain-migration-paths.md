# Domain migration: move the timer to toastmusters.com paths (Phases 0–3, stop before Zoom)

**Labels:** `enhancement`

## Summary

Move from one subdomain per product to paths on one domain, then move the timer from simple-tech.app to toastmusters.com. This follows the *Toastmusters domain migration plan* (runbook v1.1, 26 Sep 2026).

**Scope of this issue: Phases 0–3 only.** Stop before the Zoom cutover. Do **not** change the Zoom Marketplace listing, its app URL, OAuth settings, domain allowlists, or the behaviour of `zoom.timer.simple-tech.app` without a separate confirmation (see [The Zoom stop](#the-zoom-stop)).

This replaces the subdomain-per-tool approach in `docs/DOMAIN_MIGRATION.md` (decided 2026-09-02). Update or archive that doc as part of Phase 0.

## Status (2026-10-03)

Step 1 is built on branch `feat/seo-and-domain-migration` (PR #82), not yet
deployed. The live URL map, configuration, deploy order and the open step 2
decisions are in [`docs/TOASTMUSTERS_PATHS.md`](../TOASTMUSTERS_PATHS.md),
which supersedes the target map below where they differ. Decisions changed
since this issue was written:

| Topic | This issue said | Decided |
| --- | --- | --- |
| Phase 2 (`simple-tech.app/timer`) | Keep it | **Dropped.** Each old URL moves once, straight to its final page; `simple-tech.app` is not touched at all. |
| Web timer path | `/timer` | **`/timer/app`**, its final URL. `/timer` is held for a timer landing page should `/` ever become a suite home (302 → `/` until then). |
| Root page | Timer marketing page, 200 | Unchanged: the landing page stays at `/` while the timer is the main product. |
| `timer.toastmusters.com/*` | 301 → `www.toastmusters.com/timer/*` | 301 → the same path on `www.toastmusters.com` (`/app` → `/timer/app`). Its homepage maps onto `/`. |
| `zoom.timer.toastmusters.com/*` | 301 → `www.toastmusters.com/zoom/*` | **Not redirected.** The Zoom app will move to a subdomain (`zoom.toastmusters.com` or `zoom.timer.toastmusters.com`, decided at that time), not a path; a cached 301 there would get in the way. |
| Web users' saved data | One-time carry-over | Deferred to step 2 and to be measured first. Step 1 redirects `www.timer.toastmusters.com` without one (3 web-timer users there in 90 days). |
| Calls to action | — | The Zoom app is the product: every CTA leads with Add to Zoom, and every CTA click is tracked (`cta_clicked`). |
| Zoom allow list | Untouched | A Zoom review adding `toastmusters.com` was submitted; it gates merging PR #82, because the Zoom app's browser-timer fallback now opens `www.toastmusters.com/timer/app`. |

## Decisions

| Decision | Choice |
| --- | --- |
| Canonical host | **`www.toastmusters.com`**. The bare `toastmusters.com` 301s to it, as it does today; the Worker's existing apex → www rule covers it unchanged. Every legacy redirect, canonical tag, sitemap entry and internal link uses the `www` form directly, so nothing passes through the bare domain first. Printed material may still say `toastmusters.com/…`; that costs one hop. |
| Phase 2 | **Keep it.** The timer is served temporarily at `simple-tech.app/timer` before the final move. |
| Web users' saved data | **One-time carry-over** on the way out of each old host (see [Carrying web users' data](#carrying-web-users-data)). |
| Root page | `www.toastmusters.com/` serves the timer marketing page with **200**. It never redirects to `/timer`. |
| `simple-tech.app` | Stays the portfolio. Only its timer routes move. |

## Current state (checked 2026-10-02)

- **One Worker serves most of it.** `toastmaster-timer` serves every timer host on both domains, plus `toastmusters.com` and `www.toastmusters.com`, plus the official Zoom host `zoom.timer.simple-tech.app`. Table Topics is a separate Worker, `toastmusters-tabletopics`.
- **`toastmusters.com/`** 301s to `www.toastmusters.com/`, which serves the timer landing page. Its canonical tag still points to `https://www.timer.simple-tech.app/`.
- **Timer paths today:** `/` is the landing page, `/app` the web timer, `/zoom/*` the Zoom app (built with Vite `base: '/zoom/'`). `/web` 302s to `/app`. Other SPA routes: `/oauth/redirect`, `/billing/success`, `/billing/cancel`, `/account`, `/pro/*`. There are about a dozen static SEO pages in `apps/web/public/*.html`.
- **`simple-tech.app` and `www.simple-tech.app` still go to Vercel.** The zone is on Cloudflare, but both records are DNS-only: `216.150.1.1` and `…vercel-dns-016.com`, and responses carry `server: Vercel` and `x-vercel-id`. No Worker is attached to either host. **Phase 2 cannot work until requests to these hosts go through Cloudflare** (see Phase 2, step 2.0).
- **Settings tied to a hostname:**
  - `WEB_ORIGIN = https://www.timer.simple-tech.app` (`wrangler.jsonc`): used for the web sign-in `redirect_uri` (`/oauth/redirect`) and for Stripe Checkout and Billing Portal return URLs.
  - `ZOOM_OAUTH_REDIRECT_URL` and the support link in `packages/shared/appLinks.js` point to `www.timer.simple-tech.app`.
  - `www.timer.simple-tech.app/oauth/redirect` is registered in the **Zoom Marketplace**, so it must keep working until the Zoom cutover.
  - Hardcoded `simple-tech.app` URLs: `apps/web/index.html`, `apps/web/public/*.html`, `sitemap.xml`, `robots.txt`, `llms.txt`, `apps/web/src/utils/posthog.js`, `worker/index.js`, `worker/flags.js`. The Zoom app's own references (`apps/zoom-app/*`) are **out of scope** until the Zoom cutover.
  - The PostHog proxy `e.simple-tech.app` stays as it is.
- **Real Zoom traffic** (`ZoomApps/1.0` user agent) arrives only on simple-tech.app. `zoom.timer.toastmusters.com` only gets crawlers and scanners.

## Target URL map

> Superseded where it differs from [`docs/TOASTMUSTERS_PATHS.md`](../TOASTMUSTERS_PATHS.md); see Status above.

Same as the runbook. Each row is mapped on its own, not with one wildcard rule. Query strings are kept, with one trailing-slash policy throughout. The rows apply equally to each host's `www` alias.

| Source | Phases 1–2 | Final (Phase 3) |
| --- | --- | --- |
| `toastmusters.com/*` | 301 → `www.toastmusters.com/*` (already live) | same |
| `www.toastmusters.com/` | timer marketing, 200 | same (never → `/timer`) |
| `www.toastmusters.com/timer` | web timer, 200 | same |
| `www.toastmusters.com/tabletopics` | Table Topics, 200 | same |
| `www.toastmusters.com/zoom` | Zoom app (tested in a browser only) | same; becomes the Zoom URL only after approval |
| `timer.toastmusters.com/*` | 301 → `www.toastmusters.com/timer/*` | same |
| `tabletopics.toastmusters.com/*` | 301 → `www.toastmusters.com/tabletopics/*` | same |
| `zoom.timer.toastmusters.com/*` | 301 → `www.toastmusters.com/zoom/*` | same, after the route test |
| `timer.simple-tech.app/` | 301 → `simple-tech.app/timer` | 301 → `www.toastmusters.com/` |
| `timer.simple-tech.app/app` | 301 → `simple-tech.app/timer/app` | 301 → `www.toastmusters.com/timer` |
| `simple-tech.app/timer` | timer marketing, 200 | 301 → `www.toastmusters.com/` |
| `simple-tech.app/timer/app` | web timer, 200 | 301 → `www.toastmusters.com/timer` |
| `zoom.timer.simple-tech.app/*` | **unchanged** | **unchanged** until Zoom approval |
| `simple-tech.app/*` (portfolio) | **unchanged** | **unchanged**, except the timer routes |

**Paths that need their own decision before any redirect** (Phase 0.1). A wildcard must not catch them by accident:
- `/oauth/redirect` and `/api/auth/*`: web sign-in. Excluded from every redirect on `www.timer.simple-tech.app` until the Zoom cutover.
- `/api/*`: every POST endpoint, plus the Zoom and Stripe webhooks. A 301 drops the request body, so these are never redirected. Today the Worker deliberately handles them *before* any redirect.
- `/billing/success`, `/billing/cancel`, `/account`, `/pro/*`: these go under `/timer` or stay at the root.
- The static SEO pages (`/toastmasters-timing-chart.html` etc.): stay at the root, as marketing content.
- `/privacy`, `/support`, `/terms-of-use`, `/documentation`: today these rewrite to `/zoom/*.html`, and the Zoom listing links to them.
- `/r/*` short links, `/assets/*`, `/backgrounds/*`, `/zoom/*`, `robots.txt`, `sitemap.xml`, `llms.txt`.

## Carrying web users' data

All web-timer state lives in browser storage, which is tied to one host: agenda, role rules and order, reports, prompts, card images and so on. A redirect does not carry it. Profile sync (`/api/profile`) doesn't cover it either: it needs sign-in, uploading is Pro- or club-only (`402 upgrade_required` otherwise), and `toastmaster_reports` is not a synced key. So free and anonymous users would arrive at the new URL empty.

**One-time carry-over:**
1. On a legacy timer host, a browser **with saved data** gets a small handoff page instead of the immediate 301. Bots and browsers with nothing saved still get a plain 301, so search engines see one hop.
2. The handoff page uploads all `toastmaster_*` keys (reports included) to the Worker under a **random one-time code**, then forwards to the matching new URL with that code.
3. The new origin pulls the data, merges it into its own storage (existing data on the new origin wins), and the Worker **deletes the stored copy immediately**. Unused codes expire after, for example, 24 hours.
4. Mark the old origin "migrated", so later visits go straight to the 301.

**Constraints:**
- The URL carries only the opaque code, never user data.
- Cap the upload size.
- Custom card images (IndexedDB) go through the same path or through R2, as the card-asset sync does today.
- Repeat at each hop: Phase 2 (`timer.simple-tech.app` → `simple-tech.app/timer`) and Phase 3 (→ `www.toastmusters.com/timer`).

**How the Worker tells the cases apart, without client-side code on every request:** an open question. A first-party "has data" cookie set by the web app, checked at the edge, is one option.

## Phase 0: prepare (no production changes)

- [ ] **0.1 Freeze the URL map.** Export the routes both Workers serve today. List every host, path exception, status code, canonical tag, sitemap entry and analytics property. Resolve the special paths listed above.
- [ ] **0.2 Record a baseline:** response codes, titles, canonical tags, indexability, key Search Console metrics, Cloudflare request counts, PostHog events, and one real Zoom launch.
- [ ] **0.3 Access and rollback.** Production write access for this work is granted separately. Export the current routes and Worker versions, name a rollback owner, and make reverting a route a single action.
- [ ] **0.4 Migration observability.** Split analytics by hostname and path. Set up saved views for 404s, 5xx, redirect volume, canonical destinations, page-load failures and Zoom launch success.
- [ ] **0.5 Acceptance samples.** A fixed test set: root pages, deep links, query strings, assets, API calls, mobile layouts, bookmarks, social previews, the Zoom client, and the data carry-over. Write the expected outcome next to each.
- [ ] Update or archive `docs/DOMAIN_MIGRATION.md`, and record the decisions above.

**Go / no-go gate:**
- All routes and aliases are listed.
- The new paths can be deployed without redirecting any old host.
- Analytics can tell old-host traffic from new-path traffic.
- Rollback has been tested outside production.
- The Zoom host has an explicit exclusion rule.

## Phase 1: toastmusters.com paths (Zoom untouched)

- [ ] **1.1 Serve the final pages:** `/` (marketing, 200), `/timer` (web timer; today's `/app`), `/tabletopics`, `/zoom`. Check that assets, APIs, storage, cookies, service workers and client-side routing work under each path prefix.
  - The web app needs its `/app` routes moved to `/timer`.
  - Table Topics needs to serve under `/tabletopics`: either a base-path build of `toastmusters-tabletopics` proxied through a service binding, or a path route.
- [ ] **Canonical host:** keep `www.toastmusters.com` (the bare domain already 301s to it). Point the canonical tag, `og:url` and sitemap at `https://www.toastmusters.com/…`; today the canonical still names `www.timer.simple-tech.app`.
- [ ] **1.2 Update the product's own references** to the new paths: navigation, canonical tags, Open Graph, structured data, sitemap, analytics page paths, app links. Not the Zoom Marketplace configuration.
- [ ] **1.3 Validate side by side.** Compare old and new routes for content, behaviour, headers, events and performance. Test `/zoom` directly in a browser.
- [ ] **1.4 Redirects for toastmusters.com hosts only:** `timer.`, `tabletopics.` and `zoom.timer.toastmusters.com`, plus their `www` aliases, 301 to the matching paths. Keep their DNS and routes active.

**Exit criteria:**
- New paths load with no asset or API failures.
- Redirects take one hop and keep the path.
- The new paths show up in analytics and canonical tags.
- **The Zoom app still launches from `zoom.timer.simple-tech.app`.**

## Phase 2: timer into simple-tech.app/timer (temporary)

- [ ] **2.0 Prerequisite: route simple-tech.app through Cloudflare.** Move the portfolio onto Cloudflare and switch `simple-tech.app` and `www.simple-tech.app` from DNS-only (Vercel) to Cloudflare's proxy. Confirm the portfolio is unchanged (response headers no longer show Vercel). Without this, no Worker can answer `simple-tech.app/timer`.
- [ ] **2.1 Serve both timer pages under `/timer`:** marketing at `simple-tech.app/timer`, web timer at `simple-tech.app/timer/app`. Use a Worker route limited to `simple-tech.app/timer*`, never a root-level wildcard. Every other portfolio route keeps returning 200 unchanged.
- [ ] **2.2 Change only the timer subdomain:** `timer.simple-tech.app/` 301s to `simple-tech.app/timer`, and `/app` 301s to `simple-tech.app/timer/app`, with the data carry-over. Apply the same to the confirmed aliases. **Explicitly exclude** `zoom.timer.simple-tech.app`, and the sign-in callback `/oauth/redirect` plus `/api/*` on `www.timer.simple-tech.app`.
- [ ] **2.3 Check portfolio isolation:** test several non-timer projects. No wildcard, Worker route or service worker should catch them.
- [ ] **2.4 Watch the temporary state** long enough to catch broken deep links, asset paths and duplicate analytics.

**Must stay as they are:** `simple-tech.app/` and every other portfolio route return 200. `zoom.timer.simple-tech.app` and every path the official app uses are unchanged.

## Phase 3: timer to toastmusters.com, then stop

- [ ] **3.1 Re-test both final timer pages** at `www.toastmusters.com/` and `www.toastmusters.com/timer` before changing any simple-tech.app entry point.
- [ ] **3.2 Map each old page directly to its new page.** Replace the Phase 2 redirects rather than chaining onto them:
  - `timer.simple-tech.app/` and `simple-tech.app/timer` 301 to `www.toastmusters.com/`.
  - Their app entries 301 to `www.toastmusters.com/timer`.
  - One hop from every source, with the data carry-over.
- [ ] **3.3 Update everything outside Zoom:**
  - Internal links, canonical tags, sitemap, share links and product docs move to the final URLs.
  - `WEB_ORIGIN`, which drives the Stripe return URLs, moves to the new host. The web sign-in callback stays on the Marketplace-registered URL until the Zoom cutover; check that a sign-in started on `www.toastmusters.com/timer` still finishes there.
  - Keep the legacy hosts live to serve their redirects.
- [ ] **3.4 Validate and collect evidence:** run the fixed test set, review 404/5xx, confirm redirect hops, compare analytics, and do one more real Zoom launch from the untouched official URL.

## The Zoom stop

**Stop here.** Prepare a handoff with:
- the Phase 1–3 test results
- the current redirect map
- the error dashboards
- the rollback status
- the `/zoom` route test evidence
- the **exact** proposed Zoom configuration changes: home URL, OAuth redirect URL, domain allowlist, webhook, privacy and support links

Then ask:

> "The non-Zoom migration is stable and the new Zoom route has passed the agreed tests. May we update the Zoom Marketplace app URL and related approved configuration?"

The post-approval steps (runbook Phases 4–7) belong in a separate issue.

## Quality gates (each phase)

| Gate | Pass | If it fails |
| --- | --- | --- |
| Routing | Expected 200/301, one hop, path and query kept | Disable the new redirect rule |
| Application | Assets, APIs, state, cookies, navigation work | Restore the previous Worker version or route |
| Portfolio | Non-timer simple-tech.app projects unchanged | Remove the broad host or path match |
| Search | Final canonical tags and sitemaps, no accidental `noindex` | Restore metadata; pause the next phase |
| Analytics | Events attributable to the final host and path | Fix instrumentation before rollout |
| Data carry-over | Saved data arrives intact; codes are deleted after use | Fall back to the plain 301; fix, then re-enable |
| Zoom | Official launch works from the old URL | Roll back the route that collided |

**Keep for recovery:** the previous Worker deployment, exports of earlier routes and redirects, legacy DNS and custom domains, test URLs with expected outputs, a named rollback owner, and a timestamped change log.

## Open decisions (record before execution)

- [ ] The exact mapping for callbacks, APIs, assets, `/billing/*`, `/account`, `/pro/*`, the static SEO pages and the Zoom-linked pages (`/privacy` etc.).
- [ ] The minimum observation period and acceptable error thresholds between phases.
- [ ] Whether the old Zoom host stays a permanent compatibility alias after the cutover (decided in the Zoom issue).
- [ ] The dev mirror (`*.timer-dev.*`): which path-based dev host rehearses each phase first.
- [ ] How the edge detects "has saved data" for the carry-over.

## Completion criteria

- [ ] All non-Zoom entry points reach their final `www.toastmusters.com` paths in one hop, never via the bare domain.
- [ ] simple-tech.app still works as the portfolio; only its timer routes redirect.
- [ ] Old hostnames keep serving their redirects.
- [ ] Final URLs appear in canonical tags, sitemaps, internal links and analytics.
- [ ] Web users' saved data arrives at the new URL.
- [ ] `zoom.timer.simple-tech.app` is unchanged, and the Zoom app launches exactly as before.
