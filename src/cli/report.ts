import type { ManifestV2, RunResult } from '../executor/index.js';

export function formatResult(result: RunResult, detailed?: ManifestV2): string {
  const lines: string[] = [];
  if (result.watch !== undefined) {
    const { changedPaths, number } = result.watch;
    lines.push(
      `Watch run ${number} — ${changedPaths.length === 0 ? 'initial build' : changedPaths.join(', ')}`,
    );
  }
  lines.push(`Run ${result.runId} — ${result.status} (${Math.round(result.durationMs)} ms)`);
  for (const [index, stage] of result.stages.entries()) {
    const summary = detailed?.stages[index];
    const duration =
      summary?.durationMs === undefined ? '' : ` (${Math.round(summary.durationMs)} ms)`;
    lines.push(`[${stage.status}] ${stage.id}${duration}`);
    for (const task of stage.tasks) {
      const variant = task.variantId === undefined ? '' : ` (${task.variantId})`;
      const error = task.error === undefined ? '' : `: ${task.error.message}`;
      const details =
        detailed === undefined
          ? []
          : [
              task.resourceGroup,
              task.skipReason,
              task.durationMs === undefined ? undefined : `${Math.round(task.durationMs)} ms`,
            ].filter((item) => item !== undefined);
      const annotation = details.length === 0 ? '' : ` [${details.join(', ')}]`;
      lines.push(`  [${task.status}] ${task.taskId}${variant}${annotation}${error}`);
      if (detailed !== undefined) {
        if (task.cacheMiss !== undefined) {
          lines.push(`    Cache miss — ${task.cacheMiss.join(', ')}`);
        }
        for (const artifact of task.outputs ?? []) {
          lines.push(`    ${artifact.path}${artifact.kind ? ` (${artifact.kind})` : ''}`);
        }
      }
    }
  }
  lines.push(formatCounts(result.counts));
  if (detailed !== undefined) {
    lines.push(`${detailed.metrics.artifactCount} artifacts`);
    for (const group of detailed.metrics.byAdapter) {
      lines.push(`Adapter ${group.id} — ${formatCounts(group.counts)}`);
    }
    for (const group of detailed.metrics.byResourceGroup) {
      const limit = detailed.scheduling?.resourceLimits[group.id];
      lines.push(
        `Resource group ${group.id}${limit === undefined ? '' : ` (limit ${limit})`} — ${formatCounts(group.counts)}`,
      );
    }
    for (const failure of detailed.hookErrors) {
      lines.push(`Hook ${failure.hook} — ${failure.error.message}`);
    }
  }
  return lines.join('\n');
}

function formatCounts({
  cached,
  cancelled,
  failed,
  skipped,
  success,
}: RunResult['counts']): string {
  return `${success} succeeded, ${failed} failed, ${skipped} skipped, ${cancelled} cancelled, ${cached} cached`;
}
