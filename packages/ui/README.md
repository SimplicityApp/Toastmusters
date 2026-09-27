# `@toastmaster-timer/ui`

React components rendered by **both** `apps/zoom-app` and `apps/web`, plus
`content-pages.css` (copied into `apps/web/public` by `npm run sync:ui`).

Everything here is presentational: props in, markup out. No Zoom SDK, no
`TimerContext`, no `localStorage`. A component that needs any of those belongs
in the app that owns it — the two apps' `ReportTab`s and `EditRulesModal`s
differ for real reasons, and pretending otherwise is how `CardImagesModal`
drifted 39 lines apart.

## The token floor

**Shared components may use stock Tailwind plus `timer-green`, `timer-yellow`
and `timer-red`, and nothing else.**

That is the whole of the intersection of the two apps' Tailwind themes:

| Token | `apps/web` | `apps/zoom-app` |
|---|---|---|
| `timer-green` / `timer-yellow` / `timer-red` | yes | yes |
| `cream`, `ink` | yes | **no** |
| `font-display` | yes | **no** |

A shared component reaching for `bg-cream` renders unstyled inside Zoom with no
error and no warning — the class simply is not in that build's stylesheet. Since
nothing fails, only a person looking at the Zoom sidebar would ever notice.

Anything outside the floor goes through an inline `style`, which is also how the
club's own colour arrives: it is data, not a token, and no build step could know
it.

## Keeping the classes in the build

Both apps' `tailwind.config.js` files list `../../packages/ui/**/*.{js,jsx}` in
`content`. Without it every class in this package is purged from both builds.

## Resolution

Both apps alias `@toastmaster-timer/ui` to this directory in `vite.config.js`
and `vitest.config.js`. There is no `node_modules` install step and no lockfile
entry, so adding a component here is reachable from both apps immediately.
