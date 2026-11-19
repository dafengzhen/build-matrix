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
  const base = createManifest(plan, result);
  const allTasks = result.stages.flatMap((stage) => stage.tasks);
  const stages = base.stages.map((stage, index) => {
    const { durationMs, finishedAt, startedAt, tasks } = result.stages[index];
    return {
      id: stage.id,
      status: stage.status,
      ...(startedAt === undefined ? {} : { durationMs, finishedAt, startedAt }),
      tasks: stage.tasks.map((task, taskIndex) => {
        const { resourceGroup } = tasks[taskIndex];
        return resourceGroup === undefined ? task : { ...task, resourceGroup };
      }),
      ...metrics(tasks),
    };
  });
  const { scheduling, watch } = result;
  return {
    ...base,
    metrics: {
      ...metrics(allTasks),
      byAdapter: breakdown(allTasks, 'adapter'),
      byResourceGroup: breakdown(allTasks, 'resourceGroup'),
    },
    schemaVersion: 2,
    stages,
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
  const { counts, durationMs, finishedAt, runId, stages, startedAt, status } = result;
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
    schemaVersion: 1,
    stages: stages.map(({ id, status, tasks }) => ({ id, status, tasks: tasks.map(manifestTask) })),
    startedAt,
    status,
    variants: plan.variants.map(({ id, values }) => ({ id, values })),
  };
}

export async function writeManifest(
  path: string,
  manifest: ManifestV1 | ManifestV2,
): Promise<void> {
  await writeJsonFile(path, manifest, true);
}

function breakdown(
  tasks: readonly TaskResult[],
  field: 'adapter' | 'resourceGroup',
): ReportBreakdown[] {
  const groups = new Map<string, TaskResult[]>();
  for (const task of tasks) {
    const id = task[field];
    if (id === undefined) {
      continue;
    }
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, [task]);
    } else {
      group.push(task);
    }
  }
  return [...groups].map(([id, group]) => ({ id, ...metrics(group) }));
}

function manifestError({ code, message, name, stack }: TaskError): TaskError {
  return {
    message,
    name,
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
  };
}

function manifestTask(task: TaskResult): TaskResult {
  const {
    adapter,
    durationMs,
    error,
    finishedAt,
    metadata,
    outputs,
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
          outputs: outputs.map(({ kind, path }) =>
            kind === undefined ? { path } : { kind, path },
          ),
        }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(error === undefined ? {} : { error: manifestError(error) }),
  };
}

function metrics(tasks: readonly TaskResult[]): ReportMetrics {
  const counts = { cached: 0, cancelled: 0, failed: 0, skipped: 0, success: 0 };
  let artifactCount = 0;
  let taskDurationMs = 0;
  for (const { durationMs, outputs, status } of tasks) {
    counts[status]++;
    artifactCount += outputs?.length ?? 0;
    taskDurationMs += durationMs ?? 0;
  }
  return { artifactCount, counts, taskDurationMs };
}
