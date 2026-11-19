import type { DimensionValues, JsonValue } from '@dafengzhen/build-matrix';

import {
  ConfigurationError,
  createPlan,
  expandMatrix,
  renderTemplate,
} from '@dafengzhen/build-matrix';
import { expect, it } from 'vitest';

it('expands empty, single and multiple dimensions in declaration order', () => {
  expect(expandMatrix({ dimensions: {} })).toStrictEqual([{ id: 'default', values: {} }]);
  const single = expandMatrix({ dimensions: { mode: ['prod', 'dev', 'prod'] } });
  expect(single.map((variant) => variant.id)).toStrictEqual(['mode=prod', 'mode=dev']);

  const matrix = {
    dimensions: { format: ['esm', 'cjs'], runtime: ['node', 'browser'] },
    exclude: [{ format: 'cjs', runtime: 'browser' }],
    idTemplate: '{runtime}-{format}',
    include: [
      { format: 'esm', runtime: 'node' },
      { format: 'cjs', runtime: 'browser' },
      { format: 'esm', runtime: 'edge' },
    ],
    maxVariants: 5,
  };
  const expanded = expandMatrix(matrix);
  expect(expanded.map((variant) => variant.id)).toStrictEqual([
    'node-esm',
    'browser-esm',
    'node-cjs',
    'browser-cjs',
    'edge-esm',
  ]);
  expect(expandMatrix(matrix)).toStrictEqual(expanded);
  expect(Object.keys(expanded[4].values)).toStrictEqual(['format', 'runtime']);
  expect(
    Object.isFrozen(expanded) &&
      Object.isFrozen(expanded[0]) &&
      Object.isFrozen(expanded[0].values),
  ).toBeTruthy();
});

it('matches all exclusion keys and applies the limit to unique final variants', () => {
  const matrix = {
    dimensions: { first: ['a', 'b'], second: [1, 2] },
    exclude: [{ first: 'b' }, { first: 'a', second: 2 }],
    include: [{ first: 'a', second: 1 }],
    maxVariants: 1,
  };
  expect(expandMatrix(matrix).map((variant) => variant.values)).toStrictEqual([
    { first: 'a', second: 1 },
  ]);
  expect(expandMatrix({ ...matrix, exclude: [{}], include: [] })).toStrictEqual([]);
  expect(() => expandMatrix({ ...matrix, include: [{ first: 'c', second: 1 }] })).toThrow(
    /maxVariants/,
  );
  expect(() =>
    expandMatrix({ dimensions: { mode: Array.from({ length: 1001 }, (_, index) => index) } }),
  ).toThrow(/1000 variants/);
});

it('validates axes, rules and names, with distinct IDs for mixed and escaped values', () => {
  const dimensions = {
    value: ['1', 1, true, 'true', '', 'a,b=c', '%', '~n1', '\ud800', '\\ud800'],
  };
  const variants = expandMatrix({ dimensions });
  expect(new Set(variants.map((variant) => variant.id)).size).toBe(dimensions.value.length);
  for (const [matrix, pattern] of [
    [{ dimensions: { mode: [] } }, /at least one value/],
    [{ dimensions: { mode: [Infinity] } }, /finite number/],
    [{ dimensions: { 'bad name': ['ok'] } }, /invalid dimension name/],
    [{ dimensions, include: [{}] }, /every dimension/],
    [{ dimensions, exclude: [{ unknown: 1 }] }, /unknown dimension/],
    [{ dimensions, maxVariants: 0 }, /positive safe integer/],
    [{ dimensions, idTemplate: '{value}' }, /duplicate variant ID/],
    [{ dimensions, exclude: [{}], idTemplate: '{wrong}' }, /unknown dimension/],
  ]) {
    const expand = () => expandMatrix(matrix);
    expect(expand).toThrow(ConfigurationError);
    expect(expand).toThrow(pattern);
  }
  const values: DimensionValues = JSON.parse('{"__proto__":"safe","mode":"{other}"}');
  expect(renderTemplate('{__proto__}/{{mode}}/{mode}', values)).toBe('safe/{mode}/{other}');
});

it('normalizes pipeline defaults and snapshots JSON options before any execution', () => {
  const flag = { flag: true };
  const options = { args: ['{mode}', flag] };
  const config = {
    matrix: { dimensions: { mode: ['prod'] } },
    pipeline: { stages: [{ id: 'build', tasks: [{ adapter: 'test', id: 'bundle', options }] }] },
  };
  const plan = createPlan(config);
  flag.flag = false;
  const [stage] = plan.stages;
  expect(stage.failurePolicy).toBe('fail-fast');
  expect(stage.tasks[0].scope).toBe('variant');
  const plannedOptions = stage.tasks[0].options as typeof options;
  expect(plannedOptions).toStrictEqual({ args: ['{mode}', { flag: true }] });
  expect(Object.isFrozen(plannedOptions.args[1])).toBeTruthy();

  const cyclic: { self?: JsonValue } = {};
  cyclic.self = cyclic;
  const sparse = ['sparse'];
  sparse.length = 2;
  for (const invalidOptions of [
    cyclic,
    { nested: () => {} },
    new Date(),
    sparse,
    { value: undefined },
  ]) {
    expect(() =>
      createPlan({
        ...config,
        pipeline: {
          stages: [
            {
              id: 'build',
              tasks: [{ adapter: 'test', id: 'bundle', options: invalidOptions as JsonValue }],
            },
          ],
        },
      }),
    ).toThrow(ConfigurationError);
  }
  const [original] = config.pipeline.stages;
  expect(() =>
    createPlan({
      ...config,
      pipeline: { stages: [original, { ...original, id: 'second' }] },
    }),
  ).toThrow(/duplicate ID "bundle"/);
  expect(() =>
    createPlan({
      ...config,
      pipeline: { stages: [original, original] },
    }),
  ).toThrow(/duplicate ID "build"/);
  expect(() =>
    createPlan({
      ...config,
      pipeline: { stages: [{ ...original, tasks: [{ ...original.tasks[0], scope: 'global' }] }] },
    }),
  ).toThrow(/unknown dimension "mode"/);
});
