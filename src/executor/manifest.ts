import type { Plan, Variant } from '../core/types.js';
import type {
  HookFailure,
  RunResult,
  SchedulingInfo,
  StageResult,
  TaskError,
  TaskResult,
  WatchRunInfo,
} from './types.js';

import { writeJsonFile } from './json-file.js';
import { createTaskCounts } from './result.js';

export interface ManifestV1 {
  readonly counts: RunResult['counts'];
  readonly durationMs: RunResult['durationMs'];
  readonly finishedAt: RunResult['finishedAt'];
  readonly plan: {
    readonly stageCount: number;
    readonly taskCount: number;
    readonly variantCount: number;
  };
  readonly runId: RunResult['runId'];
  readonly schemaVersion: 1;
  readonly stages: readonly StageResult[];
  readonly startedAt: RunResult['startedAt'];
  readonly status: RunResult['status'];
  readonly variants: readonly Variant[];
}

export interface ManifestV2 extends Omit<ManifestV1, 'schemaVersion' | 'stages'> {
  readonly hookErrors: readonly HookFailure[];
  readonly metrics: {
    readonly byAdapter: readonly ReportBreakdown[];
    readonly byResourceGroup: readonly ReportBreakdown[];
  } & ReportMetrics;
  readonly scheduling?: SchedulingInfo;
  readonly schemaVersion: 2;
  readonly stages: readonly (ReportMetrics & StageResult)[];
  readonly watch?: WatchRunInfo;
}

type GroupMetrics = { id: string } & Metrics;

type Metrics = ReturnType<typeof emptyMetrics>;

interface ReportBreakdown extends ReportMetrics {
  readonly id: string;
}
interface ReportMetrics {
  readonly artifactCount: number;
  readonly counts: RunResult['counts'];
  readonly taskDurationMs: number;
}

/** Include scheduler, artifact, timing, watch and hook diagnostics in the version 2 report. */
export function createDetailedReport(plan: Plan, result: RunResult): ManifestV2 {
  const totals = emptyMetrics();
  const byAdapter = new Map<string, GroupMetrics>();
  const byResourceGroup = new Map<string, GroupMetrics>();
  const stages = result.stages.map(({ durationMs, finishedAt, id, startedAt, status, tasks }) => {
    const metrics = emptyMetrics();
    const projected = tasks.map((task) => {
      const { adapter, resourceGroup } = task;
      recordTask(metrics, task);
      recordTask(totals, task);
      recordTask(groupMetrics(byAdapter, adapter), task);
      if (resourceGroup !== undefined) {
        recordTask(groupMetrics(byResourceGroup, resourceGroup), task);
      }
      return manifestTask(task, true);
    });
    return {
      id,
      status,
      ...(startedAt === undefined ? {} : { durationMs, finishedAt, startedAt }),
      tasks: projected,
      ...metrics,
    };
  });
  const { scheduling, watch } = result;
  return {
    ...createReport(plan, result, 2, stages),
    metrics: {
      ...totals,
      byAdapter: [...byAdapter.values()],
      byResourceGroup: [...byResourceGroup.values()],
    },
    ...(scheduling === undefined
      ? {}
      : {
          scheduling: {
            maxConcurrency: scheduling.maxConcurrency,
            resourceLimits: { ...scheduling.resourceLimits },
          },
        }),
    hookErrors: (result.hookErrors ?? []).map(({ error, hook, stageId, taskId, variantId }) => ({
      hook,
      ...(stageId === undefined ? {} : { stageId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(variantId === undefined ? {} : { variantId }),
      error: manifestError(error),
    })),
    ...(watch === undefined
      ? {}
      : { watch: { changedPaths: [...watch.changedPaths], number: watch.number } }),
  };
}

/** Project an execution report into the stable version 1 JSON format. */
export function createManifest(plan: Plan, result: RunResult): ManifestV1 {
  const stages = result.stages.map(({ id, status, tasks }) => ({
    id,
    status,
    tasks: tasks.map((task) => manifestTask(task)),
  }));
  return createReport(plan, result, 1, stages);
}

export async function writeManifest(
  path: string,
  manifest: ManifestV1 | ManifestV2,
): Promise<void> {
  await writeJsonFile(path, manifest, true);
}

function createReport<Version extends 1 | 2, Stage extends StageResult>(
  plan: Plan,
  result: RunResult,
  schemaVersion: Version,
  stages: readonly Stage[],
) {
  const { counts, durationMs, finishedAt, runId, startedAt, status } = result;
  return {
    counts: {
      cached: counts.cached,
      cancelled: counts.cancelled,
      failed: counts.failed,
      skipped: counts.skipped,
      success: counts.success,
    },
    durationMs,
    finishedAt,
    plan: {
      stageCount: plan.stages.length,
      taskCount: plan.stages.reduce((count, stage) => count + stage.tasks.length, 0),
      variantCount: plan.variants.length,
    },
    runId,
    schemaVersion,
    stages,
    startedAt,
    status,
    variants: plan.variants.map(({ id, values }) => ({ id, values })),
  };
}

function emptyMetrics() {
  return { artifactCount: 0, counts: createTaskCounts(), taskDurationMs: 0 };
}

function groupMetrics(groups: Map<string, GroupMetrics>, id: string): GroupMetrics {
  let metrics = groups.get(id);
  if (metrics === undefined) {
    metrics = { id, ...emptyMetrics() };
    groups.set(id, metrics);
  }
  return metrics;
}

function manifestError({ code, message, name, stack }: TaskError): TaskError {
  return {
    message,
    name,
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
  };
}

function manifestTask(task: TaskResult, detailed = false): TaskResult {
  const {
    adapter,
    durationMs,
    error,
    finishedAt,
    metadata,
    outputs,
    resourceGroup,
    runId,
    skipReason,
    stageId,
    startedAt,
    status,
    taskId,
    variantId,
  } = task;
  return {
    adapter,
    runId,
    stageId,
    status,
    taskId,
    ...(variantId === undefined ? {} : { variantId }),
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(outputs === undefined
      ? {}
      : {
          outputs: outputs.map(({ environment, kind, path }) => ({
            ...(environment === undefined ? {} : { environment }),
            ...(kind === undefined ? {} : { kind }),
            path,
          })),
        }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(error === undefined ? {} : { error: manifestError(error) }),
    ...(detailed && resourceGroup !== undefined ? { resourceGroup } : {}),
  };
}

function recordTask(metrics: Metrics, { durationMs, outputs, status }: TaskResult) {
  metrics.counts[status]++;
  metrics.artifactCount += outputs?.length ?? 0;
  metrics.taskDurationMs += durationMs ?? 0;
}
