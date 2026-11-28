# Build Matrix 使用示例

[English](./README.md) · [项目说明](../README.zh.md)

请使用 Node.js 26 或更高版本，并在仓库根目录运行下列命令。CLI 任务以配置文件所在目录为工作目录。

```sh
npm ci
npm run build
```

## 01 快速开始

```sh
node dist/cli/bin.js examples/01-quickstart/build-matrix.json
```

`greet` 通过 `shell` 为 `default` 变体执行一次，生成 `examples/01-quickstart/out/hello.txt`。[配置](./01-quickstart/build-matrix.json)

## 02 矩阵、筛选和资源组

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --max-concurrency 4
node dist/cli/bin.js examples/02-matrix/build-matrix.json --variant node-esm --task emit --json --detailed --manifest reports/run.json
```

第一条命令在同一阶段构建 `node-esm`、`node-cjs`、`browser-esm` 和 `edge-esm`。`cpu` 资源组最多允许两个构建同时进行。加上 `--resource cpu=1` 可让该组串行运行。第二条命令为 `node-esm` 运行 `emit`，并将版本 2 报告写入 `examples/02-matrix/reports/run.json`。[配置](./02-matrix/build-matrix.json)

## 03 本地缓存和文件监听

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json --watch src --watch build.ts --json --detailed --manifest reports/latest.json
```

连续运行两次第一条命令即可看到缓存命中。进入监听模式后，修改 `examples/03-cache-watch/src/a.txt` 会重建示例目录中的 `dist/bundle.txt`，并更新 `reports/latest.json`。按 Ctrl+C 停止监听。[配置](./03-cache-watch/build-matrix.json)

## 04 编程接口

```sh
node examples/04-programmatic/run.ts
```

脚本注册了一个返回变体元数据的适配器，并用 `onTaskFinish` 钩子打印这些数据。[脚本](./04-programmatic/run.ts) · [API 参考](../README.zh.md#javascript-和-typescript-api)

## 05 Vite 构建模式

```sh
node dist/cli/bin.js examples/05-vite/build-matrix.json --max-concurrency 2
```

`vite` 适配器将开发和生产版本分别写入示例目录中的 `dist/development/` 和 `dist/production/`。输入和产物相同时，再次运行会命中两次缓存。本示例使用仓库根目录安装的 Vite。[配置](./05-vite/build-matrix.json)

## 06 CI 检查与失败报告

```sh
node dist/cli/bin.js examples/06-ci-reports/build-matrix.json --json --detailed --manifest reports/failed.json
```

`legacy` 检查会故意失败。由于设置了 `failurePolicy: "continue"`，`modern` 检查仍会执行，后续的 `summary` 阶段则会跳过。CLI 以状态码 `1` 退出，并写入 `examples/06-ci-reports/reports/failed.json`。以下命令只检查 `modern` 变体，检查通过后执行全局汇总任务。[配置](./06-ci-reports/build-matrix.json)

```sh
node dist/cli/bin.js examples/06-ci-reports/build-matrix.json --variant modern
```

## 07 环境变量与缓存

在终端中保持 `BUILD_MATRIX_EXAMPLE_LABEL` 未设置，由 Node 从环境变量文件读取它。

```sh
node --env-file=examples/07-cache-env/preview.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
node --env-file=examples/07-cache-env/preview.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
node --env-file=examples/07-cache-env/release.env dist/cli/bin.js examples/07-cache-env/build-matrix.json
```

第二次预览构建会命中两次缓存。切换到 `release.env` 后，`cache.env` 中声明的值发生变化，会重新生成两种语言的横幅。可在 `examples/07-cache-env/dist/en.txt` 和 `examples/07-cache-env/dist/zh.txt` 查看新标签。[配置](./07-cache-env/build-matrix.json)

## 08 Vite 客户端和服务端构建

```sh
node dist/cli/bin.js examples/08-vite-environments/build-matrix.json --json --detailed
```

一个 Vite 任务依次构建 `client` 和 `ssr`，并校验 `dist/client/index.html` 和 `dist/server/render.js` 两个产物。报告会标明各产物所属的环境。产物路径相对于示例目录。[Build Matrix 配置](./08-vite-environments/build-matrix.json) · [Vite 配置](./08-vite-environments/vite.config.ts)

## 09 从上游产物生成发布索引

```sh
node examples/09-artifact-pipeline/run.ts
```

脚本只选中全局任务 `release-index`，其 `consumes` 声明会自动选中两个语言变体的 `release-notes` 任务。索引任务通过 `artifacts.get()` 读取已发布的产物路径，并将其写入 `dist/release.json`。两个适配器均通过 `artifacts.stage()` 写入临时路径，任务成功后再发布文件。可在示例目录的 `reports/release.json` 中查看任务结果和产物路径。[脚本](./09-artifact-pipeline/run.ts)

## 10 按目标增量监听

```sh
node dist/cli/bin.js examples/10-incremental-watch/build-matrix.json --watch-incremental --watch-strategy native --json --detailed --manifest reports/latest.json
```

首次运行完成后，修改示例目录中的 `src/web.txt`。监听器根据 `cache.inputs` 找到该文件，重建 `dist/web.txt`，并将 `worker` 标记为 `skipped`，其 `skipReason` 为 `"unchanged"`。修改共享输入 `src/header.txt` 会重建两个目标。可在 `reports/latest.json` 中查看 `watch.changes` 和任务状态。按 Ctrl+C 停止监听。[配置](./10-incremental-watch/build-matrix.json)

## 11 在同一仓库中构建多个 Vite 应用

```sh
node dist/cli/bin.js examples/11-vite-monorepo/build-matrix.json --max-concurrency 2 --json --detailed
node dist/cli/bin.js examples/11-vite-monorepo/build-matrix.json --variant admin
```

第一条命令并行构建 `apps/storefront` 和 `apps/admin`。通过 `root` 和 `outDir` 中的模板，每个应用都会在示例目录中生成各自的 `dist/<app>/index.html`。`artifacts: "files"` 让详细报告包含各文件的大小和 SHA-256 摘要。第二条命令只构建 `admin`。[配置](./11-vite-monorepo/build-matrix.json)
