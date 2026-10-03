# Toastmusters on one host: `www.toastmusters.com/<tool>`

Every tool in the suite is a path on **`www.toastmusters.com`**, the main
site. This replaces the one-subdomain-per-tool plan in
[DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md) and tracks issue #81.

Three decisions shape it:

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

## URL map

| URL | What it does | Since |
| --- | --- | --- |
| `www.toastmusters.com/` | Timer landing page, 200 | step 1 |
| `www.toastmusters.com/timer/app` | Web timer, 200 (`?role=…&name=…` deep links are `noindex`) | step 1 |
| `www.toastmusters.com/timer` | 302 → `/` (held for a future timer landing page) | step 1 |
| `www.toastmusters.com/app` | 301 → `/timer/app`, query kept | step 1 |
| `www.toastmusters.com/<guide>` | The timer guides (`/toastmasters-timing-chart` etc.), 200 | unchanged |
| `www.toastmusters.com/tabletopics/…` | Table Topics, via the `TABLETOPICS` service binding | step 1 |
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

## Configuration

- **Timer Worker** (`wrangler.jsonc`): `ROOT_ORIGIN = https://www.toastmusters.com`
  turns on the toastmusters.com subdomain redirects; `services` binds
  `TABLETOPICS` to `toastmusters-tabletopics`. `WEB_ORIGIN` stays on
  `www.timer.simple-tech.app` for now (sign-in and Stripe returns; see step 2).
- **Table Topics Worker** (`apps/table-topics/wrangler.jsonc`):
  `ROOT_ORIGIN = https://www.toastmusters.com` turns on its host redirect. Its
  build defaults to `SITE_ORIGIN=https://www.toastmusters.com/tabletopics` and
  writes the whole site under `/tabletopics`.
- **Dev** sets neither `ROOT_ORIGIN`, because there is no path-based dev host
  yet. Dev hosts keep serving as before, with Table Topics under
  `/tabletopics` on `www.tabletopics-dev.toastmusters.com`.

## Deploying step 1 (order matters)

**Gate: the Zoom review that adds `toastmusters.com` to the app's domain
allow list must be approved first.** The Zoom app's "use the browser timer"
fallback opens `TIMER_APP_URL` (`https://www.toastmusters.com/timer/app`) with
`zoomSdk.openUrl`, which only opens allow-listed domains. Check that the
approved entry covers the `www.` host.

The Table Topics Worker deploys itself from CI on every push to `master` that
touches it; the timer Worker is deployed by hand. Its new build redirects the
old host to `www.toastmusters.com/tabletopics`, which only exists once the
timer Worker with the binding is live. So:

1. Deploy the **timer Worker** (`npm run cf:deploy:prod`). Until the next
   step, `/tabletopics` on the main site reaches the *old* Table Topics build
   and 404s; nothing links there yet.
2. Deploy the **Table Topics Worker** (`npm run cf:deploy:tabletopics:prod`),
   or merge to `master` and let CI do it. Its smoke test checks the new page
   and the old host's redirect.
3. Verify (below), then in Search Console submit
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

Then launch the Zoom app once from the client and confirm it behaves as before.

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
  custom rules, roles or saved reports on `timer.simple-tech.app`).
- **A path-based dev host** to rehearse it on.
