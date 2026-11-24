import type { EnvironmentOptions, InlineConfig, PluginOption, ResolvedConfig } from 'vite';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtempDisposable, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { JsonObject } from '../core/types.js';
import type {
  Adapter,
  AdapterContext,
  AdapterOutput,
  Artifact,
  InputDiscovery,
  TaskContext,
} from '../executor/types.js';
import type { BuildRequest, ViteApi } from './vite-config.js';
import type { ViteBuildReport } from './vite-session.js';

import { renderOptions } from '../core/template.js';
import { asNonemptyString, asPositiveInteger, invalid } from '../core/validation.js';
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

export interface ViteAdapter extends Adapter<undefined | ViteOptions, TaskContext> {
  dispose(): Promise<void>;
  run(context: TaskContext, input: undefined | ViteOptions): Promise<AdapterOutput>;
}

export interface ViteAdapterOptions {
  beforeConfig?(
    config: InlineConfig,
    context: ViteConfigureContext,
  ): Awaitable<InlineConfig | void>;
  readonly builderPool?: { readonly idleTimeoutMs?: number; readonly maxInstances?: number };
  /** Opt runtime extensions into task caching, and identify configuration changes outside Vite's files. */
  readonly cacheKey?: ((context: TaskContext) => Awaitable<string>) | string;
  collectArtifacts?(
    outputs: readonly ViteOutput[],
    context: TaskContext,
  ): Awaitable<readonly ViteOutput[]>;
  configure?(config: InlineConfig, context: ViteConfigureContext): Awaitable<InlineConfig | void>;
  configureEnvironment?(
    config: EnvironmentOptions,
    context: { readonly environment: string } & ViteConfigureContext,
  ): Awaitable<EnvironmentOptions | void>;
  readonly defaults?: ViteOptions;
  readonly environmentPlugins?: Readonly<Record<string, PluginOption>>;
  inputs?(context: TaskContext): Awaitable<readonly string[]>;
  onBuildEnd?(event: ViteBuildEnd): Awaitable<void>;
  onBuildStart?(context: TaskContext): Awaitable<void>;
  onEnvironmentEnd?(event: ViteEnvironmentEnd): Awaitable<void>;
  onEnvironmentStart?(event: ViteEnvironmentContext): Awaitable<void>;
  readonly plugins?: readonly PluginOption[];
  resolvedConfig?(config: ResolvedConfig, context: ViteConfigureContext): Awaitable<void>;
  transformArtifact?(output: ViteOutput, context: TaskContext): Awaitable<ViteOutput>;
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
  onDispose(cleanup: () => Awaitable<void>): void;
  trackInputs(paths: readonly string[], timing?: InputDiscovery): Promise<void>;
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
  readonly config?: JsonObject;
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
  timer?: ReturnType<typeof setTimeout>;
}

const packageRequire = createRequire(import.meta.url);
const buildScript = fileURLToPath(import.meta.resolve('#vite-build'));
let inProcessQueue = Promise.resolve();

export function createViteAdapter(extensions: ViteAdapterOptions = {}): ViteAdapter {
  const defaultOptions = readOptions(extensions.defaults, 'vite adapter defaults');
  const maxInstances = asPositiveInteger(
    extensions.builderPool?.maxInstances ?? 8,
    'vite builderPool.maxInstances',
  );
  const idleTimeout = extensions.builderPool?.idleTimeoutMs;
  if (
    idleTimeout !== undefined &&
    (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 2_147_483_647)
  ) {
    invalid('vite builderPool.idleTimeoutMs', 'expected a positive integer within the timer limit');
  }
  const usesExtensions =
    [
      extensions.beforeConfig,
      extensions.configure,
      extensions.configureEnvironment,
      extensions.onBuildStart,
      extensions.onBuildEnd,
      extensions.onEnvironmentStart,
      extensions.onEnvironmentEnd,
      extensions.collectArtifacts,
      extensions.resolvedConfig,
      extensions.transformArtifact,
      extensions.validateArtifact,
    ].some((callback) => callback !== undefined) ||
    Boolean(extensions.plugins?.length) ||
    Object.keys(extensions.environmentPlugins ?? {}).length > 0;
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
      return entry;
    }
  }

  async function evict(slot: string) {
    const entry = builders.get(slot);
    if (entry !== undefined) {
      builders.delete(slot);
      clearTimeout(entry.timer);
      await entry.session.dispose();
    }
  }

  function touch(context: TaskContext, slot: string, entry: ReusableBuilder) {
    clearTimeout(entry.timer);
    builders.delete(slot);
    builders.set(slot, entry);
    if (idleTimeout !== undefined) {
      const timer = setTimeout(() => {
        void inProcess(new AbortController().signal, async () => {
          if (builders.get(slot) === entry && entry.timer === timer) {
            await evict(slot);
          }
        }).catch((error) => context.logger.error(`Vite builder disposal failed: ${String(error)}`));
      }, idleTimeout).unref();
      entry.timer = timer;
    }
  }

  async function run(
    context: TaskContext,
    request: BuildRequest,
    key: string | undefined,
    knownInputs?: readonly string[],
  ) {
    const options = { ...request.defaults, ...request.task };
    const artifacts = (context as Partial<AdapterContext>).artifacts;
    for (const path of [
      ...(options.outputs ?? []).map(({ path }) => path),
      ...(options.outDir === undefined ? [] : [options.outDir]),
    ]) {
      await artifacts?.reserve(path);
    }
    const viteUrl = pathToFileURL(resolveVite(viteRoot(request), context.cwd)).href;
    if (options.execution !== 'in-process') {
      const report = await runChild<ViteBuildReport>(context, request, viteUrl, 'build');
      await context.trackInputs?.(report.inputs, { late: true });
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
            try {
              await context.trackInputs?.(session.preparedInputs);
              return await session.build(context);
            } finally {
              await session.dispose();
            }
          }
          const slot = builderSlot(context);
          const builderKey = builderIdentity(request, viteUrl, key);
          let temporary: Awaited<ReturnType<typeof createViteSession>> | undefined;
          try {
            let entry = await findReusable(context, slot, builderKey);
            if (entry === undefined) {
              const tracked =
                knownInputs ??
                builders.get(slot)?.session.dependencies ??
                configCandidates(request);
              await evict(slot);
              while (builders.size >= maxInstances) {
                await evict(builders.keys().next().value!);
              }
              const before = await fingerprintInputFiles(tracked, context.signal);
              temporary = await createViteSession(vite, request, extensions, context);
              const signature = await fingerprintInputFiles(temporary.dependencies, context.signal);
              if (
                signature !== undefined &&
                before !== undefined &&
                (await fingerprintInputFiles(tracked, context.signal)) === before
              ) {
                entry = { key: builderKey, session: temporary, signature };
                builders.set(slot, entry);
                temporary = undefined;
              }
            }
            const session = entry?.session ?? temporary!;
            await context.trackInputs?.(session.preparedInputs);
            const report = await session.build(context);
            if (entry !== undefined) {
              touch(context, slot, entry);
            }
            return report;
          } catch (error) {
            await evict(slot);
            throw error;
          } finally {
            await temporary?.dispose();
          }
        });
        return { outputs: await reportArtifacts(context, report, options, extensions) };
      },
    );
  }

  return {
    dispose() {
      return inProcess(new AbortController().signal, async () => {
        const results = await Promise.allSettled([...builders.keys()].map(evict));
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, 'Vite builder disposal failed');
        }
      });
    },
    async prepare(context, input) {
      const request = taskRequest(context, input);
      const key = await runtimeKey(context);
      const pluginInputs = (await extensions.inputs?.(context)) ?? [];
      await context.trackInputs?.(pluginInputs);
      if (
        'cacheEnabled' in context &&
        'watching' in context &&
        !context.cacheEnabled &&
        !context.watching
      ) {
        return { run: () => run(context, request, key) };
      }
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
                inputs: existing?.session.preparedInputs ?? (await inspectVite(vite, request)),
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
        inputs: [...report.inputs, ...pluginInputs],
        run: () => run(context, request, key, report.inputs),
      };
    },
    async run(context, input) {
      await context.trackInputs?.((await extensions.inputs?.(context)) ?? []);
      return run(context, taskRequest(context, input), await runtimeKey(context));
    },
  };
}

function builderIdentity(request: BuildRequest, viteUrl: string, key: string | undefined): string {
  return JSON.stringify([request, viteUrl, key, process.env.NODE_ENV]);
}

function builderSlot(context: TaskContext): string {
  const { cwd, stageId, taskId, variant } = context;
  const { environment, stepPath } = context as Partial<AdapterContext>;
  return JSON.stringify([cwd, stageId, taskId, variant?.id, environment, stepPath]);
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
  for (const input of customized) {
    signal.throwIfAborted();
    const candidate =
      extensions.transformArtifact === undefined
        ? input
        : readOutputs(
            [await extensions.transformArtifact(input, context)],
            'vite transformed output',
          )[0];
    if (candidate.environment !== undefined) {
      checkEnvironment(candidate.environment, report.available, 'vite collected outputs');
      if (!built.has(candidate.environment)) {
        continue;
      }
    }
    const output = await verifyArtifact(context, candidate, {
      detailed: options.artifacts === 'files',
      required:
        declared !== undefined ||
        extensions.collectArtifacts !== undefined ||
        extensions.transformArtifact !== undefined,
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
