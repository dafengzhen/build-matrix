import type { CacheBackend, CachePayload, RunResult } from '@dafengzhen/build-matrix/executor';
import type { TestContext } from 'vitest';

import { createPlan } from '@dafengzhen/build-matrix';
import {
  AdapterRegistry,
  composeAdapter,
  executePlan,
  retryAdapter,
  watchPlan,
} from '@dafengzhen/build-matrix/executor';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const cache = (input: string, output: string) => ({
  inputs: [input],
  outputs: [output],
  version: '1',
});

const plan = (tasks: unknown[]) =>
  createPlan({
    matrix: { dimensions: {} },
    pipeline: { stages: [{ id: 'build', tasks }] },
  });

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'build-matrix-composition-'));
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }));
  return cwd;
}

it('caches composed steps independently and reports changes to their discovered inputs', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'source.txt'), 'first');
  await writeFile(join(cwd, 'extra.txt'), '+extra');
  const events: string[] = [];
  const misses: string[] = [];
  const composedOutputCounts: number[] = [];
  let attempts = 0;
  let disposals = 0;
  const registry = new AdapterRegistry()
    .use(retryAdapter(2))
    .register('derive', {
      factory: ({ environment }) => ({
        dispose() {
          disposals++;
        },
        async run({ artifacts, trackInputs }) {
          await trackInputs(['extra.txt']);
          const output = await artifacts.stage({ kind: 'file', path: 'compiled.txt' });
          const content =
            (await readFile(join(cwd, 'source.txt'), 'utf8')) +
            (await readFile(join(cwd, 'extra.txt'), 'utf8'));
          await writeFile(output, content + environment);
          if (++attempts === 1) {
            throw new Error('retry this attempt');
          }
          return {};
        },
      }),
      scope: 'invocation',
    })
    .register('compose', {
      factory: () =>
        composeAdapter([
          {
            cache: cache('source.txt', 'final.txt'),
            dependsOn: ['derive'],
            id: 'finalize',
            async run({ artifacts, taskData }) {
              expect(taskData.get('active')).toBe(true);
              const [source] = artifacts.get('derive');
              await writeFile(join(cwd, 'final.txt'), await readFile(join(cwd, source.path)));
              return {};
            },
          },
          {
            adapter: 'derive',
            cache: cache('source.txt', 'compiled.txt'),
            environment: 'client',
            id: 'derive',
          },
        ]),
    })
    .use(async ({ context }, next) => {
      context.taskData.set('active', true);
      const output = await next();
      if (context.stepPath.length === 0) {
        composedOutputCounts.push(output.outputs?.length ?? 0);
      }
      return output;
    });
  const configured = plan([{ adapter: 'compose', id: 'build' }]);
  const run = () =>
    executePlan(configured, {
      cwd,
      hooks: {
        onAdapterFinish: ({ cacheMiss, status, stepPath }) => {
          events.push(`${stepPath.join('/')}:${status}`);
          misses.push(...(cacheMiss ?? []));
        },
      },
      registry,
    });
  expect((await run()).status).toBe('success');
  expect(composedOutputCounts).toEqual([2]);
  expect(await readFile(join(cwd, 'final.txt'), 'utf8')).toBe('first+extraclient');
  events.length = 0;
  expect((await run()).status).toBe('success');
  expect(events).toEqual(['derive:cached', 'finalize:cached', ':success']);
  expect(attempts).toBe(2);
  expect(disposals).toBe(2);
  await writeFile(join(cwd, 'extra.txt'), '+changed');
  expect((await run()).status).toBe('success');
  expect(await readFile(join(cwd, 'final.txt'), 'utf8')).toBe('first+changedclient');
  expect(attempts).toBe(3);
  expect(misses).toContain(`discovered:${join(cwd, 'extra.txt')}`);
});

it('restores verified shared cache outputs in another workspace and falls back when payloads are corrupt', async (t) => {
  const first = await workspace(t);
  const second = await workspace(t);
  const third = await workspace(t);
  for (const cwd of [first, second, third]) {
    await writeFile(join(cwd, 'input.txt'), 'input');
  }
  const records = new Map<string, CachePayload>();
  let corrupt = false;
  const backend: CacheBackend = {
    get(key) {
      const record = records.get(key);
      return corrupt && record
        ? {
            ...record,
            files: record.files.map((entry) =>
              entry.kind === 'file' ? { ...entry, data: 'Y29ycnVwdGVk' } : entry,
            ),
          }
        : record;
    },
    put(key, payload) {
      records.set(key, payload);
    },
  };
  let builds = 0;
  const registry = new AdapterRegistry().register('output', {
    factory: () => ({
      async run({ artifacts }) {
        builds++;
        const directory = await artifacts.stage({ kind: 'directory', path: 'dist' });
        await mkdir(directory);
        await writeFile(join(directory, 'result.txt'), 'result');
        return {};
      },
    }),
  });
  const run = async (cwd: string, id: string) =>
    (
      await executePlan(
        plan([{ adapter: 'output', cache: { ...cache('input.txt', 'dist'), shared: true }, id }]),
        { cache: { backend }, cwd, registry },
      )
    ).stages[0].tasks[0];
  expect((await run(first, 'one')).status).toBe('success');
  expect((await run(second, 'two')).status).toBe('cached');
  expect(await readFile(join(second, 'dist', 'result.txt'), 'utf8')).toBe('result');
  corrupt = true;
  expect((await run(third, 'three')).status).toBe('success');
  expect(builds).toBe(2);
});

it('rebuilds affected steps and downstream tasks when overlapping watch requests are merged', async (t) => {
  const cwd = await workspace(t);
  const built: string[] = [];
  const reports: RunResult[] = [];
  const registry = new AdapterRegistry()
    .register('compose', {
      factory: () =>
        composeAdapter(
          ['a', 'b'].map((id) => ({
            id,
            inputs: [`${id}.txt`],
            async run({ artifacts }) {
              built.push(id);
              const output = await artifacts.stage({ kind: 'file', path: `out-${id}.txt` });
              await writeFile(output, id);
              return {};
            },
          })),
        ),
    })
    .register('package', {
      factory: () => ({
        async run({ artifacts }) {
          built.push('package');
          expect(artifacts.get('compile').map(({ path }) => path)).toEqual([
            'out-a.txt',
            'out-b.txt',
          ]);
          return {};
        },
      }),
    });
  const configured = createPlan({
    matrix: { dimensions: {} },
    pipeline: {
      stages: [
        { id: 'build', tasks: [{ adapter: 'compose', id: 'compile' }] },
        { id: 'package', tasks: [{ adapter: 'package', consumes: ['compile'], id: 'package' }] },
      ],
    },
  });
  await watchPlan(configured, {
    cwd,
    filter: { taskIds: ['package'] },
    incremental: true,
    onRun(result) {
      reports.push(result);
    },
    registry,
    watchAdapter: {
      async watch({ run, trackedPaths }) {
        await run([]);
        expect(trackedPaths?.()).toEqual(
          expect.arrayContaining([join(cwd, 'a.txt'), join(cwd, 'b.txt')]),
        );
        await Promise.all([run(['b.txt']), run(['b.txt'])]);
      },
    },
  });
  expect(built).toEqual(['a', 'b', 'package', 'b', 'package']);
  expect(reports.map(({ status }) => status)).toEqual(['success', 'success']);
  expect(reports[1].watch?.changedPaths).toEqual(['b.txt']);
});

it('rolls back staged outputs on validation failure and cleans obsolete owned files on success', async (t) => {
  const cwd = await workspace(t);
  const registry = new AdapterRegistry().register('emit', {
    factory: () => ({
      async run({ artifacts }, options) {
        const path = `dist/${String(options)}`;
        const source = await artifacts.stage({ kind: 'file', path });
        await writeFile(source, String(options));
        return {};
      },
    }),
  });
  const run = (name: string, reject = false) =>
    executePlan(plan([{ adapter: 'emit', id: 'emit', options: name }]), {
      artifacts: {
        cleanup: ['dist'],
        async transform(artifact, _context, source) {
          if (reject) {
            throw new Error('validation failed');
          }
          if (source !== undefined) {
            await writeFile(source, `published:${await readFile(source, 'utf8')}`);
          }
          return artifact;
        },
      },
      cwd,
      manifestPath: reject ? undefined : 'manifest.json',
      registry,
    });
  expect((await run('old.txt')).status).toBe('success');
  expect((await run('old.txt', true)).status).toBe('failed');
  expect(await readFile(join(cwd, 'dist/old.txt'), 'utf8')).toBe('published:old.txt');
  expect((await run('new.txt')).status).toBe('success');
  await expect(readFile(join(cwd, 'dist/old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(cwd, 'dist/new.txt'), 'utf8')).toBe('published:new.txt');
});

it('classifies a native watch rename using the original and new path', async (t) => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  const reports: RunResult[] = [];
  await writeFile(join(cwd, 'old.txt'), 'source');
  const registry = new AdapterRegistry().register('noop', { factory: () => ({ run: () => ({}) }) });
  await watchPlan(plan([{ adapter: 'noop', id: 'noop' }]), {
    cwd,
    debounceMs: 20,
    async onRun(result) {
      reports.push(result);
      if (reports.length === 1) {
        await rename(join(cwd, 'old.txt'), join(cwd, 'new.txt'));
      } else {
        controller.abort();
      }
    },
    paths: ['.'],
    pollIntervalMs: 20,
    registry,
    signal: AbortSignal.any([controller.signal, t.signal]),
    strategy: 'native',
  });
  expect(reports[1]?.watch?.changes).toEqual([
    { from: 'old.txt', kind: 'renamed', path: 'new.txt' },
  ]);
});

it('detects output conflicts before direct writes and continues independent stages when requested', async (t) => {
  const cwd = await workspace(t);
  const writes: string[] = [];
  const registry = new AdapterRegistry()
    .register('emit', {
      factory: () => ({
        async run({ artifacts, taskId }) {
          await artifacts.reserve('shared.txt');
          writes.push(taskId);
          await writeFile(join(cwd, 'shared.txt'), taskId);
          return { outputs: [{ path: 'shared.txt' }] };
        },
      }),
    })
    .register('noop', { factory: () => ({ run: () => ({}) }) });
  const configured = createPlan({
    matrix: { dimensions: {} },
    pipeline: {
      stages: [
        {
          failurePolicy: 'continue-pipeline',
          id: 'emit',
          tasks: [
            { adapter: 'emit', id: 'first' },
            { adapter: 'emit', id: 'second' },
          ],
        },
        {
          failurePolicy: 'continue',
          id: 'next',
          tasks: [
            { adapter: 'noop', consumes: ['first', 'second'], id: 'dependent' },
            { adapter: 'noop', id: 'independent' },
          ],
        },
      ],
    },
  });
  const report = await executePlan(configured, { cwd, maxConcurrency: 2, registry });
  expect(report.status).toBe('failed');
  expect(writes).toHaveLength(1);
  expect(await readFile(join(cwd, 'shared.txt'), 'utf8')).toBe(writes[0]);
  expect(report.stages[0].tasks.find(({ status }) => status === 'failed')?.error?.code).toBe(
    'ARTIFACT_CONFLICT',
  );
  expect(report.stages[1].tasks[0].error?.code).toBe('ARTIFACT_DEPENDENCY_UNAVAILABLE');
  expect(report.stages[1].tasks[1].status).toBe('success');
});
