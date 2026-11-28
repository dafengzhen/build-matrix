import type {
  DimensionValues,
  Plan,
  PlannedStage,
  PlannedTask,
  TaskCacheDefinition,
} from './types.js';

import { resolveMatrix } from './matrix.js';
import { renderOptions, renderTemplate } from './template.js';
import {
  asArray,
  asNonemptyString,
  asRecord,
  asResourceGroup,
  asResourceLimits,
  checkKeys,
  copyJson,
  invalid,
} from './validation.js';

/** Validate untrusted configuration and make an immutable snapshot for execution. */
export function createPlan(input: unknown): Plan {
  const config = asRecord(input, 'config');
  checkKeys(config, 'config', ['matrix', 'pipeline']);
  const { names, variants } = resolveMatrix(config.matrix);
  const dimensions = Object.fromEntries(names.map((name) => [name, '']));
  const pipeline = asRecord(config.pipeline, 'pipeline');
  checkKeys(pipeline, 'pipeline', ['stages', 'resourceLimits']);
  const resourceLimits =
    pipeline.resourceLimits === undefined
      ? undefined
      : asResourceLimits(pipeline.resourceLimits, 'pipeline.resourceLimits');
  const stageIds = new Set<string>();
  const taskStages = new Map<string, string>();
  const stages = asArray(pipeline.stages, 'pipeline.stages').map((value, index): PlannedStage => {
    const path = `pipeline.stages[${index}]`;
    const stage = asRecord(value, path);
    checkKeys(stage, path, ['id', 'tasks', 'failurePolicy']);
    const stageId = uniqueId(stage.id, `${path}.id`, stageIds);
    const failurePolicy = stage.failurePolicy === undefined ? 'fail-fast' : stage.failurePolicy;
    if (
      failurePolicy !== 'fail-fast' &&
      failurePolicy !== 'continue' &&
      failurePolicy !== 'continue-pipeline'
    ) {
      invalid(`${path}.failurePolicy`, 'expected "fail-fast", "continue" or "continue-pipeline"');
    }
    const tasks = asArray(stage.tasks, `${path}.tasks`).map((value, index): PlannedTask => {
      const taskPath = `${path}.tasks[${index}]`;
      const task = asRecord(value, taskPath);
      checkKeys(task, taskPath, [
        'id',
        'adapter',
        'options',
        'scope',
        'cache',
        'consumes',
        'environment',
        'resourceGroup',
      ]);
      const id = asNonemptyString(task.id, `${taskPath}.id`);
      if (taskStages.has(id)) {
        invalid(`${taskPath}.id`, `duplicate ID "${id}"`);
      }
      taskStages.set(id, stageId);
      const adapter = asNonemptyString(task.adapter, `${taskPath}.adapter`);
      const scope = task.scope === undefined ? 'variant' : task.scope;
      if (scope !== 'variant' && scope !== 'global') {
        invalid(`${taskPath}.scope`, 'expected "variant" or "global"');
      }
      const values = scope === 'variant' ? dimensions : {};
      const environment =
        task.environment === undefined
          ? undefined
          : asNonemptyString(task.environment, `${taskPath}.environment`);
      if (environment !== undefined) {
        renderTemplate(environment, values, `${taskPath}.environment`);
      }
      const cache =
        task.cache === undefined
          ? undefined
          : cacheDefinition(task.cache, `${taskPath}.cache`, values);
      const options =
        task.options === undefined ? undefined : copyJson(task.options, `${taskPath}.options`);
      const consumes =
        task.consumes === undefined
          ? undefined
          : Object.freeze([
              ...new Set(
                asArray(task.consumes, `${taskPath}.consumes`).map((value, index) => {
                  const field = `${taskPath}.consumes[${index}]`;
                  const dependency = asNonemptyString(value, field);
                  const producerStage = taskStages.get(dependency);
                  if (producerStage === undefined || producerStage === stageId) {
                    invalid(field, `expected a task ID from an earlier stage, got "${dependency}"`);
                  }
                  return dependency;
                }),
              ),
            ]);
      const resourceGroup =
        task.resourceGroup === undefined
          ? undefined
          : asResourceGroup(task.resourceGroup, `${taskPath}.resourceGroup`);
      if (options !== undefined) {
        renderOptions(options, values, `${taskPath}.options`);
      }
      return Object.freeze({
        adapter,
        id,
        scope,
        ...(options === undefined ? {} : { options }),
        ...(cache === undefined ? {} : { cache }),
        ...(consumes === undefined ? {} : { consumes }),
        ...(environment === undefined ? {} : { environment }),
        ...(resourceGroup === undefined ? {} : { resourceGroup }),
      });
    });
    return Object.freeze({ failurePolicy, id: stageId, tasks: Object.freeze(tasks) });
  });
  return Object.freeze({
    stages: Object.freeze(stages),
    variants,
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
  });
}

function cacheDefinition(
  input: unknown,
  path: string,
  dimensions: DimensionValues,
): TaskCacheDefinition {
  const cache = asRecord(input, path);
  checkKeys(cache, path, ['version', 'inputs', 'outputs', 'env', 'shared']);
  const version = asNonemptyString(cache.version, `${path}.version`);
  const readPaths = (value: unknown, field: string) =>
    Object.freeze(
      asArray(value, field).map((item, index) => {
        const itemPath = `${field}[${index}]`;
        const template = asNonemptyString(item, itemPath);
        renderTemplate(template, dimensions, itemPath);
        return template;
      }),
    );
  const inputs = readPaths(cache.inputs, `${path}.inputs`);
  const outputs = readPaths(cache.outputs, `${path}.outputs`);
  if (outputs.length === 0) {
    invalid(`${path}.outputs`, 'expected at least one output path');
  }
  const { shared } = cache;
  if (shared !== undefined && typeof shared !== 'boolean') {
    invalid(`${path}.shared`, 'expected a boolean');
  }
  const base = { inputs, outputs, version, ...(shared === undefined ? {} : { shared }) };
  if (cache.env === undefined) {
    return Object.freeze(base);
  }
  const env = asArray(cache.env, `${path}.env`).map((item, index) => {
    const itemPath = `${path}.env[${index}]`;
    const name = asNonemptyString(item, itemPath);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) {
      invalid(itemPath, 'invalid environment variable name');
    }
    return name;
  });
  return Object.freeze({ ...base, env: Object.freeze([...new Set(env)].sort()) });
}

function uniqueId(value: unknown, path: string, ids: Set<string>): string {
  const id = asNonemptyString(value, path);
  if (ids.has(id)) {
    invalid(path, `duplicate ID "${id}"`);
  }
  ids.add(id);
  return id;
}
