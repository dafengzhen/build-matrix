import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['dist/**/*.js'],
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
    },
    dir: 'src',
    environment: 'node',
  },
});
