# Build Matrix 使用示例

[English](./README.md) · [项目说明](../README.zh.md)

使用 Node.js 22.13 及以上的 22.x 版本、24.x，或 26 及以上版本。以下命令均在仓库根目录运行，CLI 任务以配置文件所在目录为工作目录。

```sh
npm ci
npm run build
node dist/cli/bin.js --help
```

| 示例                                  | 演示内容                          |
| ------------------------------------- | --------------------------------- |
| [01-quickstart](./01-quickstart/)     | 一个阶段和一个 shell 任务         |
| [02-matrix](./02-matrix/)             | 多维矩阵、全局任务、过滤和资源组  |
| [03-cache-watch](./03-cache-watch/)   | 缓存产物与文件变更重建            |
| [04-programmatic](./04-programmatic/) | 自定义适配器和生命周期钩子        |
| [05-vite](./05-vite/)                 | Vite 构建模式、独立输出目录和缓存 |

## 01 快速开始

```sh
node dist/cli/bin.js examples/01-quickstart/build-matrix.json
```

[配置](./01-quickstart/build-matrix.json)中的维度表为空，因此会产生一个 ID 为 `default` 的变体。`greet` 任务通过 `shell` 适配器运行 [hello.mjs](./01-quickstart/hello.mjs)，生成 `examples/01-quickstart/out/hello.txt`。任务日志写入标准错误，标准输出的报告中会显示 `[success] greet (default)`。

## 02 矩阵、过滤和资源组

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --max-concurrency 4
```

[配置](./02-matrix/build-matrix.json)组合 `runtime` 和 `format`，排除 `browser-cjs`，追加 `edge-esm`，并用 `{runtime}-{format}` 生成 ID。最终顺序为 `node-esm`、`node-cjs`、`browser-esm`、`edge-esm`。

`prepare` 阶段清理一次 `out/`。`build` 阶段把各变体的值替换到 [build.mjs](./02-matrix/build.mjs) 的参数中，每个变体生成一个文件。最后，全局任务 `summary` 列出文件。`cpu` 资源组允许最多两个 `emit` 调用并发执行。即使阶段总并发上限为 4，使用 `--resource cpu=1` 也可让这一组串行执行。

```sh
node dist/cli/bin.js examples/02-matrix/build-matrix.json --variant node-esm --task emit --json --detailed --manifest reports/run.json
```

这条命令只对 `node-esm` 执行 `emit`。其余调用仍保留在报告中，状态为 `skipped`，`skipReason` 为 `filtered`。版本 2 报告写入 `examples/02-matrix/reports/run.json`。可重复使用同类筛选参数以匹配多个完整 ID。只按变体筛选时，全局任务仍会执行。

## 03 本地缓存和文件监听

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json
```

[配置](./03-cache-watch/build-matrix.json)将 `src/` 和 [build.mjs](./03-cache-watch/build.mjs) 声明为缓存输入。首次运行时，脚本将源文本合并到 `examples/03-cache-watch/dist/bundle.txt`。输入和产物保持不变时，再次运行会显示 `[cached] bundle (default)`。用 `--no-cache` 强制执行并跳过缓存读写，或用 `--cache-dir <path>` 指定缓存目录。

```sh
node dist/cli/bin.js examples/03-cache-watch/build-matrix.json --watch src --watch build.mjs --json --detailed --manifest reports/latest.json
```

首次运行完成后，修改并保存 `examples/03-cache-watch/src/a.txt` 以触发重建。每轮输出一行 JSON，并更新 `examples/03-cache-watch/reports/latest.json`。报告中的 `watch` 字段记录轮次和变化路径。按 Ctrl+C 停止监听。监听目录包含生成文件时，可用 `--watch-ignore` 排除它们。

## 04 编程接口

```sh
node examples/04-programmatic/run.mjs
```

[脚本](./04-programmatic/run.mjs)从 `@dafengzhen/build-matrix` 导入 `createPlan`，从 `@dafengzhen/build-matrix/executor` 导入注册表和执行器。自定义适配器 `report-mode` 将当前模式作为 JSON 元数据返回。`onTaskFinish` 钩子打印各变体的元数据，最终汇总显示两个调用成功。

适配器实现 `run(context, options)`，可以返回 `{ outputs, metadata }`。上下文包含变体、工作目录和取消信号。[API 说明](../README.zh.md#javascript-和-typescript-api)还介绍了报告生成和程序化监听。

## 05 Vite 构建

```sh
node dist/cli/bin.js examples/05-vite/build-matrix.json --max-concurrency 2
```

[配置](./05-vite/build-matrix.json)用 `vite` 适配器分别执行 `development` 和 `production` 模式的构建，输出到 `examples/05-vite/dist/development/` 和 `examples/05-vite/dist/production/`。生成的页面会显示对应的构建模式。输入和产物保持不变时，再次运行会命中两次缓存。

仓库根目录安装的 Vite 可直接用于本示例。也可用 `npm install --prefix examples/05-vite` 在示例目录内单独安装。适配器在任务启动时解析 Vite，解析失败会报告 `VITE_NOT_INSTALLED`。更换示例使用的 Vite 版本时，请同步更新任务的 `cache.version`。

## CLI 速查

| 参数                                      | 行为                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `-j, --max-concurrency <n>`               | 阶段内总并发任务数，默认 1                     |
| `--resource <group>=<n>`                  | 覆盖资源组并发上限，可重复                     |
| `--variant <id>`、`--task <id>`           | 按完整 ID 筛选，可重复                         |
| `--json`、`--manifest <path>`             | 输出 JSON 报告或写入文件，路径相对于配置目录   |
| `--detailed`                              | 补充文本诊断信息或使用版本 2 的 JSON 报告      |
| `--cache-dir <path>`、`--no-cache`        | 设置缓存目录或跳过缓存                         |
| `--watch <path>`、`--watch-ignore <path>` | 监听或排除文件与目录，可重复                   |
| `--poll-interval <ms>`、`--debounce <ms>` | 扫描间隔与变更静默期，默认 150 毫秒和 200 毫秒 |
| `-h, --help`                              | 显示帮助                                       |

省略配置路径时，CLI 读取当前目录的 `build-matrix.json`。报告中的任务状态包括 `success`、`failed`、`skipped`、`cancelled` 和 `cached`。跳过原因包括 `filtered`、`fail-fast` 和 `stage-failed`。退出码为 `0` 成功、`1` 任务失败、`2` 配置或执行错误、`130` 响应 SIGINT、`143` 响应 SIGTERM。

配置字段、适配器选项和失败策略见[项目说明](../README.zh.md#矩阵与流水线)。

## 常见问题

- 筛选时报未知变体 ID，可先查看未筛选的 JSON 报告中的 `variants` 数组。默认 ID 按维度声明顺序生成，数字和布尔值带有编码前缀。
- 缓存未命中时，检查产物是否仍存在、声明的路径是否可读。构建前清理产物会导致缓存未命中。更新工具时同步修改缓存版本，并声明所有影响构建的文件和环境变量。
- 监听反复触发时，可只监听源文件，或用 `--watch-ignore` 排除生成路径。正在使用的缓存和报告文件会自动排除。
- 需要管道或重定向时，将 `command` 设置为相应的 shell 程序，通过参数传入命令。适配器会将 `args` 原样传给可执行文件。
