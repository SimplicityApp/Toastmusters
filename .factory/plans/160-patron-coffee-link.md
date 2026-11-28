# Monetization: add a "Buy Me a Coffee" patron option alongside Pro (#160)

## Problem
Pro is the only way to pay for Toastmusters today. People who like the free timer and want to
say thanks, without needing Pro's features, have no way to do it. The issue asks for a low-key
"Buy Me a Coffee" patron link that sits beside Pro, never replaces it and never locks anything.

## Findings
Nothing donation-related exists yet. A search for coffee, ko-fi, donat, sponsor, patron and tip
only finds "Coffee break" agenda fixtures and the "not sponsored by Toastmasters International"
disclaimer.

**External link constants.** These belong in `packages/shared/appLinks.js`. Its header (:1-3)
says it holds "external links that more than one component needs". Two examples:
`ZOOM_MARKETPLACE_REVIEW_URL` (:9) and `TUTORIALS_URL` (:32). The file is re-exported from
`packages/shared/index.js:9`.

**Landing page footer** (`apps/web/src/pages/Landing.jsx:985-1037`):
- It has four columns: Resources, Legal, Get Started and Tools. Under them is the copyright line (:1036).
- External links use `target="_blank" rel="noopener noreferrer"` with `onClick={trackCta(cta, 'footer')}` (e.g. :1016). `trackCta` is at :605 and sends `cta_clicked`.
- The landing page never mentions Pro, so a patron link can't compete with it there.

**Web timer footer** (`apps/web/src/components/Footer.jsx:40-70`, mounted at
`apps/web/src/pages/TimerApp.jsx:119`):
- It holds three icon links: Add to Zoom, Send Us Feedback and Leave a Review.
- Each external link already uses `target="_blank" rel="noopener noreferrer"` and `trackEvent('cta_clicked', { …, location: 'timer-footer' })` (:47).
- No Pro control is here either. The web's Pro lives in `AccountMenu` and on `/account`.

**Zoom app: where a link would go.**
- Classic panel footer, `apps/zoom-app/src/components/Footer.jsx:84-133`. It already holds Feedback, Review and Upgrade/Pro, and the comment at :84 says labels must stay short in the 400px panel. A fourth button would crowd Upgrade.
- Design B's ⋯ menu, `apps/zoom-app/src/b/MoreMenu.jsx:154-166`. It has a help group (How-to videos, Send feedback, Rate the app) that would fit a patron item.

**Zoom app: opening the link.**
- External URLs must open through `openExternalUrl` (`apps/zoom-app/src/utils/zoomSdk.js:2176`), which calls `zoomSdk.openUrl`.
- `openUrl` only opens domains on the Marketplace Domain Allow List (`appLinks.js:20-23`, `docs/TOASTMUSTERS_PATHS.md:122-126`). Adding buymeacoffee.com means a Zoom review.
- Zoom also requires the listing to disclose paid features (`docs/BILLING.md:199-203`). A donation link inside the app is a listing question, not just a code change.

**Reports.**
- None of the three Report tabs has a footer: web `ReportTab.jsx`, Zoom classic `ReportTab.jsx` and `b/ReportTabB.jsx`.
- The exported image and the hosted `/r/<token>` page end with "Timed with Toastmusters Timer" (`packages/shared/reportImage.js:38`, `worker/club-share.js:305-308`).
- Design B's report already has a Pro pitch (`b/ReportTabB.jsx:148-153`). A patron line there would sit next to it and compete.

**Content Security Policy (CSP).**
- A plain `<a>` link needs no CSP change.
- The official BMC floating widget is a script from `cdnjs.buymeacoffee.com` that also embeds buymeacoffee.com in a frame. It would need `script-src` and `frame-src` changes to `ROOT_CSP` (`worker/index.js:25-26`), both `vercel.json` copies and `worker/csp.test.js`.

**Tests in this area.**
- `apps/web/src/pages/Landing.test.jsx` checks footer links (:265 tutorials in header and footer, :276 tools links).
- `apps/web/src/components/Footer.test.jsx` checks Add to Zoom (:19) and the review link (:26, :34).
- No Playwright spec loads the landing page. `e2e/web.performance.spec.js:71-75` touches the web timer footer.
- No Zoom-client spec covers `Landing.jsx` or the web `Footer.jsx` (`e2e/zoom-client/INDEX.md`).

## Approach
Show a plain external link, web only, in the two footers that carry no Pro. Copy: "Buy us a
coffee". Pro and the patron link are never on the same surface, so they can't be confused.

1. In `packages/shared/appLinks.js`, add `PATRON_URL = 'https://buymeacoffee.com/<handle>'` (handle per Q2). Its doc comment says it is a thank-you only, unlocks nothing, and must not be opened from the Zoom app until Q4 is settled.
2. Landing footer, Get Started column (`Landing.jsx:1014-1019`): add a "Buy us a coffee" item.
   - `href={PATRON_URL}`, `target="_blank"`, `rel="noopener noreferrer"`.
   - `onClick={trackCta('patron', 'footer')}`.
   - Same classes as the items beside it, with no colour or button styling, so it stays low-key.
3. Web timer footer (`apps/web/src/components/Footer.jsx`): add a fourth link after "Leave a Review".
   - Lucide `Coffee` icon and the text "Buy us a coffee".
   - Same classes and `rel` as its neighbours.
   - `trackEvent('cta_clicked', { cta: 'patron', location: 'timer-footer', page: '/timer/app' })`.
4. No flag, no worker change and no CSP change. Nothing is gated, and nothing depends on whether someone gave, so the base timer is untouched.

Rejected:
- **BMC floating widget:** it needs third-party script and frame exceptions in three CSP copies and puts a bubble on every page. Not low-key.
- **Zoom panel or ⋯ menu now:** the allow-list review and the listing disclosure come first. That is Q4's follow-up.
- **Report tab, exported image or share page:** reports go to whole clubs and sit next to the Pro pitch. An ask there reads as a nag.
- **Recurring tiers or patron perks:** any perk turns the link into a second paywall. Thanks only.
- **A feature flag:** a static link has nothing to roll back that a revert can't. Flags also touch `worker/flags.js` (riskHigh).
- **A link on the 13 static SEO pages (`apps/web/public/*.html`):** each hand-copies its footer. A follow-up can add it once the wording has settled.

## Acceptance criteria
- AC-1: Given the landing page at `/`, when the footer renders, then a "Buy us a coffee" link points at `PATRON_URL` with `target="_blank"` and `rel="noopener noreferrer"`.
- AC-2: Given the landing page, when a visitor clicks "Buy us a coffee", then `cta_clicked` is sent with `{ cta: 'patron', location: 'footer', page: '/' }`.
- AC-3: Given the web timer at `/timer/app`, when the footer renders, then a "Buy us a coffee" link points at `PATRON_URL` with `target="_blank"` and `rel="noopener noreferrer"`, after "Leave a Review", and Add to Zoom, Send Us Feedback and Leave a Review are still there.
- AC-4: Given the web timer, when someone clicks "Buy us a coffee", then `cta_clicked` is sent with `{ cta: 'patron', location: 'timer-footer', page: '/timer/app' }`.
- AC-5: Given `PATRON_URL`, then it is an `https://` URL on `buymeacoffee.com`, and it is exported from `@toastmaster-timer/shared`.
- AC-6 (nothing gated): Given a visitor who never clicked the link, then the web timer's flows still pass unchanged: start, finish, report and agenda. No component reads anything about the patron link except to render it.
- AC-7 (proposed, Q4): Given the Zoom app (classic panel and design B), then it shows no patron link in this issue.

## Test list
| AC | Unit | Playwright | Zoom-client spec |
|---|---|---|---|
| AC-1 | `apps/web/src/pages/Landing.test.jsx`: new case "footer has a Buy us a coffee link" (href, target, rel) | NEW `e2e/web.patron-link.spec.js`: load `/` and read the footer link's href, target and rel | none: `Landing.jsx` is not covered by any spec |
| AC-2 | `Landing.test.jsx`: click it and expect `trackEvent('cta_clicked', { cta: 'patron', location: 'footer', page: '/' })` | — | none |
| AC-3 | `apps/web/src/components/Footer.test.jsx`: new case for the link, its attributes and its order; the existing cases at :19, :26 and :34 stay green | `e2e/web.patron-link.spec.js`: load `/timer/app`, footer link visible, href = `PATRON_URL` | none: web `Footer.jsx` is not covered |
| AC-4 | `Footer.test.jsx`: click and assert the `trackEvent` call | — | none |
| AC-5 | `packages/shared/__tests__/appLinks.test.js` (existing file, new case): `PATRON_URL` is https on `buymeacoffee.com` and exported from the package index | — | none |
| AC-6 | existing web suites unchanged | existing `e2e/web.timer-flow.spec.js`, `web.report-flow.spec.js` and `web.agenda-flow.spec.js` pass | none |
| AC-7 | existing `apps/zoom-app/src/components/Footer.test.jsx` "leaves the other footer buttons alone" (:140) and `b/TopBar.test.jsx` ⋯ menu contents (:91, :104) stay green, untouched | existing `e2e/zoom.new-look.spec.js:236-245` (exact ⋯ menu items) and `zoom.pro-coming-soon.spec.js:16` (footer button count) stay green | none: no Zoom-app file changes, so no spec's `covers` is touched and the Zoom station has nothing to run |

## Risk
**Low.** The change is two static links and one constant, all in the web app. Nothing changes in
the worker, flags, billing, the CSP or the Zoom app. No `config.json` `riskHigh` path is touched.

The one real exposure is a link to an account we don't control yet. The handle (Q2) must exist
and be owned by us before merge, otherwise the link 404s or, worse, sends money to someone else.

## Open questions
- **Q1: Platform.** Buy Me a Coffee, Ko-fi or GitHub Sponsors?
  *Default: Buy Me a Coffee.* The issue names it, it takes one-time tips with no visitor account, and it pays out through Stripe, which we already use.
- **Q2: The account and handle.** Which BMC page does `PATRON_URL` point at?
  *Default: `https://buymeacoffee.com/toastmusters`.* The owner creates (or confirms) that account before the build station runs. **The build won't ship a link to an unconfirmed handle**, so please answer this one.
- **Q3: One-time or recurring, and perks?**
  *Default: one-time tips only, and patrons get thanks and nothing else.* The BMC page itself can say thanks. Recurring "memberships" on BMC would read as a second subscription next to Pro.
- **Q4: The Zoom app.** Add a "Buy us a coffee" item to design B's ⋯ menu help group (`b/MoreMenu.jsx:154-166`)? The classic panel footer is too full.
  *Default: not in this issue (AC-7).* It needs buymeacoffee.com on the Marketplace Domain Allow List, or a redirect via an allow-listed toastmusters.com page, plus a check that a donation link fits Zoom's listing rules (`docs/BILLING.md:199-203`). I'll file it as a follow-up issue once you answer.
- **Q5: Placement on the web.** Landing footer and web timer footer only? Or also the `/support` page and the 13 static SEO page footers?
  *Default: the two React footers only.* The static pages can follow in one pass once the wording has settled.
- **Q6: Wording.** "Buy us a coffee" or "Support Toastmusters"? Any note beside it?
  *Default: "Buy us a coffee", no extra note.* The landing page doesn't mention Pro, so there is nothing to tell apart.
- **Q7 (proposed criteria).** The issue's acceptance criteria were written before these decisions. AC-1 to AC-7 above are my reading of them: please confirm or edit.
