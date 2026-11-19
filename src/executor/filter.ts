import type { Plan } from '../core/types.js';

import { asArray, asNonemptyString, invalid } from '../core/validation.js';

export interface RunFilter {
  readonly taskIds?: readonly string[];
  readonly variantIds?: readonly string[];
}

export function selectInvocations(plan: Plan, filter?: RunFilter) {
  const variants = selectedIds(
    filter?.variantIds,
    plan.variants.map((variant) => variant.id),
    'filter.variantIds',
  );
  const tasks = selectedIds(
    filter?.taskIds,
    plan.stages.flatMap((stage) => stage.tasks.map((task) => task.id)),
    'filter.taskIds',
  );
  return (taskId: string, variantId?: string) =>
    (tasks === undefined || tasks.has(taskId)) &&
    (variants === undefined || variantId === undefined || variants.has(variantId));
}

function selectedIds(
  requested: readonly string[] | undefined,
  known: Iterable<string>,
  path: string,
) {
  if (requested === undefined) {
    return undefined;
  }
  const available = new Set(known);
  const selected = new Set<string>();
  for (const value of asArray(requested, path)) {
    const id = asNonemptyString(value, path);
    if (!available.has(id)) {
      invalid(path, `unknown ID "${id}"`);
    }
    selected.add(id);
  }
  return selected;
}
