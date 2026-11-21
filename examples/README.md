# Build Matrix examples

[简体中文](./README.zh.md) · [Project README](../README.md) · [Reference](../docs/reference.md)

Run the commands from the repository root with Node.js 26 or later. CLI tasks use the configuration directory as their working directory.

```sh
npm ci
npm run build
```

## 01 Quick start

```sh
node dist/cli/bin.js examples/01-quickstart/build-matrix.json
```

The `greet` shell task runs once for the `default` variant and writes `examples/01-quickstart/out/hello.txt`. [Configuration](./01-quickstart/build-matrix.json)

## 02 Matrix, filters, and resource groups

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --max-concurrency 4
node dist/cli/bin.js examples/02-matrix/build-matrix.json --variant node-esm --task emit --json --detailed --manifest reports/run.json
```

The first command builds `node-esm`, `node-cjs`, `browser-esm`, and `edge-esm` in the same stage. The `cpu` group caps concurrent builds at two. Add `--resource cpu=1` to run that group serially. The second command selects just `emit` for `node-esm` and writes a schema 2 report to `examples/02-matrix/reports/run.json`. [Configuration](./02-matrix/build-matrix.json)

## 03 Local cache and watch mode

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json --watch src --watch build.ts --json --detailed --manifest reports/latest.json
```

Run the first command twice to see a cache hit. In watch mode, edit `examples/03-cache-watch/src/a.txt` to rebuild `dist/bundle.txt` and update `reports/latest.json` in the example directory. Press Ctrl+C to stop. [Configuration](./03-cache-watch/build-matrix.json)

## 04 Programmatic API

```sh
node examples/04-programmatic/run.ts
```

The script registers an adapter that returns variant metadata and prints it from an `onTaskFinish` hook. [Script](./04-programmatic/run.ts) · [API reference](../docs/reference.md#javascript-and-typescript-api)

## 05 Vite build modes

```sh
node dist/cli/bin.js examples/05-vite/build-matrix.json --max-concurrency 2
```

The `vite` adapter builds development and production pages in `dist/development/` and `dist/production/` inside the example directory. Running again with the same inputs and outputs yields two cache hits. The example uses Vite from the root installation. [Configuration](./05-vite/build-matrix.json)

## 06 CI checks and failure reports

```sh
node dist/cli/bin.js examples/06-ci-reports/build-matrix.json --json --detailed --manifest reports/failed.json
```

The `legacy` check fails on purpose. With `failurePolicy: "continue"`, the `modern` check still runs and the later `summary` stage is skipped. The CLI exits with code `1` and writes `examples/06-ci-reports/reports/failed.json`. Run the following command to pass only the `modern` variant through verification and run the global summary task. [Configuration](./06-ci-reports/build-matrix.json)

```sh
node dist/cli/bin.js examples/06-ci-reports/build-matrix.json --variant modern
```

## 07 Cache inputs from environment variables

Leave `BUILD_MATRIX_EXAMPLE_LABEL` unset in your shell so Node reads its value from the env files.

```sh
node --env-file=examples/07-cache-env/preview.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
node --env-file=examples/07-cache-env/preview.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
node --env-file=examples/07-cache-env/release.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
```

The repeated preview build reports two cache hits. Switching to `release.env` rebuilds both localized banners because the label is listed in `cache.env`. See `examples/07-cache-env/dist/en.txt` and `examples/07-cache-env/dist/zh.txt` for the new label. [Configuration](./07-cache-env/build-matrix.json)

## 08 Vite client and server builds

```sh
node dist/cli/bin.js examples/08-vite-environments/build-matrix.json --json --detailed
```

A single Vite task builds `client` and then `ssr`. It verifies and reports `dist/client/index.html` and `dist/server/render.js` with their environment names. Both paths are relative to the example directory. [Build Matrix config](./08-vite-environments/build-matrix.json) · [Vite config](./08-vite-environments/vite.config.ts)
