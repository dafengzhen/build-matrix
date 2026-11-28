import type { Plan } from '../core/types.js';

import { asArray, asNonemptyString, invalid } from '../core/validation.js';

export interface RunFilter {
  readonly taskIds?: readonly string[];
  readonly variantIds?: readonly string[];
}

export function selectInvocations(plan: Plan, filter?: RunFilter) {
  const variants = selectedIds(
    filter?.variantIds,
    () => plan.variants.map((variant) => variant.id),
    'filter.variantIds',
  );
  const tasks = selectedIds(
    filter?.taskIds,
    () => plan.stages.flatMap((stage) => stage.tasks.map((task) => task.id)),
    'filter.taskIds',
  );
  const selected = (taskId: string, variantId?: string) =>
    (tasks === undefined || tasks.has(taskId)) &&
    (variants === undefined || variantId === undefined || variants.has(variantId));
  if (tasks === undefined && variants === undefined) {
    return selected;
  }

  const taskList = plan.stages.flatMap(({ tasks }) => tasks);
  const scopes = new Map(taskList.map(({ id, scope }) => [id, scope]));
  const globalVariants = [undefined];
  const variantIds = plan.variants.map(({ id }) => id);
  const required = new Map<string, Set<string | undefined>>();
  function include(taskId: string, ids: readonly (string | undefined)[]) {
    let set = required.get(taskId);
    if (set === undefined) {
      set = new Set();
      required.set(taskId, set);
    }
    for (const id of ids) {
      set.add(id);
    }
  }

  // Every producer is in an earlier stage, so all requests reach it before its turn.
  for (const task of taskList.reverse()) {
    const { consumes } = task;
    if (!consumes?.length) {
      continue;
    }
    const needed = required.get(task.id);
    const ids = task.scope === 'global' ? globalVariants : variantIds;
    for (const id of ids) {
      if (!selected(task.id, id) && !needed?.has(id)) {
        continue;
      }
      for (const producer of consumes) {
        include(
          producer,
          scopes.get(producer) === 'global' ? globalVariants : id === undefined ? variantIds : [id],
        );
      }
    }
  }
  return (taskId: string, variantId?: string) =>
    selected(taskId, variantId) || (required.get(taskId)?.has(variantId) ?? false);
}

function selectedIds(
  requested: readonly string[] | undefined,
  known: () => Iterable<string>,
  path: string,
) {
  if (requested === undefined) {
    return undefined;
  }
  const available = new Set(known());
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
