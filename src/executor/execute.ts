import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { Plan, PlannedStage, PlannedTask, ResourceLimits, Variant } from '../core/types.js';
import type { ArtifactOptions } from './artifacts.js';
import type { CacheOptions, PreparedCache } from './cache.js';
import type { RunFilter } from './filter.js';
import type { AdapterRegistry } from './registry.js';
import type { ScheduledTask } from './scheduler.js';
import type {
  Artifact,
  LifecycleHooks,
  Logger,
  RunResult,
  SchedulingInfo,
  StageResult,
  TaskContext,
  TaskResult,
  WatchRunInfo,
} from './types.js';
import type { UnitServices, UnitState } from './unit.js';

import { renderOptions, renderTemplate } from '../core/template.js';
import { asPath, asPositiveInteger, asResourceLimits, invalid } from '../core/validation.js';
import { ArtifactClaims, reconcileArtifacts } from './artifacts.js';
import { defaultCacheDirectory, prepareCache, validateStageCaches } from './cache.js';
import { selectInvocations } from './filter.js';
import { createLifecycle } from './lifecycle.js';
import { createDetailedReport, createManifest, writeManifest } from './manifest.js';
import { createDefaultRegistry } from './registry.js';
import { createTaskCounts, normalizeError } from './result.js';
import { StageScheduler } from './scheduler.js';
import { affected, runUnit, unitKey } from './unit.js';

export interface ExecuteOptions {
  readonly artifacts?: ArtifactOptions;
  readonly cache?: CacheOptions | false;
  readonly cwd?: string;
  readonly filter?: RunFilter;
  readonly hooks?: LifecycleHooks;
  readonly logger?: Logger;
  readonly manifestPath?: string;
  readonly manifestVersion?: 1 | 2;
  readonly maxConcurrency?: number;
  readonly registry?: AdapterRegistry;
  readonly resourceLimits?: ResourceLimits;
  readonly signal?: AbortSignal;
}

interface Invocation {
  readonly cache?: PreparedCache;
  readonly context: TaskContext;
  readonly selected: boolean;
  readonly task: PlannedTask;
}

const quietLogger: Logger = { error() {}, info() {} };
type Lifecycle = ReturnType<typeof createLifecycle>;

/** Execute a plan produced by createPlan, retaining declaration order in the report. */
export async function executePlan(plan: Plan, options: ExecuteOptions = {}): Promise<RunResult> {
  const registry = options.registry ?? createDefaultRegistry();
  try {
    return await runPlan(plan, { ...options, registry });
  } finally {
    if (options.registry === undefined) {
      await registry.dispose();
    }
  }
}

export async function runPlan(
  plan: Plan,
  options: ExecuteOptions,
  watch?: WatchRunInfo,
  trackInputs?: TaskContext['trackInputs'],
  state = new Map<string, UnitState>(),
  incremental = false,
): Promise<RunResult> {
  const registry = options.registry ?? createDefaultRegistry();
  const concurrency =
    options.maxConcurrency === undefined
      ? 1
      : asPositiveInteger(options.maxConcurrency, 'maxConcurrency');
  const cwd = options.cwd === undefined ? process.cwd() : resolve(asPath(options.cwd, 'cwd'));
  const signal = options.signal ?? new AbortController().signal;
  const logger = options.logger ?? quietLogger;
  const overrides =
    options.resourceLimits === undefined
      ? undefined
      : asResourceLimits(options.resourceLimits, 'resourceLimits');
  const resourceLimits = Object.freeze({ ...plan.resourceLimits, ...overrides });
  const scheduling = { maxConcurrency: concurrency, resourceLimits };
  const lifecycle = createLifecycle(options.hooks);
  const cacheDirectory =
    options.cache === false
      ? undefined
      : resolve(cwd, asPath(options.cache?.directory ?? defaultCacheDirectory, 'cache.directory'));
  const manifestPath =
    options.manifestPath === undefined
      ? undefined
      : resolve(cwd, asPath(options.manifestPath, 'manifestPath'));
  const manifestVersion = options.manifestVersion ?? 1;
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    invalid('manifestVersion', 'expected 1 or 2');
  }
  const runId = randomUUID();
  const selected = selectionWithDependencies(plan, options.filter);
  const planned = plan.stages.map((stage) => ({
    invocations: listInvocations(
      stage,
      plan.variants,
      { cwd, logger, runId, signal, ...(trackInputs === undefined ? {} : { trackInputs }) },
      selected,
      cacheDirectory,
      registry,
      resourceLimits,
    ),
    stage,
  }));
  const claims = new ArtifactClaims();
  const active = planned.flatMap(({ invocations }) =>
    invocations.filter(({ selected }) => selected),
  );
  for (const { cache, context } of active) {
    claims.claim(
      owner(context),
      (cache?.outputs ?? []).map((path) => resolve(cwd, path)),
    );
  }
  const watchChanges =
    incremental && watch !== undefined && watch.number > 1
      ? watch.changedPaths.map((path) => resolve(cwd, path))
      : undefined;
  const dirty = new Set<string>();
  const upstream = new Map<string, Invocation[]>();
  for (const invocation of active) {
    const { context, task } = invocation;
    const key = unitKey(context);
    if (
      watchChanges === undefined ||
      affected(state.get(key), watchChanges) ||
      dependenciesOf(invocation, upstream).some((producer) => dirty.has(unitKey(producer.context)))
    ) {
      dirty.add(key);
    }
    const invocations = upstream.get(task.id) ?? [];
    invocations.push(invocation);
    upstream.set(task.id, invocations);
  }
  const completed = new Map<string, TaskResult>();
  const services: Omit<UnitServices, 'reserve' | 'visited'> = {
    artifacts: options.artifacts,
    cacheDirectory,
    cacheOptions: options.cache || undefined,
    changed: watchChanges,
    lifecycle,
    registry,
    runData: new Map(),
    state,
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const counts = createTaskCounts();
  const stages: StageResult[] = [];
  const watchInfo = watch === undefined ? {} : { watch };
  await lifecycle.emit('onRunStart', { runId, scheduling, startedAt, ...watchInfo });

  let stopped = false;
  for (const { invocations, stage } of planned) {
    const inactive = signal.aborted ? 'cancelled' : stopped ? 'skipped' : undefined;
    const filtered =
      invocations.length > 0 && invocations.every((invocation) => !invocation.selected);
    let result: StageResult;
    if (inactive !== undefined || filtered) {
      result = {
        id: stage.id,
        status: filtered ? 'skipped' : (inactive ?? 'skipped'),
        tasks: invocations.map((invocation) =>
          waitingResult(invocation, inactive ?? 'skipped', 'stage-failed'),
        ),
      };
    } else {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const stageId = stage.id;
      await lifecycle.emit('onStageStart', { runId, stageId, startedAt }, { stageId });
      const stageResult = await runStage(
        stage,
        invocations,
        scheduling,
        signal,
        lifecycle,
        async (invocation) => {
          if (!dirty.has(unitKey(invocation.context))) {
            const outputs = state.get(unitKey(invocation.context))?.output?.outputs;
            claims.claim(
              owner(invocation.context),
              (outputs ?? []).map(({ path }) => resolve(cwd, path)),
            );
            return {
              ...taskIdentity(invocation),
              ...(outputs === undefined ? {} : { outputs }),
              skipReason: 'unchanged',
              status: 'skipped',
            };
          }
          const producers = dependenciesOf(invocation, upstream);
          const force = producers.some((producer) => dirty.has(unitKey(producer.context)));
          return runTask(
            invocation,
            { ...services, ...(force ? { changed: undefined } : {}) },
            producers,
            completed,
            claims,
          );
        },
      );
      result = {
        ...stageResult,
        durationMs: performance.now() - started,
        finishedAt: new Date().toISOString(),
        startedAt,
      };
      await lifecycle.emit('onStageFinish', { runId, stage: result }, { stageId });
    }
    for (const [index, task] of result.tasks.entries()) {
      counts[task.status]++;
      completed.set(unitKey(invocations[index].context), task);
    }
    stopped ||= result.status === 'failed' && stage.failurePolicy !== 'continue-pipeline';
    stages.push(result);
  }

  let result: RunResult = {
    counts,
    durationMs: performance.now() - started,
    finishedAt: new Date().toISOString(),
    runId,
    scheduling,
    stages,
    startedAt,
    status: signal.aborted ? 'cancelled' : counts.failed > 0 ? 'failed' : 'success',
    ...watchInfo,
  };
  if (lifecycle.errors.length > 0) {
    result = { ...result, hookErrors: [...lifecycle.errors] };
  }
  await lifecycle.emit('onRunFinish', result);
  if (lifecycle.errors.length !== (result.hookErrors?.length ?? 0)) {
    result = { ...result, hookErrors: [...lifecycle.errors] };
  }
  if (manifestPath !== undefined) {
    if (
      options.artifacts?.cleanup !== undefined &&
      result.status === 'success' &&
      options.filter?.taskIds === undefined &&
      options.filter?.variantIds === undefined
    ) {
      await reconcileArtifacts(
        cwd,
        manifestPath,
        options.artifacts.cleanup,
        stages.flatMap(({ tasks }) => tasks),
        signal,
      );
    }
    const manifest =
      manifestVersion === 2 ? createDetailedReport(plan, result) : createManifest(plan, result);
    await writeManifest(manifestPath, manifest);
  }
  return result;
}

function dependenciesOf(
  invocation: Invocation,
  upstream: ReadonlyMap<string, readonly Invocation[]>,
): Invocation[] {
  const variant = invocation.context.variant?.id;
  return (invocation.task.consumes ?? []).flatMap((id) =>
    (upstream.get(id) ?? []).filter(
      ({ context }) =>
        variant === undefined || context.variant === undefined || context.variant.id === variant,
    ),
  );
}

function dependencyUnavailable(id: string) {
  return Object.assign(new Error(`Artifacts from task "${id}" are unavailable`), {
    code: 'ARTIFACT_DEPENDENCY_UNAVAILABLE',
  });
}

function listInvocations(
  stage: PlannedStage,
  variants: readonly Variant[],
  context: Omit<TaskContext, 'stageId' | 'taskId' | 'variant'>,
  selected: ReturnType<typeof selectInvocations>,
  cacheDirectory: string | undefined,
  registry: AdapterRegistry,
  limits: ResourceLimits,
): Invocation[] {
  const invocations = stage.tasks.flatMap((task) => {
    const taskContext = { ...context, stageId: stage.id, taskId: task.id };
    const contexts =
      task.scope === 'global'
        ? [taskContext]
        : variants.map((variant) => ({ ...taskContext, variant }));
    return contexts.map((context: TaskContext): Invocation => {
      const active = selected(task.id, context.variant?.id);
      if (active && !registry.has(task.adapter)) {
        invalid(`stage "${stage.id}", task "${task.id}"`, `unknown adapter "${task.adapter}"`);
      }
      if (
        active &&
        task.resourceGroup !== undefined &&
        !Object.hasOwn(limits, task.resourceGroup)
      ) {
        invalid(
          `stage "${stage.id}", task "${task.id}"`,
          `missing limit for resource group "${task.resourceGroup}"`,
        );
      }
      const cache =
        active && task.cache !== undefined
          ? prepareCache(task.cache, cacheDirectory, context)
          : undefined;
      const adapterContext =
        cache === undefined
          ? context
          : { ...context, cacheOutputs: Object.freeze([...cache.outputs]) };
      return { cache, context: Object.freeze(adapterContext), selected: active, task };
    });
  });
  if (cacheDirectory !== undefined) {
    validateStageCaches(invocations.flatMap(({ cache }) => (cache === undefined ? [] : [cache])));
  }
  return invocations;
}

function owner({ stageId, taskId, variant }: TaskContext): string {
  return `task "${stageId}/${taskId}"${variant === undefined ? '' : ` (${variant.id})`}`;
}

async function runStage(
  stage: PlannedStage,
  invocations: readonly Invocation[],
  scheduling: SchedulingInfo,
  signal: AbortSignal,
  lifecycle: Lifecycle,
  run: (invocation: Invocation) => Promise<TaskResult>,
): Promise<StageResult> {
  const results: (TaskResult | undefined)[] = [];
  const scheduler = new StageScheduler(invocations, scheduling);
  let active = 0;
  let completed = Promise.withResolvers<void>();
  let failed = false;
  let stopped = false;
  let failure: { error: unknown } | undefined;

  async function launch(scheduled: ScheduledTask) {
    const { index } = scheduled;
    active++;
    try {
      const result = await run(invocations[index]);
      results[index] = result;
      if (result.status === 'failed') {
        failed = true;
        if (stage.failurePolicy === 'fail-fast') {
          stopped = true;
        }
      }
      await lifecycle.emit('onTaskFinish', result, result);
    } catch (error) {
      failure ??= { error };
      stopped = true;
    } finally {
      scheduler.complete(scheduled);
      active--;
      completed.resolve();
    }
  }

  while (true) {
    while (!stopped && !signal.aborted && active < scheduling.maxConcurrency) {
      const scheduled = scheduler.take();
      if (scheduled === undefined) {
        break;
      }
      void launch(scheduled);
    }
    if (active === 0) {
      break;
    }
    await completed.promise;
    completed = Promise.withResolvers<void>();
  }
  if (failure !== undefined) {
    throw failure.error;
  }
  const inactive = signal.aborted ? 'cancelled' : 'skipped';
  const tasks = invocations.map(
    (invocation, index) => results[index] ?? waitingResult(invocation, inactive, 'fail-fast'),
  );
  const status = tasks.some((task) => task.status === 'cancelled')
    ? 'cancelled'
    : failed
      ? 'failed'
      : 'success';
  return { id: stage.id, status, tasks };
}

async function runTask(
  invocation: Invocation,
  service: Omit<UnitServices, 'reserve' | 'visited'>,
  producers: readonly Invocation[],
  completed: ReadonlyMap<string, TaskResult>,
  claims: ArtifactClaims,
): Promise<TaskResult> {
  const { context, task } = invocation;
  const { signal, variant } = context;
  const { lifecycle, registry, state } = service;
  const identity = taskIdentity(invocation);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const finish = () => ({
    ...identity,
    durationMs: performance.now() - started,
    finishedAt: new Date().toISOString(),
    startedAt,
  });
  const key = unitKey(context);
  const visited = new Set<string>();
  await lifecycle.emit('onTaskStart', { ...identity, startedAt }, identity);
  try {
    signal.throwIfAborted();
    const dependencies = new Map<string, Artifact[]>();
    for (const producer of producers) {
      const result = completed.get(unitKey(producer.context));
      if (
        result?.status !== 'success' &&
        result?.status !== 'cached' &&
        result?.skipReason !== 'unchanged'
      ) {
        throw dependencyUnavailable(producer.task.id);
      }
      const artifacts = dependencies.get(producer.task.id) ?? [];
      artifacts.push(...(result.outputs ?? []));
      dependencies.set(producer.task.id, artifacts);
    }
    for (const id of task.consumes ?? []) {
      if (!dependencies.has(id)) {
        throw dependencyUnavailable(id);
      }
    }
    const merged = registry.mergeTaskOptions(task.adapter, task.options);
    const outcome = await runUnit(
      {
        adapterId: task.adapter,
        cache:
          invocation.cache === undefined
            ? undefined
            : { ...invocation.cache, settings: service.cacheOptions },
        context,
        dependencies,
        environment:
          task.environment === undefined
            ? undefined
            : renderTemplate(task.environment, variant?.values ?? {}),
        options: merged === undefined ? undefined : renderOptions(merged, variant?.values ?? {}),
        path: [],
        taskData: new Map(),
      },
      { ...service, reserve: (paths) => claims.claim(owner(context), paths), visited },
    );
    signal.throwIfAborted();
    for (const step of state.keys()) {
      if (step.startsWith(key.slice(0, -1) + ',') && !visited.has(step)) {
        state.delete(step);
      }
    }
    return {
      ...outcome.output,
      ...(outcome.cacheMiss === undefined ? {} : { cacheMiss: outcome.cacheMiss }),
      ...finish(),
      status: outcome.status === 'unchanged' ? 'skipped' : outcome.status,
    };
  } catch (error) {
    state.set(key, { inputs: state.get(key)?.inputs ?? [] });
    return signal.aborted
      ? { ...finish(), status: 'cancelled' }
      : { ...finish(), error: normalizeError(error), status: 'failed' };
  }
}

function selectionWithDependencies(plan: Plan, filter?: RunFilter) {
  const selected = selectInvocations(plan, filter);
  const required = new Set<string>();
  const tasks = new Map(
    plan.stages.flatMap(({ tasks }) => tasks.map((task) => [task.id, task] as const)),
  );
  const key = (id: string, variantId?: string) => JSON.stringify([id, variantId]);
  function visit(task: PlannedTask, variantId?: string) {
    const identity = key(task.id, variantId);
    if (required.has(identity)) {
      return;
    }
    required.add(identity);
    for (const id of task.consumes ?? []) {
      const producer = tasks.get(id)!;
      if (producer.scope === 'global' || variantId !== undefined) {
        visit(producer, producer.scope === 'global' ? undefined : variantId);
      } else {
        for (const variant of plan.variants) {
          visit(producer, variant.id);
        }
      }
    }
  }
  for (const task of tasks.values()) {
    for (const variantId of task.scope === 'global'
      ? [undefined]
      : plan.variants.map(({ id }) => id)) {
      if (selected(task.id, variantId)) {
        visit(task, variantId);
      }
    }
  }
  return (taskId: string, variantId?: string) => required.has(key(taskId, variantId));
}

function taskIdentity({ context, task }: Invocation) {
  const { runId, stageId, taskId, variant } = context;
  const { adapter, resourceGroup } = task;
  return {
    adapter,
    runId,
    stageId,
    taskId,
    ...(variant && { variantId: variant.id }),
    ...(resourceGroup === undefined ? {} : { resourceGroup }),
  };
}

function waitingResult(
  invocation: Invocation,
  status: 'cancelled' | 'skipped',
  reason: 'fail-fast' | 'stage-failed',
): TaskResult {
  const identity = taskIdentity(invocation);
  if (!invocation.selected) {
    return { ...identity, skipReason: 'filtered', status: 'skipped' };
  }
  if (status === 'cancelled') {
    return { ...identity, status };
  }
  return { ...identity, skipReason: reason, status };
}
