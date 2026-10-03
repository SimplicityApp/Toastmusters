import { organization, webSite } from './seo.mjs';

/** Escape for HTML text content (quotes stay readable in titles and prose). */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for double-quoted HTML attribute values. */
export function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

/** Serialize JSON-LD safely inside a <script> (no `</script>` break-outs). */
function jsonLdScript(graph) {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

export function footer(config) {
  const tools = config.tools
    .map((t) => `<li><a href="${attr(t.url)}/"${t.slug === 'table-topics' ? ' aria-current="true"' : ''}>${esc(t.name)}</a></li>`)
    .join('\n            ');
  const timer = config.tools.find((t) => t.slug === 'timer')?.url ?? config.timerOrigin;
  return `
    <footer class="static-footer">
      <div class="static-footer-inner">
        <div>
          <h4>Tools</h4>
          <ul class="static-footer-links">
            ${tools}
            <li><a href="/today/">Today&rsquo;s Table Topics</a></li>
            <li><a href="/topics/">All categories</a></li>
          </ul>
        </div>
        <div>
          <h4>Guides</h4>
          <ul class="static-footer-links">
            <li><a href="${attr(timer)}/table-topics-timer">Table Topics Timing Rules</a></li>
            <li><a href="${attr(timer)}/toastmasters-timer-role-guide">Timer Role Guide</a></li>
            <li><a href="${attr(timer)}/toastmasters-timing-chart">Timing Chart</a></li>
            <li><a href="${attr(timer)}/toastmasters-speech-contest-timing-rules">Contest Timing Rules</a></li>
            <li><a href="${attr(timer)}/how-to-use-zoom-for-toastmasters">Zoom for Toastmasters</a></li>
          </ul>
        </div>
        <div>
          <h4>Legal</h4>
          <ul class="static-footer-links">
            <li><a href="${attr(timer)}/privacy">Privacy Policy</a></li>
            <li><a href="${attr(timer)}/terms-of-use">Terms of Use</a></li>
            <li><a href="${attr(timer)}/support">Support</a></li>
          </ul>
        </div>
      </div>
      <p class="static-footer-copy">&copy; ${new Date(config.buildDate).getUTCFullYear()} Toastmusters. Not affiliated with <a href="https://www.toastmasters.org/" target="_blank" rel="noopener noreferrer">Toastmasters International</a>. Questions are written to be answerable by anyone, anywhere.</p>
    </footer>`;
}

export function header(config) {
  const timer = config.tools.find((t) => t.slug === 'timer')?.url ?? config.timerOrigin;
  return `
    <header class="static-header">
      <div class="static-header-inner tt-header-inner">
        <a href="/" class="tt-brand">
          <img src="/logo.png" alt="" width="36" height="36" class="static-header-logo" />
          <span class="static-header-title">Table Topics Generator</span>
        </a>
        <nav class="tt-nav" aria-label="Site">
          <a href="/topics/">Categories</a>
          <a href="/today/">Today&rsquo;s set</a>
          <a href="${attr(timer)}/timer" rel="noopener">Toastmasters timer</a>
        </nav>
      </div>
    </header>`;
}

export function breadcrumbNav(items) {
  const parts = items.map((it, i) =>
    i === items.length - 1
      ? `<span class="current">${esc(it.name)}</span>`
      : `<a href="${attr(it.path)}">${esc(it.name)}</a>`
  );
  return `
    <nav class="static-breadcrumb" aria-label="Breadcrumb">
      ${parts.join('\n      <span aria-hidden="true">&rsaquo;</span>\n      ')}
    </nav>`;
}

/**
 * Full HTML document. `jsonLd` is a list of schema.org nodes; Organization and
 * WebSite are always prepended so every page carries the same entity graph.
 */
export function page(config, { title, description, path, body, jsonLd = [], ogType = 'website', noindex = false, breadcrumbs = null }) {
  const url = `${config.siteOrigin}${path}`;
  const graph = [organization(config), webSite(config), ...jsonLd];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${attr(description)}" />
  <link rel="canonical" href="${attr(url)}" />
  ${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ''}

  <meta property="og:type" content="${ogType}" />
  <meta property="og:site_name" content="Table Topics Generator" />
  <meta property="og:url" content="${attr(url)}" />
  <meta property="og:title" content="${attr(title)}" />
  <meta property="og:description" content="${attr(description)}" />
  <meta property="og:image" content="${attr(config.siteOrigin)}/og-cover.png" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />

  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="theme-color" content="#FAF7F2" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="dns-prefetch" href="${attr(config.posthogHost || 'https://e.simple-tech.app')}" />
  <link rel="stylesheet" href="${attr(config.assets['content-pages.css'])}" />
  <link rel="stylesheet" href="${attr(config.assets['tabletopics.css'])}" />

  ${jsonLdScript(graph)}
  <script src="${attr(config.assets['analytics.js'])}" defer></script>
  <script type="module" src="${attr(config.assets['generator.js'])}"></script>
</head>
<body>
  <div class="static-landing">
    ${header(config)}
    ${breadcrumbs ? breadcrumbNav(breadcrumbs) : ''}
    <main class="static-main">
${body}
    </main>
    ${footer(config)}
  </div>
</body>
</html>
`;
}
