import type { JsonObject, MatrixDefinition, StageDefinition } from '@dafengzhen/build-matrix';
import type { TestContext } from 'vitest';

import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    await writeFile(
      join(cwd, 'site files', 'entry.js'),
      'console.log(__PROJECT_CONFIG__, __VITE_MODE__, __MATRIX_TARGET__);',
    );
    await mkdir(join(cwd, 'build', 'browser'), { recursive: true });
    await writeFile(join(cwd, 'build', 'browser', 'stale.txt'), 'stale');
    const logger = { error() {}, info() {} };
    const registry = createDefaultRegistry({
      clean: { path: 'build/{target}' },
      shell: { command: node },
      vite: { configFile: 'project.vite.mjs', mode: 'development', root: 'site files' },
    });
    const plan = makePlan(
      [
        {
          id: 'clean',
          tasks: [{ adapter: 'clean', id: 'remove' }],
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
                  'require("node:fs").writeFileSync("site files/index.html", "<p>Matrix build</p><script type=module src=./entry.js></script>")',
                ],
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
                mode: 'production',
                outDir: 'build/{target}',
                viteConfig: {
                  build: { assetsDir: 'bundles', outDir: 'unused' },
                  configFile: false,
                  define: { __MATRIX_TARGET__: '"{target}"' },
                  mode: 'development',
                  root: 'unused',
                },
              },
            },
          ],
        },
      ],
      { target: ['browser'] },
    );
    await writeFile(
      join(cwd, 'project.vite.mjs'),
      `export default ({ mode }) => ({
        build: { emptyOutDir: true, minify: false, watch: {} },
        define: {
          __MATRIX_TARGET__: '"fallback"',
          __PROJECT_CONFIG__: '"project"',
          __VITE_MODE__: JSON.stringify(mode),
        },
      })`,
    );

    const result = await executePlan(plan, { cwd, logger, registry, signal: t.signal });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    expect(result.stages[0].tasks[0].metadata).toStrictEqual({ removed: true });
    expect(result.stages[2].tasks[0].outputs).toStrictEqual([
      { kind: 'directory', path: 'build/browser' },
    ]);
    expect(await readFile(join(cwd, 'build', 'browser', 'index.html'), 'utf8')).toMatch(
      /Matrix build/,
    );
    const assets = join(cwd, 'build', 'browser', 'bundles');
    const [bundle] = await readdir(assets);
    expect(await readFile(join(assets, bundle), 'utf8')).toContain(
      'console.log("project", "production", "browser")',
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
      registry,
      signal: t.signal,
    });
    expect(next.counts.cached).toBe(1);
    expect(next.counts.skipped).toBe(2);
    expect(observed).toStrictEqual(['vite-build', 'cached']);
  },
);

it(
  'builds Vite environments individually or as an app and reports written outputs',
  { timeout: 30_000 },
  async (t) => {
    const cwd = await workspace(t);
    const root = join(cwd, 'site');
    await mkdir(root);
    await writeFile(join(root, 'entry.js'), 'export const value = 1;');
    await writeFile(
      join(root, 'vite.config.mjs'),
      `
    import { appendFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const entry = fileURLToPath(new URL('./entry.js', import.meta.url));
    const record = (name) => appendFileSync('events.txt', name + '\\n');
    export default {
      builder: {
        async buildApp(builder) {
          record('app');
          await builder.build(builder.environments.worker);
        },
      },
      environments: {
        client: {
          build: { rolldownOptions: { input: entry, output: [
            { dir: 'bundles/client-es' },
            { dir: 'bundles/client-cjs', format: 'cjs' },
          ] } },
        },
        worker: { build: { outDir: 'worker', rolldownOptions: { input: entry, output: { entryFileNames: 'bundle.js' } } } },
        admin: { build: { outDir: 'admin', rolldownOptions: { input: entry } } },
      },
      plugins: [{
        name: 'test-lifecycle',
        buildApp: { order: 'pre', handler() { record('pre'); } },
        closeBundle() { record(this.environment.name); },
      }, {
        name: 'test-post',
        buildApp: { order: 'post', handler() { record('post'); } },
      }],
    };
  `,
    );
    const run = async (options: JsonObject) => {
      const result = await executePlan(
        makePlan([
          {
            id: 'build',
            tasks: [{ adapter: 'vite', id: 'bundle', options: { root: 'site', ...options } }],
          },
        ]),
        { cwd, signal: t.signal },
      );
      assert.strictEqual(result.status, 'success', JSON.stringify(result));
      return result.stages[0].tasks[0].outputs;
    };

    expect(
      await run({
        environments: 'worker',
        outputs: [
          { environment: 'worker', path: 'site/worker/bundle.js' },
          { environment: 'worker', kind: 'directory', path: 'site/worker' },
          { environment: 'admin', kind: 'directory', path: 'site/admin' },
        ],
      }),
    ).toStrictEqual([
      { environment: 'worker', kind: 'file', path: 'site/worker/bundle.js' },
      { environment: 'worker', kind: 'directory', path: 'site/worker' },
    ]);
    expect(await readFile(join(cwd, 'events.txt'), 'utf8')).toBe('worker\n');

    expect(await run({ environments: ['admin', 'client', 'admin'] })).toStrictEqual([
      { environment: 'admin', kind: 'directory', path: 'site/admin' },
      { environment: 'client', kind: 'directory', path: 'bundles/client-es' },
      { environment: 'client', kind: 'directory', path: 'bundles/client-cjs' },
    ]);
    expect(await run({ environments: 'all' })).toEqual(
      expect.arrayContaining([
        { environment: 'worker', kind: 'directory', path: 'site/worker' },
        { environment: 'admin', kind: 'directory', path: 'site/admin' },
        { environment: 'client', kind: 'directory', path: 'bundles/client-es' },
        { environment: 'client', kind: 'directory', path: 'bundles/client-cjs' },
      ]),
    );
    expect(await readFile(join(cwd, 'events.txt'), 'utf8')).toMatch(
      /^worker\nadmin\nclient\npre\napp\nworker\npost\nclient\nadmin\n$/,
    );
  },
);

it('reports inferred Vite outputs relative to a linked task directory', async (t) => {
  const parent = await workspace(t);
  const root = join(parent, 'project');
  const cwd = join(parent, 'linked');
  await mkdir(root);
  try {
    await symlink(root, cwd, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') {
      throw error;
    }
    await rm(parent, { force: true, recursive: true });
    t.skip('current environment does not permit creating a symbolic link');
  }
  await writeFile(join(root, 'index.html'), '<p>Build Matrix</p>');
  const plan = makePlan([
    {
      id: 'build',
      tasks: [
        {
          adapter: 'vite',
          cache: { inputs: ['index.html'], outputs: ['dist'], version: '1' },
          id: 'bundle',
          options: { environments: 'client', root: '../project' },
        },
      ],
    },
  ]);
  const result = await executePlan(plan, { cwd, signal: t.signal });
  expect(result.stages[0].tasks[0].outputs).toStrictEqual([
    { environment: 'client', kind: 'directory', path: 'dist' },
  ]);
  const cached = await executePlan(plan, { cwd, signal: t.signal });
  expect(cached.counts.cached).toBe(1);
});

it(
  'validates Vite output declarations and cache coverage and restores environment metadata',
  { timeout: 30_000 },
  async (t) => {
    const cwd = await workspace(t);
    await writeFile(join(cwd, 'index.html'), '<p>Vite</p>');
    const run = async (
      path: string,
      kind: 'directory' | 'file',
      cacheOutput: string,
      environment = 'client',
    ) => {
      const report = join(cwd, 'report.json');
      const plan = makePlan([
        {
          id: 'build',
          tasks: [
            {
              adapter: 'vite',
              cache: {
                inputs: ['index.html'],
                outputs: [cacheOutput],
                version: 'test-vite-outputs',
              },
              id: 'bundle',
              options: { outputs: [{ environment, kind, path }] },
            },
          ],
        },
      ]);
      const result = await executePlan(plan, { cwd, manifestPath: report, signal: t.signal });
      return {
        manifest: JSON.parse(await readFile(report, 'utf8')),
        task: result.stages[0].tasks[0],
      };
    };

    expect((await run('dist/missing.txt', 'file', 'dist')).task.error).toMatchObject({
      code: 'VITE_INVALID_OUTPUT',
      message: expect.stringContaining('Vite output "dist/missing.txt" for environment "client"'),
    });
    expect((await run('dist/index.html', 'directory', 'dist')).task.error).toMatchObject({
      code: 'VITE_INVALID_OUTPUT',
      message: expect.stringContaining('expected a directory, found file'),
    });
    expect((await run('dist/index.html', 'file', 'other')).task.error).toMatchObject({
      code: 'VITE_CACHE_OUTPUT_MISMATCH',
      message: expect.stringContaining('cache.outputs'),
    });
    expect((await run('dist/index.html', 'file', 'dist', 'missing')).task.error).toMatchObject({
      code: 'VITE_UNKNOWN_ENVIRONMENT',
      message: expect.stringContaining('Available: client'),
    });
    expect((await run('dist/index.html', 'file', 'dist')).task.status).toBe('success');
    const { manifest, task } = await run('dist/index.html', 'file', 'dist');
    expect(task.status).toBe('cached');
    expect(task.outputs).toStrictEqual([
      { environment: 'client', kind: 'file', path: 'dist/index.html' },
    ]);
    expect(manifest.stages[0].tasks[0].outputs).toStrictEqual(task.outputs);
  },
);

it('resolves Vite from the effective inline or top-level root before the task directory', async (t) => {
  const cwd = await workspace(t);
  const project = join(cwd, 'packages', 'project');
  const empty = await workspace(t);
  for (const [directory, origin] of [
    [cwd, 'task'],
    [project, 'project'],
  ]) {
    const vitePackage = join(directory, 'node_modules', 'vite');
    await mkdir(vitePackage, { recursive: true });
    await writeFile(
      join(vitePackage, 'package.json'),
      JSON.stringify({ main: './index.mjs', name: 'vite' }),
    );
    await writeFile(
      join(vitePackage, 'index.mjs'),
      `
      import { writeFileSync } from 'node:fs';
      export const loadConfigFromFile = async () => null;
      export const mergeConfig = (inline, overrides) => ({ ...inline, ...overrides });
      export const createBuilder = async () => ({
        build() {},
        buildApp() { writeFileSync('origin.txt', ${JSON.stringify(origin)}); },
        config: { build: {}, environments: {} },
        environments: {},
      });
    `,
    );
  }
  const run = async (options: JsonObject) => {
    const plan = makePlan([{ id: 'build', tasks: [{ adapter: 'vite', id: 'bundle', options }] }]);
    const result = await executePlan(plan, { cwd, signal: t.signal });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    return readFile(join(cwd, 'origin.txt'), 'utf8');
  };
  expect(await run({ viteConfig: { root: 'packages/project' } })).toBe('project');
  expect(await run({ root: 'packages/project', viteConfig: { root: '.' } })).toBe('project');
  expect(await run({ root: empty.replace(/\{([a-zA-Z_][\w-]*)\}/g, '{{$1}}') })).toBe('task');
});

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
      '--no-global-search-paths',
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
