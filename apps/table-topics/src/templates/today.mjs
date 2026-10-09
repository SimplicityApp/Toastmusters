import { page, esc, attr, zoomPitch } from './layout.mjs';
import { questionList } from './widget.mjs';
import { webPage, breadcrumb } from './seo.mjs';

export function todayPage(config, bank, set) {
  const path = '/today/';
  const title = `Today's Table Topics Questions – 10 Prompts for ${config.buildDateLong}`;
  const description = 'Ten Table Topics questions for today, spread across categories and refreshed daily. Enough for a full Toastmasters meeting, with a one-click 1–2 minute timer for each.';
  const body = `
      <section class="static-card static-content" data-tt-today data-built-for="${attr(config.buildDate)}">
        <h1>Today&rsquo;s Table Topics</h1>
        <p class="page-updated"><time datetime="${attr(config.buildDate)}" data-tt-today-date>${esc(config.buildDateLong)}</time> · ten questions, one per category where possible</p>
        <div class="answer-block">
          <p>A ready-made set for one meeting: <strong>ten Table Topics questions</strong> chosen for today from ${bank.categories.length} categories. The set is the same for everyone today and changes tomorrow. Read one, name a speaker, tap <em>Time this</em>.</p>
        </div>
        <div data-tt-today-list>
${questionList(config, path, set)}
        </div>
        <div class="tt-actions">
          <button type="button" class="static-cta-primary tt-btn" data-tt-print>Print this set</button>
          <a class="static-cta-secondary tt-btn" href="/">Draw more questions</a>
        </div>
        ${zoomPitch(config, 'today')}
      </section>
      <section class="static-card static-content">
        <h2>How to use today&rsquo;s set</h2>
        <p>Ask the questions in order and skip any that do not fit your room. Guests and newer members do best with the icebreaker-style prompts; save the contest-style ones for experienced speakers. Two spares are included, so a set of ten covers a typical club meeting of six to eight Table Topics speakers.</p>
      </section>`;
  const crumbs = [
    { name: 'Table Topics Generator', path: '/' },
    { name: "Today's set", path },
  ];
  return page(config, {
    title,
    description,
    path,
    body,
    breadcrumbs: crumbs,
    jsonLd: [webPage(config, { name: "Today's Table Topics", description, path, dateModified: config.buildDate }), breadcrumb(config, crumbs)],
  });
}
