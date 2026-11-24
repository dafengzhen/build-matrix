import { createPlan } from '@dafengzhen/build-matrix';
import { AdapterRegistry, executePlan } from '@dafengzhen/build-matrix/executor';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const registry = new AdapterRegistry()
  .register('write-notes', () => ({
    async run({ artifacts, cwd }, options) {
      const locale = String(options);
      const notes = await readFile(join(cwd, 'notes', `${locale}.md`), 'utf8');
      const output = await artifacts.stage({ kind: 'file', path: `dist/notes/${locale}.md` });
      await writeFile(output, notes);
      return {};
    },
  }))
  .register('write-index', () => ({
    async run({ artifacts }) {
      const notes = artifacts.get('release-notes').map(({ path }) => path);
      const output = await artifacts.stage({ kind: 'file', path: 'dist/release.json' });
      await writeFile(output, `${JSON.stringify({ notes }, null, 2)}\n`);
      return {};
    },
  }));

const plan = createPlan({
  matrix: { dimensions: { locale: ['en', 'zh'] }, idTemplate: '{locale}' },
  pipeline: {
    stages: [
      {
        id: 'build',
        tasks: [{ adapter: 'write-notes', id: 'release-notes', options: '{locale}' }],
      },
      {
        id: 'index',
        tasks: [
          {
            adapter: 'write-index',
            consumes: ['release-notes'],
            id: 'release-index',
            scope: 'global',
          },
        ],
      },
    ],
  },
});

const result = await executePlan(plan, {
  cwd: import.meta.dirname,
  filter: { taskIds: ['release-index'] },
  manifestPath: 'reports/release.json',
  manifestVersion: 2,
  maxConcurrency: 2,
  registry,
});

console.log(result.counts);
process.exitCode = result.status === 'success' ? 0 : 1;
