import { esc, attr } from './layout.mjs';
import { timerDeepLink } from '../lib/links.js';

/**
 * The interactive generator card. Rendered with a real question so the page
 * has content before JavaScript runs; src/generator.js takes over from there.
 * `categorySlug` is '' for "all categories".
 */
export const SET_SIZE = 3;

/**
 * The interactive generator card: a set of three questions (a Table Topics
 * round), rendered with real questions so the page has content before
 * JavaScript runs; src/generator.js takes over from there.
 * `categorySlug` is '' for "all categories".
 */
export function widget(config, { categories, categorySlug, initial, showChips }) {
  const chips = showChips
    ? `
        <div class="tt-chips" role="group" aria-label="Choose a category">
          <button type="button" class="tt-chip${categorySlug ? '' : ' is-active'}" data-tt-chip="" aria-pressed="${categorySlug ? 'false' : 'true'}">All</button>
          ${categories
            .map(
              (c) =>
                `<button type="button" class="tt-chip${c.slug === categorySlug ? ' is-active' : ''}" data-tt-chip="${attr(c.slug)}" aria-pressed="${c.slug === categorySlug ? 'true' : 'false'}">${esc(c.name)}</button>`
            )
            .join('\n          ')}
        </div>`
    : '';
  return `
      <section class="static-card tt-generator" data-tt-generator data-tt-category="${attr(categorySlug)}" data-tt-initial="${attr(initial.map((q) => q.id).join(','))}" aria-labelledby="tt-your-set">
        ${chips}
        <p class="tt-kicker" id="tt-your-set">Your ${initial.length === 1 ? 'question' : `set of ${initial.length}`}</p>
        <ol class="tt-set" data-tt-set>
          ${initial.map((q, i) => setItem(config, q, i)).join('\n          ')}
        </ol>
        <div class="tt-actions">
          <button type="button" class="static-cta-primary tt-btn" data-tt-new>New set</button>
          <button type="button" class="tt-btn tt-btn-ghost" data-tt-copy>Copy all</button>
          <button type="button" class="tt-btn tt-btn-ghost" data-tt-share>Copy link</button>
          <button type="button" class="tt-btn tt-btn-ghost" data-tt-print>Print</button>
        </div>
        <p class="tt-status" data-tt-status role="status" aria-live="polite"></p>
        <noscript><p class="static-note">Enable JavaScript for new random sets, or scroll down: every question is listed on its category page.</p></noscript>
      </section>`;
}

/** One question inside the set. Mirrored in src/generator.js renderItem(). */
export function setItem(config, q, index) {
  return `<li class="tt-set-item" data-tt-item data-tt-id="${attr(q.id)}">
            <span class="tt-set-num" aria-hidden="true">${index + 1}</span>
            <div class="tt-set-body">
              <p class="tt-question" data-tt-text>${esc(q.text)}</p>
              <p class="tt-set-meta">
                <a href="/topics/${attr(q.category)}/" data-tt-category-link>${esc(q.categoryName)}</a>
                <span aria-hidden="true">·</span>
                <a class="tt-set-time" data-tt-time href="${attr(timerDeepLink(q.text, config.timerAppUrl))}" rel="nofollow noopener">Time this (1–2 min)</a>
              </p>
            </div>
          </li>`;
}

export const LIST_VISIBLE = 40;

export function questionList(config, path, questions, { numbered = true, collapsible = false, id = 'tt-list' } = {}) {
  const tag = numbered ? 'ol' : 'ul';
  const extra = collapsible ? ` id="${attr(id)}" data-tt-collapsible` : '';
  return `
        <${tag} class="tt-list"${extra}>
          ${questions
            .map(
              (q) => `<li id="${attr(q.id)}">
            <span class="tt-list-text">${esc(q.text)}</span>
            <span class="tt-list-actions">
              ${q.categoryName && !path.startsWith('/topics/') ? `<a class="tt-list-cat" href="/topics/${attr(q.category)}/">${esc(q.categoryName)}</a>` : ''}
              <a class="tt-list-time" href="${attr(timerDeepLink(q.text, config.timerAppUrl))}" rel="nofollow noopener" data-tt-list-time>Time this</a>
            </span>
          </li>`
            )
            .join('\n          ')}
        </${tag}>`;
}
