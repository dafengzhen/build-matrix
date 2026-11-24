import type {
  JsonObject,
  JsonValue,
  ResourceLimits,
  TaskCacheDefinition,
  Variant,
} from '../core/types.js';
import type { AdapterRegistry } from './registry.js';

export interface Adapter<Options = unknown, Context extends TaskContext = AdapterContext> {
  dispose?(): Awaitable<void>;
  /** Discover additional inputs before a cache lookup or a watched build. */
  prepare?(context: Context, options: Options): Awaitable<AdapterPreparation | void>;
  run?(context: Context, options: Options): Awaitable<AdapterOutput>;
}

export interface AdapterContext extends TaskContext {
  readonly artifacts: ArtifactContext;
  readonly cacheEnabled: boolean;
  readonly environment?: string;
  readonly runData: Map<unknown, unknown>;
  readonly stepPath: readonly string[];
  readonly taskData: Map<unknown, unknown>;
  trackInputs(paths: readonly string[], timing?: InputDiscovery): Promise<void>;
  readonly watching: boolean;
}

export type AdapterDefinition<
  Options = unknown,
  Scope extends 'invocation' | undefined = 'invocation' | undefined,
> = {
  readonly defaults?: JsonValue;
  /** Set false when the factory provides defaults to an adapter that merges its own options. */
  readonly mergeDefaults?: false;
  /** Load the adapter before probing the cache to call adapter.prepare(). */
  readonly prepare?: true;
} & (Scope extends 'invocation'
  ? { readonly factory: InvocationAdapterFactory<Options>; readonly scope: 'invocation' }
  : { readonly factory: AdapterFactory<Options>; readonly scope?: undefined });
export type AdapterFactory<Options = unknown> = () => Awaitable<Adapter<Options>>;

export type AdapterLoader<Options = unknown> = () =>
  | { default: Adapter<Options> }
  | Adapter<Options>
  | Promise<{ default: Adapter<Options> } | Adapter<Options>>;

export type AdapterMiddleware = (
  invocation: { readonly context: AdapterContext; readonly options: JsonValue | undefined },
  next: () => Promise<AdapterOutput>,
) => Awaitable<AdapterOutput>;

export interface AdapterOutput {
  readonly metadata?: JsonObject;
  /** Omit to report existing paths from the task's `cache.outputs` declaration. */
  readonly outputs?: readonly Artifact[];
}

export interface AdapterPlugin {
  readonly middleware?: readonly AdapterMiddleware[];
  setup?(registry: AdapterRegistry): void;
}

export interface AdapterPreparation {
  /** Set false to bypass the task cache, or supply an additional cache key. */
  readonly cacheKey?: false | string;
  /** Extra input paths, including paths that have not been created yet. */
  readonly inputs?: readonly string[];
  run?(): Awaitable<AdapterOutput>;
  /** Dependencies are local step IDs and execute before their consumers. */
  readonly steps?: readonly AdapterStep[];
}

export interface AdapterStep {
  readonly adapter?: Adapter | string;
  readonly cache?: TaskCacheDefinition;
  readonly dependsOn?: readonly string[];
  readonly environment?: string;
  readonly id: string;
  readonly inputs?: readonly string[];
  readonly options?: JsonValue;
  run?(context: AdapterContext): Awaitable<AdapterOutput>;
}

export interface Artifact {
  readonly environment?: string;
  readonly kind?: string;
  /** Relative to the task working directory, or an absolute path. */
  readonly path: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
}

export interface ArtifactContext {
  /** Artifacts from declared upstream tasks and completed sibling steps. */
  get(id: string): readonly Artifact[];
  register(artifact: Artifact): void;
  /** Reserve a destination before a direct write. */
  reserve(path: string): Promise<void>;
  /** Get a temporary path to write. The executor publishes it on success. */
  stage(artifact: Artifact): Promise<string>;
  validate(artifact: Artifact): Promise<Artifact>;
}

export interface HookFailure {
  readonly error: TaskError;
  readonly hook: keyof LifecycleHooks;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly variantId?: string;
}

export interface InputDiscovery {
  /** Indicate that these inputs may have been read already. */
  readonly late?: boolean;
}

export type InvocationAdapterFactory<Options = unknown> = (
  context: AdapterContext,
) => Awaitable<Adapter<Options>>;

export interface LifecycleHooks {
  onAdapterFinish?(
    event: {
      readonly cacheMiss?: readonly string[];
      readonly error?: TaskError;
      readonly status: TaskStatus;
    } & AdapterEvent,
  ): HookResult;
  onAdapterStart?(event: AdapterEvent): HookResult;
  onRunFinish?(result: RunResult): HookResult;
  onRunStart?(event: RunStart): HookResult;
  onStageFinish?(event: { readonly runId: string; readonly stage: StageResult }): HookResult;
  onStageStart?(event: StageStart): HookResult;
  onTaskFinish?(result: TaskResult): HookResult;
  onTaskStart?(event: TaskStart): HookResult;
}
export interface Logger {
  error(message: string): void;
  info(message: string): void;
}
export interface RunResult {
  readonly counts: Readonly<Record<TaskStatus, number>>;
  readonly durationMs: number;
  readonly finishedAt: string;
  readonly hookErrors?: readonly HookFailure[];
  readonly runId: string;
  readonly scheduling?: SchedulingInfo;
  readonly stages: readonly StageResult[];
  readonly startedAt: string;
  readonly status: 'cancelled' | 'failed' | 'success';
  readonly watch?: WatchRunInfo;
}

export interface SchedulingInfo {
  readonly maxConcurrency: number;
  readonly resourceLimits: ResourceLimits;
}

export type SkipReason = 'fail-fast' | 'filtered' | 'stage-failed' | 'unchanged';

export interface StageResult {
  readonly durationMs?: number;
  readonly finishedAt?: string;
  readonly id: string;
  readonly startedAt?: string;
  readonly status: StageStatus;
  readonly tasks: readonly TaskResult[];
}

export type StageStatus = Exclude<TaskStatus, 'cached'>;
export interface TaskContext {
  /** Rendered cache output paths relative to cwd, when the task declares a cache. */
  readonly cacheOutputs?: readonly string[];
  readonly cwd: string;
  readonly logger: Logger;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly stageId: string;
  readonly taskId: string;
  /** Register input files as soon as they are known during a watched run. */
  readonly trackInputs?: (paths: readonly string[], timing?: InputDiscovery) => Promise<void>;
  readonly variant?: Variant;
}

export interface TaskError {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export interface TaskResult extends AdapterOutput {
  readonly adapter: string;
  readonly cacheMiss?: readonly string[];
  readonly durationMs?: number;
  readonly error?: TaskError;
  readonly finishedAt?: string;
  readonly resourceGroup?: string;
  readonly runId: string;
  readonly skipReason?: SkipReason;
  readonly stageId: string;
  readonly startedAt?: string;
  readonly status: TaskStatus;
  readonly taskId: string;
  readonly variantId?: string;
}

export type TaskStatus = 'cached' | 'cancelled' | 'failed' | 'skipped' | 'success';
export interface WatchAdapter {
  watch(context: WatchContext): Promise<void>;
}

export type WatchChange =
  | { readonly from: string; readonly kind: 'renamed'; readonly path: string }
  | { readonly kind: 'added' | 'deleted' | 'modified'; readonly path: string };

export interface WatchContext {
  readonly cwd: string;
  readonly debounceMs?: number;
  /** Check whether an absolute path should be excluded from watching. */
  ignore(path: string): boolean;
  /** Absolute paths to watch. */
  readonly paths: readonly string[];
  readonly pollIntervalMs?: number;
  /**
   * Pass an empty list for the initial run and cwd-relative paths for subsequent runs.
   * Await each run before starting another. The optional signal can cancel the active run.
   */
  run(
    changedPaths: readonly string[],
    signal?: AbortSignal,
    trackInputs?: TaskContext['trackInputs'],
    changes?: readonly WatchChange[],
  ): Promise<void>;
  readonly signal: AbortSignal;
  /** Absolute dynamic paths, replaced as adapters rediscover their dependencies. */
  trackedPaths?(): readonly string[];
}

export interface WatchRunInfo {
  readonly changedPaths: readonly string[];
  readonly changes?: readonly WatchChange[];
  readonly number: number;
}
type AdapterEvent = {
  readonly environment?: string;
  readonly stepPath: readonly string[];
  readonly variantId?: string;
} & Pick<TaskContext, 'runId' | 'stageId' | 'taskId'>;
type Awaitable<T> = Promise<T> | T;
type HookResult = Promise<void> | void;

type RunStart = Pick<RunResult, 'runId' | 'scheduling' | 'startedAt' | 'watch'>;

type StageStart = { readonly runId: string; readonly stageId: string; readonly startedAt: string };

type TaskStart = { readonly startedAt: string } & Pick<
  TaskResult,
  'adapter' | 'resourceGroup' | 'runId' | 'stageId' | 'taskId' | 'variantId'
>;
