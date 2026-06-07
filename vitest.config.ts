import { defineConfig } from 'vitest/config';

// The source uses ESM ".js" import specifiers (NodeNext/Bundler style) that point
// at sibling ".ts" files. Vitest resolves TS natively; we add a resolver alias so
// the same specifiers used by the published build also work under test.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Fake timers are opt-in per-test via vi.useFakeTimers().
    clearMocks: true,
  },
});
