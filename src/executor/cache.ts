import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { JsonValue, TaskCacheDefinition } from '../core/types.js';
import type { CacheBackend } from './cache-backend.js';
import type { PathKind } from './fingerprint.js';
import type { AdapterContext, AdapterOutput, Artifact, TaskContext } from './types.js';

import { renderTemplate } from '../core/template.js';
import { invalid } from '../core/validation.js';
import { restoreCacheOutputs, snapshotCacheOutputs } from './cache-backend.js';
import {
  fingerprintInputFiles,
  fingerprintPaths,
  isFileError,
  statWorkspacePath,
} from './fingerprint.js';
import { writeJsonFile } from './json-file.js';
import { normalizeOutput } from './result.js';

const schemaVersion = 1;
export const defaultCacheDirectory = '.build-matrix-cache';

export interface CacheOptions {
  readonly backend?: CacheBackend;
  readonly directory?: string;
  /** Add a custom component to the cache fingerprint. */
  fingerprint?(
    context: AdapterContext,
    components: Readonly<Record<string, string>>,
  ): Promise<string> | string;
}

export interface PreparedCache extends TaskCacheDefinition {
  readonly additionalKey?: string;
  readonly dependencyPaths?: readonly string[];
  readonly directory?: string;
  readonly inputFiles?: readonly string[];
  readonly label: string;
  readonly settings?: CacheOptions;
}

interface CacheEntry {
  readonly key: string;
  readonly outputs: string;
  readonly result: AdapterOutput;
  readonly schemaVersion: typeof schemaVersion;
}

interface CacheProbe {
  readonly components: Readonly<Record<string, string>>;
  readonly file: string;
  readonly hit?: AdapterOutput;
  readonly key: string;
  readonly miss?: readonly string[];
  readonly root: string;
}

interface CacheState {
  readonly components?: Readonly<Record<string, string>>;
  readonly inputs?: readonly string[];
}

export async function cacheProbeIsCurrent(
  cache: PreparedCache,
  probe: CacheProbe,
  context: AdapterContext,
  adapter: string,
  options: JsonValue | undefined,
): Promise<boolean> {
  return (await taskKey(cache, probe.root, context, adapter, options))?.key === probe.key;
}

export function cacheStateDirectory(directory: string): string {
  return join(dirname(directory), `.${basename(directory).replace(/^\./, '')}-state`);
}

export function cacheStatePath(
  cache: PreparedCache,
  context: TaskContext,
  identity: string,
): string | undefined {
  return cache.directory === undefined
    ? undefined
    : join(
        cacheStateDirectory(cache.directory),
        `${digest([context.cwd, context.stageId, context.taskId, context.variant?.id, identity])}.json`,
      );
}

export function coversOutputPath(outputs: readonly string[], path: string): boolean {
  const local = comparable(path);
  return outputs.some((output) => {
    const boundary = comparable(output);
    return local === boundary || local.startsWith(boundary + sep);
  });
}

export function prepareCache(
  definition: TaskCacheDefinition,
  directory: string | undefined,
  { cwd, stageId, taskId, variant }: TaskContext,
): PreparedCache {
  const variantLabel = variant === undefined ? '' : ` (${variant.id})`;
  const label = `stage "${stageId}", task "${taskId}"${variantLabel}.cache`;
  const paths = (field: 'inputs' | 'outputs') => {
    const entries = definition[field].map((template, index) => {
      const path = `${label}.${field}[${index}]`;
      const value = renderTemplate(template, variant?.values ?? {}, path);
      const absolute = resolve(cwd, value);
      const local = relative(cwd, absolute);
      if (value.includes('\0') || parse(value).root !== '' || !insideWorkspace(local)) {
        invalid(path, 'expected a relative path inside cwd');
      }
      if (
        process.platform === 'win32' &&
        local.split(sep).some((segment) => /:|[ .]$/.test(segment))
      ) {
        invalid(path, 'invalid Windows path segment');
      }
      if (
        directory !== undefined &&
        [directory, cacheStateDirectory(directory)].some((path) => overlaps(path, absolute))
      ) {
        invalid(path, 'path overlaps the cache directory');
      }
      return local;
    });
    return [...new Set(entries)].sort();
  };
  return {
    ...definition,
    directory,
    inputs: paths('inputs'),
    label,
    outputs: paths('outputs'),
  };
}

export async function probeTaskCache(
  cache: PreparedCache,
  context: AdapterContext,
  adapter: string,
  options: JsonValue | undefined,
  previous: CacheState | undefined,
  allowRestore = true,
): Promise<CacheProbe | undefined> {
  if (cache.directory === undefined) {
    return undefined;
  }
  const root = await realpath(context.cwd).catch((error) => {
    if (isFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (root === undefined) {
    return undefined;
  }
  const fingerprint = await taskKey(cache, root, context, adapter, options);
  if (fingerprint === undefined) {
    return undefined;
  }
  const { components, key } = fingerprint;
  const file = join(cache.directory, `${key}.json`);
  const local = await readEntry(file, key, context.signal);
  let entry = local;
  let outputs =
    entry === undefined ? undefined : await fingerprintOutputs(cache, root, context, entry.result);
  const backend = cache.settings?.backend;
  if (
    allowRestore &&
    backend !== undefined &&
    (entry === undefined || outputs?.digest !== entry.outputs)
  ) {
    try {
      const remote = await backend.get(key, context.signal);
      const candidate = parseEntry(remote?.entry, key);
      if (
        remote !== undefined &&
        candidate !== undefined &&
        (await taskKey(cache, root, context, adapter, options))?.key === key
      ) {
        const restored = await restoreCacheOutputs(
          root,
          cache.outputs,
          remote.files,
          context.signal,
          async (staged) =>
            (await fingerprintOutputs(cache, staged, context, candidate.result))?.digest ===
              candidate.outputs &&
            (await taskKey(cache, root, context, adapter, options))?.key === key,
        );
        if (restored) {
          entry = candidate;
          outputs = await fingerprintOutputs(cache, root, context, candidate.result);
          await writeCacheJson(file, candidate);
        }
      }
    } catch (error) {
      context.signal.throwIfAborted();
      context.logger.info(`Cache restore failed for ${cache.label}: ${String(error)}`);
    }
  }
  if (entry !== undefined) {
    if (
      outputs?.digest === entry.outputs &&
      (await taskKey(cache, root, context, adapter, options))?.key === key
    ) {
      const hit =
        entry.result.outputs === undefined
          ? {
              ...entry.result,
              outputs: [...outputs.matchedPaths]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([path, kind]) => declaredArtifact(path, kind)),
            }
          : entry.result;
      return { components, file, hit, key, root };
    }
  }
  const changes =
    previous?.components === undefined
      ? []
      : [...new Set([...Object.keys(previous.components), ...Object.keys(components)])].filter(
          (name) => previous.components?.[name] !== components[name],
        );
  return {
    components,
    file,
    key,
    miss: changes.length ? changes : [local === undefined ? 'no-entry' : 'outputs'],
    root,
  };
}

export async function readCacheState(
  path: string | undefined,
  signal: AbortSignal,
): Promise<CacheState | undefined> {
  if (path === undefined) {
    return undefined;
  }
  try {
    const state = JSON.parse(
      await readFile(path, { encoding: 'utf8', signal }),
    ) as CacheState | null;
    if (
      state === null ||
      !Array.isArray(state.inputs) ||
      !state.inputs.every((input) => typeof input === 'string') ||
      (state.components !== undefined &&
        (state.components === null ||
          typeof state.components !== 'object' ||
          Array.isArray(state.components) ||
          !Object.values(state.components).every((hash) => typeof hash === 'string')))
    ) {
      return undefined;
    }
    return state;
  } catch (error) {
    signal.throwIfAborted();
    if (!isFileError(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

export async function reportDeclaredArtifacts(
  cache: PreparedCache,
  output: AdapterOutput,
  { cwd, signal }: TaskContext,
): Promise<AdapterOutput> {
  if (output.outputs !== undefined) {
    return output;
  }
  const outputs: Artifact[] = [];
  for (const path of cache.outputs) {
    try {
      const stats = await statWorkspacePath(cwd, path, signal);
      const kind = stats?.isFile() ? 'file' : stats?.isDirectory() ? 'directory' : undefined;
      if (kind !== undefined) {
        outputs.push(declaredArtifact(path, kind));
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!isFileError(error)) {
        throw error;
      }
    }
  }
  return outputs.length === 0 ? output : { ...output, outputs };
}

export async function saveCacheState(path: string | undefined, state: CacheState): Promise<void> {
  if (path !== undefined) {
    await writeCacheJson(path, state);
  }
}

export async function saveTaskCache(
  cache: PreparedCache,
  probe: CacheProbe,
  context: AdapterContext,
  adapter: string,
  options: JsonValue | undefined,
  result: AdapterOutput,
): Promise<boolean> {
  const { signal } = context;
  const outputs = await fingerprintOutputs(cache, probe.root, context, result);
  if (
    outputs === undefined ||
    !(await cacheProbeIsCurrent(cache, probe, context, adapter, options))
  ) {
    return false;
  }
  signal.throwIfAborted();
  const entry: CacheEntry = {
    key: probe.key,
    outputs: outputs.digest,
    result:
      cache.shared && result.outputs !== undefined
        ? {
            ...result,
            outputs: result.outputs.map((artifact) => ({
              ...artifact,
              path: relative(context.cwd, resolve(context.cwd, artifact.path)).split(sep).join('/'),
            })),
          }
        : result,
    schemaVersion,
  };
  await writeCacheJson(probe.file, entry);
  const backend = cache.settings?.backend;
  if (backend !== undefined) {
    try {
      const files = await snapshotCacheOutputs(probe.root, cache.outputs, signal);
      if (
        (await fingerprintOutputs(cache, probe.root, context, result))?.digest === entry.outputs &&
        (await cacheProbeIsCurrent(cache, probe, context, adapter, options))
      ) {
        await backend.put(probe.key, { entry, files }, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      context.logger.info(`Cache upload failed for ${cache.label}: ${String(error)}`);
    }
  }
  return true;
}

/** Detect conflicting cache boundaries in work that can run in the same stage. */
export function validateStageCaches(declarations: readonly PreparedCache[]): void {
  const boundaries = declarations
    .flatMap(({ inputs, label, outputs }) => [
      ...inputs.map((path) => ({ kind: 'input', label, path, prefix: comparable(path) + sep })),
      ...outputs.map((path) => ({ kind: 'output', label, path, prefix: comparable(path) + sep })),
    ])
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const parents: typeof boundaries = [];
  for (const boundary of boundaries) {
    while (parents.length > 0 && !boundary.prefix.startsWith(parents[parents.length - 1].prefix)) {
      parents.pop();
    }
    const parent = parents.at(-1);
    if (parent !== undefined && (parent.kind === 'output' || boundary.kind === 'output')) {
      invalid(
        boundary.label,
        `${boundary.kind} "${boundary.path}" overlaps ${parent.kind} "${parent.path}" in ${parent.label}`,
      );
    }
    parents.push(boundary);
  }
}

function canonicalOptions(options: JsonValue | undefined): JsonValue | undefined {
  if (options === null || typeof options !== 'object') {
    return options;
  }
  if (Array.isArray(options)) {
    return options.map((value) => canonicalOptions(value)!);
  }
  return Object.fromEntries(
    Object.entries(options)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, canonicalOptions(value)]),
  ) as JsonValue;
}

function comparable(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function declaredArtifact(path: string, kind: PathKind): Artifact {
  return { kind, path: path.split(sep).join('/') };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function fingerprintInputFilesOrDirectories(paths: readonly string[], context: TaskContext) {
  const entries = new Map<string, string>();
  for (const absolute of [...new Set(paths)].sort()) {
    const path = relative(context.cwd, absolute);
    if (!insideWorkspace(path)) {
      return undefined;
    }
    const fingerprint = await fingerprintPaths(context.cwd, [path], context.signal);
    if (fingerprint === undefined) {
      return undefined;
    }
    entries.set(path, fingerprint.digest);
  }
  return entries;
}

function fingerprintOutputs(
  cache: PreparedCache,
  root: string,
  { cwd, signal }: TaskContext,
  result: AdapterOutput,
) {
  const reported = result.outputs?.map(({ path }) => relative(cwd, resolve(cwd, path)));
  if (reported?.some((path) => !coversOutputPath(cache.outputs, path))) {
    return undefined;
  }
  return fingerprintPaths(root, cache.outputs, signal, reported ?? cache.outputs);
}

function insideWorkspace(local: string): boolean {
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function overlaps(first: string, second: string): boolean {
  const a = comparable(first);
  const b = comparable(second);
  return (
    a === b ||
    a.startsWith(b.endsWith(sep) ? b : b + sep) ||
    b.startsWith(a.endsWith(sep) ? a : a + sep)
  );
}

function parseEntry(value: unknown, key: string): CacheEntry | undefined {
  const entry = value as null | Partial<CacheEntry> | undefined;
  if (
    entry?.schemaVersion !== schemaVersion ||
    entry.key !== key ||
    typeof entry.outputs !== 'string'
  ) {
    return undefined;
  }
  return { key, outputs: entry.outputs, result: normalizeOutput(entry.result), schemaVersion };
}

async function readEntry(
  file: string,
  key: string,
  signal: AbortSignal,
): Promise<CacheEntry | undefined> {
  try {
    return parseEntry(JSON.parse(await readFile(file, { encoding: 'utf8', signal })), key);
  } catch (error) {
    signal.throwIfAborted();
    if (isFileError(error) || error instanceof SyntaxError || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

async function taskKey(
  cache: PreparedCache,
  root: string,
  context: AdapterContext,
  adapter: string,
  options: JsonValue | undefined,
): Promise<{ components: Readonly<Record<string, string>>; key: string } | undefined> {
  const pathFingerprints = new Map<string, string>();
  const inputs = await fingerprintPaths(
    root,
    cache.inputs,
    context.signal,
    undefined,
    pathFingerprints,
  );
  const discovered = cache.inputFiles?.map((path) => resolve(context.cwd, path));
  const fileFingerprints = new Map<string, string>();
  const additionalInputs =
    discovered === undefined
      ? undefined
      : await fingerprintInputFiles(
          discovered,
          context.signal,
          fileFingerprints,
          cache.shared ? context.cwd : undefined,
        );
  const dependencies = await fingerprintInputFilesOrDirectories(
    cache.dependencyPaths ?? [],
    context,
  );
  if (
    inputs === undefined ||
    dependencies === undefined ||
    (discovered !== undefined && additionalInputs === undefined)
  ) {
    return undefined;
  }
  const { arch, env, platform, version } = process;
  const values = {
    adapter,
    adapterVersion: cache.version,
    additionalInputs,
    additionalKey: cache.additionalKey,
    cwd: cache.shared ? undefined : context.cwd,
    environment: cache.env?.map((name) => [name, env[name] ?? null]),
    inputs: inputs.digest,
    options: cache.shared ? canonicalOptions(options) : options,
    outputs: cache.outputs,
    root: cache.shared ? undefined : root,
    runtime: { arch, platform, version },
    schemaVersion,
    stageId: cache.shared ? undefined : context.stageId,
    taskId: cache.shared ? undefined : context.taskId,
    variant: cache.shared ? undefined : context.variant,
  };
  const components = Object.fromEntries([
    [
      'configuration',
      digest([
        adapter,
        cache.version,
        cache.additionalKey,
        canonicalOptions(options),
        cache.outputs,
      ]),
    ],
    ['runtime', digest(values.runtime)],
    ...(values.environment ?? []).map(([name, value]) => [`env:${name}`, digest(value)]),
    ...[...pathFingerprints].map(([path, hash]) => [`input:${path}`, hash]),
    ...[...fileFingerprints].map(([path, hash]) => [`discovered:${path}`, hash]),
    ...[...dependencies].map(([path, hash]) => [`artifact:${path}`, hash]),
  ]);
  const custom = await cache.settings?.fingerprint?.(context, Object.freeze({ ...components }));
  if (custom !== undefined) {
    components.custom = digest(custom);
  }
  return {
    components,
    key: digest({
      ...values,
      custom,
      dependencies: dependencies.size ? [...dependencies] : undefined,
    }),
  };
}

async function writeCacheJson(file: string, value: unknown) {
  try {
    await writeJsonFile(file, value);
  } catch (error) {
    if (!isFileError(error)) {
      throw error;
    }
  }
}
