// Browser behaviour for the generator card and the Today page. The build
// inlines ./lib/rng.js, ./lib/picker.js and ./lib/links.js above this code
// (imports are stripped), so this file must only use their exported names.
import { drawSet, flattenQuestions, todaySet, utcDateString } from './lib/picker.js';
import { timerDeepLink, shareLink } from './lib/links.js';

const TIMER_APP_URL = '__TIMER_APP_URL__';
// The path the site is served under ('' at a host root, '/tabletopics' on
// www.toastmusters.com). Set by the build, like TIMER_APP_URL.
const BASE_PATH = '__BASE_PATH__';
const SEEN_KEY = 'tt_seen_v1';
const SEEN_MAX = 2000;
const LIST_VISIBLE = 40;

// Questions this browser has already been shown, so the draw cycles through
// unseen ones first. Storage can be unavailable (private mode, blocked); the
// feature simply degrades to plain random.
function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveSeen(seen) {
  try {
    const arr = [...seen];
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr.slice(Math.max(0, arr.length - SEEN_MAX))));
  } catch {
    /* ignore */
  }
}

function track(name, props) {
  if (typeof window.ttTrack === 'function') window.ttTrack(name, props);
}

let bankPromise = null;
function loadBank() {
  if (!bankPromise) {
    bankPromise = fetch(`${BASE_PATH}/questions.json`, { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`questions.json ${r.status}`))))
      .catch((err) => {
        console.warn('Table Topics: could not load questions', err);
        return null;
      });
  }
  return bankPromise;
}

function randomSeed() {
  const buf = new Uint32Array(1);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  return buf[0];
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const SET_SIZE = 3;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Mirrors setItem() in src/templates/widget.mjs.
function renderItem(q, index) {
  return `<li class="tt-set-item" data-tt-item data-tt-id="${escapeHtml(q.id)}">
    <span class="tt-set-num" aria-hidden="true">${index + 1}</span>
    <div class="tt-set-body">
      <p class="tt-question" data-tt-text>${escapeHtml(q.text)}</p>
      <p class="tt-set-meta">
        <a href="${BASE_PATH}/topics/${escapeHtml(q.category)}/" data-tt-category-link>${escapeHtml(q.categoryName)}</a>
        <span aria-hidden="true">·</span>
        <a class="tt-set-time" data-tt-time href="${escapeHtml(timerDeepLink(q.text, TIMER_APP_URL))}" rel="nofollow noopener">Time this (1–2 min)</a>
      </p>
    </div>
  </li>`;
}

function initGenerator(root) {
  const setEl = root.querySelector('[data-tt-set]');
  const statusEl = root.querySelector('[data-tt-status]');
  const chips = Array.from(root.querySelectorAll('[data-tt-chip]'));
  const fixedCategory = root.dataset.ttCategory || '';
  let category = fixedCategory;
  // What is on screen. Before the bank loads we only know ids and texts from the HTML.
  let current = Array.from(root.querySelectorAll('[data-tt-item]')).map((li) => ({
    id: li.dataset.ttId,
    text: li.querySelector('[data-tt-text]').textContent.trim(),
  }));
  let pool = [];
  let all = [];
  let statusTimer = null;
  const seen = loadSeen();
  for (const q of current) seen.add(q.id);
  saveSeen(seen);

  function setStatus(msg) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(() => (statusEl.textContent = ''), 2600);
  }

  function ids() {
    return current.map((q) => q.id);
  }

  function render(questions, source) {
    current = questions;
    for (const q of questions) seen.add(q.id);
    saveSeen(seen);
    setEl.classList.add('is-changing');
    setEl.innerHTML = questions.map(renderItem).join('');
    setTimeout(() => setEl.classList.remove('is-changing'), 120);
    const url = new URL(window.location.href);
    url.searchParams.set('q', ids().join(','));
    history.replaceState(null, '', url);
    track('tt_set_shown', { question_ids: ids(), category: category || 'all', source, count: questions.length });
    questions.forEach((q, i) => track('tt_question_shown', { question_id: q.id, category: q.category, source, position: i + 1 }));
  }

  function draw() {
    const { questions, cycled } = drawSet(pool, randomSeed(), SET_SIZE, ids(), seen);
    if (cycled) {
      for (const q of pool) seen.delete(q.id);
      for (const q of questions) seen.add(q.id);
      setStatus('You have seen every question here — starting over');
    }
    return questions;
  }

  function rebuildPool() {
    pool = category ? all.filter((q) => q.category === category) : all;
  }

  root.querySelector('[data-tt-new]').addEventListener('click', () => {
    if (!pool.length) return setStatus('Questions are still loading…');
    render(draw(), 'random');
  });

  root.querySelector('[data-tt-copy]').addEventListener('click', async () => {
    const text = current.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
    const ok = await copyText(text);
    setStatus(ok ? `${current.length} questions copied` : 'Copy failed — select the text instead');
    track('tt_question_copied', { question_ids: ids(), ok });
  });

  root.querySelector('[data-tt-share]').addEventListener('click', async () => {
    const link = shareLink(window.location.origin, window.location.pathname, ids().join(','));
    const ok = await copyText(link);
    setStatus(ok ? 'Link copied' : link);
    track('tt_share_copied', { question_ids: ids(), ok });
  });

  root.querySelector('[data-tt-print]').addEventListener('click', () => {
    track('tt_print_clicked', { page: window.location.pathname });
    window.print();
  });

  setEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-tt-time]');
    if (!a) return;
    const li = a.closest('[data-tt-item]');
    track('tt_timer_deeplink_clicked', { question_id: li?.dataset.ttId || null, category: category || 'all', source: 'set' });
  });

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      category = chip.dataset.ttChip;
      chips.forEach((c) => {
        const active = c === chip;
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      root.dataset.ttCategory = category;
      rebuildPool();
      track('tt_category_selected', { category: category || 'all' });
      if (pool.length) render(draw(), 'random');
    });
  });

  loadBank().then((bank) => {
    if (!bank) return;
    all = flattenQuestions(bank.categories);
    rebuildPool();
    const byId = new Map(all.map((q) => [q.id, q]));
    const shared = (new URLSearchParams(window.location.search).get('q') || '')
      .split(',')
      .map((id) => byId.get(id.trim()))
      .filter((q) => q && (!fixedCategory || q.category === fixedCategory));
    const sharedIds = shared.map((q) => q.id).join(',');
    if (shared.length && sharedIds !== ids().join(',')) {
      render(shared, 'share');
    } else {
      current = current.map((q) => byId.get(q.id) || q);
      track('tt_set_shown', { question_ids: ids(), category: category || 'all', source: shared.length ? 'share' : 'initial', count: current.length });
    }
  });
}

function initToday(root) {
  const builtFor = root.dataset.builtFor;
  const today = utcDateString();
  root.querySelectorAll('[data-tt-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  if (builtFor === today) {
    track('tt_today_viewed', { date: today, swapped: false });
    return;
  }
  loadBank().then((bank) => {
    if (!bank) return;
    const set = todaySet(bank.categories, today, 10);
    const list = root.querySelector('[data-tt-today-list] ol');
    if (!list) return;
    list.textContent = '';
    for (const q of set) {
      const li = document.createElement('li');
      li.id = q.id;
      const text = document.createElement('span');
      text.className = 'tt-list-text';
      text.textContent = q.text;
      const actions = document.createElement('span');
      actions.className = 'tt-list-actions';
      const cat = document.createElement('a');
      cat.className = 'tt-list-cat';
      cat.href = `${BASE_PATH}/topics/${q.category}/`;
      cat.textContent = q.categoryName;
      const time = document.createElement('a');
      time.className = 'tt-list-time';
      time.href = timerDeepLink(q.text, TIMER_APP_URL);
      time.rel = 'nofollow noopener';
      time.textContent = 'Time this';
      actions.append(cat, time);
      li.append(text, actions);
      list.appendChild(li);
    }
    const dateEl = root.querySelector('[data-tt-today-date]');
    if (dateEl) {
      dateEl.textContent = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      dateEl.setAttribute('datetime', today);
    }
    root.dataset.builtFor = today;
    track('tt_today_viewed', { date: today, swapped: true });
  });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-tt-list-time]');
  if (a) track('tt_timer_deeplink_clicked', { question_id: a.closest('li')?.id || null, source: 'list' });
});

// Long category lists: show the first LIST_VISIBLE, reveal the rest on demand.
// Progressive enhancement — without JavaScript the whole list is visible, and
// crawlers always get the full list in the HTML.
function initCollapsible(list) {
  const items = list.querySelectorAll('li');
  const button = document.querySelector(`[data-tt-show-all="${list.id}"]`);
  if (items.length <= LIST_VISIBLE || !button) return;
  const targetId = (window.location.hash || '').slice(1) || new URLSearchParams(window.location.search).get('q');
  const targetIndex = targetId ? [...items].findIndex((li) => li.id === targetId) : -1;
  if (targetIndex >= LIST_VISIBLE) return; // a shared link points into the hidden part
  list.classList.add('is-collapsed');
  button.hidden = false;
  button.addEventListener('click', () => {
    list.classList.remove('is-collapsed');
    button.hidden = true;
    track('tt_list_expanded', { count: items.length, page: window.location.pathname });
  });
}

document.querySelectorAll('[data-tt-generator]').forEach(initGenerator);
document.querySelectorAll('[data-tt-collapsible]').forEach(initCollapsible);
document.querySelectorAll('[data-tt-today]').forEach(initToday);
