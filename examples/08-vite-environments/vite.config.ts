import { defineConfig } from 'vite';

export default defineConfig({
  environments: {
    client: {
      build: { outDir: 'dist/client' },
    },
    ssr: {
      build: {
        outDir: 'dist/server',
        rolldownOptions: { output: { entryFileNames: 'render.js' } },
        ssr: 'render.ts',
      },
    },
  },
});
