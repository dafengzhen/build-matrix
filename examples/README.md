# Build Matrix Examples

[简体中文](./README.zh.md) · [Project README](../README.md)

Run these commands from the repository root with Node.js 26 or later. CLI tasks use the configuration directory as their working directory.

```sh
npm ci
npm run build
node dist/cli/bin.js --help
```

| Example                               | What it shows                                                     |
| ------------------------------------- | ----------------------------------------------------------------- |
| [01-quickstart](./01-quickstart/)     | One stage and one shell task                                      |
| [02-matrix](./02-matrix/)             | Multiple dimensions, global tasks, filtering, and resource groups |
| [03-cache-watch](./03-cache-watch/)   | Cached outputs and rebuilds on file changes                       |
| [04-programmatic](./04-programmatic/) | A custom adapter and a lifecycle hook                             |
| [05-vite](./05-vite/)                 | Vite build modes, separate output directories, and caching        |

## 01 Quick start

```sh
node dist/cli/bin.js examples/01-quickstart/build-matrix.json
```

The [configuration](./01-quickstart/build-matrix.json) has an empty dimension map, so it produces one variant with the ID `default`. The `greet` task runs [hello.ts](./01-quickstart/hello.ts) through the `shell` adapter and writes `examples/01-quickstart/out/hello.txt`. The task's log goes to stderr, and its status appears as `[success] greet (default)` in the stdout report.

## 02 Matrix, filters, and resource groups

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --max-concurrency 4
```

The [configuration](./02-matrix/build-matrix.json) combines `runtime` with `format`. It excludes `browser-cjs`, appends `edge-esm`, and uses `{runtime}-{format}` for IDs. The resulting order is `node-esm`, `node-cjs`, `browser-esm`, and `edge-esm`.

The `prepare` stage clears `out/` once. The `build` stage substitutes each variant's values into the arguments to [build.ts](./02-matrix/build.ts) and writes one file per variant. The global `summary` task then lists the files. The `cpu` resource group limits the `emit` tasks to two concurrent invocations. Use `--resource cpu=1` to run them one at a time, even when the stage allows four.

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --variant node-esm --task emit --json --detailed --manifest reports/run.json
```

This runs only `emit` for `node-esm`. The other calls appear as `skipped` with `skipReason: "filtered"`. The schema 2 report is saved to `examples/02-matrix/reports/run.json`. Repeat a filter flag to select several exact IDs. A variant filter alone still allows global tasks to run.

## 03 Local cache and watch mode

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
```

The [configuration](./03-cache-watch/build-matrix.json) fingerprints `src/` and [build.ts](./03-cache-watch/build.ts). On a fresh run, the script joins the text files into `examples/03-cache-watch/dist/bundle.txt`. Running again with the same inputs and output reports `[cached] bundle (default)`. Use `--no-cache` to force execution without reading or writing cache records, or `--cache-dir <path>` to store them elsewhere.

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json --watch src --watch build.ts --json --detailed --manifest reports/latest.json
```

After the initial run, edit and save `examples/03-cache-watch/src/a.txt` to trigger a rebuild. Each run prints one JSON line and updates `examples/03-cache-watch/reports/latest.json`. The report's `watch` field shows the run number and changed paths. Press Ctrl+C to stop. Use `--watch-ignore` when watching any directory that also contains generated output.

## 04 Programmatic API

```sh
node examples/04-programmatic/run.ts
```

The [script](./04-programmatic/run.ts) imports `createPlan` from `@dafengzhen/build-matrix` and the registry and executor from `@dafengzhen/build-matrix/executor`. It registers `report-mode`, which returns the current mode as JSON metadata. The `onTaskFinish` hook logs each variant's metadata, and the final counts show two successful invocations.

An adapter implements `run(context, options)` and can return `{ outputs, metadata }`. The context provides the variant, working directory, and cancellation signal. The [API overview](../README.md#javascript-and-typescript-api) also covers report creation and programmatic watch mode.

## 05 Vite builds

```sh
node dist/cli/bin.js examples/05-vite/build-matrix.json --max-concurrency 2
```

The [configuration](./05-vite/build-matrix.json) calls the `vite` adapter for `development` and `production` and writes to `examples/05-vite/dist/development/` and `examples/05-vite/dist/production/`. Each build displays its mode in the generated page. Rerun the command with the same inputs and outputs to see two cache hits.

The root installation provides the example's Vite dependency. To install Vite inside the example itself, run `npm install --prefix examples/05-vite`. The adapter resolves Vite when the task starts. It reports `VITE_NOT_INSTALLED` if it cannot resolve it. If you change the Vite version for this example, update the task's `cache.version` to match.

## CLI reference

| Option                                    | Behavior                                                        |
| ----------------------------------------- | --------------------------------------------------------------- |
| `-j, --max-concurrency <n>`               | Total concurrent tasks within a stage, default 1                |
| `--resource <group>=<n>`                  | Override a resource group limit, repeatable                     |
| `--variant <id>`, `--task <id>`           | Select by exact ID, repeatable                                  |
| `--json`, `--manifest <path>`             | Print a JSON report or save it relative to the config directory |
| `--detailed`                              | Add text diagnostics or use JSON schema 2                       |
| `--cache-dir <path>`, `--no-cache`        | Set the cache location or bypass caching                        |
| `--watch <path>`, `--watch-ignore <path>` | Watch or exclude a file or directory, repeatable                |
| `--poll-interval <ms>`, `--debounce <ms>` | Scan interval and quiet period, default 150 ms and 200 ms       |
| `-h, --help`                              | Show usage                                                      |

If you omit the config path, the CLI reads `build-matrix.json` from the current directory. Reported task statuses are `success`, `failed`, `skipped`, `cancelled`, and `cached`. A skipped task can have reason `filtered`, `fail-fast`, or `stage-failed`. Exit codes are `0` for success, `1` for task failure, `2` for configuration or execution errors, `130` for SIGINT, and `143` for SIGTERM.

For configuration fields, adapter options, and failure policies, see the [project README](../README.md#matrix-and-pipeline).

## Troubleshooting

- For an unknown variant ID, inspect the `variants` array in the unfiltered JSON report. Default IDs follow the declared dimension order and distinguish number and boolean values with encoded prefixes.
- For unexpected cache misses, check whether the outputs still exist and whether every declared path is readable. Cleaning outputs before a build forces a miss. Keep cache versions in sync with tools and include the files and environment variables that affect the build.
- For repeated watch runs, limit the watched paths to source files or exclude generated paths with `--watch-ignore`. Watch mode already excludes the active cache and the manifest.
- To use shell pipes or redirection, set `command` to your shell executable and pass the command through its arguments. The adapter passes `args` directly to the chosen executable.
