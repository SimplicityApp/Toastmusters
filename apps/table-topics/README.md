# Table Topics Generator

Static site + Cloudflare Worker. Full documentation: [`docs/TABLE_TOPICS.md`](../../docs/TABLE_TOPICS.md).

- Add or review questions: `content/questions.json`, rules in `content/GENERATION_PROMPT.md`,
  categories in `content/CATEGORIES.md`. Check with `npm run validate:tabletopics` (repo root).
- Build: `npm run build:tabletopics` → `dist/`. The timer Worker serves it under `/tabletopics`: `npm run build && npx wrangler dev`.
- Tests: `npx vitest run --root apps/table-topics`.
- Deploy: deployed by the timer Workers' Cloudflare Workers Builds on `master`/`dev` (see `docs/TABLE_TOPICS.md`);
  manual: `npm run cf:deploy:dev` / `cf:deploy:prod`.
