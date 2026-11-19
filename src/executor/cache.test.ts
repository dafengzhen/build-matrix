import type { MatrixDefinition, StageDefinition, TaskDefinition } from '@dafengzhen/build-matrix';
import type {
  AdapterFactory,
  ExecuteOptions,
  ManifestV1,
  RunResult,
} from '@dafengzhen/build-matrix/executor';
import type { ExecFileException } from 'node:child_process';
import type { TestContext } from 'vitest';

import { ConfigurationError, createPlan } from '@dafengzhen/build-matrix';
import { AdapterRegistry, createManifest, executePlan } from '@dafengzhen/build-matrix/executor';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assert, expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

function cacheStatus(result: RunResult) {
  return result.stages[0].tasks[0].status;
}

function plan(stages: readonly StageDefinition[], dimensions: MatrixDefinition['dimensions'] = {}) {
  return createPlan({ matrix: { dimensions }, pipeline: { stages } });
}

function task(id: string, fields: Partial<TaskDefinition> = {}): TaskDefinition {
  return { adapter: 'custom', id, ...fields };
}

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'build-matrix-cache-'));
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }));
  return cwd;
}

it('combines exact-ID filters while retaining plan order and global tasks', async () => {
  const ran: [taskId: string, variantId: string | undefined][] = [];
  const registry = new AdapterRegistry()
    .register('custom', () => ({
      async run({ taskId, variant }) {
        ran.push([taskId, variant?.id]);
        return {};
      },
    }))
    .register('unused', () => assert.fail('filtered adapter must not load'));
  const configured = plan(
    [
      { id: 'build', tasks: [task('compile'), task('prepare', { scope: 'global' })] },
      {
        id: 'other',
        tasks: [task('unused', { adapter: 'unused' }), task('missing', { adapter: 'missing' })],
      },
    ],
    { format: ['esm'], mode: ['a', 'b', 'c'] },
  );
  const a = 'format=esm,mode=a';
  const c = 'format=esm,mode=c';
  const result = await executePlan(configured, {
    filter: { taskIds: ['prepare', 'compile'], variantIds: [c, a, c] },
    registry,
  });
  expect(ran).toStrictEqual([
    ['compile', a],
    ['compile', c],
    ['prepare', undefined],
  ]);
  expect(
    result.stages[0].tasks.map(({ skipReason, status }) => [status, skipReason]),
  ).toStrictEqual([
    ['success', undefined],
    ['skipped', 'filtered'],
    ['success', undefined],
    ['success', undefined],
  ]);
  expect(
    result.stages[1].tasks.every(
      (item) => item.skipReason === 'filtered' && item.startedAt === undefined,
    ),
  ).toBeTruthy();
  expect(result.stages[1].status).toBe('skipped');
  expect(result.counts.skipped).toBe(7);

  await expect(
    executePlan(configured, { filter: { variantIds: ['b'] }, registry }),
  ).rejects.toThrow(/unknown ID "b"/);
  await expect(
    executePlan(configured, { filter: { taskIds: ['not-there'] }, registry }),
  ).rejects.toThrow(ConfigurationError);
  const none = await executePlan(configured, { filter: { taskIds: [] }, registry });
  expect(none.status).toBe('success');
  expect(none.stages.every((stage) => stage.status === 'skipped')).toBeTruthy();
  expect(ran.length).toBe(3);
});

it('preserves a filtered skip on cancellation and persists a projected manifest', async (t) => {
  const cwd = await workspace(t);
  const registry = new AdapterRegistry().register('custom', () => assert.fail('pre-aborted run'));
  const configured = plan(
    [
      {
        id: 'build',
        tasks: [task('compile', { options: { secret: 'never-in-plan-summary' } }), task('verify')],
      },
    ],
    { mode: ['a', 'b'] },
  );
  const result = await executePlan(configured, {
    cwd,
    filter: { taskIds: ['compile'], variantIds: ['mode=b'] },
    manifestPath: 'reports/run.json',
    registry,
    signal: AbortSignal.abort(),
  });
  const source = await readFile(join(cwd, 'reports', 'run.json'), 'utf8');
  const report: ManifestV1 = JSON.parse(source);
  const extendedResult = { ...result, internalValue: 'ignored' };
  expect(report).toStrictEqual(createManifest(configured, extendedResult));
  expect(report.plan).toStrictEqual({ stageCount: 1, taskCount: 2, variantCount: 2 });
  expect(report.variants.map((item) => item.id)).toStrictEqual(['mode=a', 'mode=b']);
  expect(
    report.stages[0].tasks.map(({ skipReason, status }) => [status, skipReason]),
  ).toStrictEqual([
    ['skipped', 'filtered'],
    ['cancelled', undefined],
    ['skipped', 'filtered'],
    ['skipped', 'filtered'],
  ]);
  expect(report.status).toBe('cancelled');
  expect(report.schemaVersion).toBe(1);
  expect(source).not.toContain('never-in-plan-summary');
});

it('cache keys track options, variants, versions, declared environment and input contents', async (t) => {
  const cwd = await workspace(t);
  const name = 'BUILD_MATRIX_TEST_MODE';
  const oldValue = process.env[name];
  t.onTestFinished(() => {
    if (oldValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = oldValue;
    }
  });
  process.env[name] = 'one';
  await mkdir(join(cwd, 'inputs'));
  await writeFile(join(cwd, 'inputs', 'a.txt'), 'A');
  await writeFile(join(cwd, 'inputs', 'b.txt'), 'B');
  let runs = 0;
  const registry = new AdapterRegistry().register<{ suffix: string }>('custom', () => ({
    async run({ variant }, { suffix }) {
      runs++;
      const mode = variant?.values.mode;
      if (typeof mode !== 'string') {
        assert.fail('expected a string mode');
      }
      const input = await readFile(join(cwd, 'inputs', `${mode}.txt`), 'utf8');
      await mkdir(join(cwd, 'out', mode), { recursive: true });
      const path = `out/${mode}/artifact.txt`;
      await writeFile(join(cwd, path), input + suffix + process.env[name]);
      return { metadata: { mode }, outputs: [{ kind: 'file', path }] };
    },
  }));
  const configuration = (version: string, suffix: string) =>
    plan(
      [
        {
          id: 'build',
          tasks: [
            task('compile', {
              cache: {
                env: [name],
                inputs: ['inputs/{mode}.txt'],
                outputs: ['out/{mode}'],
                version,
              },
              options: { suffix },
            }),
          ],
        },
      ],
      { mode: ['a', 'b'] },
    );
  const run = (version = 'adapter@1;tool@1', suffix = 'first', overrides: ExecuteOptions = {}) =>
    executePlan(configuration(version, suffix), { cwd, maxConcurrency: 2, registry, ...overrides });
  const base = await run();
  expect(base.counts.success).toBe(2);
  const idle = new AdapterRegistry().register('custom', () =>
    assert.fail('cache hit must not load the adapter'),
  );
  const hit = await run(undefined, undefined, { registry: idle });
  expect(hit.status).toBe('success');
  expect(hit.counts.cached).toBe(2);
  expect(hit.runId).not.toBe(base.runId);
  expect(hit.stages[0].tasks[0].runId).toBe(hit.runId);
  expect(hit.stages[0].tasks[0].outputs).toStrictEqual(base.stages[0].tasks[0].outputs);
  expect(hit.stages[0].tasks[0].metadata).toStrictEqual({ mode: 'a' });
  expect(runs).toBe(2);

  await writeFile(join(cwd, 'inputs', 'b.txt'), 'C');
  const changedInput = await run();
  expect(changedInput.stages[0].tasks.map((item) => item.status)).toStrictEqual([
    'cached',
    'success',
  ]);
  await writeFile(join(cwd, 'out', 'a', 'artifact.txt'), 'xfirstone');
  expect((await run()).stages[0].tasks.map((item) => item.status)).toStrictEqual([
    'success',
    'cached',
  ]);
  await rm(join(cwd, 'out', 'b', 'artifact.txt'));
  expect((await run()).stages[0].tasks.map((item) => item.status)).toStrictEqual([
    'cached',
    'success',
  ]);

  expect((await run(undefined, 'changed')).counts.success).toBe(2);
  expect((await run('adapter@2;tool@1', 'changed')).counts.success).toBe(2);
  process.env[name] = 'two';
  expect((await run('adapter@2;tool@1', 'changed')).counts.success).toBe(2);
  expect((await run('adapter@2;tool@1', 'changed')).counts.cached).toBe(2);
});

it('keys the cache by effective adapter options and skips the factory on a hit', async (t) => {
  const cwd = await workspace(t);
  const configured = plan([
    {
      id: 'build',
      tasks: [
        task('compile', {
          cache: { inputs: [], outputs: ['artifact.txt'], version: '1' },
          options: { format: 'text' },
        }),
      ],
    },
  ]);
  const run = (content: string, factory: AdapterFactory<{ content: string }>) =>
    executePlan(configured, {
      cwd,
      registry: new AdapterRegistry().register('custom', {
        defaults: { content },
        factory,
      }),
    });
  const write: AdapterFactory<{ content: string }> = () => ({
    async run({ cwd }, { content }) {
      await writeFile(join(cwd, 'artifact.txt'), content);
      return {};
    },
  });
  expect(cacheStatus(await run('first', write))).toBe('success');
  expect(
    cacheStatus(await run('first', () => assert.fail('cache hit must not call the factory'))),
  ).toBe('cached');
  expect(cacheStatus(await run('second', write))).toBe('success');
  expect(await readFile(join(cwd, 'artifact.txt'), 'utf8')).toBe('second');
});

it.for(['side.txt', 'dist/missing.txt'])(
  'bypasses cache entries that report an unverified artifact (%s)',
  async (unverified, t) => {
    const cwd = await workspace(t);
    const directory = join(cwd, 'cache');
    const covered = join(cwd, 'dist', 'bundle.txt');
    let path = unverified;
    const registry = new AdapterRegistry().register('custom', () => ({
      async run() {
        await mkdir(join(cwd, 'dist'), { recursive: true });
        await writeFile(covered, 'bundle');
        await writeFile(join(cwd, 'side.txt'), 'side artifact');
        return { outputs: [{ kind: 'bundle', path }] };
      },
    }));
    const configured = plan([
      {
        id: 'build',
        tasks: [task('compile', { cache: { inputs: [], outputs: ['dist'], version: '1' } })],
      },
    ]);
    const run = () => executePlan(configured, { cache: { directory }, cwd, registry });

    const first = await run();
    expect(cacheStatus(first)).toBe('success');
    expect(first.stages[0].tasks[0].outputs).toStrictEqual([{ kind: 'bundle', path: unverified }]);
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });

    path = covered;
    expect(cacheStatus(await run())).toBe('success');
    const hit = await run();
    expect(cacheStatus(hit)).toBe('cached');
    expect(hit.stages[0].tasks[0].outputs).toStrictEqual([{ kind: 'bundle', path: covered }]);

    const [name] = await readdir(directory);
    const file = join(directory, name);
    const entry = JSON.parse(await readFile(file, 'utf8'));
    entry.result.outputs = [{ path: unverified }];
    await writeFile(file, JSON.stringify(entry));
    expect(cacheStatus(await run())).toBe('success');
    expect(cacheStatus(await run())).toBe('cached');
  },
);

it('bypasses corrupt or unavailable cache and never records a failed or unstable build', async (t) => {
  const cwd = await workspace(t);
  const input = join(cwd, 'source.txt');
  const output = join(cwd, 'artifact.txt');
  const directory = 'cache';
  let mode = 'fail';
  const controller = new AbortController();
  const registry = new AdapterRegistry().register('custom', () => ({
    async run() {
      await writeFile(output, 'artifact');
      if (mode === 'fail') {
        throw new Error('intentional failure');
      }
      if (mode === 'cancel') {
        controller.abort();
      }
      if (mode === 'mutate') {
        await writeFile(input, 'changed during task');
      }
      return {};
    },
  }));
  const configured = plan([
    {
      id: 'build',
      tasks: [
        task('compile', {
          cache: { inputs: ['source.txt'], outputs: ['artifact.txt'], version: '1' },
        }),
      ],
    },
  ]);
  const run = (overrides: ExecuteOptions = {}) =>
    executePlan(configured, { cache: { directory }, cwd, registry, ...overrides });
  await writeFile(input, 'source');
  expect(cacheStatus(await run())).toBe('failed');
  await expect(readdir(join(cwd, directory))).rejects.toMatchObject({ code: 'ENOENT' });
  mode = 'cancel';
  expect(cacheStatus(await run({ signal: controller.signal }))).toBe('cancelled');
  await expect(readdir(join(cwd, directory))).rejects.toMatchObject({ code: 'ENOENT' });
  mode = 'mutate';
  expect(cacheStatus(await run())).toBe('success');
  await expect(readdir(join(cwd, directory))).rejects.toMatchObject({ code: 'ENOENT' });
  mode = 'normal';
  expect(cacheStatus(await run())).toBe('success');
  const [entry] = await readdir(join(cwd, directory));
  expect(entry).toMatch(/^[a-f0-9]{64}\.json$/);
  await writeFile(join(cwd, directory, entry), '{invalid');
  expect(cacheStatus(await run())).toBe('success');
  expect(cacheStatus(await run())).toBe('cached');
  expect(cacheStatus(await run({ cache: false }))).toBe('success');
  expect(cacheStatus(await run())).toBe('cached');
  await writeFile(join(cwd, 'unavailable-cache'), 'a regular file');
  expect(cacheStatus(await run({ cache: { directory: 'unavailable-cache' } }))).toBe('success');
  await rm(input);
  expect(cacheStatus(await run())).toBe('success');
});

it('validates cache declarations and conflicting selected paths before running tasks', async (t) => {
  const cwd = await workspace(t);
  const registry = new AdapterRegistry().register('custom', () =>
    assert.fail('invalid configuration executed'),
  );
  const cache = { inputs: [], outputs: ['out'], version: '1' };
  const first = { id: 'first', tasks: [task('prepare')] };
  for (const [candidate, pattern] of [
    [{ ...cache, outputs: [] }, /at least one output/],
    [{ ...cache, outputs: ['out/{missing}'] }, /unknown dimension/],
    [{ ...cache, env: ['A=B'] }, /invalid environment variable name/],
    [{ ...cache, version: '' }, /non-empty string/],
  ] as const) {
    expect(() =>
      plan([first, { id: 'later', tasks: [task('write', { cache: candidate })] }]),
    ).toThrow(pattern);
  }
  for (const second of [
    [task('write', { cache: { ...cache, outputs: ['../out'] } })],
    [task('write', { cache: { ...cache, inputs: ['out/inside'] } })],
    [task('write', { cache: { ...cache, outputs: ['.build-matrix-cache/data'] } })],
    [task('write', { cache }), task('duplicate', { cache: { ...cache, outputs: ['out/inside'] } })],
  ]) {
    const execution = executePlan(plan([first, { id: 'later', tasks: second }]), { cwd, registry });
    await expect(execution).rejects.toThrow(ConfigurationError);
    await expect(execution).rejects.toThrow(/relative path|overlap/);
  }
});

it('does not cache declarations that traverse symbolic links or junctions', async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside, 'source.txt'), 'input');
  try {
    await symlink(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') {
      throw error;
    }
    await Promise.all([
      rm(cwd, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ]);
    t.skip('current environment does not permit creating a symbolic link');
  }
  const registry = new AdapterRegistry().register('custom', () => ({
    async run() {
      await writeFile(join(cwd, 'artifact.txt'), 'unchanged artifact');
      return {};
    },
  }));
  const configured = plan([
    {
      id: 'build',
      tasks: [
        task('compile', {
          cache: { inputs: ['linked/source.txt'], outputs: ['artifact.txt'], version: '1' },
        }),
      ],
    },
  ]);
  expect(cacheStatus(await executePlan(configured, { cwd, registry }))).toBe('success');
  expect(cacheStatus(await executePlan(configured, { cwd, registry }))).toBe('success');
  await expect(readdir(join(cwd, '.build-matrix-cache'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('CLI emits JSON and a matching manifest with cache controls and exit codes', async (t) => {
  const cwd = await workspace(t);
  const file = join(cwd, 'config.json');
  await writeFile(join(cwd, 'input.txt'), 'hello');
  const build = {
    adapter: 'shell',
    cache: {
      inputs: ['input.txt'],
      outputs: ['out-{mode}.txt', 'dist/{mode}'],
      version: 'shell@1;node',
    },
    id: 'bundle',
    options: {
      args: [
        '-e',
        'const fs = require("node:fs"); fs.copyFileSync(process.argv[1], process.argv[2]); fs.mkdirSync(process.argv[3], { recursive: true }); console.log("built")',
        'input.txt',
        'out-{mode}.txt',
        'dist/{mode}',
      ],
      command: process.execPath,
    },
  };
  const config = {
    matrix: { dimensions: { format: ['esm'], mode: ['dev', 'build'] } },
    pipeline: { stages: [{ id: 'build', tasks: [build] }] },
  };
  await writeFile(file, JSON.stringify(config));
  const args = [
    cli,
    file,
    '--json',
    '--manifest',
    'reports/latest.json',
    '--variant',
    'format=esm,mode=build',
    '--task',
    'bundle',
    '--cache-dir',
    'storage',
  ];
  const first = await exec(process.execPath, args);
  const report: ManifestV1 = JSON.parse(first.stdout);
  expect(first.stderr).toContain('built');
  expect(report).toStrictEqual(
    JSON.parse(await readFile(join(cwd, 'reports', 'latest.json'), 'utf8')),
  );
  expect(report.stages[0].tasks.map((item) => item.status)).toStrictEqual(['skipped', 'success']);
  const outputs = [
    { kind: 'directory', path: 'dist/build' },
    { kind: 'file', path: 'out-build.txt' },
  ];
  expect(report.stages[0].tasks[0].outputs).toBeUndefined();
  expect(report.stages[0].tasks[1].outputs).toStrictEqual(outputs);
  expect(await readFile(join(cwd, 'out-build.txt'), 'utf8')).toBe('hello');
  expect((await readdir(join(cwd, 'storage'))).length).toBe(1);
  const second = await exec(process.execPath, args);
  const cached: ManifestV1 = JSON.parse(second.stdout);
  expect(cached.counts.cached).toBe(1);
  expect(cached.stages[0].tasks[1].outputs).toStrictEqual(outputs);
  expect(second.stderr).toBe('');
  const uncached: ManifestV1 = JSON.parse(
    (await exec(process.execPath, [...args, '--no-cache'])).stdout,
  );
  expect(uncached.counts.success).toBe(1);
  expect(uncached.stages[0].tasks[1].outputs).toStrictEqual(outputs);
  await expect(
    exec(process.execPath, [cli, file, '--json', '--task', 'unknown']),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringMatching(/unknown ID "unknown"/),
    stdout: '',
  });
  await expect(
    exec(process.execPath, [cli, file, '--manifest', 'config.json']),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringMatching(/different from the configuration path/),
  });
  expect(JSON.parse(await readFile(file, 'utf8'))).toStrictEqual(config);

  build.options.args = ['-e', 'process.exit(9)'];
  await writeFile(file, JSON.stringify(config));
  const failure = exec(process.execPath, args);
  await expect(failure).rejects.toHaveProperty('code', 1);
  const { stdout } = await failure.catch((error: { stdout: string } & ExecFileException) => error);
  expect(JSON.parse(stdout).counts.failed).toBe(1);
  const failed = JSON.parse(await readFile(join(cwd, 'reports', 'latest.json'), 'utf8'));
  expect(failed.status).toBe('failed');
  expect(failed.stages[0].tasks[1].error.message).toMatch(/code 9/);
});
