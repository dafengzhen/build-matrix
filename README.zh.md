# Build Matrix

[English](./README.md) · [使用示例](./examples/README.zh.md)

Build Matrix 将构建维度展开为变体，按阶段执行任务。可以用 `build-matrix` 命令读取 JSON 配置，也可以从 JavaScript 或 TypeScript 创建并执行计划。内置适配器支持运行命令、清理路径和构建 Vite 项目。

## 快速开始

需要 Node.js 26 或更高版本。

```sh
npm install -D @dafengzhen/build-matrix
```

在项目中将下列配置保存为 `build-matrix.json`。

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

CLI 默认读取当前目录中的 `build-matrix.json`。可将另一份配置文件的路径作为第一个参数。任务以配置文件所在目录为工作目录，缓存、监听和报告文件的相对路径也以该目录为基准。

## 矩阵与流水线

- 按维度及其值的声明顺序展开笛卡尔积。维度名以字母或下划线开头，可包含英文字母、数字、下划线和连字符。维度值可以是字符串、有限数字或布尔值。空维度表产生一个 ID 为 `default` 的变体。
- `exclude` 排除匹配某条规则所有字段的组合，随后 `include` 按声明顺序追加组合。追加的组合需要提供所有维度的值，也可用维度表中未声明的值。相同组合只保留一次。`maxVariants` 默认上限为 1,000。
- 默认 ID 按维度声明顺序生成，例如 `runtime=node,format=esm`。可用 `idTemplate` 自定义非空且唯一的 ID。任务选项中的字符串支持 `{dimension}` 替换和 `{{dimension}}` 字面转义，包括嵌套数组和对象中的字符串。
- 阶段按声明顺序执行。阶段 ID 和任务 ID 各自在整个流水线中唯一。任务默认对每个变体执行一次。`scope: "global"` 的任务即使在矩阵没有变体时也会在所属阶段执行一次，且没有维度上下文。
- 默认一次执行一个任务。可用 `--max-concurrency` 或 API 的 `maxConcurrency` 提高阶段内的并发上限。用 `pipeline.resourceLimits` 和任务的 `resourceGroup` 约束组内并发。可用 `--resource cpu=2` 或 API 的 `resourceLimits` 覆盖组上限。报告保持阶段、任务和变体的声明顺序。
- 任务失败后跳过后续阶段。默认策略 `fail-fast` 停止启动当前阶段的剩余任务，并等待已启动的任务结束。设置 `failurePolicy: "continue"` 可跑完当前阶段。取消时保留已完成的结果，并向正在运行的适配器传递取消信号。

## 适配器

| 适配器  | 选项与行为                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell` | `command` 为可执行文件，`args` 为可选字符串数组。参数按原样传递。使用管道或重定向时需显式调用 shell。取消时终止直接启动的子进程。                                                            |
| `clean` | `path` 为工作目录内的相对文件或目录。路径缺失时成功返回。工作目录本身、目录外路径和经过符号链接或 junction 的路径会报错。                                                                    |
| `vite`  | 可选 `root`、`configFile`、`mode`、`outDir` 和 `viteConfig`。每次调用构建一次，若顶层 `outDir` 指定的目录在构建后存在则报告该产物。使用此适配器的项目需要安装 Vite 8.3.8 或兼容的 8.x 版本。 |

在 `options.viteConfig` 中以 JSON 对象传入 Vite 内联配置，例如 `{ "build": { "sourcemap": true } }`。Vite 会按自身规则将它与项目配置文件合并。显式设置的顶层 `root`、`configFile`、`mode` 和 `outDir` 优先，顶层选项中的路径相对于任务工作目录。`viteConfig` 内的路径遵循 Vite 规则，例如相对的 `viteConfig.build.outDir` 以 Vite 项目根目录为基准。

## 过滤和报告

- `--variant <id>` 和 `--task <id>` 按完整 ID 匹配。重复传入同类参数可选择多个 ID，两类参数同时使用时取交集。全局任务只受任务 ID 过滤。被过滤的调用仍保留在报告中，状态为 `skipped`，`skipReason` 为 `filtered`。未知 ID 会在执行前报错。
- 执行报告写入标准输出，工具日志写入标准错误。`--json` 输出版本 1 的报告，`--manifest <path>` 将报告写入文件，任务失败或运行取消时也会写入。加上 `--detailed` 可查看耗时、产物、跳过原因和分组统计，JSON 改用版本 2 并包含调度、监听和钩子数据。
- 退出码为 `0` 成功、`1` 任务失败、`2` 配置或执行错误、`130` 响应 SIGINT、`143` 响应 SIGTERM。用 `npx build-matrix --help` 查看完整选项。

## 任务缓存与文件监听

为可重复执行的任务声明 `cache.version`、`cache.inputs` 和 `cache.outputs`。输入和输出路径相对于任务工作目录，支持变体模板。至少声明一个输出，并在 `cache.env` 中列出影响结果的环境变量。目录按其内容递归校验，输入应包含源文件、工具配置、锁文件等影响结果的文件。

命中时保留现有产物，报告状态为 `cached`。输入、输出、选项、变体、缓存版本或声明的环境变量变化都可能触发重建。升级适配器或工具时，同步更新缓存版本。缓存调用应独占其声明的输出。同一阶段内缓存边界重叠会报错，缺失、无法读取或包含符号链接的路径会导致无法命中。缓存记录默认存放在 `.build-matrix-cache`，可用 `--cache-dir <path>` 改位置，或用 `--no-cache` 跳过读写。

适配器省略 `outputs` 时，报告会列出 `cache.outputs` 声明中实际存在的文件和目录，使用 `--no-cache` 时也一样。适配器显式返回的 `outputs` 优先。要缓存任务结果，每个报告的产物都必须存在且由 `cache.outputs` 覆盖，声明目录也会覆盖其子路径。无法校验产物时，成功任务仍会报告这些产物，该结果无法通过缓存复用。

`--watch <path>` 会先执行一次，随后在监听的文件变化时重跑。可以重复传参来监听多个路径，目录会递归扫描。用 `--watch-ignore <path>` 排除生成文件。默认每 150 毫秒扫描一次，变更静默 200 毫秒后开始重跑，可通过 `--poll-interval` 和 `--debounce` 调整。运行期间的新变更会合并到下一轮，任务失败后继续监听。按 Ctrl+C 停止。

监听模式下，`--json` 每轮输出一行 JSON，`--manifest` 原子更新最近一轮报告。报告文件和正在使用的缓存目录会自动排除。

## JavaScript 和 TypeScript API

用 `createPlan` 校验配置并展开矩阵，用 `executePlan` 配合内置适配器或自定义注册表执行计划。适配器的 `run(context, options)` 可以返回产物和 JSON 元数据，并可通过 `context.signal` 响应取消。

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

适配器工厂可以是同步或异步函数。注册表按需创建实例，同一注册项下的任务共享该实例。`register(id, loader)` 也支持返回适配器或以适配器为默认导出的模块。

`defaults` 接受 JSON 值。任务省略 `options` 时使用默认值。两者都是对象时，任务选项按顶层字段覆盖默认值。任务显式传入数组、标量或 `null` 时会替换整个默认值。执行器在合并后渲染维度模板，并将得到的选项纳入任务缓存键。

可用 `createDefaultRegistry({ shell: { command: 'node' } })` 为内置适配器设置默认值。内置适配器的子路径也分别导出了 `createShellAdapter`、`createCleanAdapter` 和 `createViteAdapter`，可用于自定义注册。

`createManifest(plan, result)` 生成版本 1 的报告，`createDetailedReport(plan, result)` 生成版本 2。使用 `manifestVersion: 2` 将版本 2 写入文件。用 `cache: { directory: 'cache' }` 指定缓存目录，或用 `cache: false` 禁用缓存。

`watchPlan(plan, { paths, signal, onRun })` 提供监听模式，并在每轮报告写入后调用 `onRun`。`executePlan` 和 `watchPlan` 都接受运行、阶段和任务的异步开始与结束钩子。任务钩子覆盖已调度的调用，包括缓存命中。钩子错误记录在 `result.hookErrors` 和版本 2 的报告中。

为 `watchPlan` 传入 `watchAdapter` 可替换变更来源。适配器的 `watch(context)` 接收绝对路径 `paths`、用于判断是否排除路径的 `ignore(path)` 和取消信号 `signal`。首轮调用并等待 `context.run([])`，后续每批变更调用并等待 `context.run(changedPaths)`，传入相对于 `context.cwd` 的路径。

## 示例与开发

[可运行示例](./examples/README.zh.md) 涵盖矩阵过滤、缓存、文件监听、自定义适配器和 Vite 构建。

开发本仓库也需要 Node.js 26 或更高版本。

```sh
npm ci
npm run check
```

`npm run check` 检查 lint、格式和 TypeScript 类型，运行测试，并用 publint 校验包。`npm run build` 生成 JavaScript 和类型声明，`npm test` 会先构建包，再运行 Vitest。用 `npm run lint:fix` 和 `npm run fmt` 自动修复，用 `npm run test:coverage` 在 `coverage/` 中生成覆盖率报告。

Vitest 会发现 `src/` 中与模块放在一起的 `.test.ts` 文件。

## 许可证

[MIT](./LICENSE)
