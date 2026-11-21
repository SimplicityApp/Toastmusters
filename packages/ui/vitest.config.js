import { defineConfig } from 'vitest/config';

// Test-only: the components themselves still depend on nothing but React (see
// README). react, react-dom, jsdom and @testing-library/react resolve from the
// repo root's node_modules.
export default defineConfig({
  // The automatic runtime, as both apps build these components; without it the
  // JSX compiles to React.createElement with no React in scope.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{js,jsx}'],
  },
});
