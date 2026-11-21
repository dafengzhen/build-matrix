import type * as Vite from 'vite';

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { json } from 'node:stream/consumers';

import type { ViteBuildReport, ViteOptions, ViteOutput } from './vite.js';

const [, , viteUrl, reportPath] = process.argv;
const { environments, outDir, outputs, viteConfig, ...options } = (await json(process.stdin)) as {
  environments?: 'all' | readonly string[];
} & Omit<ViteOptions, 'environments'>;
const { createBuilder, mergeConfig } = (await import(viteUrl)) as typeof Vite;
const written = new Map<string, ViteOutput>();
const collector: Vite.Plugin = {
  name: 'build-matrix:outputs',
  writeBundle({ dir, file }) {
    const { config, name: environment } = this.environment;
    const cwd = config.build.rolldownOptions.cwd ?? process.cwd();
    const path = resolve(cwd, file ?? dir ?? resolve(config.root, config.build.outDir));
    written.set(`${environment}\0${path}`, {
      environment,
      kind: file === undefined ? 'directory' : 'file',
      path,
    });
  },
};
const config = mergeConfig(viteConfig ?? {}, {
  ...options,
  ...(outDir === undefined ? {} : { build: { outDir } }),
  plugins: [collector],
});
const builder = await createBuilder(config, environments === undefined ? null : false);
const report = await build();
await writeFile(reportPath, JSON.stringify(report));

async function build(): Promise<ViteBuildReport> {
  const selected = environments === 'all' ? undefined : environments;
  const available = Object.keys(builder.environments);
  const declared = Object.keys(builder.config.environments);
  const unknown = selected?.find((name) => !Object.hasOwn(builder.environments, name));
  if (unknown !== undefined) {
    return {
      error: `Unknown Vite environment "${unknown}" in vite options.environments. Available: ${available.join(', ')}`,
    };
  }
  for (const { environment } of outputs ?? []) {
    if (environment !== undefined && !Object.hasOwn(builder.config.environments, environment)) {
      return {
        error: `Unknown Vite environment "${environment}" in vite options.outputs. Available: ${declared.join(', ')}`,
      };
    }
  }

  // An invocation is a single build even when the project enables Vite watch mode.
  builder.config.build.watch = null;
  for (const environment of Object.values(builder.environments)) {
    environment.config.build.watch = null;
  }
  if (selected === undefined) {
    await builder.buildApp();
    if (environments === 'all') {
      // Vite's project hooks can choose to build only a subset in app mode.
      for (const environment of Object.values(builder.environments)) {
        if (!environment.isBuilt) {
          await builder.build(environment);
        }
      }
    }
  } else {
    for (const name of selected) {
      await builder.build(builder.environments[name]);
    }
  }
  return {
    environments: Object.values(builder.environments)
      .filter(({ isBuilt }) => isBuilt)
      .map(({ name }) => name),
    outputs: [...written.values()],
  };
}
