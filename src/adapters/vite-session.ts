import type * as Vite from 'vite';

import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { TaskContext } from '../executor/types.js';
import type { BuildRequest, ViteApi } from './vite-config.js';
import type { ViteAdapterOptions, ViteEnvironmentOptions, ViteOutput } from './vite.js';

import {
  buildSettings,
  configCandidates,
  configInputs,
  configureVite,
  loadProject,
  withViteEnv,
} from './vite-config.js';

export interface ViteBuildReport {
  readonly available: readonly string[];
  readonly environments: readonly string[];
  readonly outputs: readonly ViteOutput[];
}

type Outcome<T> =
  | { readonly error: unknown; readonly status: 'failed' }
  | { readonly result: T; readonly status: 'success' };

export function checkEnvironment(name: string, available: readonly string[], option: string) {
  if (!available.includes(name)) {
    throw Object.assign(
      new Error(
        `Unknown Vite environment "${name}" in ${option}. Available: ${available.join(', ')}`,
      ),
      { code: 'VITE_UNKNOWN_ENVIRONMENT' },
    );
  }
}

export async function createViteSession(
  vite: ViteApi,
  request: BuildRequest,
  extensions: ViteAdapterOptions = {},
  context?: TaskContext,
) {
  const { artifacts, environmentOptions, environments, outputs } = buildSettings(vite, request);
  const written = new Map<string, ViteOutput>();
  let activeLogger = context?.logger;
  const dependencies = new Set(configCandidates(request));
  const collector: Vite.Plugin = {
    name: 'build-matrix:outputs',
    writeBundle: {
      async handler({ dir, file, sourcemap }, bundle) {
        const { config, name } = this.environment;
        const cwd = config.build.rolldownOptions.cwd ?? request.cwd;
        const directory = resolve(cwd, dir ?? resolve(config.root, config.build.outDir));
        const record = (path: string, kind: 'directory' | 'file') =>
          written.set(`${name}\0${path}`, { environment: name, kind, path });
        if (file !== undefined) {
          record(resolve(cwd, file), 'file');
        } else if (artifacts === 'directories') {
          record(directory, 'directory');
        }
        if (artifacts === 'files') {
          for (const output of Object.values(bundle)) {
            record(resolve(directory, output.fileName), 'file');
            if (
              output.type === 'chunk' &&
              sourcemap &&
              sourcemap !== 'inline' &&
              output.sourcemapFileName
            ) {
              record(resolve(directory, output.sourcemapFileName), 'file');
            }
          }
          if (config.build.copyPublicDir && config.publicDir) {
            const entries = await readdir(config.publicDir, {
              recursive: true,
              withFileTypes: true,
            }).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') {
                return [];
              }
              throw error;
            });
            for (const entry of entries) {
              if (entry.isFile()) {
                const path = relative(config.publicDir, resolve(entry.parentPath, entry.name));
                record(resolve(directory, path), 'file');
              }
            }
          }
        }
      },
      order: 'post',
      sequential: true,
    },
  };

  async function createBuilder(
    environment?: string,
    overrides?: ViteEnvironmentOptions,
    projectFile?: false | string,
  ) {
    const project = await loadProject(vite, request, overrides, projectFile);
    const config = { ...(await configureVite(project.config, extensions, context, environment)) };
    config.root = resolve(request.cwd, config.root ?? '.');
    for (const path of [...project.dependencies, ...configInputs(config)]) {
      dependencies.add(path);
    }
    if (activeLogger !== undefined && config.customLogger === undefined) {
      config.customLogger = vite.createLogger(config.logLevel, {
        allowClearScreen: false,
        console: {
          ...console,
          error: (message) => activeLogger?.error(message),
          log: (message) => activeLogger?.info(message),
          warn: (message) => activeLogger?.error(message),
        },
      });
      // The native build reporter can print progress directly to stdout.
      config.logLevel ??= 'warn';
    }
    const provenance: Vite.Plugin = {
      configResolved: {
        handler(resolved) {
          Object.assign(resolved, {
            configFile: project.projectFile || undefined,
            configFileDependencies: [...new Set(project.dependencies)],
          });
          for (const path of configInputs(resolved)) {
            dependencies.add(path);
          }
        },
        order: 'pre',
      },
      enforce: 'pre',
      name: 'build-matrix:config-file',
    };
    const inline = vite.mergeConfig({ build: { rolldownOptions: { cwd: request.cwd } } }, config);
    const builder = await vite.createBuilder(
      {
        ...inline,
        configFile: false,
        plugins: [provenance, ...(config.plugins ?? []), ...(extensions.plugins ?? []), collector],
      },
      environments === undefined && environment === undefined ? null : false,
    );
    builder.config.build.watch = null;
    for (const environment of Object.values(builder.environments)) {
      environment.config.build.watch = null;
    }
    return { builder, projectFile: project.projectFile };
  }

  const main = await withViteEnv(() => createBuilder());
  const { builder } = main;
  const available = Object.keys(builder.environments);
  const declared = Object.keys(builder.config.environments);
  const selected = environments === 'all' ? undefined : environments;
  for (const name of selected ?? []) {
    checkEnvironment(name, available, 'vite options.environments');
  }
  for (const { environment } of outputs ?? []) {
    if (environment !== undefined) {
      checkEnvironment(environment, declared, 'vite options.outputs');
    }
  }
  const variants = new Map<string, Vite.ViteBuilder>();
  for (const [name, overrides] of Object.entries(environmentOptions)) {
    if (
      !available.includes(name) ||
      (selected !== undefined && !selected.includes(name)) ||
      (overrides.root === undefined && overrides.mode === undefined)
    ) {
      continue;
    }
    const variant = await withViteEnv(() => createBuilder(name, overrides, main.projectFile));
    checkEnvironment(
      name,
      Object.keys(variant.builder.environments),
      'vite options.environmentOptions',
    );
    builder.environments[name] = variant.builder.environments[name];
    variants.set(name, variant.builder);
  }
  const build = builder.build.bind(builder);

  activeLogger = undefined;
  return {
    async build(context?: TaskContext): Promise<ViteBuildReport> {
      activeLogger = context?.logger;
      process.env.NODE_ENV ??= builder.config.isProduction ? 'production' : 'development';
      written.clear();
      for (const environment of Object.values(builder.environments)) {
        environment.isBuilt = false;
      }
      const pending: Promise<unknown>[] = [];
      builder.build = (environment) => {
        const name = environment.name;
        const variant = variants.get(name);
        const work = async () => {
          context?.signal.throwIfAborted();
          const result = await (variant ? variant.build(environment) : build(environment));
          context?.signal.throwIfAborted();
          return result;
        };
        const events = context === undefined ? undefined : { ...context, environment: name };
        const next =
          events === undefined
            ? work()
            : withBuildHooks(
                () => extensions.onEnvironmentStart?.(events),
                (outcome) => extensions.onEnvironmentEnd?.({ ...events, ...outcome }),
                work,
              );
        pending.push(next);
        void next.catch(() => {});
        return next;
      };
      try {
        if (selected === undefined) {
          await builder.buildApp();
          if (environments === 'all') {
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
        await Promise.all(pending);
        return {
          available: declared,
          environments: Object.values(builder.environments)
            .filter(({ isBuilt }) => isBuilt)
            .map(({ name }) => name),
          outputs: [...written.values()],
        };
      } finally {
        await Promise.allSettled(pending);
        builder.build = build;
        activeLogger = undefined;
      }
    },
    dependencies: [...dependencies],
  };
}

export async function withBuildHooks<T>(
  start: () => Promise<void> | void,
  end: (outcome: Outcome<T>) => Promise<void> | void,
  work: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    await start();
    result = await work();
  } catch (error) {
    try {
      await end({ error, status: 'failed' });
    } catch (hookError) {
      throw new AggregateError([error, hookError], 'Vite build and its end hook failed', {
        cause: error,
      });
    }
    throw error;
  }
  await end({ result, status: 'success' });
  return result;
}
