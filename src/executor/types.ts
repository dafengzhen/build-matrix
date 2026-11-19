import type { JsonObject, ResourceLimits, Variant } from '../core/types.js';

export interface Adapter<Options = unknown> {
  run(context: TaskContext, options: Options): Promise<AdapterOutput>;
}

export type AdapterLoader<Options = unknown> = () =>
  | { default: Adapter<Options> }
  | Adapter<Options>
  | Promise<{ default: Adapter<Options> } | Adapter<Options>>;

export interface AdapterOutput {
  readonly metadata?: JsonObject;
  readonly outputs?: readonly Artifact[];
}

export interface Artifact {
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
