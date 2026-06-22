import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root-level config: projects are discovered per-package via their own vitest configs.
    // Individual packages define their own test entries; this root config is used for
    // running tests that don't belong to a specific package (e.g., smoke tests).
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
});
