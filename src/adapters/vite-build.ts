import type * as Vite from 'vite';

import { json } from 'node:stream/consumers';

import type { ViteOptions } from './vite.js';

const [, , viteUrl] = process.argv;
const { outDir, viteConfig, ...options } = (await json(process.stdin)) as ViteOptions;
const { createBuilder, mergeConfig } = (await import(viteUrl)) as typeof Vite;
const overrides = outDir === undefined ? options : { ...options, build: { outDir } };
const builder = await createBuilder(mergeConfig(viteConfig ?? {}, overrides), null);

// An invocation is a single build even when the project enables Vite watch mode.
builder.config.build.watch = null;
for (const environment of Object.values(builder.environments)) {
  environment.config.build.watch = null;
}
await builder.buildApp();
