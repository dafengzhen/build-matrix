import type { JsonObject, JsonValue, ResourceLimits, Variant } from '../core/types.js';

export interface Adapter<Options = unknown> {
  run(context: TaskContext, options: Options): Promise<AdapterOutput>;
}

export interface AdapterDefinition<Options = unknown> {
  readonly defaults?: JsonValue;
  readonly factory: AdapterFactory<Options>;
}

export type AdapterFactory<Options = unknown> = () => Adapter<Options> | Promise<Adapter<Options>>;

export type AdapterLoader<Options = unknown> = () =>
  | { default: Adapter<Options> }
  | Adapter<Options>
  | Promise<{ default: Adapter<Options> } | Adapter<Options>>;

export interface AdapterOutput {
  readonly metadata?: JsonObject;
  /** Omit to report existing paths from the task's `cache.outputs` declaration. */
  readonly outputs?: readonly Artifact[];
}

export interface Artifact {
  readonly environment?: string;
  readonly kind?: string;
  /** Relative to the task working directory, or an absolute path. */
  readonly path: string;
}

export interface HookFailure {
  readonly error: TaskError;
  readonly hook: keyof LifecycleHooks;
  readonly stageId?: string;
  readonly taskId?: string;
  readonly variantId?: string;
}

export interface LifecycleHooks {
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

export type SkipReason = 'fail-fast' | 'filtered' | 'stage-failed';

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
  run(changedPaths: readonly string[], signal?: AbortSignal): Promise<void>;
  readonly signal: AbortSignal;
}

export interface WatchRunInfo {
  readonly changedPaths: readonly string[];
  readonly number: number;
}
type HookResult = Promise<void> | void;

type RunStart = Pick<RunResult, 'runId' | 'scheduling' | 'startedAt' | 'watch'>;

type StageStart = { readonly runId: string; readonly stageId: string; readonly startedAt: string };

type TaskStart = { readonly startedAt: string } & Pick<
  TaskResult,
  'adapter' | 'resourceGroup' | 'runId' | 'stageId' | 'taskId' | 'variantId'
>;
