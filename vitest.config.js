import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Continue running all tests even when failures occur
    bail: 0, // 0 = don't bail, run all tests
    // Better error reporting - show all failures
    reporter: ['verbose', 'json', 'html'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.test.js',
        '**/*.spec.js',
        '*.config.js',
        'wrangler*.toml'
      ]
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // Don't exit on unhandled errors - continue running
    passWithNoTests: true,
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js']
  }
});
