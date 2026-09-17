// Vitest configuration for Phase 1 unit tests.
// Pure-Node environment so we can import daemon CommonJS modules directly.
// `deps.inline` forces Vite to skip dep-pre-bundling for `electron`, which is
// needed so per-test `vi.mock('electron', ...)` factories take effect.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/playwright/**', 'node_modules/**'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reporter: ['text'],
      include: ['src/main/**/*.{ts,tsx}', 'src/shared/**/*.ts', 'daemon/**/*.cjs'],
    },
    server: {
      deps: {
        inline: [/electron/],
      },
    },
    deps: {
      optimizer: {
        ssr: { include: [] },
        web: { include: [] },
      },
    },
  },
});
