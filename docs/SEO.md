# SEO: decisions and conventions

What we target, and the rules the site's pages follow. Hosts and paths are in
[TOASTMUSTERS_PATHS.md](TOASTMUSTERS_PATHS.md); calls to action and their
tracking are in its [Calls to action and analytics](TOASTMUSTERS_PATHS.md#calls-to-action-and-analytics)
section.

## Keywords

- **Priority: "toastmasters timer" and "toastmaster timer".** The landing page
  at `/` owns them: its title and H1 lead with the exact phrase
  ("Toastmasters Timer – Free Online Speech Timer …"). Google treats the
  singular and plural as the same search, so no page forces "Toastmaster
  timer" into its copy.
- **"Timer" is the main term, "timekeeper" a synonym.** Clubs say Timer. Use
  "timekeeper" at most once per page, as an alias ("the Timer, sometimes
  called the timekeeper"), never in a title or heading.
- **One page per search intent.** A guide's title, H1 and meta lead with how
  people phrase that search (from Search Console's queries for the page), and
  two pages do not chase the same phrase: the role guide targets "timer role",
  the script targets "timer script" and "timer log sheet", the Table Topics
  page "Table Topics time limit".

Keyword data: Search Console properties `sc-domain:toastmusters.com` and
`sc-domain:timer.simple-tech.app` (`gog searchconsole query …`). Positions
before the domain move, 2026-07-03 to 2026-10-01: the simple-tech.app
homepage about 22 for "toastmasters timer" and 8.5 for "toastmasters timer
online"; `www.timer.toastmusters.com/` about 9.

## Why the landing page is at `/`

The homepage collects the most links and is where Google starts crawling, so
the page that converts (the timer landing page, with Add to Zoom) sits at the
strongest URL while the timer is the main product. Moving it off `/` later is
the one move that cannot be redirected, since `/` stays in use; `/timer` is
held for it if a suite home ever takes `/`. New products get their own path
and earn their own rankings, as Table Topics did.

## Content rules

- **The qualifying rule, stated the same way everywhere.** The contest rule
  is the reference: a speaker is disqualified for finishing more than 30
  seconds under the minimum or over the maximum, except Table Topics (under
  1:00 or over 2:30). For meeting awards, each club sets its own rule; many
  use the contest rule, others require reaching green. Say so whenever a page
  states a rule. Give example times that hold under either rule.
- **Timing values come from the timing chart** (`toastmasters-timing-chart.html`).
  Copy them; do not restate them from memory.
- **Freshness.** When a guide changes materially, update its visible "Last
  updated" line and the Article JSON-LD `dateModified`. The sitemap's
  `lastmod` follows git automatically.
- **FAQ markup matches the page.** Every `FAQPage` question must also appear
  on the rendered page. `index.html` declares eight, and `Landing.jsx` renders
  them from `FAQS`, which must stay word for word in step.

## Index hygiene

- **App state is not a page.** `/timer/app?…` deep links (one per Table Topics
  question) get `X-Robots-Tag: noindex`, and Table Topics marks its "Time
  this" links `rel="nofollow"`. Do not block them in `robots.txt`: Google could
  then not see the `noindex`.
- **Video markup only on watch pages.** `VideoObject` belongs on
  `/toastmasters-timer-demo` and `/toastmasters-timer-zoom-demo`, never in
  `index.html`, which is the shell for every app route.
- **Not pages:** `/oauth/*` and `/add-to-zoom` are disallowed in `robots.txt`
  and sent with `noindex`.

## After a change

Search Console needs nothing for these: a new `noindex` or `nofollow` drains
the "not indexed" reports over a few weeks without "Validate fix". Do validate
a fix for a real error (as for "Video isn't on a watch page"). Re-check a
reworked page's position 4–6 weeks after deploy.
