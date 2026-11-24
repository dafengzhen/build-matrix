import type * as Vite from 'vite';

import { resolve } from 'node:path';

import type { JsonObject } from '../core/types.js';
import type { ViteEnvironmentOptions, ViteOptions, ViteOutput } from './vite.js';

import {
  asArray,
  asNonemptyString,
  asPath,
  asRecord,
  checkKeys,
  copyJson,
  invalid,
} from '../core/validation.js';

export interface BuildRequest {
  readonly cwd: string;
  readonly defaults: ViteOptions;
  readonly task: ViteOptions;
}

export interface BuildSettings {
  readonly artifacts: 'directories' | 'files';
  readonly environmentOptions: Readonly<Record<string, ViteEnvironmentOptions>>;
  readonly environments?: 'all' | readonly string[];
  readonly outputs?: readonly ViteOutput[];
}

export type ViteApi = typeof Vite;

const viteConfigFiles = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'].map(
  (extension) => `vite.config.${extension}`,
);
const viteEnvironmentVariables = ['NODE_ENV', 'VITE_USER_NODE_ENV', 'BROWSER', 'BROWSER_ARGS'];

export function buildSettings(vite: ViteApi, { defaults, task }: BuildRequest): BuildSettings {
  const options = { ...defaults, ...task };
  return {
    artifacts: options.artifacts ?? 'directories',
    environmentOptions: vite.mergeConfig(
      defaults.environmentOptions ?? {},
      task.environmentOptions ?? {},
    ),
    environments:
      options.environments === 'all' || options.environments === undefined
        ? options.environments
        : typeof options.environments === 'string'
          ? [options.environments]
          : options.environments,
    outputs: options.outputs,
  };
}

export function configCandidates({ cwd, defaults, task }: BuildRequest): string[] {
  const file =
    task.configFile ??
    defaults.configFile ??
    task.viteConfig?.configFile ??
    defaults.viteConfig?.configFile;
  if (file === false) {
    return [];
  }
  if (file !== undefined) {
    return [resolve(cwd, asPath(file, 'vite options configFile'))];
  }
  const root = viteRoot({ cwd, defaults, task });
  return viteConfigFiles.map((name) => resolve(root, name));
}

export function configInputs(
  config: Pick<Vite.InlineConfig, 'envDir' | 'mode' | 'root'>,
): string[] {
  if (config.envDir === false || config.root === undefined) {
    return [];
  }
  const mode = config.mode || 'production';
  const root = resolve(config.root, config.envDir ?? '.');
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map((name) =>
    resolve(root, name),
  );
}

export async function inspectVite(vite: ViteApi, request: BuildRequest): Promise<string[]> {
  const { config, dependencies, projectFile } = await withViteEnv(() => loadProject(vite, request));
  const settings = buildSettings(vite, request);
  const inputs = [
    ...configCandidates(request),
    ...dependencies,
    ...configInputs(config),
    ...publicInputs(config),
  ];
  for (const [name, environment] of Object.entries(settings.environmentOptions)) {
    if (Array.isArray(settings.environments) && !settings.environments.includes(name)) {
      continue;
    }
    if (environment.root === undefined && environment.mode === undefined) {
      continue;
    }
    const project = await withViteEnv(() => loadProject(vite, request, environment, projectFile));
    inputs.push(
      ...project.dependencies,
      ...configInputs(project.config),
      ...publicInputs(project.config),
    );
  }
  return [...new Set(inputs)];
}

export async function loadProject(
  vite: ViteApi,
  request: BuildRequest,
  environment?: ViteEnvironmentOptions,
  projectFile?: false | string,
  configure?: (config: Vite.InlineConfig) => Promise<Vite.InlineConfig>,
) {
  const { cwd, defaults, task } = request;
  const inline = vite.mergeConfig(
    vite.mergeConfig(layer(vite, defaults, cwd), layer(vite, task, cwd)),
    layer(
      vite,
      {
        configFile: task.configFile ?? defaults.configFile,
        mode: task.mode ?? defaults.mode,
        outDir: task.outDir ?? defaults.outDir,
        root: task.root ?? defaults.root,
      },
      cwd,
    ),
  ) as Vite.InlineConfig;
  const defaultsAndTask: Vite.InlineConfig = {
    ...inline,
    ...(environment?.mode === undefined ? {} : { mode: environment.mode }),
    ...(environment?.root === undefined ? {} : { root: resolve(cwd, environment.root) }),
  };
  const overrides = (await configure?.(defaultsAndTask)) ?? defaultsAndTask;
  if (overrides.configFile) {
    overrides.configFile = resolve(cwd, overrides.configFile);
  }
  const file = projectFile ?? overrides.configFile;
  const searchRoot = resolve(cwd, overrides.root ?? viteRoot(request));
  const implicitNodeEnv = process.env.NODE_ENV === undefined;
  let project;
  if (file !== false) {
    process.env.NODE_ENV ??= 'production';
    try {
      project = await vite.loadConfigFromFile(
        {
          command: 'build',
          isPreview: false,
          isSsrBuild: Boolean(overrides.build?.ssr),
          mode: overrides.mode || 'production',
        },
        file,
        searchRoot,
        overrides.logLevel,
        overrides.customLogger,
        overrides.configLoader,
      );
    } finally {
      if (implicitNodeEnv && process.env.NODE_ENV === 'production') {
        delete process.env.NODE_ENV;
      }
    }
  }
  const config = vite.mergeConfig(
    vite.mergeConfig({ root: cwd }, project?.config ?? {}),
    overrides,
  ) as Vite.InlineConfig;
  config.root = resolve(cwd, config.root ?? '.');
  return {
    config,
    dependencies: project ? [project.path, ...project.dependencies] : [],
    projectFile: project?.path ?? (false as const),
  };
}

export function publicInputs(
  config: Pick<Vite.InlineConfig, 'build' | 'publicDir' | 'root'>,
): string[] {
  if (
    config.root === undefined ||
    config.publicDir === false ||
    config.publicDir === '' ||
    config.build?.copyPublicDir === false
  ) {
    return [];
  }
  return [resolve(config.root, config.publicDir ?? 'public')];
}

export function readOptions(value: unknown, label: string): ViteOptions {
  if (value === undefined) {
    return {};
  }
  const options = asRecord(value, label);
  checkKeys(options, label, [
    'artifacts',
    'builder',
    'configFile',
    'environmentOptions',
    'environments',
    'execution',
    'mode',
    'outDir',
    'outputs',
    'root',
    'viteConfig',
  ]);
  const {
    artifacts,
    builder,
    configFile,
    environmentOptions,
    environments,
    execution,
    mode,
    outDir,
    outputs,
    root,
    viteConfig,
  } = options;
  for (const [key, value, choices] of [
    ['artifacts', artifacts, ['directories', 'files']],
    ['builder', builder, ['once', 'reuse']],
    ['execution', execution, ['in-process', 'process']],
  ] as const) {
    if (value !== undefined && !choices.some((choice) => choice === value)) {
      invalid(`${label}.${key}`, `expected ${choices.join(' or ')}`);
    }
  }
  return {
    ...(artifacts === undefined ? {} : { artifacts: artifacts as ViteOptions['artifacts'] }),
    ...(builder === undefined ? {} : { builder: builder as ViteOptions['builder'] }),
    ...(configFile === undefined
      ? {}
      : { configFile: configFile === false ? false : asPath(configFile, `${label}.configFile`) }),
    ...(environmentOptions === undefined
      ? {}
      : {
          environmentOptions: readEnvironmentOptions(
            environmentOptions,
            `${label}.environmentOptions`,
          ),
        }),
    ...(environments === undefined
      ? {}
      : { environments: readEnvironments(environments, `${label}.environments`) }),
    ...(execution === undefined ? {} : { execution: execution as ViteOptions['execution'] }),
    ...(mode === undefined ? {} : { mode: asNonemptyString(mode, `${label}.mode`) }),
    ...(outDir === undefined ? {} : { outDir: asPath(outDir, `${label}.outDir`) }),
    ...(outputs === undefined ? {} : { outputs: readOutputs(outputs, `${label}.outputs`) }),
    ...(root === undefined ? {} : { root: asPath(root, `${label}.root`) }),
    ...(viteConfig === undefined
      ? {}
      : { viteConfig: jsonObject(viteConfig, `${label}.viteConfig`) }),
  };
}

export function readOutputs(value: unknown, label: string): readonly ViteOutput[] {
  return asArray(value, label).map((item, index) => {
    const field = `${label}[${index}]`;
    const entry = asRecord(item, field);
    checkKeys(entry, field, ['environment', 'kind', 'path', 'sha256', 'sizeBytes']);
    const { environment, kind, path, sha256, sizeBytes } = entry;
    if (kind !== undefined && kind !== 'file' && kind !== 'directory') {
      invalid(`${field}.kind`, 'expected "file" or "directory"');
    }
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[\da-f]{64}$/.test(sha256))) {
      invalid(`${field}.sha256`, 'expected a lowercase SHA-256 digest');
    }
    if (
      sizeBytes !== undefined &&
      (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    ) {
      invalid(`${field}.sizeBytes`, 'expected a nonnegative safe integer');
    }
    return {
      ...(environment === undefined
        ? {}
        : { environment: asNonemptyString(environment, `${field}.environment`) }),
      ...(kind === undefined ? {} : { kind }),
      path: asPath(path, `${field}.path`),
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
  });
}

export function viteRoot({ cwd, defaults, task }: BuildRequest): string {
  const root = task.root ?? defaults.root ?? task.viteConfig?.root ?? defaults.viteConfig?.root;
  return root === undefined ? cwd : resolve(cwd, asPath(root, 'vite options root'));
}

export async function withViteEnv<T>(work: () => Promise<T>): Promise<T> {
  const saved = viteEnvironmentVariables.map((key) => [key, process.env[key]] as const);
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function jsonObject(value: unknown, label: string): JsonObject {
  return copyJson(asRecord(value, label), label) as JsonObject;
}

function layer(
  vite: ViteApi,
  { configFile, environmentOptions, mode, outDir, root, viteConfig }: ViteOptions,
  cwd: string,
): Vite.InlineConfig {
  const config = structuredClone(viteConfig ?? {}) as Vite.InlineConfig;
  if (root !== undefined) {
    config.root = root;
  }
  if (config.root !== undefined) {
    config.root = resolve(cwd, asPath(config.root, 'vite options root'));
  }
  if (mode !== undefined) {
    config.mode = mode;
  }
  if (configFile !== undefined) {
    config.configFile = configFile;
  }
  if (config.configFile !== undefined && config.configFile !== false) {
    config.configFile = resolve(cwd, asPath(config.configFile, 'vite options configFile'));
  }
  if (outDir !== undefined) {
    config.build = { ...config.build, outDir: resolve(cwd, outDir) };
  }
  if (environmentOptions !== undefined) {
    const environments = Object.fromEntries(
      Object.entries(environmentOptions).map(([name, settings]) => [
        name,
        {
          ...structuredClone(settings.config),
          build: {
            ...vite.mergeConfig(
              typeof settings.config?.build === 'object' &&
                settings.config.build !== null &&
                !Array.isArray(settings.config.build)
                ? settings.config.build
                : {},
              settings.build ?? {},
            ),
            ...(settings.outDir === undefined ? {} : { outDir: resolve(cwd, settings.outDir) }),
          },
        },
      ]),
    );
    return vite.mergeConfig(config, { environments }) as Vite.InlineConfig;
  }
  return config;
}

function readEnvironmentOptions(
  value: unknown,
  label: string,
): Readonly<Record<string, ViteEnvironmentOptions>> {
  return Object.fromEntries(
    Object.entries(asRecord(value, label)).map(([name, options]) => {
      asNonemptyString(name, label);
      const path = `${label}.${name}`;
      const entry = asRecord(options, path);
      checkKeys(entry, path, ['build', 'config', 'mode', 'outDir', 'root']);
      return [
        name,
        {
          ...(entry.build === undefined ? {} : { build: jsonObject(entry.build, `${path}.build`) }),
          ...(entry.config === undefined
            ? {}
            : { config: jsonObject(entry.config, `${path}.config`) }),
          ...(entry.mode === undefined
            ? {}
            : { mode: asNonemptyString(entry.mode, `${path}.mode`) }),
          ...(entry.outDir === undefined ? {} : { outDir: asPath(entry.outDir, `${path}.outDir`) }),
          ...(entry.root === undefined ? {} : { root: asPath(entry.root, `${path}.root`) }),
        },
      ];
    }),
  );
}

function readEnvironments(value: unknown, label: string): 'all' | readonly string[] {
  if (value === 'all') {
    return value;
  }
  if (typeof value === 'string') {
    return [asNonemptyString(value, label)];
  }
  const names = asArray(value, label).map((name, index) =>
    asNonemptyString(name, `${label}[${index}]`),
  );
  if (names.length === 0) {
    invalid(label, 'expected at least one environment name');
  }
  return [...new Set(names)];
}
