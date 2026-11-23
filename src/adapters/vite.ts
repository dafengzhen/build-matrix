import type { InlineConfig, PluginOption } from 'vite';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtempDisposable, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { JsonObject } from '../core/types.js';
import type { Adapter, AdapterOutput, Artifact, TaskContext } from '../executor/types.js';
import type { BuildRequest, ViteApi } from './vite-config.js';
import type { ViteBuildReport } from './vite-session.js';

import { renderOptions } from '../core/template.js';
import { asNonemptyString, invalid } from '../core/validation.js';
import { coversOutputPath } from '../executor/cache.js';
import { fingerprintInputFiles } from '../executor/fingerprint.js';
import { runProcess } from './process.js';
import {
  configCandidates,
  inspectVite,
  readOptions,
  readOutputs,
  viteRoot,
  withViteEnv,
} from './vite-config.js';
import { checkEnvironment, createViteSession, withBuildHooks } from './vite-session.js';

export interface ViteAdapterOptions {
  /** Opt runtime extensions into task caching, and identify configuration changes outside Vite's files. */
  readonly cacheKey?: ((context: TaskContext) => Awaitable<string>) | string;
  collectArtifacts?(
    outputs: readonly ViteOutput[],
    context: TaskContext,
  ): Awaitable<readonly ViteOutput[]>;
  configure?(config: InlineConfig, context: ViteConfigureContext): Awaitable<InlineConfig | void>;
  readonly defaults?: ViteOptions;
  onBuildEnd?(event: ViteBuildEnd): Awaitable<void>;
  onBuildStart?(context: TaskContext): Awaitable<void>;
  onEnvironmentEnd?(event: ViteEnvironmentEnd): Awaitable<void>;
  onEnvironmentStart?(event: ViteEnvironmentContext): Awaitable<void>;
  readonly plugins?: readonly PluginOption[];
  validateArtifact?(output: ViteOutput, context: TaskContext): Awaitable<void>;
}

export type ViteBuildEnd = (
  | { readonly error: unknown; readonly status: 'failed' }
  | { readonly result: AdapterOutput; readonly status: 'success' }
) &
  TaskContext;

export interface ViteConfigureContext extends TaskContext {
  /** Present when resolving a separate builder for an environment's root or mode. */
  readonly environment?: string;
}

export interface ViteEnvironmentContext extends TaskContext {
  readonly environment: string;
}

export type ViteEnvironmentEnd = (
  | { readonly error: unknown; readonly status: 'failed' }
  | { readonly result: unknown; readonly status: 'success' }
) &
  ViteEnvironmentContext;

export interface ViteEnvironmentOptions {
  readonly build?: JsonObject;
  readonly mode?: string;
  readonly outDir?: string;
  readonly root?: string;
}

export interface ViteOptions {
  readonly artifacts?: 'directories' | 'files';
  readonly builder?: 'once' | 'reuse';
  readonly configFile?: false | string;
  readonly environmentOptions?: Readonly<Record<string, ViteEnvironmentOptions>>;
  readonly environments?: readonly string[] | string;
  readonly execution?: 'in-process' | 'process';
  readonly mode?: string;
  readonly outDir?: string;
  readonly outputs?: readonly ViteOutput[];
  readonly root?: string;
  readonly viteConfig?: JsonObject;
}

export interface ViteOutput extends Artifact {
  readonly kind?: 'directory' | 'file';
}

type Awaitable<T> = Promise<T> | T;

interface ReusableBuilder {
  readonly key: string;
  readonly session: Awaited<ReturnType<typeof createViteSession>>;
  readonly signature: string;
}

const packageRequire = createRequire(import.meta.url);
const buildScript = fileURLToPath(import.meta.resolve('#vite-build'));
let inProcessQueue = Promise.resolve();

export function createViteAdapter(
  extensions: ViteAdapterOptions = {},
): Adapter<undefined | ViteOptions> {
  const defaultOptions = readOptions(extensions.defaults, 'vite adapter defaults');
  const usesExtensions =
    [
      extensions.configure,
      extensions.onBuildStart,
      extensions.onBuildEnd,
      extensions.onEnvironmentStart,
      extensions.onEnvironmentEnd,
      extensions.collectArtifacts,
      extensions.validateArtifact,
    ].some((callback) => callback !== undefined) || Boolean(extensions.plugins?.length);
  const builders = new Map<string, ReusableBuilder>();

  function taskRequest(context: TaskContext, input: undefined | ViteOptions): BuildRequest {
    const task = readOptions(input, 'vite options');
    const inherited = Object.fromEntries(
      Object.entries(defaultOptions).filter(
        ([key]) =>
          key === 'viteConfig' || key === 'environmentOptions' || !Object.hasOwn(task, key),
      ),
    ) as JsonObject;
    const defaults = renderOptions(inherited, context.variant?.values ?? {}) as ViteOptions;
    const { builder = 'once', execution = 'process' } = { ...defaults, ...task };
    if (execution === 'process' && (usesExtensions || builder === 'reuse')) {
      invalid(
        'vite options.execution',
        'live plugins, callbacks and reusable builders require "in-process"',
      );
    }
    return { cwd: context.cwd, defaults, task };
  }

  async function runtimeKey(context: TaskContext): Promise<string | undefined> {
    const { cacheKey } = extensions;
    return cacheKey === undefined
      ? undefined
      : asNonemptyString(
          typeof cacheKey === 'function' ? await cacheKey(context) : cacheKey,
          'vite adapter cacheKey',
        );
  }

  async function findReusable(context: TaskContext, slot: string, builderKey: string) {
    const entry = builders.get(slot);
    if (
      entry?.key === builderKey &&
      (await fingerprintInputFiles(entry.session.dependencies, context.signal)) === entry.signature
    ) {
      return entry.session;
    }
  }

  async function run(
    context: TaskContext,
    request: BuildRequest,
    key: string | undefined,
    knownInputs?: readonly string[],
  ) {
    const options = { ...request.defaults, ...request.task };
    const viteUrl = pathToFileURL(resolveVite(viteRoot(request), context.cwd)).href;
    if (options.execution !== 'in-process') {
      const report = await runChild<ViteBuildReport>(context, request, viteUrl, 'build');
      return { outputs: await reportArtifacts(context, report, options) };
    }
    return withBuildHooks(
      () => extensions.onBuildStart?.(context),
      (outcome) => extensions.onBuildEnd?.({ ...context, ...outcome }),
      async () => {
        const report = await inProcess(context.signal, async () => {
          const vite = await importVite(viteUrl);
          if (options.builder !== 'reuse') {
            const session = await createViteSession(vite, request, extensions, context);
            await context.trackInputs?.(session.dependencies);
            return session.build(context);
          }
          const slot = builderSlot(context);
          const builderKey = builderIdentity(request, viteUrl, key);
          try {
            let session = await findReusable(context, slot, builderKey);
            if (session === undefined) {
              const tracked =
                knownInputs ??
                builders.get(slot)?.session.dependencies ??
                configCandidates(request);
              builders.delete(slot);
              const before = await fingerprintInputFiles(tracked, context.signal);
              session = await createViteSession(vite, request, extensions, context);
              const signature = await fingerprintInputFiles(session.dependencies, context.signal);
              if (
                signature !== undefined &&
                before !== undefined &&
                (await fingerprintInputFiles(tracked, context.signal)) === before
              ) {
                builders.set(slot, { key: builderKey, session, signature });
              }
            }
            await context.trackInputs?.(session.dependencies);
            return await session.build(context);
          } catch (error) {
            builders.delete(slot);
            throw error;
          }
        });
        return { outputs: await reportArtifacts(context, report, options, extensions) };
      },
    );
  }

  return {
    async prepare(context, input) {
      const request = taskRequest(context, input);
      const key = await runtimeKey(context);
      await context.trackInputs?.(configCandidates(request));
      const viteUrl = pathToFileURL(resolveVite(viteRoot(request), context.cwd)).href;
      const { builder, execution } = { ...request.defaults, ...request.task };
      const report =
        execution === 'in-process'
          ? await inProcess(context.signal, async () => {
              const vite = await importVite(viteUrl);
              const existing =
                builder === 'reuse'
                  ? await findReusable(
                      context,
                      builderSlot(context),
                      builderIdentity(request, viteUrl, key),
                    )
                  : undefined;
              return {
                inputs: existing?.dependencies ?? (await inspectVite(vite, request)),
                version: vite.version,
              };
            })
          : await runChild<{ inputs: string[]; version: string }>(
              context,
              request,
              viteUrl,
              'inspect',
            );
      return {
        cacheKey:
          usesExtensions && key === undefined
            ? false
            : JSON.stringify([
                request.defaults,
                viteUrl,
                report.version,
                process.env.NODE_ENV,
                key,
              ]),
        inputs: report.inputs,
        run: () => run(context, request, key, report.inputs),
      };
    },
    async run(context, input) {
      return run(context, taskRequest(context, input), await runtimeKey(context));
    },
  };
}

function builderIdentity(request: BuildRequest, viteUrl: string, key: string | undefined): string {
  return JSON.stringify([request, viteUrl, key, process.env.NODE_ENV]);
}

function builderSlot({ cwd, stageId, taskId, variant }: TaskContext): string {
  return JSON.stringify([cwd, stageId, taskId, variant?.id]);
}

async function importVite(url: string): Promise<ViteApi> {
  return (await import(url)) as ViteApi;
}

async function inProcess<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const next = inProcessQueue.then(() => {
    signal.throwIfAborted();
    return withViteEnv(work);
  });
  inProcessQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

function isWithinCwd(local: string): boolean {
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function relativeOutputPath(cwd: string, physicalCwd: string, path: string): string {
  const local = relative(cwd, path);
  if (isWithinCwd(local)) {
    return local;
  }
  // Vite can report the physical path when cwd uses a short name or a directory link.
  const physical = relative(physicalCwd, path);
  return isWithinCwd(physical) ? physical : local;
}

async function reportArtifacts(
  context: TaskContext,
  report: ViteBuildReport,
  options: ViteOptions,
  extensions: ViteAdapterOptions = {},
): Promise<ViteOutput[]> {
  const { cwd, signal } = context;
  const built = new Set(report.environments);
  const declared = options.outputs;
  const physicalCwd = declared === undefined ? await realpath(cwd) : cwd;
  const legacyOutDir =
    options.environments === undefined && built.size === 1 && options.artifacts !== 'files'
      ? options.outDir
      : undefined;
  const entries =
    declared ??
    report.outputs.map(({ environment, kind, path }) => {
      const local = relativeOutputPath(cwd, physicalCwd, path);
      if (
        legacyOutDir !== undefined &&
        relative(resolve(cwd, legacyOutDir), resolve(cwd, local)) === ''
      ) {
        return { kind, path: legacyOutDir };
      }
      return { environment, kind, path: (local || '.').split(sep).join('/') };
    });
  const candidates = entries.filter(
    ({ environment }) => environment === undefined || built.has(environment),
  );
  const customized =
    extensions.collectArtifacts === undefined
      ? candidates
      : readOutputs(
          await extensions.collectArtifacts(candidates, context),
          'vite collected outputs',
        );
  const outputs: ViteOutput[] = [];
  for (const candidate of customized) {
    signal.throwIfAborted();
    if (candidate.environment !== undefined) {
      checkEnvironment(candidate.environment, report.available, 'vite collected outputs');
      if (!built.has(candidate.environment)) {
        continue;
      }
    }
    const output = await verifyArtifact(context, candidate, {
      detailed: options.artifacts === 'files',
      required: declared !== undefined || extensions.collectArtifacts !== undefined,
    });
    if (output !== undefined) {
      await extensions.validateArtifact?.(output, context);
      outputs.push(output);
    }
  }
  signal.throwIfAborted();
  if (
    options.artifacts === 'files' &&
    declared === undefined &&
    extensions.collectArtifacts === undefined
  ) {
    outputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return outputs;
}

function resolveVite(root: string, cwd: string): string {
  const directories = root === cwd ? [root] : [root, cwd];
  const resolvers = directories.map((directory) => createRequire(join(directory, 'package.json')));
  let missing: unknown;
  for (const resolver of [...resolvers, packageRequire]) {
    try {
      return resolver.resolve('vite');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
      missing = error;
    }
  }
  throw Object.assign(
    new Error('The Vite adapter requires Vite. Install vite in the project.', { cause: missing }),
    { code: 'VITE_NOT_INSTALLED' },
  );
}

async function runChild<T>(
  context: TaskContext,
  request: BuildRequest,
  viteUrl: string,
  action: 'build' | 'inspect',
): Promise<T> {
  context.signal.throwIfAborted();
  await using directory = await mkdtempDisposable(join(tmpdir(), 'build-matrix-vite-'));
  const reportPath = join(directory.path, 'report.json');
  await runProcess(
    context,
    process.execPath,
    [buildScript, viteUrl, reportPath, action],
    JSON.stringify(request),
  );
  const report = JSON.parse(
    await readFile(reportPath, { encoding: 'utf8', signal: context.signal }),
  ) as { error: { code: string; message: string } } | { result: T };
  if ('error' in report) {
    throw Object.assign(new Error(report.error.message), { code: report.error.code });
  }
  return report.result;
}

async function verifyArtifact(
  { cacheOutputs, cwd, signal }: TaskContext,
  {
    environment,
    kind: expectedKind,
    path,
    sha256: expectedHash,
    sizeBytes: expectedSize,
  }: ViteOutput,
  { detailed, required }: { detailed: boolean; required: boolean },
): Promise<undefined | ViteOutput> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute, { throwIfNoEntry: false }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOTDIR') {
        return undefined;
      }
      throw error;
    },
  );
  const kind = info?.isDirectory() ? 'directory' : info?.isFile() ? 'file' : undefined;
  const label = `Vite output "${path}"${environment === undefined ? '' : ` for environment "${environment}"`}`;
  const invalidOutput = (reason: string) =>
    Object.assign(new Error(`${label} ${reason}`), { code: 'VITE_INVALID_OUTPUT' });
  if (kind === undefined || (expectedKind !== undefined && expectedKind !== kind)) {
    if (!required) {
      return undefined;
    }
    const expected = expectedKind === undefined ? 'a file or directory' : `a ${expectedKind}`;
    throw invalidOutput(`expected ${expected}, found ${kind ?? 'no file or directory'}`);
  }
  if (
    required &&
    cacheOutputs !== undefined &&
    !coversOutputPath(cacheOutputs, relative(cwd, absolute))
  ) {
    throw Object.assign(new Error(`${label} is not covered by cache.outputs`), {
      code: 'VITE_CACHE_OUTPUT_MISMATCH',
    });
  }
  const result: ViteOutput = { ...(environment === undefined ? {} : { environment }), kind, path };
  if (expectedSize !== undefined && (kind !== 'file' || info?.size !== expectedSize)) {
    throw invalidOutput(`expected a file of ${expectedSize} bytes`);
  }
  if (expectedHash !== undefined && kind !== 'file') {
    throw invalidOutput('expected a file with a SHA-256 digest');
  }
  if (kind === 'file' && (detailed || expectedHash !== undefined || expectedSize !== undefined)) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute, { signal })) {
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    if (expectedHash !== undefined && sha256 !== expectedHash) {
      throw invalidOutput(`expected SHA-256 ${expectedHash}, found ${sha256}`);
    }
    return { ...result, sha256, sizeBytes: info?.size };
  }
  return result;
}

export default createViteAdapter();
