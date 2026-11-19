import type { ResourceLimits, StageDefinition, TaskDefinition } from '@dafengzhen/build-matrix';
import type { Adapter, ManifestV2, RunResult } from '@dafengzhen/build-matrix/executor';
import type { TestContext } from 'vitest';

import { ConfigurationError, createPlan } from '@dafengzhen/build-matrix';
import {
  AdapterRegistry,
  createDetailedReport,
  createManifest,
  executePlan,
  watchPlan,
} from '@dafengzhen/build-matrix/executor';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, expect, it } from 'vitest';

function plan(stages: readonly StageDefinition[], resourceLimits?: ResourceLimits) {
  return createPlan({ matrix: { dimensions: {} }, pipeline: { resourceLimits, stages } });
}

function registryFor(run: Adapter['run']) {
  return new AdapterRegistry().register('custom', () => ({ run }));
}

function task(id: string, resourceGroup?: string): TaskDefinition {
  return { adapter: 'custom', id, resourceGroup };
}

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'build-matrix-watch-'));
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }));
  return cwd;
}

it('resource groups share global slots without blocking runnable tasks', async () => {
  const bothStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const cpu1 = Promise.withResolvers<void>();
  const cpu2 = Promise.withResolvers<void>();
  const io1 = Promise.withResolvers<void>();
  const gates = new Map([
    ['cpu-1', cpu1],
    ['cpu-2', cpu2],
    ['io-1', io1],
  ]);
  const order: string[] = [];
  const running = new Set<string>();
  const nextStage: { running: number; started: number }[] = [];
  const registry = registryFor(async ({ stageId, taskId }) => {
    if (stageId === 'next') {
      nextStage.push({ running: running.size, started: order.length });
      return {};
    }
    running.add(taskId);
    order.push(taskId);
    if (order.length === 2) {
      bothStarted.resolve();
    }
    if (taskId === 'cpu-2') {
      secondStarted.resolve();
    }
    const gate = gates.get(taskId);
    assert.isDefined(gate);
    await gate.promise;
    running.delete(taskId);
    return {};
  });
  const configured = plan(
    [
      { id: 'build', tasks: [task('cpu-1', 'cpu'), task('cpu-2', 'cpu'), task('io-1', 'io')] },
      { id: 'next', tasks: [task('verify')] },
    ],
    { cpu: 3, io: 1 },
  );
  const run = executePlan(configured, { maxConcurrency: 2, registry, resourceLimits: { cpu: 1 } });
  await bothStarted.promise;
  expect(order).toStrictEqual(['cpu-1', 'io-1']);
  cpu1.resolve();
  await secondStarted.promise;
  expect([...running]).toStrictEqual(['io-1', 'cpu-2']);
  io1.resolve();
  cpu2.resolve();
  const result = await run;
  expect(result.status).toBe('success');
  expect(nextStage).toStrictEqual([{ running: 0, started: 3 }]);
  expect(result.stages[0].tasks.map((item) => item.taskId)).toStrictEqual([
    'cpu-1',
    'cpu-2',
    'io-1',
  ]);
  expect(result.scheduling).toStrictEqual({ maxConcurrency: 2, resourceLimits: { cpu: 1, io: 1 } });
  expect(() => plan([], { cpu: 0 })).toThrow(ConfigurationError);
  const bad = plan([{ id: 'build', tasks: [task('a'), task('b', 'unknown')] }]);
  await expect(
    executePlan(bad, {
      registry: registryFor(() => assert.fail('unvalidated plan executed')),
    }),
  ).rejects.toThrow(/missing limit for resource group "unknown"/);
});

it('fail-fast stops queued work while the failed task finish hook is pending', async () => {
  const bothStarted = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const allowHook = Promise.withResolvers<void>();
  const calls: string[] = [];
  const configured = plan(
    [{ id: 'build', tasks: [task('fails', 'cpu'), task('queued', 'cpu'), task('active', 'io')] }],
    { cpu: 1, io: 1 },
  );
  const registry = registryFor(async ({ taskId }) => {
    calls.push(taskId);
    if (calls.length === 2) {
      bothStarted.resolve();
    }
    if (taskId === 'fails') {
      await fail.promise;
      throw new Error('build failed');
    }
    await finish.promise;
    return {};
  });
  const running = executePlan(configured, {
    hooks: {
      async onTaskFinish(result) {
        if (result.status !== 'failed') {
          return;
        }
        observed.resolve();
        await allowHook.promise;
      },
    },
    maxConcurrency: 2,
    registry,
  });
  await bothStarted.promise;
  fail.resolve();
  await observed.promise;
  finish.resolve();
  await delay(15);
  expect(calls).toStrictEqual(['fails', 'active']);
  allowHook.resolve();
  const result = await running;
  expect(result.stages[0].tasks.map((item) => item.status)).toStrictEqual([
    'failed',
    'skipped',
    'success',
  ]);
  expect(result.stages[0].tasks[1].skipReason).toBe('fail-fast');
});

it('isolates lifecycle hooks and publishes scheduling, timing and hook diagnostics in schema 2', async (t) => {
  const cwd = await workspace(t);
  const calls: string[] = [];
  const configured = plan(
    [
      { id: 'build', tasks: [task('bundle', 'cpu'), task('filtered')] },
      { id: 'filtered-stage', tasks: [task('another')] },
    ],
    { cpu: 1 },
  );
  const registry = registryFor(async ({ taskId }) => {
    calls.push(`adapter:${taskId}`);
    return { outputs: [{ kind: 'bundle', path: 'dist/app.js' }] };
  });
  const result = await executePlan(configured, {
    cwd,
    filter: { taskIds: ['bundle'] },
    hooks: {
      onRunFinish(report) {
        calls.push('run:finish');
        Object.assign(report.counts, { success: 0 });
        throw new Error('run observer failed');
      },
      onRunStart(event) {
        calls.push('run:start');
        assert.isDefined(event.scheduling);
        Object.assign(event.scheduling.resourceLimits, { cpu: 42 });
      },
      onStageFinish({ stage }) {
        calls.push(`stage:finish:${stage.id}`);
        Object.assign(stage, { status: 'failed' });
      },
      onStageStart(event) {
        calls.push(`stage:start:${event.stageId}`);
      },
      onTaskFinish(report) {
        calls.push(`task:finish:${report.taskId}`);
        assert.isDefined(report.outputs);
        Object.assign(report.outputs[0], { path: 'overwritten.js' });
      },
      async onTaskStart(event) {
        calls.push(`task:start:${event.taskId}`);
        Object.assign(event, { taskId: 'changed' });
        throw Object.assign(new Error('observer failed'), { code: 'OBS' });
      },
    },
    manifestPath: 'latest.json',
    manifestVersion: 2,
    registry,
  });
  expect(calls).toStrictEqual([
    'run:start',
    'stage:start:build',
    'task:start:bundle',
    'adapter:bundle',
    'task:finish:bundle',
    'stage:finish:build',
    'run:finish',
  ]);
  expect(result.status).toBe('success');
  expect(result.counts.success).toBe(1);
  expect(result.scheduling?.resourceLimits.cpu).toBe(1);
  expect(result.stages[0].tasks[0].outputs).toStrictEqual([
    { kind: 'bundle', path: 'dist/app.js' },
  ]);
  expect(result.hookErrors?.[0].taskId).toBe('bundle');
  expect(result.hookErrors?.[0].error.code).toBe('OBS');
  expect(result.hookErrors?.[1].hook).toBe('onRunFinish');

  const report = createDetailedReport(configured, result);
  expect(JSON.parse(await readFile(join(cwd, 'latest.json'), 'utf8'))).toStrictEqual(report);
  expect(report.schemaVersion).toBe(2);
  expect(report.stages[0].durationMs).toBeGreaterThanOrEqual(0);
  expect(report.stages[1].durationMs).toBeUndefined();
  expect(report.stages[0].counts).toStrictEqual({
    cached: 0,
    cancelled: 0,
    failed: 0,
    skipped: 1,
    success: 1,
  });
  expect(report.metrics.artifactCount).toBe(1);
  expect(report.metrics.byAdapter[0].counts.skipped).toBe(2);
  expect(report.metrics.byResourceGroup[0].id).toBe('cpu');
  expect(report.stages[0].tasks[0].resourceGroup).toBe('cpu');
  const base = createManifest(configured, result);
  expect(base.schemaVersion).toBe(1);
  expect(base.stages[0].durationMs).toBeUndefined();
  expect(base.stages[0].tasks[0].resourceGroup).toBeUndefined();
  expect(base).not.toHaveProperty('hookErrors');
});

it(
  'watch debounces file additions and replacements while serializing complete runs',
  { timeout: 10_000 },
  async (t) => {
    const cwd = await workspace(t);
    const source = join(cwd, 'source');
    await mkdir(source);
    await writeFile(join(source, 'replace.txt'), 'initial');
    await writeFile(join(source, 'remove.txt'), 'will be removed');
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const allowFirst = Promise.withResolvers<void>();
    const thirdReport = Promise.withResolvers<void>();
    let runs = 0;
    let active = 0;
    const reports: RunResult[] = [];
    const registry = registryFor(async () => {
      const number = ++runs;
      expect(++active).toBe(1);
      if (number === 1) {
        started.resolve();
        await allowFirst.promise;
      }
      await writeFile(join(source, 'generated.txt'), `generated run ${number}`);
      active--;
      return {};
    });
    const configured = plan([{ id: 'build', tasks: [task('bundle')] }]);
    const controllerOnTimeout = () => controller.abort();
    t.signal.addEventListener('abort', controllerOnTimeout);
    const monitoring = watchPlan(configured, {
      cwd,
      debounceMs: 35,
      ignore: ['source/generated.txt'],
      manifestPath: 'source/report.json',
      manifestVersion: 2,
      async onRun(result) {
        reports.push(result);
        const number = result.watch?.number;
        if (number === 2) {
          await writeFile(join(cwd, 'optional.txt'), 'created after launching watch');
        } else if (number === 3) {
          thirdReport.resolve();
        }
      },
      paths: ['source', 'optional.txt'],
      pollIntervalMs: 10,
      registry,
      signal: controller.signal,
    });
    try {
      await started.promise;
      await writeFile(join(source, 'new.txt'), 'new');
      await writeFile(join(cwd, 'replacement'), 'replacement');
      await rename(join(cwd, 'replacement'), join(source, 'replace.txt'));
      await rm(join(source, 'remove.txt'));
      await delay(130);
      expect(runs).toBe(1);
      allowFirst.resolve();
      await thirdReport.promise;
      await delay(100);
      expect(runs).toBe(3);
      expect(reports.every((report) => report.status === 'success')).toBe(true);
      expect(reports[0].watch).toStrictEqual({ changedPaths: [], number: 1 });
      expect(reports[1].watch?.changedPaths).toStrictEqual(
        ['new.txt', 'remove.txt', 'replace.txt'].map((name) => join('source', name)),
      );
      expect(reports[2].watch?.changedPaths).toStrictEqual(['optional.txt']);
      const persisted: ManifestV2 = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
      expect(persisted.watch).toStrictEqual(reports[2].watch);
      expect(persisted.runId).toBe(reports[2].runId);
    } finally {
      controller.abort();
      allowFirst.resolve();
      await monitoring;
    }
  },
);

it('watch publishes a cancelled active run before returning', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const reports: RunResult[] = [];
  const registry = registryFor(async ({ signal }) => {
    started.resolve();
    await delay(20_000, undefined, { signal });
    return {};
  });
  const monitoring = watchPlan(plan([{ id: 'build', tasks: [task('work')] }]), {
    onRun: (result) => {
      reports.push(result);
    },
    paths: ['package.json'],
    registry,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await monitoring;
  expect(reports.map(({ counts, status }) => [status, counts.cancelled])).toStrictEqual([
    ['cancelled', 1],
  ]);
});

it('delegates run triggers to the watch adapter and reports each completed run', async (t) => {
  const cwd = await workspace(t);
  const signal = new AbortController().signal;
  const configured = plan([{ id: 'build', tasks: [task('work')] }]);
  const runs: RunResult[] = [];
  const manifest = join(cwd, 'reports', 'latest.json');
  await watchPlan(configured, {
    cwd,
    ignore: ['generated'],
    manifestPath: manifest,
    manifestVersion: 2,
    async onRun(result) {
      const persisted: ManifestV2 = JSON.parse(await readFile(manifest, 'utf8'));
      expect(persisted.runId).toBe(result.runId);
      runs.push(result);
    },
    paths: ['source'],
    registry: registryFor(async () => ({})),
    signal,
    watchAdapter: {
      async watch(context) {
        expect(context.paths).toStrictEqual([join(cwd, 'source')]);
        expect(context.signal).toBe(signal);
        expect(context.ignore(join(cwd, 'generated', 'output.txt'))).toBe(true);
        expect(context.ignore(join(cwd, '.build-matrix-cache', 'cache.json'))).toBe(true);
        expect(context.ignore(manifest)).toBe(true);
        expect(context.ignore(join(cwd, 'source', 'input.txt'))).toBe(false);
        await context.run([]);
        await context.run([join('source', 'input.txt')]);
      },
    },
  });
  expect(runs.map((result) => result.watch)).toStrictEqual([
    { changedPaths: [], number: 1 },
    { changedPaths: [join('source', 'input.txt')], number: 2 },
  ]);
  expect(runs.map((result) => result.status)).toStrictEqual(['success', 'success']);
});

it(
  'CLI watch emits NDJSON, recovers after a failed round and exits on interruption',
  { timeout: 10_000 },
  async (t) => {
    const cwd = await workspace(t);
    const input = join(cwd, 'input.txt');
    await writeFile(input, 'fail');
    await writeFile(
      join(cwd, 'build-matrix.json'),
      JSON.stringify({
        matrix: { dimensions: {} },
        pipeline: {
          resourceLimits: { io: 2 },
          stages: [
            {
              id: 'build',
              tasks: [
                {
                  adapter: 'shell',
                  id: 'check',
                  options: {
                    args: [
                      '-e',
                      'if (require("node:fs").readFileSync("input.txt", "utf8") === "fail") process.exit(7)',
                    ],
                    command: process.execPath,
                  },
                  resourceGroup: 'io',
                },
              ],
            },
          ],
        },
      }),
    );
    const script = `
    const { runCli } = await import(process.argv[1])
    process.once('message', () => process.emit('SIGINT'))
    process.exitCode = await runCli(process.argv.slice(2))
    process.disconnect()
  `;
    const cli = new URL('../../dist/cli/index.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        '--',
        cli,
        '--watch',
        'input.txt',
        '--debounce',
        '40',
        '--poll-interval',
        '15',
        '--resource',
        'io=1',
        '--manifest',
        'report.json',
        '--json',
        '--detailed',
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const closed = once(child, 'close');
    assert.isNotNull(child.stdout);
    assert.isNotNull(child.stderr);
    const lines = createInterface({ input: child.stdout });
    const output = lines[Symbol.asyncIterator]();
    const stderr: string[] = [];
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
    const stop = () => {
      if (child.connected) {
        child.send('interrupt');
      }
    };
    t.signal.addEventListener('abort', stop);
    try {
      const first = await output.next();
      if (first.done !== false) {
        assert.fail(stderr.join(''));
      }
      const failed: ManifestV2 = JSON.parse(first.value);
      expect(failed.schemaVersion).toBe(2);
      expect(failed.status).toBe('failed');
      expect(failed.scheduling?.resourceLimits.io).toBe(1);
      await writeFile(input, 'pass');
      const second = await output.next();
      if (second.done !== false) {
        assert.fail(stderr.join(''));
      }
      const success: ManifestV2 = JSON.parse(second.value);
      expect(success.status).toBe('success');
      expect(success.watch).toStrictEqual({ changedPaths: ['input.txt'], number: 2 });
      expect(JSON.parse(await readFile(join(cwd, 'report.json'), 'utf8'))).toStrictEqual(success);
    } finally {
      stop();
      lines.close();
      const [code] = await closed;
      assert.strictEqual(code, 130, stderr.join(''));
    }
  },
);
