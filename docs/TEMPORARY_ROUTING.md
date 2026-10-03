# Temporary routing: root → Zoom app

> **Historical.** This describes a Vercel-era workaround that is no longer in
> place. Current routes: [TOASTMUSTERS_PATHS.md](TOASTMUSTERS_PATHS.md) (the web
> timer is at `/timer/app`; `/app` and `/web` redirect there).

## Why this exists

Zoom’s production app **home URL** can only be updated after Zoom approves the change. Until then, Zoom keeps opening the **root** domain (e.g. `https://www.timer.simple-tech.app/`), not the zoom subdomain.

So we temporarily changed routing so that:

- **`/`** (root) → **Zoom app** (so opening the app in Zoom still works in prod).
- **`/landing`** → **Landing page** (marketing).
- **`/landing/app`** → **Web timer** (browser).
- **`/zoom`** → Zoom app (unchanged).
- **`/app`** and **`/web`** → Redirect to **`/landing/app`**.

## What to do after Zoom approves the new home URL

When Zoom has approved the production home URL change to **`https://zoom.timer.simple-tech.app`** (zoom subdomain), you can revert to the normal setup:

1. **Web app (apps/web)**
   - **vite.config.js:** Remove the `base` / `VITE_BASE_PATH` logic and use `base: '/'` (or drop `base`).
   - **main.jsx:** Remove `basename="/landing"` from `<BrowserRouter>`.
   - **Landing.jsx:** Change image URLs back from `/landing/Toastmasters-*` to `/Toastmasters-*` (and cover background URL).

2. **Root package.json**
   - **combine:dist:** Restore the previous script so the web app is at the root again:
     - `cp -r apps/web/dist/. dist/` (web at root)
     - `mkdir -p dist/zoom && cp -r apps/zoom-app/dist/. dist/zoom/`
     - Remove the `cp apps/zoom-app/dist/index.html dist/index.html` step.

3. **vercel.json**
   - **redirects:** Point `/web` back to `/app`; remove the `/app` → `/landing/app` redirect.
   - **rewrites:** Remove the `/landing/*` rules and the explicit `"/" → "/index.html"` rule. Restore the single catch‑all: `"/(.*)" → "/index.html"` so the web app (landing at `/`, timer at `/app`) is served at root again.

4. **Optional**
   - Delete or archive this note: `docs/TEMPORARY_ROUTING.md`.

After reverting:

- **`/`** → Landing page  
- **`/app`** → Web timer  
- **`/zoom`** → Zoom app  
- **`https://zoom.timer.simple-tech.app/`** → Zoom app (via middleware or separate project).
