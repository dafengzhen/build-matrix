import { addAbortListener } from 'node:events';
import { resolve } from 'node:path';

import type { JsonValue } from '../core/types.js';
import type { ArtifactOptions } from './artifacts.js';
import type { CacheOptions, PreparedCache } from './cache.js';
import type { createLifecycle } from './lifecycle.js';
import type { AdapterRegistry } from './registry.js';
import type {
  Adapter,
  AdapterContext,
  AdapterOutput,
  AdapterPreparation,
  AdapterStep,
  Artifact,
  InputDiscovery,
  TaskContext,
  TaskStatus,
} from './types.js';

import { asNonemptyString, invalid } from '../core/validation.js';
import { runMiddleware } from './adapter.js';
import {
  containsPath,
  createArtifactTransaction,
  pathsOverlap,
  physicalPath,
} from './artifacts.js';
import {
  cacheProbeIsCurrent,
  cacheStatePath,
  prepareCache,
  probeTaskCache,
  readCacheState,
  reportDeclaredArtifacts,
  saveCacheState,
  saveTaskCache,
} from './cache.js';
import { fingerprintInputFiles, pathKey } from './fingerprint.js';
import { normalizeError, normalizeOutput } from './result.js';

export interface UnitResult {
  readonly cacheMiss?: readonly string[];
  readonly output: AdapterOutput;
  readonly status: 'cached' | 'success' | 'unchanged';
}

export interface UnitServices {
  readonly artifacts?: ArtifactOptions;
  readonly cacheDirectory?: string;
  readonly cacheOptions?: CacheOptions;
  readonly changed?: readonly string[];
  readonly lifecycle: ReturnType<typeof createLifecycle>;
  readonly registry: AdapterRegistry;
  readonly reserve: (paths: readonly string[]) => void;
  readonly runData: Map<unknown, unknown>;
  readonly state: Map<string, UnitState>;
  readonly visited: Set<string>;
}

export interface UnitState {
  readonly complete?: boolean;
  readonly inputs: readonly string[];
  readonly output?: AdapterOutput;
  readonly signature?: string;
}

interface Unit {
  readonly adapter?: Adapter;
  readonly adapterId?: string;
  readonly cache?: PreparedCache;
  readonly context: TaskContext;
  readonly dependencies: ReadonlyMap<string, readonly Artifact[]>;
  readonly environment?: string;
  readonly inputs?: readonly string[];
  readonly options?: JsonValue;
  readonly path: readonly string[];
  readonly run?: AdapterStep['run'];
  readonly signature?: string;
  readonly taskData: Map<unknown, unknown>;
}

export const rootUnitKey = '[]';

export function affected(state: undefined | UnitState, changed: readonly string[]): boolean {
  return (
    state?.output === undefined ||
    !state.complete ||
    changed.some((path) => state.inputs.some((input) => pathsOverlap(path, input)))
  );
}

export async function runUnit(unit: Unit, service: UnitServices): Promise<UnitResult> {
  const { dependencies, path, taskData } = unit;
  const { context: base, options } = unit;
  const { cwd, signal, stageId, taskId, variant } = base;
  const { lifecycle, registry, state, visited } = service;
  const key = JSON.stringify(path);
  visited.add(key);
  const previous = state.get(key);
  const declared = (unit.cache?.inputs ?? []).map((path) => resolve(cwd, path));
  const dependencyPaths = [...dependencies.values()].flatMap((artifacts) =>
    artifacts.map(({ path }) => resolve(cwd, path)),
  );
  const baseline = new Map<string, Promise<string | undefined>>();
  const ownInputs = new Map<string, string>();
  const childInputs = new Set<string>();
  let completeChildren = true;
  let transaction = createArtifactTransaction(
    base,
    service.reserve,
    (id) => dependencies.get(id) ?? [],
  );
  const context: AdapterContext = Object.freeze({
    ...base,
    get artifacts() {
      return transaction.api;
    },
    cacheEnabled: unit.cache?.directory !== undefined,
    environment: unit.environment,
    runData: service.runData,
    stepPath: Object.freeze([...path]),
    taskData,
    async trackInputs(paths: readonly string[], timing?: InputDiscovery) {
      const absolute = paths.map((path) => {
        const input = resolve(cwd, path);
        const key = pathKey(input);
        const known = ownInputs.get(key) ?? input;
        ownInputs.set(key, known);
        if (unit.cache?.directory !== undefined && !timing?.late && !baseline.has(known)) {
          baseline.set(known, fingerprintInputFiles([known], signal));
        }
        return known;
      });
      await Promise.all([
        base.trackInputs?.(absolute),
        ...absolute.map((path) => baseline.get(path)),
      ]);
    },
    watching: base.trackInputs !== undefined,
  });
  const event = {
    environment: context.environment,
    runId: context.runId,
    stageId,
    stepPath: path,
    taskId,
    variantId: variant?.id,
  };
  let adapter = unit.adapter;
  let prepared: AdapterPreparation | undefined;
  const id = unit.adapterId;
  const adapterIdentity = JSON.stringify([id ?? 'step', path, unit.environment]);
  const cacheAdapter =
    path.length === 0 && unit.environment === undefined && id !== undefined ? id : adapterIdentity;
  const perInvocation = id !== undefined && registry.invocationScoped(id);
  const statePath =
    unit.cache === undefined ? undefined : cacheStatePath(unit.cache, base, adapterIdentity);
  let retainedInputs: readonly string[] = [];
  let outcome: undefined | UnitResult;
  let failure: unknown;
  let failed = false;
  async function disposeAdapter() {
    if (perInvocation) {
      const instance = adapter;
      adapter = undefined;
      await instance?.dispose?.();
    }
  }
  await lifecycle.emit('onAdapterStart', event, event);
  try {
    signal.throwIfAborted();
    const saved = await readCacheState(statePath, signal);
    retainedInputs = saved?.inputs ?? [];
    await base.trackInputs?.([...declared, ...retainedInputs, ...(unit.inputs ?? [])]);
    await context.trackInputs(unit.inputs ?? []);
    if (adapter !== undefined || (id !== undefined && registry.prepares(id))) {
      adapter ??= await load(registry, id!, context, perInvocation);
      prepared = (await adapter.prepare?.(context, options)) ?? undefined;
      await context.trackInputs(prepared?.inputs ?? []);
    }
    const cache =
      unit.cache === undefined || prepared?.cacheKey === false || prepared?.steps !== undefined
        ? undefined
        : {
            ...unit.cache,
            additionalKey: prepared?.cacheKey,
            dependencyPaths,
            inputFiles: listInputs([...ownInputs.values(), ...retainedInputs], declared),
          };
    const probe =
      cache === undefined
        ? undefined
        : await probeTaskCache(cache, context, cacheAdapter, options, saved);
    signal.throwIfAborted();
    if (probe?.hit !== undefined) {
      service.reserve((probe.hit.outputs ?? []).map(({ path }) => resolve(cwd, path)));
      await saveCacheState(statePath, {
        components: probe.components,
        inputs: cache?.inputFiles ?? [],
      });
      outcome = { output: probe.hit, status: 'cached' };
    } else {
      if (adapter === undefined && id !== undefined) {
        adapter = await load(registry, id, context, perInvocation);
        prepared = (await adapter.prepare?.(context, options)) ?? undefined;
        await context.trackInputs(prepared?.inputs ?? []);
      }
      const work =
        prepared?.run !== undefined
          ? () => prepared!.run!()
          : unit.run !== undefined
            ? () => unit.run!(context)
            : adapter?.run !== undefined
              ? () => adapter!.run!(context, options)
              : undefined;
      if (work === undefined && prepared?.steps === undefined) {
        throw new TypeError('Adapter did not provide a run function or steps');
      }
      let ran = false;
      const childArtifacts = new Set<Artifact>();
      const direct = await runMiddleware(registry.middleware(), context, options, async () => {
        if (ran) {
          await transaction.dispose();
          transaction = createArtifactTransaction(
            base,
            service.reserve,
            (id) => dependencies.get(id) ?? [],
          );
        }
        ran = true;
        childInputs.clear();
        childArtifacts.clear();
        completeChildren = true;
        const output = work === undefined ? {} : normalizeOutput(await work());
        if (prepared?.steps === undefined) {
          return output;
        }
        signal.throwIfAborted();
        const parentChanged = service.changed?.some((path) =>
          [...declared, ...ownInputs.values()].some((input) => pathsOverlap(path, input)),
        );
        const children = await runSteps(
          prepared.steps,
          unit,
          parentChanged ? { ...service, changed: undefined } : service,
          (state) => {
            completeChildren &&= state?.complete === true;
            for (const input of state?.inputs ?? []) {
              childInputs.add(input);
            }
          },
        );
        for (const artifact of children) {
          childArtifacts.add(artifact);
        }
        return children.length === 0
          ? output
          : { ...output, outputs: [...children, ...(output.outputs ?? [])] };
      });
      signal.throwIfAborted();
      const hooks = service.artifacts;
      const fallback =
        unit.cache !== undefined &&
        (hooks?.transform !== undefined || hooks?.validate !== undefined) &&
        transaction.registered.length === 0 &&
        transaction.staged.length === 0
          ? await reportDeclaredArtifacts(unit.cache, direct, context)
          : direct;
      const outputs = [...(fallback.outputs ?? []), ...transaction.registered];
      const transformed: Artifact[] = [];
      for (const artifact of outputs) {
        if (childArtifacts.has(artifact)) {
          transformed.push(artifact);
          continue;
        }
        const mapped = (await hooks?.transform?.(artifact, context)) ?? artifact;
        await hooks?.validate?.(mapped, context);
        transformed.push(mapped);
      }
      service.reserve(
        [...transformed, ...transaction.staged].map(({ path }) => resolve(cwd, path)),
      );
      await disposeAdapter();
      const staged = await transaction.commit(async (artifact, source) => {
        const mapped = (await hooks?.transform?.(artifact, context, source)) ?? artifact;
        await hooks?.validate?.(mapped, context, source);
        return mapped;
      });
      const combined = [...transformed, ...staged];
      const output = normalizeOutput({
        ...direct,
        ...(combined.length > 0 || direct.outputs !== undefined ? { outputs: combined } : {}),
      });
      const reported =
        unit.cache === undefined
          ? output
          : await reportDeclaredArtifacts(unit.cache, output, context);
      service.reserve((reported.outputs ?? []).map(({ path }) => resolve(cwd, path)));
      const inputs = listInputs(ownInputs.values(), declared);
      let recorded: typeof probe;
      if (
        cache !== undefined &&
        probe !== undefined &&
        (await cacheProbeIsCurrent(cache, probe, context, cacheAdapter, options))
      ) {
        const current = { ...cache, inputFiles: inputs };
        const sameInputs = JSON.stringify(inputs) === JSON.stringify(cache.inputFiles);
        const finalProbe = sameInputs
          ? probe
          : (await stableDiscovery(inputs ?? [], baseline, signal))
            ? await probeTaskCache(current, context, cacheAdapter, options, saved, false)
            : undefined;
        if (
          finalProbe !== undefined &&
          prepared?.steps === undefined &&
          (prepared?.cacheKey === undefined || prepared.cacheKey === cache.additionalKey)
        ) {
          if (await saveTaskCache(current, finalProbe, context, cacheAdapter, options, output)) {
            recorded = finalProbe;
          }
        }
      }
      if (
        cache !== undefined &&
        (recorded !== undefined || inputs !== undefined || retainedInputs.length > 0)
      ) {
        await saveCacheState(statePath, {
          components: recorded?.components ?? saved?.components,
          inputs: inputs ?? [],
        });
      }
      outcome = {
        ...(unit.cache?.directory === undefined
          ? {}
          : probe?.miss !== undefined
            ? { cacheMiss: probe.miss }
            : {
                cacheMiss: [
                  prepared?.steps !== undefined
                    ? 'steps'
                    : prepared?.cacheKey === false
                      ? 'disabled'
                      : 'inputs-unavailable',
                ],
              }),
        output: reported,
        status: 'success',
      };
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup = await Promise.allSettled([transaction.dispose(), disposeAdapter()]);
  for (const result of cleanup) {
    if (result.status !== 'rejected') {
      continue;
    }
    failure = failed
      ? new AggregateError([failure, result.reason], 'Adapter execution and disposal failed')
      : result.reason;
    failed = true;
  }
  const inputs = [
    ...new Set([
      ...declared,
      ...dependencyPaths,
      ...ownInputs.values(),
      ...childInputs,
      ...(outcome?.status === 'cached' || failed ? retainedInputs : []),
      ...(failed ? (previous?.inputs ?? []) : []),
    ]),
  ];
  const complete =
    completeChildren &&
    (inputs.length > 0 ||
      unit.inputs !== undefined ||
      unit.cache !== undefined ||
      prepared?.steps !== undefined);
  state.set(key, {
    complete,
    inputs,
    output: failed ? undefined : outcome?.output,
    signature: unit.signature,
  });
  const status: TaskStatus = failed
    ? signal.aborted
      ? 'cancelled'
      : 'failed'
    : outcome?.status === 'cached'
      ? 'cached'
      : 'success';
  await lifecycle.emit(
    'onAdapterFinish',
    {
      ...event,
      status,
      ...(failed ? { error: normalizeError(failure) } : {}),
      ...(outcome?.cacheMiss === undefined ? {} : { cacheMiss: outcome.cacheMiss }),
    },
    event,
  );
  if (failed) {
    throw failure;
  }
  return outcome!;
}

function listInputs(paths: Iterable<string>, declared: readonly string[]) {
  const boundaries = declared.map(physicalPath);
  const unique = new Map<string, string>();
  for (const path of paths) {
    const key = pathKey(path);
    if (
      !unique.has(key) &&
      !boundaries.some((boundary) => containsPath(boundary, physicalPath(path)))
    ) {
      unique.set(key, path);
    }
  }
  const inputs = [...unique.values()].sort();
  return inputs.length ? inputs : undefined;
}

async function load(
  registry: AdapterRegistry,
  id: string,
  context: AdapterContext,
  disposeOnAbort: boolean,
) {
  const { signal } = context;
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => cancelled.reject(signal.reason));
  const pending = registry.load(id, context);
  try {
    return await Promise.race([pending, cancelled.promise]);
  } catch (error) {
    if (disposeOnAbort && signal.aborted) {
      void pending
        .then((adapter) => adapter.dispose?.())
        .catch((error) => {
          context.logger.error(`Adapter "${id}" disposal failed: ${String(error)}`);
        });
    }
    throw error;
  } finally {
    listener[Symbol.dispose]();
  }
}

async function runSteps(
  steps: readonly AdapterStep[],
  parent: Unit,
  service: UnitServices,
  record: (state: undefined | UnitState) => void,
): Promise<Artifact[]> {
  const byId = new Map<string, AdapterStep>();
  for (const step of steps) {
    const id = asNonemptyString(step.id, 'adapter step ID');
    if (byId.has(id) || (step.run === undefined) === (step.adapter === undefined)) {
      invalid(
        `adapter step "${id}"`,
        'expected a unique ID and exactly one run function or adapter',
      );
    }
    if (typeof step.adapter === 'string' && !service.registry.has(step.adapter)) {
      invalid(`adapter step "${id}"`, `unknown adapter "${step.adapter}"`);
    }
    byId.set(id, step);
  }
  const ordered: AdapterStep[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) {
      return;
    }
    const step = byId.get(id);
    if (step === undefined || stack.has(id)) {
      invalid(`adapter step "${id}"`, 'unknown or cyclic dependency');
    }
    stack.add(id);
    for (const dependency of step.dependsOn ?? []) {
      visit(dependency);
    }
    stack.delete(id);
    visited.add(id);
    ordered.push(step);
  }
  for (const id of byId.keys()) {
    visit(id);
  }
  const results = new Map<string, UnitResult>();
  for (const step of ordered) {
    const { context } = parent;
    const path = [...parent.path, step.id];
    const key = JSON.stringify(path);
    const previous = service.state.get(key);
    const dependencies = new Map(parent.dependencies);
    let dependencyChanged = false;
    for (const id of step.dependsOn ?? []) {
      const result = results.get(id)!;
      dependencies.set(id, result.output.outputs ?? []);
      dependencyChanged ||= result.status === 'success';
    }
    const cache =
      step.cache === undefined
        ? undefined
        : {
            ...prepareCache(step.cache, service.cacheDirectory, context),
            settings: service.cacheOptions,
          };
    const adapterId = typeof step.adapter === 'string' ? step.adapter : undefined;
    const options =
      adapterId === undefined
        ? step.options
        : service.registry.mergeTaskOptions(adapterId, step.options);
    const environment = step.environment ?? parent.environment;
    const signature = JSON.stringify([
      adapterId,
      options,
      step.cache,
      step.inputs,
      step.dependsOn,
      environment,
    ]);
    try {
      if (
        service.changed !== undefined &&
        !dependencyChanged &&
        previous?.output !== undefined &&
        previous.signature === signature &&
        !affected(previous, service.changed)
      ) {
        service.reserve(
          (previous.output.outputs ?? []).map(({ path }) => resolve(context.cwd, path)),
        );
        for (const existing of service.state.keys()) {
          if (existing === key || existing.startsWith(key.slice(0, -1) + ',')) {
            service.visited.add(existing);
          }
        }
        results.set(step.id, { output: previous.output, status: 'unchanged' });
      } else {
        service.reserve((cache?.outputs ?? []).map((path) => resolve(context.cwd, path)));
        const result = await runUnit(
          {
            adapter: typeof step.adapter === 'object' ? step.adapter : undefined,
            adapterId,
            cache,
            context: { ...context, cacheOutputs: cache?.outputs },
            dependencies,
            environment,
            inputs: step.inputs,
            options,
            path,
            run: step.run,
            signature,
            taskData: parent.taskData,
          },
          service,
        );
        results.set(step.id, result);
      }
    } finally {
      record(service.state.get(key));
    }
  }
  return steps.flatMap((step) => results.get(step.id)?.output.outputs ?? []);
}

async function stableDiscovery(
  inputs: readonly string[],
  baseline: Map<string, Promise<string | undefined>>,
  signal: AbortSignal,
) {
  for (const path of inputs) {
    const before = await baseline.get(path);
    if (before === undefined || (await fingerprintInputFiles([path], signal)) !== before) {
      return false;
    }
  }
  return true;
}
