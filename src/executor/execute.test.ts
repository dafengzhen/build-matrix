import type {
  JsonObject,
  MatrixDefinition,
  StageDefinition,
  TaskDefinition,
  Variant,
} from '@dafengzhen/build-matrix';
import type { Adapter } from '@dafengzhen/build-matrix/executor';

import { ConfigurationError, createPlan } from '@dafengzhen/build-matrix';
import { AdapterRegistry, executePlan } from '@dafengzhen/build-matrix/executor';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, expect, it } from 'vitest';

function plan(stages: readonly StageDefinition[], matrix: MatrixDefinition = { dimensions: {} }) {
  return createPlan({ matrix, pipeline: { stages } });
}

function task(id: string, fields: Partial<TaskDefinition> = {}): TaskDefinition {
  return { adapter: 'custom', id, ...fields };
}

it('runs stage barriers and a single global invocation with bounded concurrency and stable results', async () => {
  const started: string[] = [];
  const finished: string[] = [];
  const verification: { finished: Set<string>; variant: undefined | Variant }[] = [];
  const firstPair = Promise.withResolvers<void>();
  const third = Promise.withResolvers<void>();
  const gates = ['a', 'b', 'c'].map(() => Promise.withResolvers<void>());
  let loaded = 0;
  let active = 0;
  let peak = 0;
  const registry = new AdapterRegistry()
    .register('unused', () => assert.fail('unused loader should stay unloaded'))
    .register<{ nested: string[] }>('custom', async () => {
      loaded++;
      return {
        async run(context, options) {
          const target = context.variant?.values.target ?? context.taskId;
          if (typeof target !== 'string') {
            assert.fail('expected a string target');
          }
          started.push(target);
          if (context.stageId === 'verify') {
            verification.push({ finished: new Set(finished), variant: context.variant });
            return {};
          }
          if (target === 'prepare') {
            finished.push(target);
            return {};
          }
          peak = Math.max(peak, ++active);
          if (started.length === 2) {
            firstPair.resolve();
          }
          if (target === 'c') {
            third.resolve();
          }
          await gates[['a', 'b', 'c'].indexOf(target)].promise;
          expect(options).toStrictEqual({ nested: [`out/${target}`, '{target}'] });
          finished.push(target);
          active--;
          return { metadata: { target }, outputs: [{ path: options.nested[0] }] };
        },
      };
    });
  const running = executePlan(
    plan(
      [
        {
          id: 'build',
          tasks: [
            task('bundle', { options: { nested: ['out/{target}', '{{target}}'] } }),
            task('prepare', { scope: 'global' }),
          ],
        },
        { id: 'verify', tasks: [task('check', { scope: 'global' })] },
      ],
      { dimensions: { target: ['a', 'b', 'c'] } },
    ),
    { maxConcurrency: 2, registry },
  );

  await firstPair.promise;
  expect(started).toStrictEqual(['a', 'b']);
  gates[1].resolve();
  await third.promise;
  expect(started).toStrictEqual(['a', 'b', 'c']);
  gates[2].resolve();
  gates[0].resolve();
  const result = await running;
  expect(loaded).toBe(1);
  expect(peak).toBe(2);
  expect(result.status).toBe('success');
  expect(verification).toStrictEqual([
    { finished: new Set(['a', 'b', 'c', 'prepare']), variant: undefined },
  ]);
  expect(result.counts).toStrictEqual({
    cached: 0,
    cancelled: 0,
    failed: 0,
    skipped: 0,
    success: 5,
  });
  expect(result.stages[0].tasks.map((item) => item.variantId)).toStrictEqual([
    'target=a',
    'target=b',
    'target=c',
    undefined,
  ]);
  expect(result.stages[0].tasks[1].outputs).toStrictEqual([{ path: 'out/b' }]);
  expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
});

it('applies both failure policies and waits for work already started', async () => {
  for (const policy of ['fail-fast', 'continue'] as const) {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const attempted: string[] = [];
    const registry = new AdapterRegistry().register('custom', () => ({
      async run({ taskId }) {
        attempted.push(taskId);
        if (taskId === 'error') {
          throw Object.assign(new Error('bad build'), { code: 'EXPECTED' });
        }
        if (taskId === 'active') {
          started.resolve();
          await release.promise;
        }
        return {};
      },
    }));
    const running = executePlan(
      plan([
        {
          failurePolicy: policy,
          id: 'first',
          tasks: [task('error'), task('active'), task('queued')],
        },
        { id: 'next', tasks: [task('next-task')] },
      ]),
      { maxConcurrency: 2, registry },
    );

    await started.promise;
    expect(attempted.slice(0, 2)).toStrictEqual(['error', 'active']);
    release.resolve();
    const result = await running;
    const [first, next] = result.stages;
    expect(result.status).toBe('failed');
    expect(first.status).toBe('failed');
    expect(first.tasks.map((item) => item.status)).toStrictEqual([
      'failed',
      'success',
      policy === 'continue' ? 'success' : 'skipped',
    ]);
    expect(first.tasks[0].error?.code).toBe('EXPECTED');
    expect(first.tasks[0].error?.message).toBe('bad build');
    expect(next.status).toBe('skipped');
    expect(next.tasks[0].status).toBe('skipped');
    expect(attempted).not.toContain('next-task');
  }
});

it('validates registry and concurrency before loading any adapter', async () => {
  const registry = new AdapterRegistry().register('custom', () =>
    assert.fail('loaded before preflight'),
  );
  expect(() => registry.register('custom', () => ({ run: async () => ({}) }))).toThrow(
    /already registered/,
  );
  await expect(
    executePlan(
      plan([
        { id: 'first', tasks: [task('yes')] },
        { id: 'next', tasks: [task('no', { adapter: 'unknown' })] },
      ]),
      { registry },
    ),
  ).rejects.toThrow(ConfigurationError);
  await expect(
    executePlan(plan([{ id: 'first', tasks: [task('yes')] }]), { maxConcurrency: 0, registry }),
  ).rejects.toThrow(/positive safe integer/);
});

it('propagates cancellation and preserves completed task results', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const registry = new AdapterRegistry().register('custom', () => ({
    async run({ signal, taskId }) {
      expect(signal).toBe(controller.signal);
      if (taskId === 'finished') {
        return {};
      }
      expect(taskId).toBe('in-flight');
      started.resolve();
      await delay(20_000, undefined, { signal });
      return {};
    },
  }));
  const running = executePlan(
    plan([
      { id: 'first', tasks: [task('finished'), task('in-flight'), task('queued')] },
      { id: 'next', tasks: [task('later')] },
    ]),
    { registry, signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  const result = await running;
  expect(result.status).toBe('cancelled');
  expect(result.stages.flatMap((stage) => stage.tasks.map((item) => item.status))).toStrictEqual([
    'success',
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
  expect(result.stages[0].tasks[1].startedAt).toBeTruthy();
  expect(result.stages[0].tasks[2].startedAt).toBeUndefined();
  expect(result.counts.cancelled).toBe(3);
});

it('cancels an invocation awaiting its adapter loader', async () => {
  const controller = new AbortController();
  const loading = Promise.withResolvers<void>();
  const loaded = Promise.withResolvers<Adapter>();
  const registry = new AdapterRegistry().register('custom', () => {
    loading.resolve();
    return loaded.promise;
  });
  const running = executePlan(plan([{ id: 'first', tasks: [task('pending')] }]), {
    registry,
    signal: controller.signal,
  });
  await loading.promise;
  controller.abort();
  const result = await running;
  expect(result.status).toBe('cancelled');
  expect(result.counts.cancelled).toBe(1);
  loaded.resolve({ run: () => assert.fail('aborted invocation must never enter run()') });
  await registry.load('custom');
});

it('handles zero variants, pre-aborted runs and non-JSON adapter results', async () => {
  const invalidMetadata = { date: new Date() } as unknown as JsonObject;
  const registry = new AdapterRegistry().register('custom', () => ({
    async run({ taskId }) {
      return taskId === 'invalid' ? { metadata: invalidMetadata } : {};
    },
  }));
  const configured = plan(
    [
      {
        failurePolicy: 'continue',
        id: 'all',
        tasks: [
          task('variant'),
          task('invalid', { scope: 'global' }),
          task('global', { scope: 'global' }),
        ],
      },
    ],
    { dimensions: {}, exclude: [{}] },
  );
  const result = await executePlan(configured, { registry });
  expect(result.stages[0].tasks.map((item) => item.taskId)).toStrictEqual(['invalid', 'global']);
  expect(result.counts.failed).toBe(1);
  expect(result.counts.success).toBe(1);
  expect(result.stages[0].tasks[0].error?.message).toMatch(/Invalid adapter result/);

  const unplugged = new AdapterRegistry().register('custom', () =>
    assert.fail('loaded after abort'),
  );
  const cancelled = await executePlan(configured, {
    registry: unplugged,
    signal: AbortSignal.abort(),
  });
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.counts.cancelled).toBe(2);
});
