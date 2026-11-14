import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/web', 'apps/zoom-app', 'api', 'worker', 'apps/table-topics', 'scripts'],
  },
});
