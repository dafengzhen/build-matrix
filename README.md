# Build Matrix

[简体中文](./README.zh.md) · [Examples](./examples/README.md)

Build Matrix expands build dimensions into variants and runs them through a staged pipeline. Use the `build-matrix` CLI with a JSON configuration, or build and execute plans from JavaScript or TypeScript. Built-in adapters run commands, clean paths, and build Vite projects.

## Quick start

Requires Node.js 26 or later.

```sh
npm install -D @dafengzhen/build-matrix
```

Save this configuration as `build-matrix.json` in your project.

```json
{
  "matrix": {
    "dimensions": { "mode": ["development", "production"] },
    "idTemplate": "{mode}"
  },
  "pipeline": {
    "stages": [
      {
        "id": "build",
        "tasks": [
          {
            "id": "print-mode",
            "adapter": "shell",
            "options": {
              "command": "node",
              "args": ["-e", "console.log(process.argv[1])", "{mode}"]
            }
          }
        ]
      }
    ]
  }
}
```

```sh
npx build-matrix
npx build-matrix --variant production --task print-mode --json --detailed --manifest reports/run.json
```

The CLI reads `build-matrix.json` in the current directory by default. Pass a path as the first argument to use another configuration. Tasks run from the configuration directory, which is also the base for relative cache, watch, and manifest paths.

## Matrix and pipeline

- Dimensions and their values expand in declaration order. Names start with a letter or underscore and may contain letters, digits, underscores, and hyphens. Values are strings, finite numbers, or booleans. An empty dimension map produces one variant named `default`.
- Each `exclude` rule removes combinations matching all its fields. After exclusions, `include` appends complete combinations and may introduce new values. Duplicate combinations are collapsed. `maxVariants` defaults to 1,000.
- Default IDs follow the dimension order, for example `runtime=node,format=esm`. Set `idTemplate` for custom IDs. IDs must be nonempty and unique. Strings in task options, including nested arrays and objects, support `{dimension}` substitution and `{{dimension}}` for a literal placeholder.
- Stages run in declaration order. Stage IDs and task IDs are each unique across the pipeline. A task runs once per variant by default. A task with `scope: "global"` runs once in its stage, even with zero variants, and has no dimension context.
- The default concurrency is one task at a time. Set `--max-concurrency` or API option `maxConcurrency` to run tasks in parallel within a stage. Use `pipeline.resourceLimits` and task `resourceGroup` for per-group limits. Override those limits with `--resource cpu=2` or API option `resourceLimits`. Reports keep stage, task, and variant declaration order.
- A failed task stops later stages. Within the current stage, `fail-fast` stops starting tasks and waits for work already running. Use `failurePolicy: "continue"` to finish the current stage. Cancellation preserves completed results and passes an abort signal to running adapters.

## Adapters

| Adapter | Options and behavior                                                                                                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell` | `command` is an executable and `args` is an optional array of strings. Arguments are passed directly. To use pipes or redirection, invoke a shell explicitly. Cancellation stops the direct child process.                                                                              |
| `clean` | `path` is a relative file or directory inside the task working directory. A missing path succeeds. The working directory itself, external paths, and paths through symbolic links or junctions are rejected.                                                                            |
| `vite`  | Optional `root`, `configFile`, `mode`, and `outDir`. Paths are relative to the task working directory. Each invocation runs one build and reports the supplied output directory if it exists afterwards. Install Vite 8.3.8 or a compatible 8.x release in projects using this adapter. |

## Filters and reports

- `--variant <id>` and `--task <id>` match exact IDs. Repeating a flag selects any specified ID. Using both flags applies both filters. Global tasks are filtered by task ID alone. Filtered invocations remain in reports as `skipped` with `skipReason: "filtered"`. Unknown IDs are configuration errors.
- Reports go to stdout and tool logs go to stderr. `--json` emits a schema 1 report and `--manifest <path>` writes the report to a file, including on task failure or cancellation. Add `--detailed` for timing, artifacts, skip reasons, grouped counts, and schema 2 JSON with scheduling, watch, and hook data.
- Exit codes are `0` for success, `1` for task failure, `2` for configuration or execution errors, `130` for SIGINT, and `143` for SIGTERM. Run `npx build-matrix --help` for the full option list.

## Task caching and watch mode

Declare a task's `cache.version`, `cache.inputs`, and `cache.outputs` to reuse successful results. Input and output paths are relative to the task working directory and support dimension templates. Declare at least one output and list relevant environment variables in `cache.env`. Directory contents are fingerprinted recursively. Include source files, tool configuration, lockfiles, and other inputs that affect the result.

A cache hit reports `cached` and keeps the existing artifacts. Changes to inputs, outputs, options, variants, the declared cache version, or declared environment variables can cause a rebuild. Update the cache version when upgrading an adapter or tool. Each cached invocation should own its outputs. Overlapping cache boundaries within a stage are rejected, and missing, unreadable, or symlinked paths prevent cache hits. Successful records live in `.build-matrix-cache` by default. Use `--cache-dir <path>` to change that location or `--no-cache` to bypass reads and writes.

`--watch <path>` runs the pipeline once and reruns it when a watched file changes. Repeat the flag to watch several paths. Directories are scanned recursively. Use `--watch-ignore <path>` to exclude generated files. Scans run every 150 ms by default, with a 200 ms quiet period before rebuilding. Override these defaults with `--poll-interval` and `--debounce`. Changes during a run queue for the next run, and task failures leave the watcher running. Press Ctrl+C to stop.

In watch mode, `--json` emits one JSON object per run and `--manifest` atomically replaces the latest report. The manifest and active cache directory are excluded from watching.

## JavaScript and TypeScript API

Use `createPlan` for validation and matrix expansion. Use `executePlan` to run a plan with the built-in adapters or your own registry. An adapter's `run(context, options)` can return artifacts and JSON metadata. Use `context.signal` to respond to cancellation.

```js
import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';

const registry = createDefaultRegistry().register('report-mode', () => ({
  async run({ variant }) {
    return { metadata: { mode: variant?.values.mode ?? null } };
  },
}));

const plan = createPlan({
  matrix: { dimensions: { mode: ['development', 'production'] } },
  pipeline: { stages: [{ id: 'report', tasks: [{ id: 'mode', adapter: 'report-mode' }] }] },
});

const result = await executePlan(plan, {
  registry,
  filter: { variantIds: ['mode=production'], taskIds: ['mode'] },
  manifestPath: 'reports/run.json',
});
console.log(result.counts);
```

Use `createManifest(plan, result)` for schema 1 and `createDetailedReport(plan, result)` for schema 2. Set `manifestVersion: 2` to write schema 2 to disk. Use `cache: { directory: 'cache' }` to change the cache location or `cache: false` to disable it.

`watchPlan(plan, { paths, signal, onRun })` provides watch mode and calls `onRun` after persisting the manifest for that run. Both `executePlan` and `watchPlan` accept asynchronous run, stage, and task start and finish hooks. Task hooks cover scheduled invocations, including cache hits. Hook errors appear in `result.hookErrors` and schema 2 reports.

## Examples and development

See the [runnable examples](./examples/README.md) for matrix filtering, caching, watch mode, custom adapters, and Vite builds.

Development also requires Node.js 26 or later.

```sh
npm ci
npm run check
```

`npm run check` checks lint, formatting, and TypeScript types, runs the tests, and validates the package with publint. `npm run build` emits JavaScript and type declarations, and `npm test` builds the package before running Vitest. Use `npm run lint:fix` and `npm run fmt` for fixes, and `npm run test:coverage` for a coverage report in `coverage/`.

Vitest discovers `.test.ts` files alongside the modules under `src/`.

## License

[MIT](./LICENSE)
