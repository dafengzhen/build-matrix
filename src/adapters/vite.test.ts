import type { JsonObject } from '@dafengzhen/build-matrix';
import type { Plugin } from 'vite';
import type { TestContext } from 'vitest';

import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan, watchPlan } from '@dafengzhen/build-matrix/executor';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, expect, it } from 'vitest';

function plan(options: JsonObject, cached = false) {
  return createPlan({
    matrix: { dimensions: {} },
    pipeline: {
      stages: [
        {
          id: 'build',
          tasks: [
            {
              adapter: 'vite',
              ...(cached
                ? { cache: { inputs: ['index.html'], outputs: ['dist'], version: '1' } }
                : {}),
              id: 'bundle',
              options,
            },
          ],
        },
      ],
    },
  });
}

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'build-matrix-vite-test-'));
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }));
  return cwd;
}

it.for(['process', 'in-process'])(
  'merges Vite settings and reports file artifacts for each environment in %s mode',
  async (execution, t) => {
    const cwd = await workspace(t);
    await mkdir(join(cwd, 'alternate'));
    await mkdir(join(cwd, 'alternate', 'public'));
    await writeFile(
      join(cwd, 'index.html'),
      '<p>main</p><script type="module" src="/entry.js"></script>',
    );
    await writeFile(
      join(cwd, 'alternate', 'index.html'),
      '<p>alternate</p><script type="module" src="/entry.js"></script>',
    );
    const entry = 'console.log(__PROJECT__, __ADAPTER__, __TASK__, import.meta.env.MODE)';
    await writeFile(join(cwd, 'entry.js'), entry);
    await writeFile(join(cwd, 'alternate', 'entry.js'), entry);
    await writeFile(join(cwd, 'alternate', 'public', 'robots.txt'), 'test');
    await writeFile(
      join(cwd, 'vite.config.mjs'),
      `export default ({ mode }) => ({
    define: { __PROJECT__: JSON.stringify(mode), __ADAPTER__: '0', __TASK__: '0' },
    environments: { secondary: { consumer: 'client' } }
  })`,
    );
    const registry = createDefaultRegistry({
      vite: {
        environmentOptions: {
          client: { build: { assetsDir: 'from-adapter', sourcemap: true }, outDir: 'build/unused' },
        },
        viteConfig: { define: { __ADAPTER__: '27', __TASK__: '32' } },
      },
    });
    const result = await executePlan(
      plan({
        artifacts: 'files',
        environmentOptions: {
          client: { outDir: 'build/main' },
          secondary: {
            build: { minify: false },
            mode: 'preview',
            outDir: 'build/alternate',
            root: 'alternate',
          },
        },
        environments: ['client', 'secondary'],
        execution,
        viteConfig: { define: { __TASK__: '42' } },
      }),
      { cwd, registry, signal: t.signal },
    );
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    const outputs = result.stages[0].tasks[0].outputs ?? [];
    expect(outputs.map(({ environment, path }) => [environment, path])).toEqual(
      expect.arrayContaining([
        ['client', 'build/main/index.html'],
        ['secondary', 'build/alternate/index.html'],
        ['secondary', 'build/alternate/robots.txt'],
        ['client', expect.stringMatching(/^build\/main\/from-adapter\/.+\.js\.map$/)],
      ]),
    );
    for (const output of outputs) {
      const bytes = await readFile(join(cwd, output.path));
      expect(output.sizeBytes).toBe(bytes.length);
      expect(output.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    const scripts = outputs.filter(({ path }) => path.endsWith('.js'));
    expect(scripts).toHaveLength(2);
    for (const output of scripts) {
      const mode = output.environment === 'client' ? 'production' : 'preview';
      const code = await readFile(join(cwd, output.path), 'utf8');
      expect(code.replaceAll(' ', '').replaceAll('`', '"')).toContain(
        `console.log("${mode}",27,42,"${mode}")`,
      );
    }
  },
);

it('invalidates the process cache when Vite configuration imports or env files change', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'index.html'), '<p>cache</p>');
  await writeFile(
    join(cwd, 'vite.config.mjs'),
    `
    import { text } from './values.mjs';
    export default {
      plugins: [{ name: 'text', transformIndexHtml(html) { return html + text; } }]
    };
  `,
  );
  await writeFile(join(cwd, 'values.mjs'), 'export const text = "first";');
  const configured = plan({ artifacts: 'files' }, true);
  const run = async () =>
    (await executePlan(configured, { cwd, signal: t.signal })).stages[0].tasks[0];
  const first = await run();
  assert.strictEqual(first.status, 'success', JSON.stringify(first));
  expect((await run()).outputs).toStrictEqual(first.outputs);
  expect((await run()).status).toBe('cached');
  await writeFile(join(cwd, 'values.mjs'), 'export const text = "second";');
  expect((await run()).status).toBe('success');
  expect(await readFile(join(cwd, 'dist', 'index.html'), 'utf8')).toContain('second');
  await writeFile(join(cwd, '.env.production.local'), 'VITE_VALUE=updated');
  expect((await run()).status).toBe('success');
});

it('tracks environment plugin inputs and releases cached builders on registry disposal', async (t) => {
  const cwd = await workspace(t);
  const input = join(cwd, 'extra.txt');
  await writeFile(join(cwd, 'index.html'), '<p>page</p>');
  await writeFile(input, 'first');
  let builders = 0;
  let disposed = 0;
  const registry = createDefaultRegistry(
    {},
    {
      vite: {
        beforeConfig(config, context) {
          builders++;
          context.onDispose(() => {
            disposed++;
          });
          config.configFile = false;
        },
        cacheKey: 'environment-plugin-v1',
        configureEnvironment(config, { environment }) {
          if (environment === 'client') {
            return { ...config, build: { ...config.build, minify: false } };
          }
        },
        environmentPlugins: {
          client: {
            buildStart() {
              this.addWatchFile(input);
            },
            async generateBundle() {
              this.emitFile({
                fileName: 'extra-data.txt',
                source: await readFile(input, 'utf8'),
                type: 'asset',
              });
            },
            name: 'dynamic-input',
          } satisfies Plugin,
        },
      },
    },
  );
  t.onTestFinished(() => registry.dispose());
  const configured = plan({ builder: 'reuse', execution: 'in-process' }, true);
  const run = async () =>
    (await executePlan(configured, { cwd, registry, signal: t.signal })).stages[0].tasks[0];
  const first = await run();
  assert.strictEqual(first.status, 'success', JSON.stringify(first));
  expect((await run()).status).toBe('success');
  expect((await run()).status).toBe('cached');
  await writeFile(input, 'changed');
  const changed = await run();
  expect(changed.status).toBe('success');
  expect(changed.cacheMiss).toContain(`discovered:${input}`);
  expect(await readFile(join(cwd, 'dist', 'extra-data.txt'), 'utf8')).toBe('changed');
  expect(builders).toBe(1);
  await registry.dispose();
  expect(disposed).toBe(1);
});

it('watches configuration imports and reuses an in-process Builder across source changes', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'index.html'), '<p>source-one</p>');
  await writeFile(
    join(cwd, 'vite.config.mjs'),
    `
    import { text } from './values.mjs';
    export default { define: { __TEXT__: text } };
  `,
  );
  await writeFile(join(cwd, 'values.mjs'), 'export const text = "config-one";');
  const events: string[] = [];
  const controller = new AbortController();
  const registry = createDefaultRegistry(
    {
      vite: { artifacts: 'files', builder: 'reuse', execution: 'in-process' },
    },
    {
      vite: {
        async collectArtifacts(outputs, context) {
          await writeFile(join(context.cwd, 'dist', 'extra.txt'), 'extra');
          return [...outputs, { environment: 'client', path: 'dist/extra.txt', sizeBytes: 5 }];
        },
        configure(config, { taskId }) {
          events.push(`configure:${taskId}`);
          const text = String(config.define?.__TEXT__);
          config.build!.sourcemap = true;
          config.plugins = [
            {
              name: 'configured-text',
              transformIndexHtml: (html) => `${html}<p>${text}</p>`,
            },
          ];
        },
        onBuildEnd: ({ status }) => {
          events.push(`end:${status}`);
        },
        onBuildStart: () => {
          events.push('start');
        },
        onEnvironmentEnd: ({ environment, status }) => {
          events.push(`end:${environment}:${status}`);
        },
        onEnvironmentStart: ({ environment }) => {
          events.push(`start:${environment}`);
        },
        plugins: [
          false,
          Promise.resolve({
            name: 'direct-text',
            transformIndexHtml: (html) => `${html}<p>direct</p>`,
          }),
        ],
        validateArtifact: (output) => {
          expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
        },
      },
    },
  );
  const reported: string[][] = [];
  await watchPlan(plan({ viteConfig: { build: { minify: false } } }), {
    cwd,
    debounceMs: 10,
    async onRun(result) {
      assert.strictEqual(result.status, 'success', JSON.stringify(result));
      const html = await readFile(join(cwd, 'dist', 'index.html'), 'utf8');
      expect(html).toContain('direct');
      expect(result.stages[0].tasks[0].outputs).toContainEqual(
        expect.objectContaining({ path: 'dist/extra.txt', sizeBytes: 5 }),
      );
      const { changedPaths, number } = result.watch!;
      reported.push([...changedPaths]);
      expect(html).toContain(['config-one', 'source-two', 'config-two'][number - 1]);
      if (number === 1) {
        await writeFile(join(cwd, 'index.html'), '<p>source-two</p>');
      } else if (number === 2) {
        await writeFile(join(cwd, 'values.mjs'), 'export const text = "config-two";');
      } else {
        controller.abort();
      }
    },
    paths: ['index.html'],
    pollIntervalMs: 10,
    registry,
    signal: AbortSignal.any([controller.signal, t.signal, AbortSignal.timeout(5_000)]),
  });
  expect(reported).toEqual([[], ['index.html'], ['values.mjs']]);
  const environment = ['start:client', 'end:client:success', 'end:success'];
  expect(events).toEqual([
    'start',
    'configure:bundle',
    ...environment,
    'start',
    ...environment,
    'start',
    'configure:bundle',
    ...environment,
  ]);
});

it('reports failed lifecycle events and rejects bad artifact checksums', async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'index.html'), '<p>build</p>');
  const statuses: string[] = [];
  const registry = createDefaultRegistry(
    { vite: { execution: 'in-process' } },
    {
      vite: {
        onBuildEnd: ({ status }) => {
          statuses.push(status);
        },
        onEnvironmentEnd: ({ status }) => {
          statuses.push(status);
        },
      },
    },
  );
  const result = await executePlan(
    plan({
      configFile: false,
      outputs: [{ path: 'dist/index.html', sha256: '0'.repeat(64) }],
    }),
    { cwd, registry, signal: t.signal },
  );
  expect(result.stages[0].tasks[0].error?.code).toBe('VITE_INVALID_OUTPUT');
  expect(statuses).toEqual(['success', 'failed']);
  await rm(join(cwd, 'index.html'));
  const failed = await executePlan(plan({ configFile: false }), {
    cwd,
    registry,
    signal: t.signal,
  });
  expect(failed.status).toBe('failed');
  expect(statuses).toEqual(['success', 'failed', 'failed', 'failed']);
});
