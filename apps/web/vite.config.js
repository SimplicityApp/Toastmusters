import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const base = process.env.VITE_BASE_PATH ?? '/'

// In dev, rewrite clean URLs to .html files (mirrors Vercel rewrites).
function serveContentPages() {
  const webPublic = path.resolve(__dirname, 'public')
  const zoomPublic = path.resolve(__dirname, '../zoom-app/public')
  // Mirror the rewrites from vercel.json
  const rewriteMap = {
    '/privacy': path.join(zoomPublic, 'privacy.html'),
    '/support': path.join(zoomPublic, 'support.html'),
    '/terms-of-use': path.join(zoomPublic, 'terms-of-use.html'),
    '/documentation': path.join(zoomPublic, 'documentation.html'),
  }
  return {
    name: 'serve-content-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url.split('?')[0]
        if (url.includes('.') || url === '/') return next()
        // Check explicit rewrite map first (legal pages from zoom-app)
        const mapped = rewriteMap[url]
        if (mapped && fs.existsSync(mapped)) {
          res.setHeader('Content-Type', 'text/html')
          return res.writeHead(200).end(fs.readFileSync(mapped))
        }
        // Then check web public dir for content pages
        const htmlPath = path.join(webPublic, url + '.html')
        if (fs.existsSync(htmlPath)) {
          res.setHeader('Content-Type', 'text/html')
          return res.writeHead(200).end(fs.readFileSync(htmlPath))
        }
        next()
      })
    }
  }
}

// In dev, serve /zoom/* files from zoom-app/public so video etc. work without
// running the zoom-app dev server. In production combine:dist handles this.
function serveZoomPublic() {
  const zoomPublic = path.resolve(__dirname, '../zoom-app/public')
  return {
    name: 'serve-zoom-public',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/zoom/')) return next()
        // Drop the query string (cache-busting ?v=N on the card images) or the
        // lookup misses and the SPA fallback answers with index.html.
        const filePath = path.join(zoomPublic, req.url.replace('/zoom/', '').split('?')[0])
        if (fs.existsSync(filePath)) {
          return res.writeHead(200).end(fs.readFileSync(filePath))
        }
        next()
      })
    }
  }
}

// The static pages load public/site-analytics.js, which Vite copies as is.
// Fill in its PostHog key and host after the build, from the same env the
// React app reads. Without a key the placeholders stay and the script does
// nothing.
function fillSiteAnalytics() {
  let config
  return {
    name: 'fill-site-analytics',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    closeBundle() {
      const file = path.resolve(config.root, config.build.outDir, 'site-analytics.js')
      const key = config.env.VITE_PUBLIC_POSTHOG_KEY
      const host = config.env.VITE_PUBLIC_POSTHOG_HOST
      if (!fs.existsSync(file) || !key || !host) return
      const filled = fs.readFileSync(file, 'utf8').replace('__POSTHOG_KEY__', key).replace('__POSTHOG_HOST__', host)
      fs.writeFileSync(file, filled)
    },
  }
}

export default defineConfig(async () => {
  const plugins = [
    react(),
    serveContentPages(),
    serveZoomPublic(),
    fillSiteAnalytics(),
  ]

  if (process.env.ANALYZE) {
    const { visualizer } = await import('rollup-plugin-visualizer')
    plugins.push(visualizer({ open: true, filename: 'stats.html', gzipSize: true }))
  }

  return {
    base,
    plugins,
    resolve: {
      alias: {
        // Aliased rather than installed: packages/ui is a source directory in
        // this repo, and a file: dependency would put it in the lockfile and
        // need an install before a new shared component was reachable.
        '@toastmaster-timer/ui': path.resolve(__dirname, '../../packages/ui'),
      },
    },
    envDir: path.resolve(__dirname, '../..'),
    server: {
      port: 3001,
      // Bind every interface, not the default "localhost": depending on which
      // process starts vite, that name resolves to only ::1 or only 127.0.0.1,
      // and a browser on the other stack gets connection refused.
      host: true,
      open: true
    }
  }
})
