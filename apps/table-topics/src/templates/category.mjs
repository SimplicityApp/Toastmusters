import { page, esc, attr, zoomPitch } from './layout.mjs';
import { widget, questionList, LIST_VISIBLE } from './widget.mjs';
import { article, breadcrumb, itemList } from './seo.mjs';

export function categoryPage(config, bank, category, initial) {
  const path = `/topics/${category.slug}/`;
  const n = category.questions.length;
  const title = `${category.name} Table Topics Questions (${n} Prompts) – Table Topics Generator`;
  const description = `${n} ${category.name.toLowerCase()} Table Topics questions for Toastmasters: ${category.description} Draw one at random or read the full list, then time the answer in one click.`;
  const dates = category.questions.map((q) => q.added).sort();
  const datePublished = dates[0];
  const dateModified = dates[dates.length - 1];
  const questions = category.questions.map((q) => ({ ...q, category: category.slug, categoryName: category.name }));
  const others = bank.categories.filter((c) => c.slug !== category.slug);
  const related = [...others].sort(() => 0).slice(0, 6); // stable: first six other categories
  const body = `
      <section class="static-card static-content tt-intro">
        <h1>${esc(category.name)} Table Topics Questions</h1>
        <p class="page-updated">${n} questions · updated ${esc(dateModified)}</p>
        <div class="answer-block">
          <p>${esc(category.description)} Every question below is open-ended and answerable in a <strong>1 to 2 minute</strong> impromptu speech. Draw one at random, or scroll for the full list.</p>
        </div>
      </section>
${widget(config, { categories: bank.categories, categorySlug: category.slug, initial, showChips: false })}
      <section class="static-card static-content">
        <h2>All ${n} ${esc(category.name.toLowerCase())} questions</h2>
${questionList(config, path, questions, { collapsible: true, id: 'tt-list' })}
        ${n > LIST_VISIBLE ? `<p class="tt-show-all-row"><button type="button" class="tt-btn tt-btn-ghost" data-tt-show-all="tt-list" hidden>Show all ${n} questions</button></p>` : ''}
        <p><a class="static-inline-cta" href="${attr(config.timerAppUrl)}?role=Table%20Topics%20Speech" rel="noopener" data-cta="web_timer" data-cta-location="category">Open the Table Topics timer &rarr;</a></p>
        ${zoomPitch(config, 'category')}
      </section>
      <section class="static-card static-content">
        <h2>More categories</h2>
        <ul class="tt-related">
          ${related.map((c) => `<li><a href="/topics/${attr(c.slug)}/">${esc(c.name)}</a> <span>${c.questions.length}</span></li>`).join('\n          ')}
          <li><a href="/topics/">All categories &rarr;</a></li>
        </ul>
      </section>`;
  return page(config, {
    title,
    description,
    path,
    body,
    ogType: 'article',
    breadcrumbs: [
      { name: 'Table Topics Generator', path: '/' },
      { name: 'Categories', path: '/topics/' },
      { name: category.name, path },
    ],
    jsonLd: [
      article(config, { headline: `${category.name} Table Topics Questions`, description, path, datePublished, dateModified }),
      breadcrumb(config, [
        { name: 'Table Topics Generator', path: '/' },
        { name: 'Categories', path: '/topics/' },
        { name: category.name, path },
      ]),
      itemList(config, path, questions),
    ],
  });
}
