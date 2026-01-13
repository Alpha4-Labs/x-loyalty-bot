import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
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
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js']
  }
});
