import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';

const registry = createDefaultRegistry().register('report-mode', () => ({
  async run({ variant }) {
    return { metadata: { mode: variant?.values.mode ?? null } };
  },
}));

const plan = createPlan({
  matrix: {
    dimensions: { mode: ['development', 'production'] },
    idTemplate: '{mode}',
  },
  pipeline: {
    stages: [
      {
        id: 'report',
        tasks: [{ adapter: 'report-mode', id: 'mode' }],
      },
    ],
  },
});

const result = await executePlan(plan, {
  hooks: {
    onTaskFinish(task) {
      console.log(`[${task.status}] ${task.variantId} ${JSON.stringify(task.metadata)}`);
    },
  },
  maxConcurrency: 2,
  registry,
});

console.log(JSON.stringify(result.counts));
