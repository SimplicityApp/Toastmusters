import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Needed for the automatic JSX runtime in component tests, as in apps/web.
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['../../test/jsdom-webstorage.js'],
  },
  resolve: {
    alias: {
      '@toastmaster-timer/shared': path.resolve(__dirname, '../../packages/shared'),
      '@toastmaster-timer/ui': path.resolve(__dirname, '../../packages/ui'),
    },
  },
});
