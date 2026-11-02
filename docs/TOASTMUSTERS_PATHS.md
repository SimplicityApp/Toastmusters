# Toastmusters on one host: `www.toastmusters.com/<tool>`

Every tool in the suite is a path on **`www.toastmusters.com`**, the main
site. This replaces the one-subdomain-per-tool plan in
[DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md) and tracks issue #81.
Keyword targets and content rules are in [SEO.md](SEO.md).

Four decisions shape it:

- **No detour through `simple-tech.app/timer`.** Each old URL moves once,
  straight to its final page. The `simple-tech.app` portfolio is not touched.
- **The Zoom app stays on `zoom.timer.simple-tech.app`** until everything else
  is settled. The main site sends people to it; nothing here changes how it
  launches, signs in or bills. When it moves, it moves to a subdomain
  (`zoom.toastmusters.com` or `zoom.timer.toastmusters.com`, decided then),
  not a path: the Zoom app is `noindex`, so a path adds no search value, and a
  host of its own keeps website rules away from it.
- **The timer's landing page stays at `/`** while the timer is the main
  product: the strongest URL carries the page that converts. New products get
  their own path, as Table Topics did. Should `/` ever become a suite home,
  the landing page moves to `/timer`, which is held for it (302 → `/`, which
  browsers do not cache). The web app is already at its final URL,
  `/timer/app`, because that is the URL other things link to.
- **The Zoom app is the product; the web timer complements it.** Every call
  to action leads with "Add to Zoom" and offers the browser timer and the
  Marketplace listing as quieter choices. See
  [Calls to action and analytics](#calls-to-action-and-analytics).

## URL map

| URL | What it does | Since |
| --- | --- | --- |
| `www.toastmusters.com/` | Timer landing page, 200 | step 1 |
| `www.toastmusters.com/timer/app` | Web timer, 200 (`?role=…&name=…` deep links are `noindex`) | step 1 |
| `www.toastmusters.com/timer` | 302 → `/` (held for a future timer landing page) | step 1 |
| `www.toastmusters.com/app` | 301 → `/timer/app`, query kept | step 1 |
| `www.toastmusters.com/add-to-zoom` | 302 → this deployment's Zoom install screen, or the Marketplace listing if it has none (`noindex`, not cached) | step 1 |
| `www.toastmusters.com/<guide>` | The timer guides (`/toastmasters-timing-chart` etc.), 200 | unchanged |
| `www.toastmusters.com/tabletopics/…` | Table Topics, from the timer Worker's own assets | step 1 |
| `www.toastmusters.com/zoom/…` | Zoom app shell in a browser (not the Zoom URL) | unchanged |
| `toastmusters.com/*` | 301 → `www.toastmusters.com/*` | unchanged |
| `timer.toastmusters.com/*`, `www.timer.toastmusters.com/*` | 301 → `www.toastmusters.com/*` (`/app`, `/web` → `/timer/app`) | step 1 |
| `zoom.timer.toastmusters.com/*` | **Unchanged.** May become the Zoom app's home | — |
| `tabletopics.toastmusters.com/*`, `www.tabletopics…/*` | 301 → `www.toastmusters.com/tabletopics/*` | step 1 |
| `timer.simple-tech.app/…`, `www.timer.simple-tech.app/…`: public pages (the 16 sitemap pages, `/tabletopics/…`) | 301 → the same path and query on `www.toastmusters.com`, one hop from either host, cacheable for a day. [Step 2a](#step-2a-public-pages-built) | step 2a |
| the same two hosts: app routes (`/timer/app`, `/oauth/redirect`, `/account`, `/billing/*`, `/club/*`, `/pro/*`, `/r/*`, `/zoom/*`, `/add-to-zoom`, `/app`, `/web`) and static files | **Unchanged.** Served on the `www` host (the bare host first 301s there); `/app` still 301s to `/timer/app` on the same host. Sign-in, Stripe and the Zoom install still come back here. Step 2b | unchanged |
| `zoom.timer.simple-tech.app/*` | **Unchanged.** The Zoom app | — |
| `simple-tech.app/*` | **Unchanged.** The portfolio, on Vercel | — |

Every redirect is one hop, keeps the path and query, and runs only over
https (so `wrangler dev`, which rewrites Host to production, never bounces).
API routes (`/api/*`) and the signed sign-in callback run before any redirect
on every host: a 301 would drop a POST body. The dev hosts follow the same
rules and redirect to the dev twin (`(www.)timer-dev.simple-tech.app` →
`www.timer-dev.toastmusters.com`), never to production.

Canonical tags, `og:url`, JSON-LD, sitemaps and `llms.txt` all name
`https://www.toastmusters.com/…`. The one exception is the Zoom OAuth
`redirect_uri`, which stays `https://www.timer.simple-tech.app/oauth/redirect`
because it must match the Marketplace registration byte for byte.

`apps/web/public/sitemap.xml` is generated: `npm run build` runs
`scripts/generate-sitemap.mjs`, which sets the origin and takes each `lastmod`
from git. Change the origin there, not in the XML.

## Calls to action and analytics

**Where each call to action goes**

| Where | Main action | Quieter choices |
| --- | --- | --- |
| Landing page (hero, header, closing band, footer) | Add to Zoom | Use in Browser, See it on the Zoom Marketplace, "Already use the Zoom app? Reconnect it" (to `/reconnect`) |
| Reconnect page (`/reconnect`, #96) | Approve in Zoom (same tab) | Use the browser timer instead, Already approved? Open in Zoom, Go to the homepage (`/?home`) |
| Guide pages (`apps/web/public/*.html`) | Add to Zoom (`/add-to-zoom`) | use it in your browser · See it on the Zoom Marketplace |
| In-copy mentions of the app on guide pages | The landing page `/`, which leads with Zoom | — |
| Web timer footer | Add to Zoom | (plus its periodic "Add to Zoom" prompt) |
| Table Topics home, Today and category pages | One line: "Meeting on Zoom? Add Toastmusters Timer to Zoom…" | "Time this" still opens the web timer with the question filled in |
| Zoom app, connection lost | Re-add / Approve in Zoom | "Use the browser timer instead" (`TIMER_APP_URL`) |

The React pages link to `VITE_ZOOM_OAUTH_REDIRECT` (the build's install
screen) and fall back to `ZOOM_MARKETPLACE_LISTING_URL`. The static pages
cannot know the build's Zoom app, so they link to `/add-to-zoom` and let the
Worker answer from `ZOOM_CLIENT_ID` + `WEB_ORIGIN`.

**One event for every click.** Each call to action sends PostHog
`cta_clicked` with:

- `cta`: `add_to_zoom`, `web_timer`, `marketplace` or `reconnect`; on the
  reconnect page `approve_in_zoom`, `web_timer`, `open_in_zoom` or `home`
- `location`: `hero`, `header`, `closing`, `footer`, `content`,
  `install-steps`, `troubleshooting`, `timer-footer`, or the Table Topics page
  (`home`, `today`, `category`)
- `page`: the path it was clicked on

On the React pages it comes from `trackCta()` in `Landing.jsx`,
`Reconnect.jsx` and `Footer.jsx`. On static pages, any element with
`data-cta` (and optionally `data-cta-location`) is tracked by `apps/web/public/site-analytics.js`, which
also records their page views; the web build fills in its PostHog key
(`fillSiteAnalytics` in `apps/web/vite.config.js`). Table Topics'
`src/analytics.js` handles `data-cta` the same way. Events use `sendBeacon`
because most of these links leave the page. `apps/web/src/staticPages.test.js`
fails if a guide page drops the script, loses its tracked Add to Zoom, or
links into the web timer without `data-cta`.

## Configuration

- **Timer Worker** (`wrangler.jsonc`): `ROOT_ORIGIN` (prod
  `https://www.toastmusters.com`, dev `https://www.timer-dev.toastmusters.com`)
  turns on the redirects from the old `timer.toastmusters.com` and
  `tabletopics.toastmusters.com` hosts, which are attached to this Worker as
  custom domains for that purpose, and the redirects of the old
  `simple-tech.app` host's public pages (step 2a). It is also the target of all
  of them. `WEB_ORIGIN` stays on `www.timer.simple-tech.app` for now (sign-in
  and Stripe returns; see step 2b).
- **Table Topics build**: defaults to
  `SITE_ORIGIN=https://www.toastmusters.com/tabletopics` and writes the whole
  site under `/tabletopics`; `npm run build` copies it into `dist/`. Dev sets
  `SITE_ORIGIN` as a build variable.

## Deploying step 1 (order matters)

**Gate: the Zoom review that adds `toastmusters.com` to the app's domain
allow list must be approved first.** The Zoom app's "use the browser timer"
fallback opens `TIMER_APP_URL` (`https://www.toastmusters.com/timer/app`) with
`zoomSdk.openUrl`, which only opens allow-listed domains. Check that the
approved entry covers the `www.` host.

One Worker serves both, so one deploy ships both and there is no ordering
to get wrong: the redirects from the old Table Topics host only go live in the
same deploy that serves `/tabletopics`.

1. Merge to `dev`, check `www.timer-dev.toastmusters.com/` and `/tabletopics/`,
   then merge to `master`.
2. Verify (below), then in Search Console submit
   `https://www.toastmusters.com/sitemap.xml` and
   `https://www.toastmusters.com/tabletopics/sitemap.xml`. Keep the old
   sitemaps submitted for a few weeks so Google recrawls the redirects.

### Verify

```bash
curl -sI https://www.toastmusters.com/timer/app | head -1                          # 200
curl -sI "https://www.toastmusters.com/app?role=x" | grep -i location              # /timer/app?role=x
curl -sI https://www.toastmusters.com/tabletopics/ | head -1                       # 200
curl -sI https://www.tabletopics.toastmusters.com/topics/ | grep -i location       # www.toastmusters.com/tabletopics/topics/
curl -sI https://www.timer.toastmusters.com/toastmasters-timing-chart | grep -i location  # www.toastmusters.com/toastmasters-timing-chart
curl -s https://www.timer.simple-tech.app/timer/app | grep -o '<link rel="canonical"[^>]*>' # www.toastmusters.com/ (the old host's / now 301s: step 2a)
curl -sI https://zoom.timer.simple-tech.app/ | head -1                             # 200, unchanged
```

```bash
curl -sI https://www.toastmusters.com/add-to-zoom | grep -i location               # zoom.us/oauth/authorize?…client_id=…
```

Then launch the Zoom app once from the client and confirm it behaves as before,
and check PostHog for `cta_clicked` events and page views on a guide page.

### Roll back

Redeploy the previous version of each Worker (`wrangler rollback`, or the
dashboard's Deployments tab): timer first, then Table Topics, so the old host
never redirects to a path that no longer serves.

## Step 2a: public pages (built)

Issue #98. Search Console reported "Duplicate, Google chose different
canonical than user" for `www.toastmusters.com/best-toastmasters-timer-apps`:
the old web host answered the same pages with 200 and the same bytes, and
Google overrode the canonical tag and chose the old URL. So the old host's
public pages now 301 to the main site, and its app routes stay.

```text
on an https request to (www.)timer(-dev).simple-tech.app, ROOT_ORIGIN set
  public page (sitemap list, /tabletopics/*) → 301 ROOT_ORIGIN + same path + query, max-age=86400
  anything else                              → served as before
```

The rule is Worker code, not a Cloudflare dashboard rule: `oldWebHostTarget()`
in `worker/old-web-host.js`, called as step 2c in `fetch` (`worker/index.js`),
after the API routes and the two legacy-host redirects and before the apex
rule. That keeps it in version control, tested against the sitemap, rehearsed
on dev by the normal pipeline and rolled back with the deploy.

- **What moves.** The 16 pages in `apps/web/public/sitemap.xml` (the landing
  page, the 11 guides, `/privacy`, `/support`, `/terms-of-use`,
  `/documentation`) and everything under `/tabletopics`. `MOVED_PAGES` in
  `worker/old-web-host.js` lists the pages. When the sitemap gains a page, add
  it there: the "moves every page the sitemap lists" test in
  `worker/routing.test.js` fails until you do. The query is kept. A page lands
  without its trailing slash; Table Topics paths land exactly as asked,
  because the slash is part of that site's addresses.
- **What stays.** Every app route: `/api/*`, `/oauth/redirect`, `/timer/app`,
  `/account`, `/billing/*`, `/club/*`, `/pro/*`, `/r/*`, `/zoom/*`,
  `/add-to-zoom`, `/app`, `/web`, the static files and `robots.txt`. Sign-in,
  Stripe returns and the Zoom install all come back to `WEB_ORIGIN` on this
  host, and the session cookie belongs to it. `/app` already 301s to
  `/timer/app` on the same host, and stays on that host. `robots.txt` still
  allows everything, because Google has to crawl the old URLs to see the 301s.
  Nobody loses a session or saved data: the web timer and its browser storage
  stay on the old host.
- **Which hosts.** `timer.simple-tech.app` and `www.timer.simple-tech.app`, and
  their dev twins. Never `zoom.timer(-dev).simple-tech.app` or
  `www.toastmusters.com`, never over http, and never when `ROOT_ORIGIN` is
  unset. The bare host's public pages reach the main site in one hop; its app
  paths still go to the old `www` host through the apex rule.
- **A day of cache.** The 301 carries `Cache-Control: public, max-age=86400`,
  so it is built by hand, not with `Response.redirect()`. Without a lifetime,
  Chromium keeps a 301 until the user clears the cache, and a rollback could
  not reach those browsers. A day still reads to Google as a permanent move,
  and a rollback reaches every browser within a day. (`b1018c5` undid a 301 on
  `zoom.timer.toastmusters.com` for the same reason.)
- **`/x.html` takes two hops** on the `www` host (the bare host adds the apex
  hop first). A `.html` path is not on the list, so the asset layer's
  clean-URL redirect to `/x` answers first, and then the 301 moves `/x`. Google indexes the clean URLs, so this matters only to a link
  that names the file.
- **Sign-in started on a moved page.** `handleOAuthCallback` (`worker/auth.js`)
  swaps a `returnTo` that has moved for `/timer/app`, so a sign-in from the
  landing page ends on `WEB_ORIGIN/timer/app`, signed in, and not on a page
  that now 301s to a host with no session cookie. It uses the same helper, so
  it turns itself off when `WEB_ORIGIN` moves off the old host.
- **Marketplace and listing: no change.** The listing's and the manifest's
  Privacy, Terms and Support URLs, and the in-client "lost access" help link,
  still name the old host and now end on `www.toastmusters.com` after the 301
  (see [ZOOM_LISTING_PRO.md](ZOOM_LISTING_PRO.md#links-zoom-asks-for)).
  `ZOOM_RECONNECT_HELP_URL` keeps its old-host URL: `zoomSdk.openUrl` opens
  only allow-listed domains, and the `toastmusters.com` allow-list review is
  not recorded as approved. The old host is allow-listed, and the system
  browser follows the redirect from there.
- **No Zoom-client spec.** Nothing inside the Zoom client looks different: the
  links open the same URLs and the browser follows the 301 after it has left
  Zoom. The unit tests (`worker/old-web-host.test.js`, `worker/routing.test.js`,
  `worker/auth.test.js`) and the checklist below cover it.
- **Keep the 301s.** Google asks for them for at least a year, and the Change
  of Address forwards signals for 180 days. Do not retire the old host's
  routes.

### Rollout, in order

1. **Dev.** Push to `dev` (Workers Builds deploys it; `npm run cf:deploy:dev`
   does the same by hand until the next push overwrites it). Run the checklist
   below against the `-dev` hosts.
2. **Prod.** Merge `dev` → `master`, then run the checklist against
   production. No Marketplace setting changes, so there is no gate.
3. **Search Console, URL Inspection** on the top old URLs (below).
4. **Search Console, Change of Address** (below).
5. **Search Console, sitemaps:** keep
   `https://www.toastmusters.com/sitemap.xml` and
   `https://www.toastmusters.com/tabletopics/sitemap.xml` submitted. The old
   host's `sitemap.xml` already lists `www.toastmusters.com` URLs, because the
   generator hard-codes that origin, so keeping it submitted does not make
   Google recrawl the old URLs. Step 3 does.

### Verify step 2a

Run it once per environment. The same lines work for both, because dev's
`ROOT_ORIGIN` is its own twin.

```bash
# production
OLD=https://www.timer.simple-tech.app  BARE=https://timer.simple-tech.app  NEW=https://www.toastmusters.com  ZOOM=https://zoom.timer.simple-tech.app
# dev
OLD=https://www.timer-dev.simple-tech.app  BARE=https://timer-dev.simple-tech.app  NEW=https://www.timer-dev.toastmusters.com  ZOOM=https://zoom.timer-dev.simple-tech.app
```

Public pages move: one 301 to the same path on `$NEW`.

```bash
curl -sI $OLD/ | grep -iE '^(HTTP|location|cache-control)'              # 301, location: $NEW/, cache-control: public, max-age=86400
curl -sI "$OLD/?utm_source=x" | grep -i location                        # $NEW/?utm_source=x (query kept)
curl -sI $OLD/toastmasters-timing-chart | grep -i location              # $NEW/toastmasters-timing-chart
curl -sI $OLD/best-toastmasters-timer-apps/ | grep -i location          # $NEW/best-toastmasters-timer-apps (slash dropped)
curl -sI $OLD/privacy | grep -i location                                # $NEW/privacy (also /support, /terms-of-use, /documentation)
curl -sI $OLD/tabletopics/ | grep -i location                           # $NEW/tabletopics/
curl -sI $OLD/tabletopics/topics/ | grep -i location                    # $NEW/tabletopics/topics/
curl -sI $BARE/ | grep -i location                                      # $NEW/ (one hop from the bare host)
curl -sIL $OLD/best-toastmasters-timer-apps | grep -i '^HTTP'           # 301, then 200 on the new host
curl -sIL $OLD/toastmasters-timing-chart.html | grep -iE '^(HTTP|location)'  # two redirects (clean URL, then the 301), then 200
```

The app stays where it was.

```bash
curl -sI $OLD/timer/app | head -1                                       # 200
curl -sI $OLD/app | grep -i location                                    # $OLD/timer/app (same host)
curl -sI $OLD/add-to-zoom | grep -i location                            # zoom.us/oauth/authorize?…redirect_uri=$OLD/oauth/redirect
curl -sI $OLD/robots.txt | head -1                                      # 200
curl -sI $OLD/sitemap.xml | head -1                                     # 200
curl -sI $BARE/timer/app | grep -i location                             # $OLD/timer/app (the apex rule, as before)
curl -sI $NEW/ | head -1                                                # 200, unchanged
curl -sI $ZOOM/ | head -1                                               # 200, unchanged
```

Then, by hand:

- **Dev:** on `https://www.timer-dev.toastmusters.com/`, use "Sign in with Zoom"
  in the account menu. It ends on `https://www.timer-dev.simple-tech.app/timer/app`,
  signed in. (Web sign-in is behind the `pro` flag: on in dev, dark in
  production.)
- **Both:** the web timer at `$OLD/timer/app` loads with no blocked scripts in
  the console, and its saved settings are still there.
- **Production:** add the app from the Marketplace listing and confirm it
  still lands on `https://www.timer.simple-tech.app/oauth/redirect` with the
  install-success page.

### Search Console

Run these after the production checklist passes (rollout steps 3 and 4).

1. **URL Inspection** on the top old URLs: `https://www.timer.simple-tech.app/`,
   `/toastmasters-timing-chart` and `/best-toastmasters-timer-apps`. Confirm
   Google sees the 301. Then, on the `www.toastmusters.com` versions of the
   same three, **Request indexing**.
2. **Change of Address**, from `sc-domain:timer.simple-tech.app` to
   `sc-domain:toastmusters.com`. Not from the parent
   `sc-domain:simple-tech.app`, which is the portfolio. The tool's required
   pre-move check, a 301 from the old homepage, passes because `/` moves. If a
   check fails, withdraw the move and write the failure down; the 301s and
   the indexing requests in step 1 still stand. It is not strictly needed,
   since the 301s alone would move Google over in time, but it is the
   strongest signal Google offers for a domain move and forwards the old
   domain's signals for 180 days.
3. **Done when**, in the weeks after: URL Inspection shows the Google-selected
   canonical equal to the declared one on `www.toastmusters.com` for the public
   pages; the "Duplicate, Google chose different canonical than user" rows
   clear; and the Performance report by page shows most clicks and impressions
   on `www.toastmusters.com`. (For scale, the 30 days to 2026-10-12 gave
   `www.timer.simple-tech.app` pages 42 clicks and about 2,340 impressions, and
   `www.toastmusters.com` 2 impressions.)

Still unknown:

- How Google's Change of Address tool treats a Domain property's `www.`
  subdomain. Google does not say, and the tool is meant for whole-site moves
  while the app routes keep serving on the old host. Those routes are
  `noindex`, or name `www.toastmusters.com/` as their canonical, so they should
  not block it.
- Two things only Zoom's Marketplace console shows; it has not been read for
  them. Which production setting sends a post-consent landing to
  `https://www.timer.simple-tech.app/` (the one recorded in
  [ZOOM_AUTH_AND_REDIRECTS.md](ZOOM_AUTH_AND_REDIRECTS.md) was on the dev app):
  `/` now 301s to the main site's landing page, so such a landing would end
  there. And which Event Subscription URL and full OAuth redirect allow list
  the production app has registered: the webhook is under `/api/`, which never
  redirects, and `/oauth/redirect` stays.

### Roll back

Redeploy the previous version of the Worker (`wrangler rollback`, or the
dashboard's Deployments tab). A browser that has already seen a 301 holds it
for up to a day (`max-age=86400`). The Search Console steps are not undone by
a rollback: withdraw the Change of Address there if you roll back for good.

## Step 2b: app routes and `WEB_ORIGIN` (not built)

What is left of the move. Step 2a deliberately leaves every app route on
`timer.simple-tech.app`, so the old host stays alive as the app host. Finishing
the move means redirecting everything except `/api/*` and `/oauth/*`, and moving
`WEB_ORIGIN` to `www.toastmusters.com`. Before building it, decide:

- **Sign-in and billing.** Web sign-in always finishes on `WEB_ORIGIN`, and the
  session cookie belongs to that host; Stripe returns there too. Redirecting
  the app routes while `WEB_ORIGIN` stays there would bounce signed-in users
  between hosts, and 301 a sign-in or Stripe return to a host with no session
  cookie. Moving `WEB_ORIGIN` to `www.toastmusters.com` needs
  `https://www.toastmusters.com/oauth/redirect` added to the Zoom app's
  allowed redirect URLs in the Marketplace, and signs out every web user. The
  swap in `handleOAuthCallback` (step 2a) turns itself off when it moves.
- **Excluded paths.** `/api/*` and `/oauth/redirect` stay on the old host
  until `WEB_ORIGIN` moves. `zoom.timer.simple-tech.app` is excluded entirely.
  The Zoom-listing pages already moved in step 2a.
- **Web users' saved data.** Browser storage is per host, so web-timer users
  arrive at the new host empty. #81 proposes a one-time hand-off; measure
  first, as DOMAIN_MIGRATION.md did for the Zoom origin (web users with
  custom rules, roles or saved reports on `timer.simple-tech.app`). For
  scale: over the 90 days to 2026-10-13, 53 people opened the web timer on
  `www.timer.simple-tech.app` and 10 on `www.toastmusters.com`, 3 on
  `www.timer.toastmusters.com` (which step 1 redirects without a hand-off),
  against 223 Zoom install landings. Step 2a leaves the old host's web-timer
  users, and their data, where they are.
- **A dev rehearsal.** Step 2a runs on the `-dev` hosts because dev's
  `ROOT_ORIGIN` is the dev twin `www.timer-dev.toastmusters.com`. Decide how
  to rehearse the `WEB_ORIGIN` move there as well.
