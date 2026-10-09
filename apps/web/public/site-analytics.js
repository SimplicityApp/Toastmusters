// Analytics for the static pages (the guides, 404): PostHog page views, and
// one `cta_clicked` event per click on any element marked data-cta. The React
// pages use apps/web/src/utils/posthog.js instead.
//
// The two placeholders below are filled in by the web build (vite.config.js,
// from VITE_PUBLIC_POSTHOG_KEY / _HOST). Unfilled — the dev server, a build
// without a key — the page view is skipped and clicks are dropped, and nothing
// else changes. Loaded as a classic deferred script; analytics must never
// break a page.
(function () {
  var KEY = '__POSTHOG_KEY__';
  var HOST = '__POSTHOG_HOST__';
  var configured = KEY && KEY.indexOf('__') !== 0 && HOST && HOST.indexOf('__') !== 0;
  var queue = [];

  function capture(name, props) {
    try {
      if (window.posthog && window.posthog.__loaded) {
        // sendBeacon: most CTAs navigate away, which would cancel a fetch.
        window.posthog.capture(name, props, { transport: 'sendBeacon' });
      } else if (configured) {
        queue.push([name, props]);
      }
    } catch (e) {
      /* ignore */
    }
  }

  // data-cta names what the button does (add_to_zoom, web_timer, marketplace);
  // data-cta-location names where on the page it sits.
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-cta]') : null;
    if (!el) return;
    capture('cta_clicked', {
      cta: el.getAttribute('data-cta'),
      location: el.getAttribute('data-cta-location') || 'content',
      page: window.location.pathname,
    });
  });

  if (!configured) return;
  var script = document.createElement('script');
  script.src = HOST.replace(/\/$/, '') + '/static/array.js';
  script.async = true;
  script.onload = function () {
    try {
      window.posthog.init(KEY, {
        api_host: HOST,
        ui_host: 'https://us.posthog.com',
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: true,
        capture_pageleave: true,
        disable_session_recording: true,
        disable_surveys: true,
      });
      while (queue.length) {
        var queued = queue.shift();
        window.posthog.capture(queued[0], queued[1], { transport: 'sendBeacon' });
      }
    } catch (e) {
      /* ignore */
    }
  };
  document.head.appendChild(script);
})();
