# Build Matrix 参考

[English](./reference.md) · [项目说明](../README.zh.md) · [使用示例](../examples/README.zh.md)

## 矩阵与流水线

- 按维度及其值的声明顺序展开笛卡尔积。维度名以字母或下划线开头，可包含英文字母、数字、下划线和连字符。维度值可以是字符串、有限数字或布尔值。空维度表产生一个 ID 为 `default` 的变体。
- `exclude` 排除匹配某条规则所有字段的组合，随后 `include` 按声明顺序追加组合。追加的组合需要提供所有维度的值，也可用维度表中未声明的值。相同组合只保留一次。`maxVariants` 默认上限为 1,000。
- 默认 ID 按维度声明顺序生成，例如 `runtime=node,format=esm`。可用 `idTemplate` 自定义非空且唯一的 ID。任务选项中的字符串支持 `{dimension}` 替换和 `{{dimension}}` 字面转义，包括嵌套数组和对象中的字符串。
- 阶段按声明顺序执行。阶段 ID 和任务 ID 各自在整个流水线中唯一。任务默认对每个变体执行一次。`scope: "global"` 的任务即使在矩阵没有变体时也会在所属阶段执行一次，且没有维度上下文。
- 默认一次执行一个任务。可用 `--max-concurrency` 或 API 的 `maxConcurrency` 提高阶段内的并发上限。用 `pipeline.resourceLimits` 和任务的 `resourceGroup` 约束组内并发。可用 `--resource cpu=2` 或 API 的 `resourceLimits` 覆盖组上限。报告保持阶段、任务和变体的声明顺序。
- 任务失败后跳过后续阶段。默认策略 `fail-fast` 停止启动当前阶段的剩余任务，并等待已启动的任务结束。设置 `failurePolicy: "continue"` 可跑完当前阶段。取消时保留已完成的结果，并向正在运行的适配器传递取消信号。

## 适配器

| 适配器  | 选项与行为                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell` | `command` 为可执行文件，`args` 为可选字符串数组。参数按原样传递。使用管道或重定向时需显式调用 shell。取消时终止直接启动的子进程。                                                     |
| `clean` | `path` 为工作目录内的相对文件或目录。路径缺失时成功返回。工作目录本身、目录外路径和经过符号链接或 junction 的路径会报错。                                                             |
| `vite`  | 可选 `root`、`configFile`、`mode`、`outDir`、`viteConfig`、`environments` 和 `outputs`。每次调用执行一次构建并报告磁盘产物。使用此适配器的项目需要安装 Vite 8.3.8 或兼容的 8.x 版本。 |

在 `options.viteConfig` 中以 JSON 对象传入 Vite 内联配置，例如 `{ "build": { "sourcemap": true } }`。Vite 会按自身规则将它与项目配置文件合并。显式设置的顶层 `root`、`configFile`、`mode` 和 `outDir` 优先，顶层选项中的路径相对于任务工作目录。`viteConfig` 内的路径遵循 Vite 规则，例如相对的 `viteConfig.build.outDir` 以 Vite 项目根目录为基准。

适配器优先从顶层 `root` 或 `viteConfig.root` 解析 Vite，其次从任务工作目录解析，最后从 Build Matrix 自身解析。如果 Vite 安装在 Monorepo 的子包中，请设置其中一个根目录选项。依赖解析发生在 Vite 加载项目配置文件之前。

`environments` 支持单个名称、名称数组和 `"all"`。指定名称时按列表顺序构建，每个 Environment 执行一次并触发自身的 Vite 构建钩子。`"all"` 首先通过 Vite 的应用构建入口执行项目的应用级钩子和构建编排，然后补建其余 Environment。省略此选项时沿用 Vite 默认的 Builder 选择规则。[Vite Environment API](https://vite.dev/guide/api-environment-frameworks#environments-during-build)

```json
{
  "environments": ["client", "worker"],
  "outputs": [
    { "environment": "client", "kind": "directory", "path": "dist/client" },
    { "environment": "worker", "kind": "file", "path": "dist/worker/index.js" }
  ]
}
```

`outputs` 声明构建后需要检查和报告的产物。路径可以是相对于任务工作目录的路径，也可以是绝对路径。省略 `kind` 时根据磁盘上的产物判断类型。带有 `environment` 的条目在对应 Environment 参与构建时生效，其余条目适用于整个任务。省略 `outputs` 时，适配器根据 Vite 实际写入的路径报告文件或目录，并支持多个输出目录。只在内存中生成的内容不会出现在磁盘产物列表中。

任务同时声明 `cache.outputs` 时，每项适用的 `options.outputs` 都必须在缓存声明中列出，或位于声明的目录内。产物缺失、类型不符或未被缓存声明覆盖时，Vite 任务会失败。

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

## 常见问题

- 筛选时报未知变体 ID，可先查看未筛选的 JSON 报告中的 `variants` 数组。默认 ID 按维度声明顺序生成，数字和布尔值带有编码前缀。
- 缓存未命中时，检查产物是否仍存在、声明的路径是否可读。构建前清理产物会导致缓存未命中。更新工具时同步修改缓存版本，并声明所有影响构建的文件和环境变量。
- 监听反复触发时，可只监听源文件，或用 `--watch-ignore` 排除生成路径。正在使用的缓存和报告文件会自动排除。
- 需要管道或重定向时，将 `command` 设置为相应的 shell 程序，通过参数传入命令。适配器会将 `args` 原样传给可执行文件。
