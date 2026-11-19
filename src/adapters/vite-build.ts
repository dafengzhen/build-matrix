import type * as Vite from 'vite';

import type { ViteOptions } from './vite.js';

const [, , viteUrl, config] = process.argv;
const { outDir, ...options } = JSON.parse(config) as ViteOptions;
const { createBuilder } = (await import(viteUrl)) as typeof Vite;
const builder = await createBuilder({ ...options, build: { outDir } }, null);

// An invocation is a single build even when the project enables Vite watch mode.
builder.config.build.watch = null;
for (const environment of Object.values(builder.environments)) {
  environment.config.build.watch = null;
}
await builder.buildApp();
