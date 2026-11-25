import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The runtime module behind `extends DurableObject` (worker/club-places.js).
      'cloudflare:workers': fileURLToPath(new URL('./test-stubs/cloudflare-workers.js', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.js'],
    unstubEnvs: true,
  },
});
