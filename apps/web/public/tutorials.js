// The /tutorials page: one visible video at a time, chosen by the playlist, the
// "Next" button or the URL hash (/tutorials#agenda). Every video, with its
// transcript, is in the HTML already, so the page reads fine without this file;
// the script only swaps which one is shown, starts playback on a click, and
// reports plays. Loaded as a classic deferred script, like site-analytics.js.
(function () {
  var articles = [].slice.call(document.querySelectorAll('.tut-video'));
  var items = [].slice.call(document.querySelectorAll('.tut-item'));
  if (!articles.length) return;
  var slugs = articles.map(function (a) { return a.id; });
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 60rem)') : { matches: false };
  var phone = window.matchMedia ? window.matchMedia('(max-width: 40rem)') : { matches: false };
  var current = slugs[0];
  var played = {};

  function track(name, props) {
    try { if (window.siteTrack) window.siteTrack(name, props); } catch (e) { /* analytics must never break the page */ }
  }
  function part(slug) {
    var article = document.getElementById(slug);
    return {
      article: article,
      video: article.querySelector('video'),
      player: article.querySelector('.tut-player'),
      button: article.querySelector('.tut-playbtn'),
      toggle: article.querySelector('.tut-toggle'),
      tx: article.querySelector('.tut-tx'),
    };
  }

  function select(slug, opts) {
    if (slugs.indexOf(slug) < 0) slug = slugs[0];
    opts = opts || {};
    articles.forEach(function (article) {
      var on = article.id === slug;
      article.hidden = !on;
      if (!on) { var v = article.querySelector('video'); if (v && !v.paused) v.pause(); }
    });
    items.forEach(function (item) {
      var on = item.getAttribute('data-slug') === slug;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
    });
    current = slug;
    var p = part(slug);
    if (opts.scroll && narrow.matches && p.player.scrollIntoView) p.player.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (opts.play) start(p, true);
  }

  function start(p, userStarted) {
    if (!p.video) return;
    var promise = p.video.play();
    if (promise && promise.catch) promise.catch(function () { /* autoplay blocked: the poster and button stay */ });
  }

  // Each video: a poster with one play button, native controls once it starts.
  articles.forEach(function (article) {
    var p = part(article.id);
    var slug = article.id;
    if (p.video) {
      p.video.controls = false;
      p.video.addEventListener('click', function () { if (!p.player.classList.contains('is-started')) start(p); });
      p.video.addEventListener('play', function () {
        p.player.classList.add('is-started');
        p.video.controls = true;
        if (!played[slug]) {
          played[slug] = true;
          track('tutorial_played', { tutorial: slug, page: window.location.pathname });
        }
      });
      p.video.addEventListener('ended', function () { track('tutorial_completed', { tutorial: slug, page: window.location.pathname }); });
    }
    if (p.button) { p.button.hidden = false; p.button.addEventListener('click', function () { start(p); }); }
    if (p.toggle && p.tx) {
      p.toggle.hidden = false;
      var open = !phone.matches;
      var paint = function () { p.tx.hidden = !open; p.toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); p.toggle.textContent = open ? 'Hide transcript' : 'Show transcript'; };
      p.toggle.addEventListener('click', function () { open = !open; paint(); });
      paint();
    }
  });

  // The playlist and the Next buttons change the hash without jumping, and play.
  function go(slug, e) {
    if (e) e.preventDefault();
    if (history.pushState) history.pushState(null, '', '#' + slug); else window.location.hash = slug;
    select(slug, { play: true, scroll: true });
  }
  items.forEach(function (item) {
    item.addEventListener('click', function (e) { go(item.getAttribute('data-slug'), e); });
  });
  [].slice.call(document.querySelectorAll('.tut-next[data-next]')).forEach(function (link) {
    link.addEventListener('click', function (e) { go(link.getAttribute('data-next'), e); });
  });

  window.addEventListener('popstate', function () { select((window.location.hash || '').replace('#', ''), {}); });
  window.addEventListener('hashchange', function () { var h = (window.location.hash || '').replace('#', ''); if (h !== current) select(h, {}); });
  select((window.location.hash || '').replace('#', '') || slugs[0], {});
})();
