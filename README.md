# Build Matrix

[简体中文](./README.zh.md) · [Runnable examples](./examples/README.md)

Build Matrix orchestrates builds for projects that ship multiple variants, such as a library with ESM and CommonJS bundles or a monorepo with several Vite apps. Use the same build configuration locally and in CI.

- [Why Build Matrix?](#why-build-matrix)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI](#cli)
- [JavaScript and TypeScript API](#javascript-and-typescript-api)
- [Common workflows](#common-workflows)
- [Vite integration](#vite-integration)
- [Third-party build tools](#third-party-build-tools)

## Why Build Matrix?

- **Define variants once.** Declare dimensions such as app, mode, and output format. Include or exclude combinations, use templates to route each build to its own output directory, and select individual tasks or variants by ID.
- **Connect build stages through artifacts.** Run checks, builds, and packaging in order. A downstream task can consume artifacts from its matching variant, or a global task can gather outputs from every variant into one release index.
- **Control parallelism and failure handling.** Run independent tasks concurrently within a stage, cap resource-intensive tasks by group, and choose whether a failure stops scheduling or allows later stages to run.
- **Reuse builds and rebuild affected work.** Task caches check declared inputs, outputs, and environment variables. Incremental watch uses known inputs and artifact dependencies to rerun affected tasks and steps.
- **Keep your existing tooling.** The built-in Vite adapter supports modes, environments, and artifact reporting. Run other tools through `shell` or call their JavaScript APIs from custom adapters.
- **See what ran in CI.** JSON reports show which tasks succeeded, failed, were skipped, or hit the cache. Detailed reports add timing, cache miss reasons, and watch changes.

## Quick start

Requires Node.js 26 or later.

```sh
npm install -D @dafengzhen/build-matrix
```

Save this as `build-matrix.json`.

```json
{
  "matrix": { "dimensions": { "mode": ["dev", "prod"] }, "idTemplate": "{mode}" },
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
npx build-matrix --variant prod
```

The first command runs both variants. The second runs only `prod`. Use the CLI for a JSON configuration in local builds or CI. Use `createPlan` with `executePlan` when a JavaScript or TypeScript script needs a custom adapter, lifecycle hooks, or access to results. Use `watchPlan` for repeated builds driven by file changes. Use `expandMatrix` when you only need the variant list.

## Configuration

### Matrix

| Field         | Behavior                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dimensions`  | Required map of dimension names to nonempty arrays of strings, finite numbers, or booleans. Names match `[A-Za-z_][\w-]*`. Combinations follow the declared dimension and value order. `{}` produces one variant with ID `default`. |
| `exclude`     | Removes combinations matching every field in a rule. Use partial rules to exclude across multiple values.                                                                                                                           |
| `include`     | Adds complete combinations after exclusions. Each entry supplies every dimension and may introduce new values. Duplicate combinations collapse.                                                                                     |
| `idTemplate`  | Generates a unique, nonempty ID, such as `{runtime}-{format}`. Without a template, IDs look like `runtime=node,format=esm`. String values are escaped when needed, and numbers and booleans use `~n` and `~b` prefixes.             |
| `maxVariants` | Positive integer cap on expanded variants. Defaults to 1,000.                                                                                                                                                                       |

Use `{dimension}` in strings and `{{dimension}}` to emit a literal placeholder. Build Matrix renders task option values recursively, including strings in arrays and objects, as well as `environment` and cache input and output paths. A global task has no dimension values.

### Pipeline

| Field                        | Behavior                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline.stages`            | Required array. Stages run in declaration order. Each stage has a unique `id` and a `tasks` array.                                                                            |
| `pipeline.resourceLimits`    | Map of resource group names to positive concurrency limits. Set a per-run override with `--resource` or `resourceLimits`. The run-wide limit still applies.                   |
| `stage.failurePolicy`        | `"fail-fast"` (default) stops starting new tasks after failure and waits for active tasks. `"continue"` finishes the stage. `"continue-pipeline"` allows later stages to run. |
| `task.id` and `task.adapter` | Required task ID and registered adapter ID. Task IDs are unique across the pipeline. The default registry provides `shell`, `clean`, and `vite`.                              |
| `task.options`               | JSON value passed to the adapter after defaults and template rendering. See the adapter for its fields.                                                                       |
| `task.scope`                 | `"variant"` (default) runs once per variant. `"global"` runs once in the stage, even with zero variants.                                                                      |
| `task.resourceGroup`         | Assigns the task to a named concurrency group. The effective resource limits must include that group.                                                                         |
| `task.environment`           | Optional label exposed as `context.environment`. Use the Vite adapter's `environments` option to select Vite environments.                                                    |
| `task.consumes`              | IDs of tasks in earlier stages whose artifacts this task needs. Selecting a consumer also selects its upstream invocations.                                                   |
| `task.cache`                 | Enables caching for the task. Supply `version`, `inputs`, and `outputs`. `env` and `shared` are optional. See [Cache and watch](#cache-and-watch).                            |

### Built-in adapters

| Adapter | Options and when to use                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell` | Runs `command` with optional string `args` (default `[]`). Use it for an existing build, test, or packaging command. Arguments go directly to the executable. To use pipes or redirection, invoke a shell explicitly. Cancellation stops the direct child process.                 |
| `clean` | Deletes the relative file or directory in `path` inside the task working directory. A missing path succeeds. The adapter rejects the working directory itself, paths outside it, and symlinks or junctions. Use it for explicit cleanup. Deleting cached outputs forces a rebuild. |
| `vite`  | Builds a Vite project with configurable modes, environments, and artifacts. See [Vite integration](#vite-integration) for all options.                                                                                                                                             |

## CLI

`build-matrix [config.json] [options]` defaults to `build-matrix.json`. The CLI resolves the config path from the current directory, then uses the config directory as the task working directory and as the base for relative cache, manifest, and watch paths.

| Option                                    | Behavior                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h`, `--help`                            | Print usage.                                                                                                                                                                                                                                      |
| `--variant <id>`, `--task <id>`           | Select exact IDs. Repeat either flag to select several IDs, and combine both to apply both filters. Global tasks use the task filter. Unknown IDs are configuration errors. Filtered invocations remain in reports with `skipReason: "filtered"`. |
| `-j <n>`, `--max-concurrency <n>`         | Set maximum concurrent tasks within a stage. Defaults to 1.                                                                                                                                                                                       |
| `--resource <group>=<n>`                  | Override a concurrency group limit. Repeat for multiple groups.                                                                                                                                                                                   |
| `--json`, `--manifest <path>`             | Print JSON to stdout, write it to a file, or do both. The CLI sends tool logs to stderr. A manifest is written for completed runs, including task failure or cancellation.                                                                        |
| `--detailed`                              | Add report detail and select schema 2 for JSON. Schema 1 is the default.                                                                                                                                                                          |
| `--cache-dir <path>`, `--no-cache`        | Change the local cache location (default `.build-matrix-cache`) or bypass cache reads and writes.                                                                                                                                                 |
| `--watch <path>`, `--watch-ignore <path>` | Watch a file or scan a directory recursively, or exclude a path. Both flags are repeatable.                                                                                                                                                       |
| `--watch-incremental`                     | Watch known task inputs and rebuild affected tasks and steps. Works without `--watch`.                                                                                                                                                            |
| `--watch-strategy <name>`                 | `polling` (default) uses scans. `native` uses filesystem events with fallback scans.                                                                                                                                                              |
| `--debounce <ms>`, `--poll-interval <ms>` | Set the quiet period (default 200 ms) and scan interval (default 150 ms for polling, 1,000 ms for native fallback).                                                                                                                               |

Watch mode runs once immediately, then queues changes made during a build. Task failures leave the watcher running. Press Ctrl+C to stop. Each run emits one JSON object on a single line when using `--json`, and `--manifest` atomically replaces the latest report. Use `--watch` or `--watch-incremental` to enable the other watch flags.

Exit codes are `0` for success, `1` for task failure, `2` for a configuration or execution error, `130` for SIGINT, and `143` for SIGTERM.

## JavaScript and TypeScript API

### Planning and templates

Import from `@dafengzhen/build-matrix`.

| API                                       | Arguments and return value                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expandMatrix(matrix)`                    | Validates a `MatrixDefinition` and returns a read-only array of `{ id, values }` variants. Use it to preview IDs or drive another tool with the same matrix.                    |
| `createPlan(config)`                      | Validates a `BuildConfiguration` with `matrix` and `pipeline` and returns an immutable `Plan` with `variants`, `stages`, and optional `resourceLimits`. Pass it to an executor. |
| `renderTemplate(template, values, path?)` | Substitutes dimension values in a string. `path` defaults to `"template"` and labels validation errors.                                                                         |
| `renderOptions(options, values, path?)`   | Renders string values recursively in any `JsonValue`. Object keys and non-string values stay as supplied. `path` defaults to `"options"`.                                       |
| `ConfigurationError`                      | Error class for invalid configuration, such as an unknown dimension or duplicate ID. Use `instanceof ConfigurationError` to distinguish validation errors.                      |

### Execution

Import from `@dafengzhen/build-matrix/executor`.

`executePlan(plan, options?)` runs a plan once and resolves to a `RunResult` with run status, counts, timings, stages, and individual task results. Check `result.status` for `success`, `failed`, or `cancelled`. Task failures appear in the result. Invalid execution settings can reject the call.

| `ExecuteOptions`                   | Behavior                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                              | Task working directory. Defaults to `process.cwd()`.                                                                                                                                                                                                                                     |
| `registry`                         | Adapter registry. Omit it to use the built-ins with automatic disposal. Dispose a caller-owned registry when finished.                                                                                                                                                                   |
| `filter`                           | `{ variantIds?, taskIds? }` matches exact IDs as in the CLI.                                                                                                                                                                                                                             |
| `maxConcurrency`, `resourceLimits` | Set the run-wide concurrency (default 1) and override resource limits from the plan.                                                                                                                                                                                                     |
| `signal`                           | An `AbortSignal` passed to adapters. Cancellation preserves completed results.                                                                                                                                                                                                           |
| `logger`                           | Object with `info(message)` and `error(message)`. The default logger is silent.                                                                                                                                                                                                          |
| `hooks`                            | Async or sync callbacks `onRunStart`, `onRunFinish`, `onStageStart`, `onStageFinish`, `onTaskStart`, `onTaskFinish`, `onAdapterStart`, and `onAdapterFinish`. Task and adapter hooks cover scheduled invocations, including cache hits. Hook errors are recorded in `result.hookErrors`. |
| `manifestPath`, `manifestVersion`  | Write a manifest relative to `cwd` or to an absolute path. Select schema `1` (default) or `2`.                                                                                                                                                                                           |
| `cache`                            | `false` disables caching. Pass `{ directory?, backend?, fingerprint? }` to configure it for tasks that declare a cache. See [Cache and watch](#cache-and-watch).                                                                                                                         |
| `artifacts`                        | `{ cleanup?, transform?, validate? }` configures artifact reconciliation and processing. See [Pass artifacts between stages](#pass-artifacts-between-stages).                                                                                                                            |

`watchPlan(plan, options)` accepts every execution option plus the options below. It resolves when the watcher stops. Use `onRun` to inspect each result.

| `WatchOptions`                             | Behavior                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`, `ignore`                          | Paths to watch and exclude, resolved from `cwd`. Supply at least one path or enable `incremental`. The active cache, its state directory, manifest, and temporary artifact paths are excluded.                                                                                         |
| `incremental`                              | Defaults to `false`. When enabled, reruns affected tasks and steps and discovers watch paths from known inputs. Tasks with incomplete dependency information rerun conservatively.                                                                                                     |
| `classifyChanges`                          | Defaults to `true` in the API. Includes available `added`, `modified`, `deleted`, and detectable `renamed` events in `result.watch.changes`.                                                                                                                                           |
| `strategy`, `pollIntervalMs`, `debounceMs` | Choose `"polling"` or `"native"`, set the scan interval, and set the quiet period. Defaults match the CLI.                                                                                                                                                                             |
| `watchAdapter`                             | Supply a custom `WatchAdapter` instead of the strategy. Its `watch(context)` receives absolute `paths`, `ignore(path)`, `trackedPaths()` and an abort `signal`. Await `context.run([])` for the initial run and `context.run(changedPaths)` for each batch using `cwd`-relative paths. |
| `onRun(result)`                            | Optional sync or async callback after each run and after its manifest has been written.                                                                                                                                                                                                |

The `pollingWatchAdapter` and `nativeWatchAdapter` exports are ready-to-use `WatchAdapter` objects. Pass either as `watchAdapter` if selecting the watcher in code.

### Registries and adapters

| API                                                | Arguments and behavior                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new AdapterRegistry()`                            | Creates an empty registry. Use it when you want to register all adapters yourself.                                                                                                                                                                                             |
| `createDefaultRegistry(defaults?, extensions?)`    | Registers the three built-ins. Defaults accept `{ shell?, clean?, vite? }`. `extensions.vite` accepts the programmatic Vite options except `defaults`, which comes from `defaults.vite`.                                                                                       |
| `registry.register(id, definition)`                | Registers a unique ID and returns the registry for chaining. Accepts a definition with `factory`, `defaults?`, `prepare?: true`, `scope?: "invocation"`, and `mergeDefaults?: false`. It also accepts a loader returning an adapter or a module with a default adapter export. |
| `registry.has(id)`, `getDefaults(id)`              | Check registration or read its declared defaults.                                                                                                                                                                                                                              |
| `registry.invocationScoped(id)`, `prepares(id)`    | Check whether an adapter is invocation-scoped or is loaded before the cache lookup.                                                                                                                                                                                            |
| `registry.load(id, context?)`                      | Load an instance directly. Pass an `AdapterContext` for an invocation-scoped registration.                                                                                                                                                                                     |
| `registry.mergeTaskOptions(id, options)`           | Apply registry defaults without rendering dimension templates.                                                                                                                                                                                                                 |
| `registry.use(middlewareOrPlugin)`, `middleware()` | Register middleware, or a plugin with `setup(registry)` and a `middleware` array. Middleware receives `{ context, options }` and `next()`. `middleware()` returns the current middleware in registration order.                                                                |
| `registry.dispose()`                               | Await cleanup of loaded shared adapters.                                                                                                                                                                                                                                       |
| `composeAdapter(steps)`                            | Make an adapter from an array of `AdapterStep` objects or a sync or async `(context, options) => steps` factory.                                                                                                                                                               |
| `retryAdapter(attempts, shouldRetry?)`             | Middleware for transient failures. `attempts` includes the first try. The optional predicate receives the thrown error and defaults to accepting all errors. Cancellation stops retrying.                                                                                      |

A factory can be synchronous or asynchronous. By default, the registry loads one instance lazily and shares it across invocations. Use `scope: "invocation"` to pass the context to the factory and dispose each instance after its invocation. For registry-managed defaults, task objects override default fields at the top level. Arrays, scalars, and `null` replace the defaults. Set `mergeDefaults: false` when the adapter merges options itself.

An adapter implements `run(context, options)` or `prepare(context, options)` and may implement `dispose()`. `run` returns an object with optional `outputs` and JSON `metadata`. `prepare` can return `inputs`, a `cacheKey` (or `false` to bypass caching), a `run()` callback, or `steps`. Set `prepare: true` on a shared registration when preparation must run before a cache lookup. `AdapterContext` supplies `cwd`, `signal`, `logger`, run/stage/task IDs, `variant`, `environment`, `artifacts`, `cacheOutputs`, `cacheEnabled`, `watching`, `stepPath`, `trackInputs()`, `taskData` shared by the task and its steps, and `runData` shared by the run.

For custom registrations, import `createShellAdapter()` from `@dafengzhen/build-matrix/adapters/shell`, `createCleanAdapter()` from `@dafengzhen/build-matrix/adapters/clean`, or `createViteAdapter(options?)` from `@dafengzhen/build-matrix/adapters/vite`. The shell and clean factories take no arguments. Set their task defaults in the registry. Each adapter subpath also default-exports a ready-to-use instance.

### Reports and CLI entry point

| API                                  | Arguments and return value                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createManifest(plan, result)`       | From `/executor`. Returns schema 1 JSON data with plan counts, variants, run status, and task results.                                                                                                                              |
| `createDetailedReport(plan, result)` | From `/executor`. Returns schema 2 with scheduler settings, timing and artifact metrics grouped by adapter and resource group, cache miss reasons, watch changes, and hook errors.                                                  |
| `writeManifest(path, manifest)`      | From `/executor`. Writes either schema atomically, creating parent directories as needed. Resolves relative paths from the current process directory.                                                                               |
| `runCli(argv?)`                      | From `@dafengzhen/build-matrix/cli`. Accepts the config path and CLI flags without the executable name. Defaults to `process.argv.slice(2)` and returns a numeric exit code. Assign it to `process.exitCode` when wrapping the CLI. |

## Common workflows

### Run one variant from a script

Save this as `build.mjs` next to the quick-start config and run `node build.mjs`. Change `maxConcurrency` for parallel builds, or remove the filters to run the full plan.

```js
import { readFile } from 'node:fs/promises';
import { createPlan } from '@dafengzhen/build-matrix';
import { executePlan } from '@dafengzhen/build-matrix/executor';

const config = JSON.parse(await readFile(new URL('./build-matrix.json', import.meta.url), 'utf8'));
const plan = createPlan(config);
const result = await executePlan(plan, {
  cwd: import.meta.dirname,
  filter: { variantIds: ['prod'], taskIds: ['print-mode'] },
  hooks: {
    onTaskFinish({ taskId, variantId, status }) {
      console.log(taskId, variantId, status);
    },
  },
  manifestPath: 'reports/build.json',
  manifestVersion: 2,
  maxConcurrency: 2,
});

process.exitCode = result.status === 'success' ? 0 : 1;
```

### Cache and watch

Declare a cache on tasks whose outputs can be reused. Each invocation should own its own outputs, such as `dist/{mode}`.

| `task.cache` | Behavior                                                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | Required nonempty string. Change it when upgrading a tool or changing adapter behavior that affects output.                                                                                                                                                                       |
| `inputs`     | Required array of input files and directories, such as source, tool configuration, and lockfiles. Directories are fingerprinted recursively.                                                                                                                                      |
| `outputs`    | Required array with at least one file or directory. Every adapter-reported artifact must exist and be covered by these paths for cache reuse. When the adapter omits `outputs`, existing declared paths are reported as artifacts, even when cache reads and writes are disabled. |
| `env`        | Names of environment variables that affect output. Their values are included in the cache fingerprint.                                                                                                                                                                            |
| `shared`     | Set to `true` for portable tasks with matching options and output layouts across invocations or workspaces.                                                                                                                                                                       |

Cache paths must be relative and stay inside the task working directory. They can use templates. With caching enabled, overlapping cache boundaries in a stage are rejected. Missing, unreadable, or symlinked paths can prevent cache hits. A hit reports `cached`. Use `--detailed` or `onAdapterFinish` to inspect cache misses.

For API runs, `cache.directory` changes the local cache location, and `cache.fingerprint(context, components)` adds a custom string component. Supply `cache.backend` with `get(key, signal)` and `put(key, payload, signal)` to store reusable entries elsewhere. `get` can return `undefined` for a miss. A `CachePayload` carries the entry and file records, and restored outputs are verified before publication. The dependency and diagnostic index defaults to `.build-matrix-cache-state`.

In a custom adapter, await `context.trackInputs(paths)` before reading dynamic files. Use `{ late: true }` for inputs discovered after reading, so later runs can fingerprint them safely. For local development, start with `npx build-matrix --watch src --watch-ignore dist`. With declared or discovered dependencies, use `npx build-matrix --watch-incremental --watch-strategy native --json --detailed` to see affected tasks and classified changes. For a programmatic watch, use the same `plan` and `cwd` as in the previous script.

```js
import { watchPlan } from '@dafengzhen/build-matrix/executor';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
try {
  await watchPlan(plan, {
    cwd: import.meta.dirname,
    paths: ['src'],
    ignore: ['dist'],
    incremental: true,
    strategy: 'native',
    signal: controller.signal,
    onRun(result) {
      console.log(result.watch?.changedPaths, result.counts);
    },
  });
} finally {
  process.off('SIGINT', stop);
}
```

### Pass artifacts between stages

Set `consumes: ["bundle"]` on a task in a later stage and read `context.artifacts.get("bundle")` in its adapter. A variant task receives artifacts from the matching variant or a global producer. A global task can read the artifacts from all variants. The downstream cache fingerprints the consumed artifacts. A failed producer can cause the consumer to report `ARTIFACT_DEPENDENCY_UNAVAILABLE`.

An artifact has a `path` and optional `kind`, `environment`, `sizeBytes`, and `sha256`. Use `artifacts.register(artifact)` to report a direct output, `await artifacts.reserve(path)` to claim an exclusive destination before writing, or `await artifacts.validate(artifact)` to verify a file. Use `const tempPath = await artifacts.stage(artifact)` to write to a temporary location. The executor validates staged outputs before publishing and rolls back a failed installation. [Runnable release-index example](./examples/09-artifact-pipeline/run.ts)

`ExecuteOptions.artifacts.transform(artifact, context, sourcePath?)` can replace a fresh artifact before validation. `validate(artifact, context, sourcePath?)` can reject one by throwing. For staged outputs, `sourcePath` points to the temporary file or directory. Pair `artifacts.cleanup: ["dist"]` with `manifestPath` to remove obsolete outputs from a previous successful manifest after a successful, unfiltered run. A directory artifact represents ownership of its contents.

### Compose steps within one task

Use `composeAdapter` when phases belong to one task and need local dependencies or separate caches. Give each step an `id` and a registered or inline `adapter`, or supply a `run(context)` callback. Optional fields are `dependsOn` (sibling IDs), `options`, `environment`, `inputs`, and `cache`. Cache the individual steps when the adapter returns a step list. Use `artifacts.get(stepId)` to read artifacts from completed dependencies and `taskData` to share in-memory state.

```js
import { composeAdapter, createDefaultRegistry } from '@dafengzhen/build-matrix/executor';

const registry = createDefaultRegistry().register('verify-project', {
  prepare: true,
  factory: () =>
    composeAdapter([
      {
        id: 'syntax',
        adapter: 'shell',
        options: { command: 'node', args: ['--check', 'src/index.js'] },
      },
      {
        id: 'test',
        dependsOn: ['syntax'],
        adapter: 'shell',
        options: { command: 'node', args: ['--test'] },
      },
    ]),
});
```

Set `adapter: "verify-project"` on a task and pass `registry` to the executor. Use a separate pipeline stage and `consumes` when other tasks also need the outputs.

## Vite integration

Install the optional peer dependency in the project that runs Vite.

```sh
npm install -D "vite@^8.3.8"
```

For a Vite app with an `index.html`, change the quick-start task to the following. Keep its matrix to build `dev` and `prod` into separate directories. Put plugins and app settings in `vite.config.*` as usual.

```json
{
  "id": "bundle",
  "adapter": "vite",
  "options": { "mode": "{mode}", "outDir": "dist/{mode}", "artifacts": "files" }
}
```

```sh
npx build-matrix --variant prod --json --detailed
```

### Vite task options

| `ViteOptions`        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution`          | `"process"` (default) runs builds in child processes. Choose `"in-process"` for programmatically injected plugins, build hooks, or builder reuse. In-process Vite calls are serialized and cancellation waits for an active call to settle.                                                                                                                                                               |
| `builder`            | `"once"` (default) releases the builder after the build. `"reuse"` retains builders for later runs in the same registry and requires `"in-process"`. Config dependency changes, option changes, `cacheKey` changes, and build failures invalidate a reused builder.                                                                                                                                       |
| `root`, `configFile` | Project root and config file path, relative to the task working directory. Use `configFile: false` to skip config-file loading. Vite is resolved from the effective root, then the task working directory, then Build Matrix.                                                                                                                                                                             |
| `mode`, `outDir`     | Vite mode and output directory. `outDir` is relative to the task working directory. Use distinct paths for parallel variants.                                                                                                                                                                                                                                                                             |
| `viteConfig`         | JSON inline Vite configuration. Defaults apply first, followed by the project file, registry `viteConfig`, and task `viteConfig`. Vite merges nested objects and arrays. Top-level `root`, `configFile`, `mode`, and `outDir` take precedence over values in `viteConfig`. Task shortcuts take precedence over matching registry shortcuts. `viteConfig.build.outDir` follows Vite's root-relative rules. |
| `environments`       | A name, an ordered list of names, or `"all"`. `"all"` runs the app builder and then builds remaining environments. Omit it to use Vite's default builder selection.                                                                                                                                                                                                                                       |
| `environmentOptions` | Map of environment names to `{ config?, build?, root?, mode?, outDir? }`. `config` and `build` merge into that environment. `root` and `outDir` are relative to the task working directory. A `root` or `mode` override resolves a separate builder using the same project config file.                                                                                                                   |
| `artifacts`          | `"directories"` (default) reports output directories. `"files"` reports emitted and copied public files with their environments, byte sizes, and SHA-256 digests. In-memory builds have no inferred disk outputs.                                                                                                                                                                                         |
| `outputs`            | Explicit artifact declarations with `path` and optional `kind` (`"file"` or `"directory"`), `environment`, `sizeBytes`, and `sha256`. Absolute and task-relative paths are allowed. Environment-specific entries apply when that environment builds. Explicit artifacts are checked after the build and must be within declared `cache.outputs` when the task uses a cache.                               |

Use templated `root: "apps/{app}"` and `outDir: "dist/{app}"` for multiple Vite apps in a monorepo. Use `environments: ["client", "ssr"]` with environment-specific `outDir` values for separate client and server builds. Set an environment's `build.rolldownOptions.output` to customize file names. [Monorepo example](./examples/11-vite-monorepo/build-matrix.json) · [Client and SSR example](./examples/08-vite-environments/build-matrix.json) · [Vite Environment API](https://vite.dev/guide/api-environment-frameworks#environments-during-build)

### Programmatic Vite options

Pass these options to `createViteAdapter(options?)` or to `createDefaultRegistry(defaults, { vite: options })`. In the latter form, set adapter defaults via `defaults.vite`. Set `prepare: true` when registering a Vite adapter under a custom ID to enable cache and watch preparation.

| `ViteAdapterOptions`                                                                                            | Behavior                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaults`                                                                                                      | Default `ViteOptions` for tasks using this adapter.                                                                                                                                                                                                    |
| `beforeConfig(config, context)`, `configure(config, context)`                                                   | Mutate or replace inline config before loading the project file and after merging it, respectively.                                                                                                                                                    |
| `configureEnvironment(config, context)`, `resolvedConfig(config, context)`                                      | Mutate or replace settings for an individual environment, or inspect the final resolved config. Config hooks can use `context.trackInputs()` and `context.onDispose(cleanup)`. `context.environment` is available for environment-specific resolution. |
| `plugins`, `environmentPlugins`                                                                                 | Vite `PluginOption[]` (including nested and promised plugins) for the builder, and a map of environment names to `PluginOption` for environment builds.                                                                                                |
| `onBuildStart(context)`, `onBuildEnd(event)`                                                                    | Wrap the executed build and artifact collection.                                                                                                                                                                                                       |
| `onEnvironmentStart(event)`, `onEnvironmentEnd(event)`                                                          | Wrap each environment build, including those started by the app builder. End hooks receive `status` and either `result` or `error`. Hook errors fail the task. Cache hits skip build hooks.                                                            |
| `collectArtifacts(outputs, context)`, `transformArtifact(output, context)`, `validateArtifact(output, context)` | Replace the candidate list, process or replace individual entries before validation, or add checks that throw on failure.                                                                                                                              |
| `inputs(context)`, `cacheKey`                                                                                   | Declare plugin inputs before the first build. A string or a function returning a string for `cacheKey` opts runtime plugins and callbacks into caching. Change it when extension behavior changes.                                                     |
| `builderPool`                                                                                                   | For reusable builders, `maxInstances` caps the least-recently-used pool (default 8) and `idleTimeoutMs` enables idle eviction. Dispose a caller-owned registry or standalone adapter when finished.                                                    |

The adapter tracks Vite config dependencies, env and public files, build modules, and plugin inputs registered with `this.addWatchFile(path)`. Use `inputs(context)` or `cache.inputs` for extra inputs that affect the first build. Save the following as `build-vite.mjs` alongside the Vite matrix config and run `node build-vite.mjs`.

```js
import { readFile } from 'node:fs/promises';
import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';

const config = JSON.parse(await readFile(new URL('./build-matrix.json', import.meta.url), 'utf8'));
const registry = createDefaultRegistry(
  { vite: { execution: 'in-process' } },
  {
    vite: {
      cacheKey: 'variant-meta-v1',
      configure(viteConfig, { variant }) {
        viteConfig.define = {
          ...viteConfig.define,
          __VARIANT__: JSON.stringify(variant?.id ?? 'global'),
        };
      },
    },
  },
);

try {
  const result = await executePlan(createPlan(config), { cwd: import.meta.dirname, registry });
  process.exitCode = result.status === 'success' ? 0 : 1;
} finally {
  await registry.dispose();
}
```

## Third-party build tools

### Run the tool's CLI

Use `shell` when the tool already has a CLI. Install the tool in the project, pass each argument separately, and template the arguments that vary. For npm-installed JavaScript CLIs, invoking their JS entry with `node` avoids relying on platform-specific command shims. Use one-shot commands if Build Matrix handles file watching.

For example, install Rolldown with `npm install -D rolldown` and give it a `src/index.js` entry. Set the quick-start matrix to `"dimensions": { "format": ["esm", "cjs"] }` with `"idTemplate": "{format}"` and use this task.

```json
{
  "id": "bundle",
  "adapter": "shell",
  "options": {
    "command": "node",
    "args": [
      "node_modules/rolldown/bin/cli.mjs",
      "src/index.js",
      "--format",
      "{format}",
      "--dir",
      "dist/{format}"
    ]
  },
  "cache": {
    "version": "rolldown-cli-v1",
    "inputs": ["src", "package.json", "package-lock.json"],
    "outputs": ["dist/{format}"]
  }
}
```

Run `npx build-matrix --variant esm` for the ESM bundle, or `npx build-matrix --max-concurrency 2` for both formats. Adjust the cache inputs to include any tool config and the lockfile used by your project. [Rolldown CLI guide](https://rolldown.rs/guide/getting-started#using-the-cli)

### Call the tool's JavaScript API

Use a custom adapter when you need build results, JS plugins, or explicit artifact reporting. Keep the same matrix and cache declaration, change the task to `"adapter": "rolldown"`, and replace its `options` with `{ "entry": "src/index.js", "format": "{format}", "outDir": "dist/{format}" }`. Save the following as `build-rolldown.mjs` next to `build-matrix.json` and run `node build-rolldown.mjs`.

```js
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { createPlan } from '@dafengzhen/build-matrix';
import { createDefaultRegistry, executePlan } from '@dafengzhen/build-matrix/executor';

const config = JSON.parse(await readFile(new URL('./build-matrix.json', import.meta.url), 'utf8'));
const registry = createDefaultRegistry().register('rolldown', () => ({
  async run({ artifacts, cwd, signal }, { entry, format, outDir }) {
    signal.throwIfAborted();
    await artifacts.reserve(outDir);
    const bundle = await rolldown({ cwd, input: entry });
    try {
      signal.throwIfAborted();
      const result = await bundle.write({ dir: resolve(cwd, outDir), format });
      signal.throwIfAborted();
      return {
        metadata: { outputCount: result.output.length },
        outputs: [{ kind: 'directory', path: outDir }],
      };
    } finally {
      await bundle.close();
    }
  },
}));

try {
  const result = await executePlan(createPlan(config), {
    cwd: import.meta.dirname,
    registry,
    logger: console,
    hooks: {
      onTaskFinish({ variantId, metadata, error }) {
        console.log(variantId, error ?? metadata);
      },
    },
  });
  process.exitCode = result.status === 'success' ? 0 : 1;
} finally {
  await registry.dispose();
}
```

The adapter reports the directory for downstream tasks and records the tool's output count. [Rolldown JavaScript API](https://rolldown.rs/reference/Function.rolldown)

## Development

```sh
npm ci
npm run check
```

## License

[MIT](./LICENSE)
