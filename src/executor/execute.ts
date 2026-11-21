import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { resolve } from 'node:path';

import type {
  JsonValue,
  Plan,
  PlannedStage,
  PlannedTask,
  ResourceLimits,
  Variant,
} from '../core/types.js';
import type { CacheOptions } from './cache.js';
import type { RunFilter } from './filter.js';
import type { AdapterRegistry } from './registry.js';
import type {
  LifecycleHooks,
  Logger,
  RunResult,
  SchedulingInfo,
  StageResult,
  TaskContext,
  TaskResult,
  TaskStatus,
  WatchRunInfo,
} from './types.js';

import { renderOptions } from '../core/template.js';
import {
  asNonemptyString,
  asPositiveInteger,
  asResourceLimits,
  invalid,
} from '../core/validation.js';
import {
  defaultCacheDirectory,
  prepareCache,
  probeTaskCache,
  reportDeclaredArtifacts,
  saveTaskCache,
  validateStageCaches,
} from './cache.js';
import { selectInvocations } from './filter.js';
import { createLifecycle } from './lifecycle.js';
import { createDetailedReport, createManifest, writeManifest } from './manifest.js';
import { createDefaultRegistry } from './registry.js';
import { normalizeError, normalizeOutput } from './result.js';

export interface ExecuteOptions {
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
  readonly cache?: ReturnType<typeof prepareCache>;
  readonly context: TaskContext;
  readonly selected: boolean;
  readonly task: PlannedTask;
}

const quietLogger: Logger = { error() {}, info() {} };
type Lifecycle = ReturnType<typeof createLifecycle>;

interface ResourceQueue {
  active: number;
  readonly indices: number[];
  readonly limit: number;
  next: number;
}

/** Execute a plan produced by createPlan, retaining declaration order in the report. */
export function executePlan(plan: Plan, options: ExecuteOptions = {}): Promise<RunResult> {
  return runPlan(plan, options);
}

export async function runPlan(
  plan: Plan,
  options: ExecuteOptions,
  watch?: WatchRunInfo,
): Promise<RunResult> {
  const registry = options.registry ?? createDefaultRegistry();
  const concurrency =
    options.maxConcurrency === undefined
      ? 1
      : asPositiveInteger(options.maxConcurrency, 'maxConcurrency');
  const cwd =
    options.cwd === undefined ? process.cwd() : resolve(asNonemptyString(options.cwd, 'cwd'));
  const signal = options.signal ?? new AbortController().signal;
  const logger = options.logger ?? quietLogger;
  const selected = selectInvocations(plan, options.filter);
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
      : resolve(
          cwd,
          asNonemptyString(options.cache?.directory ?? defaultCacheDirectory, 'cache.directory'),
        );
  const manifestPath =
    options.manifestPath === undefined
      ? undefined
      : resolve(cwd, asNonemptyString(options.manifestPath, 'manifestPath'));
  if (cacheDirectory?.includes('\0')) {
    invalid('cache.directory', 'path contains a NUL character');
  }
  if (manifestPath?.includes('\0')) {
    invalid('manifestPath', 'path contains a NUL character');
  }
  const manifestVersion = options.manifestVersion ?? 1;
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    invalid('manifestVersion', 'expected 1 or 2');
  }
  const runId = randomUUID();
  const planned = plan.stages.map((stage) => ({
    invocations: listInvocations(
      stage,
      plan.variants,
      { cwd, logger, runId, signal },
      selected,
      cacheDirectory,
      registry,
      resourceLimits,
    ),
    stage,
  }));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const counts: Record<TaskStatus, number> = {
    cached: 0,
    cancelled: 0,
    failed: 0,
    skipped: 0,
    success: 0,
  };
  const stages: StageResult[] = [];
  const watchInfo = watch === undefined ? {} : { watch };
  await lifecycle.emit('onRunStart', { runId, scheduling, startedAt, ...watchInfo });

  for (const { invocations, stage } of planned) {
    const inactive = signal.aborted ? 'cancelled' : counts.failed > 0 ? 'skipped' : undefined;
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
        registry,
        scheduling,
        signal,
        lifecycle,
      );
      result = {
        ...stageResult,
        durationMs: performance.now() - started,
        finishedAt: new Date().toISOString(),
        startedAt,
      };
      await lifecycle.emit('onStageFinish', { runId, stage: result }, { stageId });
    }
    for (const task of result.tasks) {
      counts[task.status]++;
    }
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
    const manifest =
      manifestVersion === 2 ? createDetailedReport(plan, result) : createManifest(plan, result);
    await writeManifest(manifestPath, manifest);
  }
  return result;
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

async function loadAdapter(registry: AdapterRegistry, id: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => cancelled.reject(signal.reason));
  try {
    return await Promise.race([registry.load(id), cancelled.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

function mergeOptions(
  defaults: JsonValue | undefined,
  options: JsonValue | undefined,
): JsonValue | undefined {
  if (
    typeof defaults === 'object' &&
    defaults !== null &&
    !Array.isArray(defaults) &&
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options)
  ) {
    return { ...defaults, ...options };
  }
  return options === undefined ? defaults : options;
}

async function runStage(
  stage: PlannedStage,
  invocations: readonly Invocation[],
  registry: AdapterRegistry,
  scheduling: SchedulingInfo,
  signal: AbortSignal,
  lifecycle: Lifecycle,
): Promise<StageResult> {
  const results: (TaskResult | undefined)[] = [];
  const queues = new Map<string | undefined, ResourceQueue>();
  invocations.forEach(({ selected, task }, index) => {
    if (!selected) {
      return;
    }
    const group = task.resourceGroup;
    let queue = queues.get(group);
    if (queue === undefined) {
      queue = {
        active: 0,
        indices: [],
        limit: group === undefined ? scheduling.maxConcurrency : scheduling.resourceLimits[group],
        next: 0,
      };
      queues.set(group, queue);
    }
    queue.indices.push(index);
  });
  let active = 0;
  let completed = Promise.withResolvers<void>();
  let failed = false;
  let stopped = false;
  let failure: { error: unknown } | undefined;

  async function launch(queue: ResourceQueue) {
    const index = queue.indices[queue.next++];
    queue.active++;
    active++;
    try {
      const result = await runTask(invocations[index], registry, lifecycle);
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
      queue.active--;
      active--;
      completed.resolve();
    }
  }

  while (true) {
    while (!stopped && !signal.aborted && active < scheduling.maxConcurrency) {
      let eligible: ResourceQueue | undefined;
      for (const queue of queues.values()) {
        if (
          queue.active < queue.limit &&
          queue.next < queue.indices.length &&
          (eligible === undefined || queue.indices[queue.next] < eligible.indices[eligible.next])
        ) {
          eligible = queue;
        }
      }
      if (eligible === undefined) {
        break;
      }
      void launch(eligible);
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
  registry: AdapterRegistry,
  lifecycle: Lifecycle,
): Promise<TaskResult> {
  const { cache, context, task } = invocation;
  const { signal, variant } = context;
  const identity = taskIdentity(invocation);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const finish = () => ({
    ...identity,
    durationMs: performance.now() - started,
    finishedAt: new Date().toISOString(),
    startedAt,
  });
  const merged = mergeOptions(registry.getDefaults(task.adapter), task.options);
  const options = merged === undefined ? undefined : renderOptions(merged, variant?.values ?? {});
  await lifecycle.emit('onTaskStart', { ...identity, startedAt }, identity);
  try {
    signal.throwIfAborted();
    const probe =
      cache === undefined ? undefined : await probeTaskCache(cache, context, task.adapter, options);
    signal.throwIfAborted();
    let output = probe?.hit;
    const status = output === undefined ? 'success' : 'cached';
    if (output === undefined) {
      try {
        const adapter = await loadAdapter(registry, task.adapter, signal);
        signal.throwIfAborted();
        output = normalizeOutput(await adapter.run(context, options));
      } catch (error) {
        signal.throwIfAborted();
        return { ...finish(), error: normalizeError(error), status: 'failed' };
      }
    }
    signal.throwIfAborted();
    const reported =
      cache === undefined ? output : await reportDeclaredArtifacts(cache, output, context);
    signal.throwIfAborted();
    const result: TaskResult = { ...reported, ...finish(), status };
    if (status === 'success' && cache !== undefined && probe !== undefined) {
      try {
        await saveTaskCache(cache, probe, context, task.adapter, options, output);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }
    return result;
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
    return { ...finish(), status: 'cancelled' };
  }
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
