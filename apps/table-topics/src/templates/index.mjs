import { page, esc, attr, zoomPitch } from './layout.mjs';
import { widget } from './widget.mjs';
import { webApp, faq, breadcrumb } from './seo.mjs';

export const HOME_FAQ = [
  ['What is a Table Topics question?', 'Table Topics is the impromptu speaking segment of a Toastmasters meeting. The Table Topics Master asks a question and a member answers it on the spot with a one- to two-minute speech. A good question is open-ended, answerable by anyone, and invites a story or an opinion.'],
  ['How long is a Table Topics response?', 'One to two minutes. The timer shows green at 1:00, yellow at 1:30 and red at 2:00, usually with a 30-second grace period after red. The "Time this" button opens the Toastmusters Timer with that preset already selected.'],
  ['How many questions do I need for a meeting?', 'Plan one question per participant plus two spares. Most clubs run five to eight Table Topics speakers, so a set of ten covers a typical meeting; the Today page gives you exactly that.'],
  ['Can I use the same question for two speakers?', 'Yes, and it often works well: two answers to one question show how differently people think. Just avoid repeating a question the same member has already answered this month.'],
  ['Is this tool free and does it need an account?', 'It is free, needs no sign-up and stores nothing about you. The questions are a curated, version-controlled list that grows every week.'],
];

export function indexPage(config, bank, initial) {
  const total = bank.categories.reduce((n, c) => n + c.questions.length, 0);
  const path = '/';
  const title = `Table Topics Generator – ${total}+ Random Table Topics Questions for Toastmasters`;
  const description = `Free random Table Topics question generator: ${total} impromptu speaking prompts in ${bank.categories.length} categories, filterable by theme, with a one-click 1–2 minute Toastmasters timer.`;
  const body = `
      <section class="static-card static-content tt-intro">
        <h1>Table Topics Question Generator</h1>
        <p class="tt-lede">Random, open-ended Table Topics questions for your next Toastmasters meeting. Pick a category or take them all, hit <strong>New question</strong>, and time the answer with one click.</p>
        <div class="answer-block">
          <p>A Table Topics question is an impromptu speaking prompt answered in <strong>1 to 2 minutes</strong>. This generator draws from <strong>${total} curated questions</strong> in ${bank.categories.length} categories. Every question is open-ended, free of politics and trivia, and answerable by anyone in the room.</p>
        </div>
      </section>
${widget(config, { categories: bank.categories, categorySlug: '', initial, showChips: true })}
      <section class="static-card static-content">
        <h2>Browse by category</h2>
        <p>Each category page lists every question in plain text, so you can print a set or skim before the meeting.</p>
        <div class="tt-grid">
          ${bank.categories
            .map(
              (c) => `<a class="tt-card" href="/topics/${attr(c.slug)}/">
            <strong>${esc(c.name)}</strong>
            <span>${esc(c.description)}</span>
            <em>${c.questions.length} questions</em>
          </a>`
            )
            .join('\n          ')}
        </div>
        <p class="tt-today-teaser"><a class="static-inline-cta" href="/today/">Today&rsquo;s set: ten questions picked for ${esc(config.buildDateLong)} &rarr;</a></p>
      </section>
      <section class="static-card static-content">
        <h2>How to run a great Table Topics session</h2>
        <ol class="static-steps">
          <li><strong>Prepare a theme, not a script.</strong> Pick one or two categories that fit the meeting theme and let the generator surprise you.</li>
          <li><strong>Ask, then name.</strong> Read the question to the whole room first, then call on a speaker. Everyone gets a moment to think, and nobody tunes out.</li>
          <li><strong>Time every answer.</strong> Tap <em>Time this</em> to open the timer with the 1–2 minute Table Topics preset. Green at 1:00, yellow at 1:30, red at 2:00.</li>
          <li><strong>Favor guests and quiet members.</strong> Table Topics is the easiest way for a guest to speak for the first time. Keep an icebreaker question ready for them.</li>
          <li><strong>Keep spares.</strong> Have two more questions than speakers. <a href="/today/">Today&rsquo;s set</a> gives you ten in one place.</li>
        </ol>
        ${zoomPitch(config, 'home')}
      </section>
      <section class="static-card static-content" id="faq">
        <h2>Frequently asked questions</h2>
        ${HOME_FAQ.map(([q, a]) => `<h3>${esc(q)}</h3>\n        <p>${esc(a)}</p>`).join('\n        ')}
      </section>`;
  return page(config, {
    title,
    description,
    path,
    body,
    ogType: 'website',
    jsonLd: [
      webApp(config, { questionCount: total, categoryCount: bank.categories.length }),
      faq(HOME_FAQ),
      breadcrumb(config, [{ name: 'Table Topics Generator', path: '/' }]),
    ],
  });
}
