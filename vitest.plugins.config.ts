/**
 * Vitest config for running plugin tests.
 * Plugin tests import from @covel/* workspace packages.
 *
 * Usage: pnpm vitest run --config vitest.plugins.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins-v2/**/tests/**/*.test.ts'],
  },
});
