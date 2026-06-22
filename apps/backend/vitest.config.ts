import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.int.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
