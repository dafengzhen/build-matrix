import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { JsonValue, TaskCacheDefinition } from '../core/types.js';
import type { PathKind } from './fingerprint.js';
import type { AdapterOutput, Artifact, TaskContext } from './types.js';

import { renderTemplate } from '../core/template.js';
import { invalid } from '../core/validation.js';
import { fingerprintPaths, isFileError, statWorkspacePath } from './fingerprint.js';
import { writeJsonFile } from './json-file.js';
import { normalizeOutput } from './result.js';

const schemaVersion = 1;
export const defaultCacheDirectory = '.build-matrix-cache';

export interface CacheOptions {
  readonly directory?: string;
}

interface CacheEntry {
  readonly key: string;
  readonly outputs: string;
  readonly result: AdapterOutput;
  readonly schemaVersion: typeof schemaVersion;
}

interface CacheProbe {
  readonly file: string;
  readonly hit?: AdapterOutput;
  readonly key: string;
  readonly root: string;
}

interface PreparedCache extends TaskCacheDefinition {
  readonly directory?: string;
  readonly label: string;
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
      if (directory !== undefined && overlaps(directory, absolute)) {
        invalid(path, 'path overlaps the cache directory');
      }
      return local;
    });
    return [...new Set(entries)].sort();
  };
  return {
    ...definition,
    directory,
    inputs: directory === undefined ? definition.inputs : paths('inputs'),
    label,
    outputs: paths('outputs'),
  };
}

export async function probeTaskCache(
  cache: PreparedCache,
  context: TaskContext,
  adapter: string,
  options: JsonValue | undefined,
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
  const key = await taskKey(cache, root, context, adapter, options);
  if (key === undefined) {
    return undefined;
  }
  const file = join(cache.directory, `${key}.json`);
  const entry = await readEntry(file, key, context.signal);
  if (entry !== undefined) {
    const outputs = await fingerprintOutputs(cache, root, context, entry.result);
    if (
      outputs?.digest === entry.outputs &&
      (await taskKey(cache, root, context, adapter, options)) === key
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
      return { file, hit, key, root };
    }
  }
  return { file, key, root };
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

export async function saveTaskCache(
  cache: PreparedCache,
  probe: CacheProbe,
  context: TaskContext,
  adapter: string,
  options: JsonValue | undefined,
  result: AdapterOutput,
): Promise<void> {
  const { signal } = context;
  const outputs = await fingerprintOutputs(cache, probe.root, context, result);
  if (
    outputs === undefined ||
    (await taskKey(cache, probe.root, context, adapter, options)) !== probe.key
  ) {
    return;
  }
  signal.throwIfAborted();
  const entry: CacheEntry = { key: probe.key, outputs: outputs.digest, result, schemaVersion };
  try {
    await writeJsonFile(probe.file, entry);
  } catch (error) {
    if (!isFileError(error)) {
      throw error;
    }
  }
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

function comparable(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function declaredArtifact(path: string, kind: PathKind): Artifact {
  return { kind, path: path.split(sep).join('/') };
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

async function readEntry(
  file: string,
  key: string,
  signal: AbortSignal,
): Promise<CacheEntry | undefined> {
  try {
    const entry = JSON.parse(
      await readFile(file, { encoding: 'utf8', signal }),
    ) as null | Partial<CacheEntry>;
    if (
      entry?.schemaVersion !== schemaVersion ||
      entry.key !== key ||
      typeof entry.outputs !== 'string'
    ) {
      return undefined;
    }
    return {
      key,
      outputs: entry.outputs,
      result: normalizeOutput(entry.result),
      schemaVersion,
    };
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
  context: TaskContext,
  adapter: string,
  options: JsonValue | undefined,
): Promise<string | undefined> {
  const inputs = await fingerprintPaths(root, cache.inputs, context.signal);
  if (inputs === undefined) {
    return undefined;
  }
  const { arch, env, platform, version } = process;
  return createHash('sha256')
    .update(
      JSON.stringify({
        adapter,
        adapterVersion: cache.version,
        cwd: context.cwd,
        environment: cache.env?.map((name) => [name, env[name] ?? null]),
        inputs: inputs.digest,
        options,
        outputs: cache.outputs,
        root,
        runtime: { arch, platform, version },
        schemaVersion,
        stageId: context.stageId,
        taskId: context.taskId,
        variant: context.variant,
      }),
    )
    .digest('hex');
}
