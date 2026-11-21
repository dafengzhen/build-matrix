import type { DimensionValue, DimensionValues, Variant } from './types.js';

import { renderTemplate } from './template.js';
import {
  asArray,
  asNonemptyString,
  asPositiveInteger,
  asRecord,
  checkKeys,
  invalid,
} from './validation.js';

const defaultMaxVariants = 1000;
const dimensionName = /^[a-zA-Z_][\w-]*$/;
type ExcludeRule = [string, DimensionValue][];

/** Expand in dimension declaration order, applying excludes before explicit includes. */
export function expandMatrix(input: unknown): readonly Variant[] {
  return resolveMatrix(input).variants;
}

export function resolveMatrix(input: unknown) {
  const matrix = asRecord(input, 'matrix');
  checkKeys(matrix, 'matrix', ['dimensions', 'exclude', 'include', 'maxVariants', 'idTemplate']);
  const declared = asRecord(matrix.dimensions, 'matrix.dimensions');
  const dimensions = new Map<string, Set<DimensionValue>>();
  for (const [name, inputValues] of Object.entries(declared)) {
    const path = `matrix.dimensions.${name}`;
    if (!dimensionName.test(name)) {
      invalid(path, 'invalid dimension name');
    }
    const values = asArray(inputValues, path);
    if (values.length === 0) {
      invalid(path, 'expected at least one value');
    }
    dimensions.set(
      name,
      new Set(values.map((value, index) => asDimensionValue(value, `${path}[${index}]`))),
    );
  }

  const limit =
    matrix.maxVariants === undefined
      ? defaultMaxVariants
      : asPositiveInteger(matrix.maxVariants, 'matrix.maxVariants');
  const template =
    matrix.idTemplate === undefined
      ? undefined
      : asNonemptyString(matrix.idTemplate, 'matrix.idTemplate');
  const names = [...dimensions.keys()];
  if (template !== undefined) {
    renderTemplate(
      template,
      Object.fromEntries(names.map((name) => [name, ''])),
      'matrix.idTemplate',
    );
  }
  const excludes = readRules(matrix.exclude, 'exclude', dimensions).map(Object.entries);
  const includes = readRules(matrix.include, 'include', dimensions);
  const variants: Variant[] = [];
  const pendingIncludes = new Map<string, DimensionValues>();
  const combinationKey = (values: DimensionValues) =>
    JSON.stringify(names.map((name) => values[name]));
  for (const included of includes) {
    const values = Object.fromEntries(names.map((name) => [name, included[name]]));
    pendingIncludes.set(combinationKey(values), values);
  }
  const ids = template === undefined ? undefined : new Set<string>();
  function add(values: DimensionValues) {
    if (variants.length === limit) {
      invalid('matrix.maxVariants', `matrix exceeds the limit of ${limit} variants`);
    }

    const id =
      template === undefined
        ? defaultId(names, values)
        : asNonemptyString(
            renderTemplate(template, values, 'matrix.idTemplate'),
            'matrix.idTemplate result',
          );
    if (ids?.has(id)) {
      invalid('matrix.idTemplate', `duplicate variant ID "${id}"`);
    }
    ids?.add(id);
    variants.push(Object.freeze({ id, values: Object.freeze(values) }));
  }

  if (!excludes.some((rule) => rule.length === 0)) {
    const excludeAt = indexExcludes(excludes, dimensions);
    const axes = [...dimensions.values()].map((values) => [...values]);
    if (axes.every((values) => values.length > 0)) {
      expandProduct(axes, excludeAt);
    }
  }
  for (const values of pendingIncludes.values()) {
    add(values);
  }
  return { names, variants: Object.freeze(variants) };

  function expandProduct(
    axes: readonly DimensionValue[][],
    excludeAt: ReadonlyMap<DimensionValue, ExcludeRule[]>[],
  ) {
    const partial = Object.fromEntries(names.map((name, index) => [name, axes[index][0]]));
    // A cursor per axis lets each parent resume after visiting or pruning a branch.
    const nextIndex = axes.map(() => 0);
    let depth = 0;
    while (depth >= 0) {
      if (depth === axes.length) {
        if (pendingIncludes.size > 0) {
          pendingIncludes.delete(combinationKey(partial));
        }
        add({ ...partial });
        depth--;
        continue;
      }
      const axis = axes[depth];
      const index = nextIndex[depth];
      if (index === axis.length) {
        nextIndex[depth] = 0;
        depth--;
        continue;
      }
      nextIndex[depth]++;
      const value = axis[index];
      partial[names[depth]] = value;
      const rules = excludeAt[depth]?.get(value);
      if (!rules?.some((rule) => rule.every(([name, value]) => partial[name] === value))) {
        depth++;
      }
    }
  }
}

function asDimensionValue(value: unknown, path: string): DimensionValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value === 0 ? 0 : value;
  }
  return invalid(path, 'expected a string, finite number or boolean');
}

function defaultId(names: readonly string[], values: DimensionValues): string {
  if (names.length === 0) {
    return 'default';
  }
  return names
    .map((key) => {
      const value = values[key];
      if (typeof value === 'number') {
        return `${key}=~n${value}`;
      }
      if (typeof value === 'boolean') {
        return `${key}=~b${value}`;
      }
      // JSON escaping also preserves strings containing an unpaired UTF-16 surrogate.
      const encoded = encodeURIComponent(JSON.stringify(value).slice(1, -1)).replaceAll('~', '%7E');
      return `${key}=${encoded}`;
    })
    .join(',');
}

function indexExcludes(
  excludes: readonly ExcludeRule[],
  dimensions: ReadonlyMap<string, Set<DimensionValue>>,
) {
  if (excludes.length === 0) {
    return [];
  }
  // Apply single-axis rules first so compound rules can skip eliminated values.
  for (const rule of excludes) {
    if (rule.length === 1) {
      const [[name, value]] = rule;
      dimensions.get(name)!.delete(value);
    }
  }
  const positions = new Map([...dimensions.keys()].map((name, index) => [name, index]));
  const byDepth: Map<DimensionValue, ExcludeRule[]>[] = [];
  for (const rule of excludes) {
    if (rule.length < 2 || rule.some(([name, value]) => !dimensions.get(name)!.has(value))) {
      continue;
    }
    // Check a rule only when its last dimension receives the required value.
    let depth = -1;
    let anchor = 0;
    for (const [index, [name]] of rule.entries()) {
      const position = positions.get(name)!;
      if (position > depth) {
        anchor = index;
        depth = position;
      }
    }
    const [, value] = rule[anchor];
    const byValue = (byDepth[depth] ??= new Map());
    const rules = byValue.get(value);
    if (rules === undefined) {
      byValue.set(value, [rule]);
    } else {
      rules.push(rule);
    }
  }
  return byDepth;
}

function readRules(
  input: unknown,
  field: 'exclude' | 'include',
  dimensions: ReadonlyMap<string, ReadonlySet<DimensionValue>>,
): readonly DimensionValues[] {
  if (input === undefined) {
    return [];
  }
  return asArray(input, `matrix.${field}`).map((item, index) => {
    const path = `matrix.${field}[${index}]`;
    const rule = asRecord(item, path);
    for (const key of Object.keys(rule)) {
      if (!dimensions.has(key)) {
        invalid(`${path}.${key}`, 'unknown dimension');
      }
    }
    if (field === 'include' && Object.keys(rule).length !== dimensions.size) {
      invalid(path, 'expected a value for every dimension');
    }
    return Object.fromEntries(
      Object.entries(rule).map(([key, value]) => [key, asDimensionValue(value, `${path}.${key}`)]),
    );
  });
}
