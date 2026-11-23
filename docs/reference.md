# Build Matrix reference

[简体中文](./reference.zh.md) · [Project README](../README.md) · [Examples](../examples/README.md)

## Matrix and pipeline

- Dimensions and their values expand in declaration order. Names start with a letter or underscore and may contain letters, digits, underscores, and hyphens. Values are strings, finite numbers, or booleans. An empty dimension map produces one variant named `default`.
- Each `exclude` rule removes combinations matching all its fields. After exclusions, `include` appends complete combinations and may introduce new values. Duplicate combinations are collapsed. `maxVariants` defaults to 1,000.
- Default IDs follow the dimension order, for example `runtime=node,format=esm`. Set `idTemplate` for custom IDs. IDs must be nonempty and unique. Strings in task options, including nested arrays and objects, support `{dimension}` substitution and `{{dimension}}` for a literal placeholder.
- Stages run in declaration order. Stage IDs and task IDs are each unique across the pipeline. A task runs once per variant by default. A task with `scope: "global"` runs once in its stage, even with zero variants, and has no dimension context.
- The default concurrency is one task at a time. Set `--max-concurrency` or API option `maxConcurrency` to run tasks in parallel within a stage. Use `pipeline.resourceLimits` and task `resourceGroup` for per-group limits. Override those limits with `--resource cpu=2` or API option `resourceLimits`. Reports keep stage, task, and variant declaration order.
- A failed task stops later stages. Within the current stage, `fail-fast` stops starting tasks and waits for work already running. Use `failurePolicy: "continue"` to finish the current stage. Cancellation preserves completed results and passes an abort signal to running adapters.

## Adapters

| Adapter | Options and behavior                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shell` | `command` is an executable and `args` is an optional array of strings. Arguments are passed directly. To use pipes or redirection, invoke a shell explicitly. Cancellation stops the direct child process.   |
| `clean` | `path` is a relative file or directory inside the task working directory. A missing path succeeds. The working directory itself, external paths, and paths through symbolic links or junctions are rejected. |
| `vite`  | Builds with Vite 8.3.8 or a compatible 8.x release. Each task can select environments, configure their builds, and report disk artifacts.                                                                    |

### Vite execution and configuration

`execution: "process"` runs Vite in a child process and is the default. `execution: "in-process"` calls the Vite API in the executor and supports JavaScript plugins and callbacks. An in-process build observes cancellation before and after each environment build. Build Matrix waits for a Vite API call already in progress to settle.

The configuration layers, from lowest to highest priority, are Vite defaults, the project config file, the adapter's `viteConfig`, and the task's `viteConfig`. Nested objects and arrays follow Vite's merge rules. The top-level `root`, `configFile`, `mode`, and `outDir` shortcuts take precedence over their counterparts inside either `viteConfig`. A task shortcut overrides the same adapter shortcut. The shortcuts' paths are relative to the task working directory. Other Vite paths follow Vite's rules, so `viteConfig.build.outDir` is relative to the Vite root. Set `configFile: false` to disable project config loading.

The adapter resolves Vite from the effective inline root first, then from the task working directory, then from Build Matrix. Set `root` when Vite is installed in a separate package.

### Environments

Use `environments` with one name, a list of names, or `"all"`. A list builds in the order given. `"all"` runs the project's app builder and then builds any remaining environments. Omitting the option keeps Vite's default builder selection. [Vite Environment API](https://vite.dev/guide/api-environment-frameworks#environments-during-build)

`environmentOptions` takes a map keyed by environment name. Its `build` entries merge into the corresponding Vite environment, with task values taking precedence over adapter values. The per-environment `root` and `outDir` shortcuts are relative to the task working directory. A root or mode override resolves a separate Vite builder for that environment using the same project config file. Config functions receive the environment's mode.

```json
{
  "artifacts": "files",
  "environments": ["client", "worker"],
  "environmentOptions": {
    "client": { "outDir": "dist/client" },
    "worker": {
      "root": "workers",
      "mode": "staging",
      "outDir": "dist/worker",
      "build": { "sourcemap": true }
    }
  }
}
```

### JavaScript extensions

```ts
import { createDefaultRegistry } from '@dafengzhen/build-matrix/executor';

const registry = createDefaultRegistry(
  { vite: { execution: 'in-process' } },
  {
    vite: {
      configure(config, { variant }) {
        config.define = {
          ...config.define,
          __VARIANT__: JSON.stringify(variant?.id ?? 'global'),
        };
      },
      plugins: [{ name: 'project-html', transformIndexHtml: (html) => html.trim() }],
      onEnvironmentEnd({ environment, logger, status }) {
        logger.info(`${environment} ${status}`);
      },
    },
  },
);
```

Pass this registry to `executePlan` or `watchPlan`. `configure(config, context)` can mutate or replace the merged inline config before Vite resolves it. The callback runs when creating a builder and receives `context.environment` when resolving an environment's separate builder. Injected `plugins` accept Vite's `PluginOption[]`, including nested and promised plugins. You can also call `createViteAdapter({ defaults, configure, plugins })` from the Vite adapter subpath. Use `prepare: true` when registering that adapter under a custom ID to enable automatic cache and watch inputs.

`onBuildStart` and `onBuildEnd` wrap an executed build and its artifact collection. `onEnvironmentStart` and `onEnvironmentEnd` wrap each environment build, including those started by the app builder. End events contain `status` and either `result` or `error`. Hook errors fail the task. Cache hits reuse the saved artifacts and skip build hooks.

### Artifacts, cache and watch

The default `artifacts: "directories"` reports Vite's output locations. Use `artifacts: "files"` to report emitted files and copied public files with their environment, byte size, and SHA-256 digest. In-memory builds have no inferred disk artifacts.

Set `outputs` to declare the paths to report and verify after building. Entries accept `path`, `kind`, `environment`, `sizeBytes`, and `sha256`. Paths can be absolute or relative to the task working directory. An environment-specific declaration applies when that environment builds. The programmatic `collectArtifacts(outputs, context)` callback can replace or add candidates. `validateArtifact(output, context)` can apply additional checks by throwing an error. Declared or custom paths must exist, match their expectations, and be covered by `cache.outputs` if the task declares it.

The task cache and default polling watcher track the Vite config and the dependencies reported by Vite's config loader, along with the mode's env files. Continue to declare source files in `cache.inputs` and watch paths. Put additional inputs that project code reads directly in these declarations. JavaScript extensions bypass the task cache by default. Supply a string or callback as `cacheKey` to opt in, and change its value when relevant extension inputs change.

`builder: "once"` creates a new builder for each build. With `execution: "in-process"` and `builder: "reuse"`, the adapter retains a builder per task and variant for use across repeated calls with the same registry. Source edits trigger a fresh build with the same builder. Configuration dependency changes, option changes, a changed `cacheKey`, or a failed Vite build discard the builder. Build Matrix's watcher schedules these builds using its usual debounce and cancellation behavior.

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

## Troubleshooting

- For an unknown variant ID, inspect the `variants` array in the unfiltered JSON report. Default IDs follow the declared dimension order and distinguish number and boolean values with encoded prefixes.
- For unexpected cache misses, check whether the outputs still exist and whether every declared path is readable. Cleaning outputs before a build forces a miss. Keep cache versions in sync with tools and include the files and environment variables that affect the build.
- For repeated watch runs, limit the watched paths to source files or exclude generated paths with `--watch-ignore`. Watch mode already excludes the active cache and the manifest.
- To use shell pipes or redirection, set `command` to your shell executable and pass the command through its arguments. The adapter passes `args` directly to the chosen executable.
