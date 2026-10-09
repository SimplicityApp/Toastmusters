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
| `timer.simple-tech.app/*`, `www.timer.simple-tech.app/*` | Still serve, but every canonical names `www.toastmusters.com` | step 1 |
| `zoom.timer.simple-tech.app/*` | **Unchanged.** The Zoom app | — |
| `simple-tech.app/*` | **Unchanged.** The portfolio, on Vercel | — |

Every redirect is one hop, keeps the path and query, and runs only over
https (so `wrangler dev`, which rewrites Host to production, never bounces).
API routes (`/api/*`) and the signed sign-in callback run before any redirect
on every host: a 301 would drop a POST body.

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
| Landing page (hero, header, closing band, footer) | Add to Zoom | Use in Browser, See it on the Zoom Marketplace, Open in Zoom |
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

- `cta`: `add_to_zoom`, `web_timer`, `marketplace` or `open_in_zoom`
- `location`: `hero`, `header`, `closing`, `footer`, `content`,
  `install-steps`, `troubleshooting`, `timer-footer`, or the Table Topics page
  (`home`, `today`, `category`)
- `page`: the path it was clicked on

On the React pages it comes from `trackCta()` in `Landing.jsx` and
`Footer.jsx`. On static pages, any element with `data-cta` (and optionally
`data-cta-location`) is tracked by `apps/web/public/site-analytics.js`, which
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
  custom domains for that purpose. `WEB_ORIGIN` stays on
  `www.timer.simple-tech.app` for now (sign-in and Stripe returns; see step 2).
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
curl -s https://www.timer.simple-tech.app/ | grep -o '<link rel="canonical"[^>]*>' # www.toastmusters.com/
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

## Step 2: redirect `timer.simple-tech.app` (not built yet)

The public pages of `timer.simple-tech.app` and its www alias 301 to the same
page on `www.toastmusters.com`. Before building it, decide:

- **Excluded paths.** At least `/api/*`, `/oauth/redirect`, and the
  Zoom-listing pages (`/privacy`, `/support`, `/terms-of-use`,
  `/documentation`) until the Zoom listing moves. `zoom.timer.simple-tech.app`
  is excluded entirely.
- **Sign-in and billing.** Web sign-in always finishes on `WEB_ORIGIN`, and the
  session cookie belongs to that host; Stripe returns there too. Redirecting
  the simple-tech pages while `WEB_ORIGIN` stays there would bounce signed-in
  users between hosts. Moving `WEB_ORIGIN` to `www.toastmusters.com` needs
  `https://www.toastmusters.com/oauth/redirect` added to the Zoom app's
  allowed redirect URLs in the Marketplace.
- **Web users' saved data.** Browser storage is per host, so web-timer users
  arrive at the new host empty. #81 proposes a one-time hand-off; measure
  first, as DOMAIN_MIGRATION.md did for the Zoom origin (web users with
  custom rules, roles or saved reports on `timer.simple-tech.app`). For
  scale: over the 90 days to 2026-10-03, 51 people opened the web timer on
  any host, 3 of them on `www.timer.toastmusters.com` (which step 1
  redirects without a hand-off), against 203 Zoom installs.
- **A path-based dev host** to rehearse it on.
