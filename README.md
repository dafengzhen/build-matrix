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

| Adapter | Options and behavior                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shell` | `command` is an executable and `args` is an optional array of strings. Arguments are passed directly. To use pipes or redirection, invoke a shell explicitly. Cancellation stops the direct child process.                                       |
| `clean` | `path` is a relative file or directory inside the task working directory. A missing path succeeds. The working directory itself, external paths, and paths through symbolic links or junctions are rejected.                                     |
| `vite`  | Optional `root`, `configFile`, `mode`, `outDir`, `viteConfig`, `environments`, and `outputs`. Each invocation runs a one-shot build and reports its disk outputs. Install Vite 8.3.8 or a compatible 8.x release in projects using this adapter. |

Set `options.viteConfig` to a JSON object containing inline Vite settings, such as `{ "build": { "sourcemap": true } }`. Vite merges it with the project config file using its usual rules. Explicit top-level `root`, `configFile`, `mode`, and `outDir` take precedence. Paths in those top-level options are relative to the task working directory. Paths inside `viteConfig` follow Vite's rules, so a relative `viteConfig.build.outDir` is relative to the Vite project root.

The adapter resolves Vite from the top-level `root` or `viteConfig.root` first, then from the task working directory, then from Build Matrix. Set one of those root options if Vite lives in a separate package. Resolution happens before Vite loads its project config file.

Use `environments` with one name, a list of names, or `"all"`. Named environments build once each in the order listed and run their own Vite build hooks. `"all"` runs Vite's app builder with the project's app-level hooks and orchestration, then builds any remaining environments. Omitting the option keeps Vite's default builder selection. [Vite Environment API](https://vite.dev/guide/api-environment-frameworks#environments-during-build)

```json
{
  "environments": ["client", "worker"],
  "outputs": [
    { "environment": "client", "kind": "directory", "path": "dist/client" },
    { "environment": "worker", "kind": "file", "path": "dist/worker/index.js" }
  ]
}
```

`outputs` declares the paths to report and verify after the build. Paths are relative to the task working directory or absolute. Omit `kind` to infer it from disk. Entries with an `environment` apply when that environment builds. Entries without one apply to the whole task. With no `outputs` declaration, the adapter reports the files or directories Vite writes to, including multiple output directories. An in-memory build has no inferred disk outputs.

When the task also declares `cache.outputs`, each applicable `options.outputs` path must be listed there or covered by a declared directory. A missing path, the wrong kind, or a cache coverage mismatch fails the Vite task.

## Filters and reports

- `--variant <id>` and `--task <id>` match exact IDs. Repeating a flag selects any specified ID. Using both flags applies both filters. Global tasks are filtered by task ID alone. Filtered invocations remain in reports as `skipped` with `skipReason: "filtered"`. Unknown IDs are configuration errors.
- Reports go to stdout and tool logs go to stderr. `--json` emits a schema 1 report and `--manifest <path>` writes the report to a file, including on task failure or cancellation. Add `--detailed` for timing, artifacts, skip reasons, grouped counts, and schema 2 JSON with scheduling, watch, and hook data.
- Exit codes are `0` for success, `1` for task failure, `2` for configuration or execution errors, `130` for SIGINT, and `143` for SIGTERM. Run `npx build-matrix --help` for the full option list.

## Task caching and watch mode

Declare a task's `cache.version`, `cache.inputs`, and `cache.outputs` to reuse successful results. Input and output paths are relative to the task working directory and support dimension templates. Declare at least one output and list relevant environment variables in `cache.env`. Directory contents are fingerprinted recursively. Include source files, tool configuration, lockfiles, and other inputs that affect the result.

A cache hit reports `cached` and keeps the existing artifacts. Changes to inputs, outputs, options, variants, the declared cache version, or declared environment variables can cause a rebuild. Update the cache version when upgrading an adapter or tool. Each cached invocation should own its outputs. Overlapping cache boundaries within a stage are rejected, and missing, unreadable, or symlinked paths prevent cache hits. Successful records live in `.build-matrix-cache` by default. Use `--cache-dir <path>` to change that location or `--no-cache` to bypass reads and writes.

When an adapter omits `outputs`, the report lists existing files and directories declared in `cache.outputs`, including with `--no-cache`. An explicit adapter `outputs` list takes precedence. For the result to be cached, each reported artifact must be an existing path covered by `cache.outputs`. Declaring a directory also covers its descendants. A successful task still reports unverified artifacts, and its result is ineligible for cache reuse.

`--watch <path>` runs the pipeline once and reruns it when a watched file changes. Repeat the flag to watch several paths. Directories are scanned recursively. Use `--watch-ignore <path>` to exclude generated files. Scans run every 150 ms by default, with a 200 ms quiet period before rebuilding. Override these defaults with `--poll-interval` and `--debounce`. Changes during a run queue for the next run, and task failures leave the watcher running. Press Ctrl+C to stop.

In watch mode, `--json` emits one JSON object per run and `--manifest` atomically replaces the latest report. The manifest and active cache directory are excluded from watching.

## JavaScript and TypeScript API

Use `createPlan` for validation and matrix expansion. Use `executePlan` to run a plan with the built-in adapters or your own registry. An adapter's `run(context, options)` can return artifacts and JSON metadata. Use `context.signal` to respond to cancellation.

```js
import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';

const registry = createDefaultRegistry().register('report-mode', {
  defaults: { mode: '{mode}' },
  factory: () => ({
    async run(_context, { mode }) {
      return { metadata: { mode } };
    },
  }),
});

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

An adapter factory may be synchronous or asynchronous. The registry creates one instance lazily and shares it across tasks using that registration. The `register(id, loader)` form also accepts a loader that returns an adapter or a module with a default adapter export.

Defaults are JSON values. Omitting task options uses the defaults as supplied. When both values are objects, task fields override defaults at the top level. Arrays, scalars, and `null` replace the entire default when supplied as task options. The executor renders dimension templates after merging and uses the resulting options for the task cache key.

Set defaults for built-ins with `createDefaultRegistry({ shell: { command: 'node' } })`. The built-in adapter subpaths also export `createShellAdapter`, `createCleanAdapter`, and `createViteAdapter` for custom registrations.

Use `createManifest(plan, result)` for schema 1 and `createDetailedReport(plan, result)` for schema 2. Set `manifestVersion: 2` to write schema 2 to disk. Use `cache: { directory: 'cache' }` to change the cache location or `cache: false` to disable it.

`watchPlan(plan, { paths, signal, onRun })` provides watch mode and calls `onRun` after persisting the manifest for that run. Both `executePlan` and `watchPlan` accept asynchronous run, stage, and task start and finish hooks. Task hooks cover scheduled invocations, including cache hits. Hook errors appear in `result.hookErrors` and schema 2 reports.

Supply `watchAdapter` to `watchPlan` to use a different change source. Its `watch(context)` method receives absolute `paths`, an `ignore(path)` predicate, and an abort `signal`. Call and await `context.run([])` for the initial run and `context.run(changedPaths)` for each subsequent batch, with paths relative to `context.cwd`.

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
