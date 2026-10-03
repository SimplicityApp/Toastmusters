# Table Topics Generator (`apps/table-topics`)

Random Table Topics questions for Toastmasters meetings, served at
**https://www.toastmusters.com/tabletopics/** by its own Cloudflare Worker
(`toastmusters-tabletopics`), which the timer Worker reaches over its
`TABLETOPICS` service binding. First sibling of the timer in the Toastmusters
suite: one path per tool on `www.toastmusters.com`, cross-linked through
`TOOLS` in `packages/shared/appLinks.js`. The old host,
`www.tabletopics.toastmusters.com`, 301s every URL to the same page under
`/tabletopics` (see [TOASTMUSTERS_PATHS.md](TOASTMUSTERS_PATHS.md)).

## How it works

- **Content is data.** `content/questions.json` is the whole bank: 20 fixed
  categories (`content/CATEGORIES.md`), each with `{ id, text, added }`
  questions. `scripts/validate-questions.mjs` enforces the rules in
  `content/GENERATION_PROMPT.md` (shape, ids, length, `?`, exact and fuzzy
  duplicates across the bank, 15–80 per category). The build refuses an
  invalid bank. Append-only: ids are never reused, so shared `?q=` links keep
  resolving. The 80 ceiling (~1,600 total) stops growth after ~19 weekly runs;
  after that the routine skips full categories and the next step is retiring
  low-engagement questions using the per-id analytics events.
- **Sets of three.** The widget shows a set of three questions (a Table Topics
  round), on the home page for "All" and for each category. "New set" redraws
  all three; each question has its own "Time this" link; "Copy all" copies the
  numbered set; "Copy link" shares `?q=id1,id2,id3` (a single id still works).
  `SET_SIZE` lives in `src/templates/widget.mjs` and `src/generator.js`.
- **Draw order.** The browser keeps a per-device list of shown ids in
  `localStorage` (`tt_seen_v1`) and draws unseen questions first; when a pool is
  exhausted it says so and starts a new cycle. Category pages show the first 40
  questions and a "Show all" button (full list always in the HTML; a shared
  link into the hidden part expands it).
- **Static first, no framework.** `scripts/build.mjs` renders every page from
  the bank with the shared `packages/ui/content-pages.css` look, inlines
  `src/lib/{rng,picker,links}.js` into one `generator.js` (imports stripped, no
  bundler), substitutes the PostHog key/host and the timer URL, content-hashes
  the four assets, and writes `dist/`. `renderSite()` is pure and unit-tested.
- **Deterministic randomness.** `src/lib/rng.js` (FNV-1a + mulberry32) drives
  both the server-rendered initial question (seeded by page + build date) and
  the browser draw. **Today's set** = `todaySet(bank, 'YYYY-MM-DD', 10)`: the
  page is rendered for the build date and `generator.js` recomputes it for the
  visitor's UTC date, so the page changes daily with zero generation.
- **Worker.** `worker/index.js`: apex→www 301 (https-guarded for `wrangler
  dev`), assets, `/404.html` with a real 404, CSP without `unsafe-inline` for
  scripts, HSTS, `X-Robots-Tag: noindex` on `-dev.` hosts, immutable caching for
  `/assets/*`, one hour for `/questions.json`.
- **Zoom pitch.** The home, Today and category pages carry one line,
  `zoomPitch()` in `src/templates/layout.mjs`, pointing Zoom meetings at the
  timer's Zoom app (`www.toastmusters.com/add-to-zoom`), the suite's main
  product.
- **Analytics.** `src/analytics.js` loads posthog-js from the proxy
  `e.simple-tech.app` (same key as the timer, read from the repo-root `.env` or
  `VITE_PUBLIC_POSTHOG_*`). Events: `tt_set_shown {question_ids, category, source, count}`,
  `tt_question_shown {question_id, category, source, position}`, `tt_category_selected`, `tt_question_copied`,
  `tt_share_copied`, `tt_timer_deeplink_clicked`, `tt_print_clicked`,
  `tt_today_viewed {date, swapped}`, `tt_list_expanded`. Clicks on any element
  with `data-cta` send `cta_clicked {cta, location, page}`, the same event as
  the timer site (see [TOASTMUSTERS_PATHS.md](TOASTMUSTERS_PATHS.md#calls-to-action-and-analytics)).

## URL map

Paths are under `/tabletopics` on `www.toastmusters.com` (`/` below is
`www.toastmusters.com/tabletopics/`).

| Path | Page | JSON-LD |
| --- | --- | --- |
| `/` | generator, all categories, FAQ | WebApplication, FAQPage, BreadcrumbList |
| `/topics/` | category index | CollectionPage, BreadcrumbList, ItemList |
| `/topics/<slug>/` | generator scoped to one category + full question list (the indexable pages) | Article, BreadcrumbList, ItemList |
| `/today/` | ten questions for today | WebPage, BreadcrumbList |
| `/questions.json` | the bank | — |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/404.html` | | |

Every page also carries the `Organization` (`https://www.toastmusters.com/#organization`)
and `WebSite` nodes.

## Timer deep link

"Time this" opens `https://www.toastmusters.com/timer/app?role=Table%20Topics%20Speech&name=<question>`
(`TIMER_APP_URL`). The link is `rel="nofollow"` and the timer answers these URLs
with `X-Robots-Tag: noindex`, so the one-per-question deep links stay out of search.
The web timer (`apps/web/src/utils/speakerDeepLink.js`, used by `LiveTab.jsx`)
reads `role` and `name` on first mount when no speaker is set, selects the
role, fills the name, and strips the params. The role must be the exact rules
key; a persisted speaker wins over the URL.

## Commands (repo root)

```
npm run install:tabletopics        # once; links packages/shared
npm run validate:tabletopics       # content check
npm run build:tabletopics          # -> apps/table-topics/dist
npm run dev:tabletopics            # build + wrangler dev on :8789 (launch.json: tabletopics-worker)
npx vitest run --root apps/table-topics   # app only; root `npm test` also covers it once every app is installed
npm run cf:deploy:tabletopics:dev  # www.tabletopics-dev.toastmusters.com/tabletopics/ (noindex)
npm run cf:deploy:tabletopics:prod
```

Env for the build: `SITE_ORIGIN` (default `https://www.toastmusters.com/tabletopics`;
its path becomes the base path every page, asset and link is built under),
`BUILD_DATE`, `QUESTIONS_FILE`,
`VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST`.

## Automation

- **Weekly content routine** (Claude Code cloud, `tabletopics-weekly-questions`,
  Mondays 13:00 UTC): clones the repo, follows
  `content/GENERATION_PROMPT.md` (append 3 questions per category, validate,
  test), and opens a PR against `master`. It never merges. Manage it at
  https://claude.ai/code/routines.
- **Deploy on merge**: `.github/workflows/deploy-tabletopics.yml` runs on push
  to `master` when `apps/table-topics/**`, `packages/shared/appLinks.js` or
  `packages/ui/**` change: validate → test → build → `wrangler deploy` →
  smoke test. Secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Account
  Settings:Read, Zone DNS:Edit + Workers Routes:Edit on `toastmusters.com`) and
  `CLOUDFLARE_ACCOUNT_ID`; variables `VITE_PUBLIC_POSTHOG_KEY/HOST`. The timer
  Worker is never deployed by CI. Since the move to `/tabletopics`, a build
  that redirects the old host needs the timer Worker's `TABLETOPICS` binding
  live first: deploy the timer Worker before such a change reaches `master`
  ([TOASTMUSTERS_PATHS.md](TOASTMUSTERS_PATHS.md#deploying-step-1-order-matters)).

## Known trade-offs

- The generator's URL is hardcoded in `apps/web/index.html` and
  `apps/web/public/table-topics-timer.html` (static files); everything else
  reads `TOOLS`.
- Footer legal links point at the timer's `/privacy`, `/terms-of-use`,
  `/support` until the suite root owns them.
- `/today/` without JavaScript shows the build-date set; the sitemap does not
  claim daily change for it.
- `og-cover.png` is the timer's cover image as a placeholder; `logo.png` is the
  timer logo. Replace both when the suite has its own brand assets.
- `content-pages.css` lives in `packages/ui/` and is copied into
  `apps/web/public/` by the web app's `predev`/`prebuild` hooks (gitignored there).
