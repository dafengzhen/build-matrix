import type * as Vite from 'vite';

import { readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { AdapterContext, TaskContext } from '../executor/types.js';
import type { BuildRequest, ViteApi } from './vite-config.js';
import type {
  ViteAdapterOptions,
  ViteConfigureContext,
  ViteEnvironmentOptions,
  ViteOutput,
} from './vite.js';

import {
  buildSettings,
  configCandidates,
  configInputs,
  loadProject,
  publicInputs,
  withViteEnv,
} from './vite-config.js';

export interface ViteBuildReport {
  readonly available: readonly string[];
  readonly environments: readonly string[];
  readonly inputs: readonly string[];
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
  const inputs = new Set<string>();
  const publicDirectories = new Set<string>();
  const cleanups: (() => Promise<void> | void)[] = [];
  let disposed = false;
  async function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    cleanups.length = 0;
    if (errors.length) {
      throw new AggregateError(errors, 'Vite builder disposal failed');
    }
  }
  function configureContext(environment?: string): undefined | ViteConfigureContext {
    if (context === undefined) {
      return undefined;
    }
    return {
      ...context,
      environment,
      onDispose(cleanup) {
        cleanups.push(cleanup);
      },
      async trackInputs(paths, timing) {
        for (const path of paths) {
          dependencies.add(resolve(request.cwd, path));
        }
        await context.trackInputs?.(paths, timing);
      },
    };
  }
  const collector: Vite.Plugin = {
    buildEnd: {
      handler() {
        for (const id of this.getModuleIds()) {
          const path = id.split('?', 1)[0];
          if (isAbsolute(path) && !path.includes('\0')) {
            inputs.add(path);
          }
        }
      },
      order: 'post',
    },
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
    const configure = configureContext(environment);
    const project = await loadProject(vite, request, overrides, projectFile, async (config) => {
      const updated =
        configure === undefined
          ? config
          : ((await extensions.beforeConfig?.(config, configure)) ?? config);
      if (projectFile === undefined && updated.configFile !== false) {
        for (const path of configCandidates({
          cwd: request.cwd,
          defaults: {},
          task: { configFile: updated.configFile, root: updated.root },
        })) {
          dependencies.add(path);
        }
      }
      return updated;
    });
    const config = {
      ...(configure === undefined
        ? project.config
        : ((await extensions.configure?.(project.config, configure)) ?? project.config)),
    };
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
      async configEnvironment(name, settings) {
        const environmentContext = configureContext(name);
        if (environmentContext !== undefined) {
          return extensions.configureEnvironment?.(settings, {
            ...environmentContext,
            environment: name,
          });
        }
      },
      configResolved: {
        async handler(resolved) {
          Object.assign(resolved, {
            configFile: project.projectFile || undefined,
            configFileDependencies: [...new Set(project.dependencies)],
          });
          for (const path of configInputs(resolved)) {
            dependencies.add(path);
          }
          if (configure !== undefined) {
            await extensions.resolvedConfig?.(resolved, configure);
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
        plugins: [
          provenance,
          ...(config.plugins ?? []).map((plugin) => trackPluginInputs(plugin, addInput)),
          ...(extensions.plugins ?? []).map((plugin) => trackPluginInputs(plugin, addInput)),
          ...(extensions.environmentPlugins === undefined
            ? []
            : [
                vite.perEnvironmentPlugin('build-matrix:environment-plugins', ({ name }) =>
                  Object.hasOwn(extensions.environmentPlugins!, name)
                    ? trackPluginInputs(extensions.environmentPlugins![name], addInput)
                    : undefined,
                ),
              ]),
          collector,
        ],
      },
      environments === undefined && environment === undefined ? null : false,
    );
    builder.config.build.watch = null;
    for (const environment of Object.values(builder.environments)) {
      environment.config.build.watch = null;
      for (const path of publicInputs(environment.config)) {
        publicDirectories.add(path);
      }
    }
    return { builder, projectFile: project.projectFile };
  }

  function addInput(id: string, cwd: string) {
    if (!id.includes('\0')) {
      inputs.add(resolve(cwd, id));
    }
  }

  try {
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
        if (disposed) {
          throw new Error('Vite builder has been disposed');
        }
        activeLogger = context?.logger;
        process.env.NODE_ENV ??= builder.config.isProduction ? 'production' : 'development';
        written.clear();
        inputs.clear();
        for (const environment of Object.values(builder.environments)) {
          environment.isBuilt = false;
        }
        const pending: Promise<unknown>[] = [];
        builder.build = (environment) => {
          const name = environment.name;
          const variant = variants.get(name);
          const work = async () => {
            context?.signal.throwIfAborted();
            const artifacts = (context as Partial<AdapterContext> | undefined)?.artifacts;
            if (artifacts !== undefined && environment.config.build.write) {
              const { outDir, rolldownOptions } = environment.config.build;
              const output = rolldownOptions.output;
              for (const settings of Array.isArray(output) ? output : [output]) {
                await artifacts.reserve(
                  settings?.file === undefined
                    ? resolve(environment.config.root, settings?.dir ?? outDir)
                    : resolve(rolldownOptions.cwd ?? request.cwd, settings.file),
                );
              }
            }
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
            inputs: [...new Set([...dependencies, ...publicDirectories, ...inputs])],
            outputs: [...written.values()],
          };
        } finally {
          await Promise.allSettled(pending);
          builder.build = build;
          activeLogger = undefined;
          await context?.trackInputs?.([...inputs], { late: true });
        }
      },
      dependencies: [...dependencies],
      dispose,
      preparedInputs: [...dependencies, ...publicDirectories],
    };
  } catch (error) {
    await dispose().catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], 'Vite builder creation and disposal failed');
    });
    throw error;
  }
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

function trackPluginInputs(
  option: Vite.PluginOption,
  add: (path: string, cwd: string) => void,
): Vite.PluginOption {
  if (!option) {
    return option;
  }
  if (Array.isArray(option)) {
    return option.map((entry) => trackPluginInputs(entry, add));
  }
  if (option instanceof Promise) {
    return option.then((entry) => trackPluginInputs(entry, add));
  }
  const source = option as Vite.Plugin;
  const plugin = { ...source };
  const hooks = [
    'augmentChunkHash',
    'buildEnd',
    'buildStart',
    'closeBundle',
    'generateBundle',
    'load',
    'moduleParsed',
    'renderChunk',
    'renderError',
    'renderStart',
    'resolveDynamicImport',
    'resolveId',
    'transform',
    'writeBundle',
  ] as const;
  for (const key of hooks) {
    const hook = plugin[key];
    if (hook === undefined) {
      continue;
    }
    const original = typeof hook === 'function' ? hook : hook.handler;
    const handler = function (
      this: { addWatchFile?(id: string): void; environment?: Vite.BuildEnvironment },
      ...args: unknown[]
    ) {
      const context = new Proxy(this, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (
            property === 'addWatchFile' &&
            typeof value === 'function' &&
            target.environment !== undefined
          ) {
            const { config } = target.environment;
            return (path: string) => {
              add(path, config.build.rolldownOptions.cwd ?? config.root);
              return Reflect.apply(value, target, [path]);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return Reflect.apply(original, context, args);
    };
    Object.assign(plugin, { [key]: typeof hook === 'function' ? handler : { ...hook, handler } });
  }
  const apply = source.applyToEnvironment;
  if (apply !== undefined) {
    plugin.applyToEnvironment = (environment) =>
      Promise.resolve(apply.call(source, environment)).then((result) =>
        typeof result === 'boolean' ? result : trackPluginInputs(result, add),
      ) as ReturnType<typeof apply>;
  }
  return plugin;
}
