// PostHog via the managed reverse proxy. Placeholders are substituted by the
// build; when no key is configured this file does nothing except keep
// window.ttTrack callable. Loaded as a classic deferred script.
(function () {
  var KEY = '__POSTHOG_KEY__';
  var HOST = '__POSTHOG_HOST__';
  var queue = [];
  window.ttTrack = function (name, props) {
    try {
      if (window.posthog && window.posthog.__loaded) window.posthog.capture(name, props || {});
      else queue.push([name, props || {}]);
    } catch (e) {
      /* analytics must never break the page */
    }
  };
  // Clicks on any element marked data-cta: the same cta_clicked event the
  // timer site sends. sendBeacon, because these links leave the page.
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-cta]') : null;
    if (!el) return;
    var props = {
      cta: el.getAttribute('data-cta'),
      location: el.getAttribute('data-cta-location') || 'content',
      page: window.location.pathname,
    };
    try {
      if (window.posthog && window.posthog.__loaded) window.posthog.capture('cta_clicked', props, { transport: 'sendBeacon' });
      else window.ttTrack('cta_clicked', props);
    } catch (e) {
      /* ignore */
    }
  });
  if (!KEY || KEY.indexOf('__') === 0 || !HOST || HOST.indexOf('__') === 0) return;
  var s = document.createElement('script');
  s.src = HOST.replace(/\/$/, '') + '/static/array.js';
  s.async = true;
  s.onload = function () {
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
        var ev = queue.shift();
        window.posthog.capture(ev[0], ev[1]);
      }
    } catch (e) {
      /* ignore */
    }
  };
  document.head.appendChild(s);
})();
