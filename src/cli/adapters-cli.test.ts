import type { MatrixDefinition, StageDefinition } from '@dafengzhen/build-matrix';
import type { TestContext } from 'vitest';

import { createPlan } from '@dafengzhen/build-matrix';
import { executePlan } from '@dafengzhen/build-matrix/executor';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assert, expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const node = process.execPath;

function makePlan(
  stages: readonly StageDefinition[],
  dimensions: MatrixDefinition['dimensions'] = {},
) {
  return createPlan({ matrix: { dimensions }, pipeline: { stages } });
}

async function workspace(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'build-matrix-'));
  t.onTestFinished(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

it(
  'runs clean, shell and a real Vite build through the default registry',
  { timeout: 30_000 },
  async (t) => {
    const cwd = await workspace(t);
    await mkdir(join(cwd, 'site files'));
    await mkdir(join(cwd, 'build', 'browser'), { recursive: true });
    await writeFile(join(cwd, 'build', 'browser', 'stale.txt'), 'stale');
    const logger = { error() {}, info() {} };
    const plan = makePlan(
      [
        {
          id: 'clean',
          tasks: [{ adapter: 'clean', id: 'remove', options: { path: 'build/{target}' } }],
        },
        {
          id: 'prepare',
          tasks: [
            {
              adapter: 'shell',
              id: 'generate',
              options: {
                args: [
                  '-e',
                  'require("node:fs").writeFileSync("site files/index.html", "<p>Matrix build</p>")',
                ],
                command: node,
              },
            },
          ],
        },
        {
          id: 'bundle',
          tasks: [
            {
              adapter: 'vite',
              cache: {
                inputs: ['site files', 'project.vite.mjs'],
                outputs: ['build/{target}'],
                version: 'test-vite',
              },
              id: 'vite-build',
              options: {
                configFile: 'project.vite.mjs',
                mode: 'production',
                outDir: 'build/{target}',
                root: 'site files',
              },
            },
          ],
        },
      ],
      { target: ['browser'] },
    );
    await writeFile(
      join(cwd, 'project.vite.mjs'),
      'export default { build: { minify: false, watch: {} } }',
    );

    const result = await executePlan(plan, { cwd, logger, signal: t.signal });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    expect(result.stages[0].tasks[0].metadata).toStrictEqual({ removed: true });
    expect(result.stages[2].tasks[0].outputs).toStrictEqual([
      { kind: 'directory', path: 'build/browser' },
    ]);
    expect(await readFile(join(cwd, 'build', 'browser', 'index.html'), 'utf8')).toMatch(
      /Matrix build/,
    );
    await expect(readFile(join(cwd, 'build', 'browser', 'stale.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const observed: string[] = [];
    const next = await executePlan(plan, {
      cwd,
      filter: { taskIds: ['vite-build'] },
      hooks: {
        onTaskFinish: ({ status }) => {
          observed.push(status);
        },
        onTaskStart: ({ taskId }) => {
          observed.push(taskId);
        },
      },
      signal: t.signal,
    });
    expect(next.counts.cached).toBe(1);
    expect(next.counts.skipped).toBe(2);
    expect(observed).toStrictEqual(['vite-build', 'cached']);
  },
);

it('clean rejects cwd and external targets, and accepts a missing path', async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside, 'keep'), 'kept');
  const plan = makePlan([
    {
      failurePolicy: 'continue',
      id: 'clean',
      tasks: [
        { adapter: 'clean', id: 'cwd', options: { path: '.' } },
        { adapter: 'clean', id: 'escape', options: { path: join('..', basename(outside)) } },
        {
          adapter: 'clean',
          id: 'absolute',
          options: { path: outside.replace(/\{([a-zA-Z_][\w-]*)\}/g, '{{$1}}') },
        },
        { adapter: 'clean', id: 'missing', options: { path: 'no/file' } },
      ],
    },
  ]);
  const result = await executePlan(plan, { cwd });
  expect(result.stages[0].tasks.map((item) => item.status)).toStrictEqual([
    'failed',
    'failed',
    'failed',
    'success',
  ]);
  expect(result.stages[0].tasks[3].metadata).toStrictEqual({ removed: false });
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('kept');
});

it('clean rejects paths through symbolic links and junctions', async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside, 'keep'), 'kept');
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
  const result = await executePlan(
    makePlan([
      {
        id: 'clean',
        tasks: [{ adapter: 'clean', id: 'junction', options: { path: 'linked/keep' } }],
      },
    ]),
    { cwd },
  );
  expect(result.status).toBe('failed');
  expect(result.stages[0].tasks[0].error?.message).toMatch(/symbolic links and junctions/);
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('kept');
});

it('aborts an active shell process', { timeout: 10_000 }, async (t) => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  const plan = makePlan([
    {
      id: 'build',
      tasks: [
        {
          adapter: 'shell',
          id: 'long',
          options: {
            args: ['-e', 'console.log("running"); setInterval(() => {}, 1000)'],
            command: node,
          },
        },
        { adapter: 'shell', id: 'queued', options: { args: ['--version'], command: node } },
      ],
    },
  ]);
  const result = await executePlan(plan, {
    cwd,
    logger: { error() {}, info: () => controller.abort() },
    signal: controller.signal,
  });
  expect(result.status).toBe('cancelled');
  expect(result.counts.cancelled).toBe(2);
  expect(result.stages[0].tasks[0].startedAt).toBeTruthy();
  expect(result.stages[0].tasks[1].startedAt).toBeUndefined();
});

it('CLI loads JSON relative to the config and returns distinct status codes', async (t) => {
  const cwd = await workspace(t);
  const configPath = join(cwd, 'build-matrix.json');
  const task = {
    adapter: 'shell',
    id: 'write',
    options: {
      args: ['-e', 'require("node:fs").writeFileSync("marker", process.argv[1])', '{env}'],
      command: node,
    },
  };
  const config = {
    matrix: { dimensions: { env: ['test'] } },
    pipeline: { stages: [{ id: 'stage', tasks: [task] }] },
  };
  await writeFile(configPath, `\uFEFF${JSON.stringify(config)}`);
  const success = await exec(node, [cli, configPath, '-j', '2']);
  expect(success.stdout).toMatch(/\[success\] write \(env=test\)/);
  expect(await readFile(join(cwd, 'marker'), 'utf8')).toBe('test');
  const help = await exec(node, [cli, '--help'], { cwd });
  expect(help.stdout).toMatch(/Usage: build-matrix/);

  await expect(exec(node, [cli, '-j', '0'], { cwd })).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringMatching(/Configuration error: maxConcurrency/),
  });
  task.options.args = ['-e', 'process.exit(7)'];
  await writeFile(configPath, JSON.stringify(config));
  await expect(exec(node, [cli], { cwd })).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringMatching(/\[failed\] write \(env=test\).*code 7/),
  });
  await writeFile(configPath, '{');
  await expect(exec(node, [cli], { cwd })).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringMatching(/Configuration error.*build-matrix.json/),
  });
});

it('the compiled package works without Vite until that adapter runs', async (t) => {
  const cwd = await workspace(t);
  await cp(new URL('../../dist', import.meta.url), join(cwd, 'dist'), { recursive: true });
  await cp(new URL('../../package.json', import.meta.url), join(cwd, 'package.json'));
  const { stderr } = await exec(
    node,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict'
    import { createPlan } from '@dafengzhen/build-matrix'
    import { executePlan, createDefaultRegistry } from '@dafengzhen/build-matrix/executor'
    import vite from '@dafengzhen/build-matrix/adapters/vite'
    assert.equal(typeof vite.run, 'function')
    const registry = createDefaultRegistry()
    const plan = adapter => createPlan({
      matrix: { dimensions: {} },
      pipeline: { stages: [{ id: 'step', tasks: [
        { id: 'task', adapter, ...(adapter === 'clean' && { options: { path: 'absent' } }) },
      ] }] },
    })
    assert.equal((await executePlan(plan('clean'), { registry })).status, 'success')
    const result = await executePlan(plan('vite'), { registry })
    assert.equal(result.status, 'failed')
    assert.equal(result.stages[0].tasks[0].error.code, 'VITE_NOT_INSTALLED')
  `,
    ],
    { cwd },
  );
  expect(stderr).toBe('');
});
