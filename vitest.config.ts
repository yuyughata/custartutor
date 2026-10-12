import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.tsx',
      'apps/admin/src/**/*.test.ts',
      'apps/admin/src/**/*.test.tsx',
      'apps/learner/src/**/*.test.ts',
      'apps/learner/src/**/*.test.tsx',
      'scripts/**/*.test.mjs',
      'supabase/functions/_shared/**/*.test.ts',
    ],
    environment: 'node',
  },
});
