// The /tutorials page: one visible video at a time, chosen by the playlist, the
// "Next" button or the URL hash (/tutorials#agenda). Every video, with its
// transcript, is in the HTML already, so the page reads fine without this file;
// the script swaps which one is shown and sets how it plays.
//
// How a video plays, the way most product sites do it: arriving on the page (or a
// deep link) starts the video muted and looping, only while it is on screen, with
// a "Tap for sound" pill; the captions are burned in, so it reads without audio.
// A click anywhere on it restarts it from the beginning with sound and controls.
// Picking another video from the playlist or Next is already a click, so that one
// starts with sound. Reduced motion or data saver turns the muted preview off.
// Loaded as a classic deferred script, like site-analytics.js.
(function () {
  var articles = [].slice.call(document.querySelectorAll('.tut-video'));
  var items = [].slice.call(document.querySelectorAll('.tut-item'));
  if (!articles.length) return;
  var slugs = articles.map(function (a) { return a.id; });
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 60rem)') : { matches: false };
  var phone = window.matchMedia ? window.matchMedia('(max-width: 40rem)') : { matches: false };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  var previews = !reduced && !saveData;
  var current = slugs[0];
  var played = {};
  var observer = null;

  function track(name, props) {
    try { if (window.siteTrack) window.siteTrack(name, props); } catch (e) { /* analytics must never break the page */ }
  }
  function part(slug) {
    var article = document.getElementById(slug);
    return {
      slug: slug,
      article: article,
      video: article.querySelector('video'),
      player: article.querySelector('.tut-player'),
      button: article.querySelector('.tut-playbtn'),
      sound: article.querySelector('.tut-sound'),
      toggle: article.querySelector('.tut-toggle'),
      tx: article.querySelector('.tut-tx'),
    };
  }
  function attempt(video) {
    var promise = video.play();
    if (promise && promise.catch) promise.catch(function () { /* autoplay blocked: the poster and play button stay */ });
  }

  // Muted, looping, silent. Never counts as a play.
  function startPreview(p) {
    if (!previews || !p.video || p.player.classList.contains('is-started')) return;
    p.video.muted = true;
    p.video.loop = true;
    p.video.controls = false;
    p.player.classList.add('is-preview');
    attempt(p.video);
  }
  // A person chose this video: from the start, with sound, with controls.
  function startWithSound(p) {
    if (!p.video) return;
    p.player.classList.remove('is-preview');
    p.player.classList.add('is-started');
    p.video.loop = false;
    p.video.muted = false;
    p.video.controls = true;
    try { p.video.currentTime = 0; } catch (e) { /* not seekable yet */ }
    if (!played[p.slug]) {
      played[p.slug] = true;
      track('tutorial_played', { tutorial: p.slug, page: window.location.pathname });
    }
    attempt(p.video);
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
    if (opts.sound) startWithSound(p); else if (observer) observer.observe(p.player);
  }

  // A preview only plays while it is on screen.
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target.querySelector('video');
        var preview = entry.target.classList.contains('is-preview');
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (!preview && !entry.target.classList.contains('is-started')) startPreview(part(entry.target.closest('.tut-video').id));
          else if (preview && video && video.paused) attempt(video);
        } else if (preview && video && !video.paused) {
          video.pause();
        }
      });
    }, { threshold: [0, 0.5, 1] });
  }

  articles.forEach(function (article) {
    var p = part(article.id);
    if (p.video) {
      p.video.controls = false;
      p.video.setAttribute('playsinline', '');
      p.video.addEventListener('click', function () { if (!p.player.classList.contains('is-started')) startWithSound(p); });
      p.video.addEventListener('ended', function () { track('tutorial_completed', { tutorial: p.slug, page: window.location.pathname }); });
      // Someone using the native controls after the fact still counts as a play.
      p.video.addEventListener('play', function () {
        if (p.player.classList.contains('is-preview')) return;
        p.player.classList.add('is-started');
        p.video.controls = true;
        if (!played[p.slug]) { played[p.slug] = true; track('tutorial_played', { tutorial: p.slug, page: window.location.pathname }); }
      });
    }
    if (p.button) { p.button.hidden = false; p.button.addEventListener('click', function () { startWithSound(p); }); }
    if (p.sound) p.sound.addEventListener('click', function () { startWithSound(p); });
    if (p.toggle && p.tx) {
      p.toggle.hidden = false;
      var open = !phone.matches;
      var paint = function () { p.tx.hidden = !open; p.toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); p.toggle.textContent = open ? 'Hide transcript' : 'Show transcript'; };
      p.toggle.addEventListener('click', function () { open = !open; paint(); });
      paint();
    }
  });

  // The playlist and the Next buttons change the hash without jumping, and play with sound.
  function go(slug, e) {
    if (e) e.preventDefault();
    if (history.pushState) history.pushState(null, '', '#' + slug); else window.location.hash = slug;
    select(slug, { sound: true, scroll: true });
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
