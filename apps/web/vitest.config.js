import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['../../test/jsdom-webstorage.js', './src/test/setup.js'],
    css: false,
  },
  resolve: {
    alias: {
      '@toastmaster-timer/shared': path.resolve(__dirname, '../../packages/shared'),
      '@toastmaster-timer/ui': path.resolve(__dirname, '../../packages/ui'),
    },
  },
});
