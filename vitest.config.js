import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // playwright.js has no runtime import of @playwright/test; it's exercised
      // indirectly via a stub in the fixture test.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
