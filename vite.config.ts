import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        'adapters/clean': 'src/adapters/clean.ts',
        'adapters/shell': 'src/adapters/shell.ts',
        'adapters/vite': 'src/adapters/vite.ts',
        'adapters/vite-build': 'src/adapters/vite-build.ts',
        'cli/bin': 'src/cli/bin.ts',
        'cli/index': 'src/cli/index.ts',
        'executor/index': 'src/executor/index.ts',
        index: 'src/index.ts',
      },
      formats: ['es'],
    },
    rolldownOptions: {
      external: [/^node:/, 'vite'],
      platform: 'node',
    },
    sourcemap: true,
    target: 'node26',
  },
  logLevel: 'warn',
});
