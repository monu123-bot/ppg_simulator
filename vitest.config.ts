import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The validation suite simulates minutes of physiology per case — several
    // of them run a full session across every activity in the catalogue.
    // The default five seconds is a limit on the harness, not on the code.
    testTimeout: 120_000,
  },
});
