# Build Matrix

[English](./README.md) · [可运行示例](./examples/README.zh.md)

Build Matrix 用于编排多变体构建，例如同时发布 ESM 和 CommonJS 的库，或在 monorepo 中构建多个 Vite 应用。本地开发和 CI 可以共用同一份构建配置。

- [为什么使用 Build Matrix](#为什么使用-build-matrix)
- [快速开始](#快速开始)
- [配置](#配置)
- [CLI](#cli)
- [JavaScript 和 TypeScript API](#javascript-和-typescript-api)
- [常见用法](#常见用法)
- [集成 Vite](#集成-vite)
- [集成第三方构建工具](#集成第三方构建工具)

## 为什么使用 Build Matrix

- **集中定义构建变体。** 声明应用、模式或输出格式等维度，按需增删组合。用模板为各变体设置独立的输出目录，也可以按 ID 单独构建某个变体或运行某个任务。
- **按阶段编排并传递产物。** 依次执行检查、构建和打包。下游任务可以读取相同变体的上游产物，全局任务也可以汇总所有变体的输出，生成一份发布索引。
- **控制并发和失败策略。** 同一阶段可以并行运行独立任务，并为资源密集的任务组设置并发上限。任务失败后，可选择停止派发、跑完当前阶段或继续后续阶段。
- **复用构建结果，按需重跑。** 任务缓存根据声明的输入、输出和环境变量判断能否复用。增量监听根据已知输入和产物依赖重跑受影响的任务和步骤。
- **接入已有构建工具。** 内置 Vite 适配器支持模式、多环境构建和产物报告。其他工具可通过 `shell` 调用，也可以用自定义适配器接入其 JavaScript API。
- **在 CI 中查看每个任务的结果。** JSON 报告记录任务成功、失败、跳过或命中缓存的状态。详细报告还提供耗时、缓存未命中原因和监听到的文件变更。

## 快速开始

需要 Node.js 26 或更高版本。

```sh
npm install -D @dafengzhen/build-matrix
```

将以下配置保存为 `build-matrix.json`。

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

第一条命令运行两个变体，第二条只运行 `prod`。本地构建或 CI 直接用 CLI 读取 JSON 配置。需要自定义适配器、生命周期钩子或读取运行结果时，用 `createPlan` 和 `executePlan`。需要文件变更触发构建时，用 `watchPlan`。只需要变体列表时，用 `expandMatrix`。

## 配置

### 矩阵

| 字段          | 说明                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dimensions`  | 必填，键为维度名，值为非空数组，支持字符串、有限数值和布尔值。维度名匹配 `[A-Za-z_][\w-]*`。按维度和值的声明顺序展开。`{}` 生成 ID 为 `default` 的单个变体。 |
| `exclude`     | 移除符合规则中全部字段的组合。只填写部分维度即可排除多组变体。                                                                                               |
| `include`     | 排除后追加组合。每项须给出全部维度，可使用新值。相同组合只保留一次。                                                                                         |
| `idTemplate`  | 生成唯一且非空的 ID，如 `{runtime}-{format}`。默认 ID 形如 `runtime=node,format=esm`。字符串按需转义，数值和布尔值分别带 `~n` 和 `~b` 前缀。                 |
| `maxVariants` | 变体总数上限，须为正整数，默认 1,000。                                                                                                                       |

用 `{dimension}` 替换维度值，用 `{{dimension}}` 输出字面占位符。模板支持任务选项中的字符串（包括嵌套数组和对象）、`environment` 及缓存输入和输出路径。全局任务没有维度值。

### 流水线

| 字段                      | 说明                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pipeline.stages`         | 必填，按声明顺序运行。每个阶段有唯一的 `id` 和 `tasks` 数组。                                                                  |
| `pipeline.resourceLimits` | 资源组到并发上限的映射。上限须为正整数，运行时可用 `--resource` 或 `resourceLimits` 覆盖，同时受全局并发上限约束。             |
| `stage.failurePolicy`     | `"fail-fast"`（默认）在任务失败后停止派发并等待已开始的任务。`"continue"` 完成本阶段。`"continue-pipeline"` 还会运行后续阶段。 |
| `task.id`、`task.adapter` | 必填，分别为任务 ID 和已注册的适配器 ID。任务 ID 在整条流水线中唯一。                                                          |
| `task.options`            | 合并默认值并渲染模板后交给适配器的 JSON 值。字段由适配器定义。                                                                 |
| `task.scope`              | `"variant"`（默认）为每个变体运行一次。`"global"` 在该阶段运行一次，即使变体数为零。                                           |
| `task.resourceGroup`      | 将任务分配给资源组，运行时须为该组设置并发上限。                                                                               |
| `task.environment`        | 通过 `context.environment` 提供给适配器的可选标签。用 Vite 的 `environments` 选项选择 Vite 构建环境。                          |
| `task.consumes`           | 声明需要哪些早期阶段的任务产物。筛选消费任务时也会选中所需的上游调用。                                                         |
| `task.cache`              | 为任务启用缓存，须提供 `version`、`inputs`、`outputs`，可选 `env`、`shared`。见[缓存与监听](#缓存与监听)。                     |

### 内置适配器

| 适配器  | 选项和适用场景                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell` | 执行 `command`，可选字符串数组 `args`（默认 `[]`）。适合调用已有构建、测试或打包命令。参数直接传给可执行程序，需要管道或重定向时可显式调用 shell。取消时终止直接子进程。   |
| `clean` | 删除 `path` 指定的文件或目录，须使用任务工作目录内的相对路径。路径不存在时成功。适配器拒绝工作目录本身、外部路径以及经过符号链接或联接点的路径。删除缓存产物会使构建重跑。 |
| `vite`  | 构建 Vite 项目。完整选项见[集成 Vite](#集成-vite)。                                                                                                                        |

## CLI

`build-matrix [config.json] [options]` 默认读取 `build-matrix.json`。配置路径相对于当前目录。任务、相对缓存路径、报告路径和监听路径以配置文件所在目录为基准。

| 选项                                      | 说明                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h`、`--help`                            | 打印用法。                                                                                                                                                           |
| `--variant <id>`、`--task <id>`           | 精确匹配 ID。重复同一选项可选择多个 ID，同时使用时应用两种筛选条件。全局任务只受任务筛选影响。未知 ID 会报错，被筛掉的调用保留在报告中，`skipReason` 为 `filtered`。 |
| `-j <n>`、`--max-concurrency <n>`         | 设置同一阶段内的并发上限，默认 1。                                                                                                                                   |
| `--resource <group>=<n>`                  | 覆盖组并发上限，可重复。                                                                                                                                             |
| `--json`、`--manifest <path>`             | 将 JSON 打印到 stdout 或写入文件，可同时使用。工具日志写入 stderr。报告也会记录任务失败或运行取消。                                                                  |
| `--detailed`                              | 增加报告详情，并将 JSON 格式从默认的 schema 1 改为 schema 2。                                                                                                        |
| `--cache-dir <path>`、`--no-cache`        | 更改本地缓存目录（默认 `.build-matrix-cache`）或跳过缓存读写。                                                                                                       |
| `--watch <path>`、`--watch-ignore <path>` | 监听一个文件或递归扫描目录，或排除路径。两个选项都可重复。                                                                                                           |
| `--watch-incremental`                     | 监听已知输入并重跑受影响的任务和步骤，无需指定 `--watch`。                                                                                                           |
| `--watch-strategy <name>`                 | `polling`（默认）定期扫描，`native` 使用文件系统事件并定期补扫。                                                                                                     |
| `--debounce <ms>`、`--poll-interval <ms>` | 设置静默时间和扫描间隔。静默时间默认 200 毫秒，轮询模式扫描间隔默认 150 毫秒，原生模式补扫间隔默认 1,000 毫秒。                                                      |

监听先运行一轮，构建期间的变更会排到下一轮。任务失败后继续监听，按 Ctrl+C 停止。`--json` 每轮输出一行 JSON，`--manifest` 原子替换上一份报告。监听设置须配合 `--watch` 或 `--watch-incremental`。

退出码 `0` 表示成功，`1` 表示任务失败，`2` 表示配置或执行错误，`130` 对应 SIGINT，`143` 对应 SIGTERM。

## JavaScript 和 TypeScript API

### 计划和模板

从 `@dafengzhen/build-matrix` 导入。

| API                                       | 参数和用途                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `expandMatrix(matrix)`                    | 验证 `MatrixDefinition`，返回只读的 `{ id, values }` 数组，可用来预览变体 ID 或在其他工具里复用矩阵。                          |
| `createPlan(config)`                      | 验证包含 `matrix` 和 `pipeline` 的 `BuildConfiguration`，返回带 `variants`、`stages` 和可选 `resourceLimits` 的不可变 `Plan`。 |
| `renderTemplate(template, values, path?)` | 替换字符串中的维度值。`path` 默认 `"template"`，用于标明校验错误的位置。                                                       |
| `renderOptions(options, values, path?)`   | 递归渲染 `JsonValue` 中的字符串值，保留对象键和非字符串值。`path` 默认 `"options"`。                                           |
| `ConfigurationError`                      | 未知维度、重复 ID 等配置错误的类型，可用 `instanceof ConfigurationError` 判断。                                                |

### 执行和监听

从 `@dafengzhen/build-matrix/executor` 导入。`executePlan(plan, options?)` 运行一次计划，返回包含状态、计数、耗时和各阶段任务结果的 `RunResult`。用 `result.status` 区分 `success`、`failed` 和 `cancelled`。任务失败记录在结果中，无效的执行选项可能使调用抛错。

| `ExecuteOptions`                   | 说明                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                              | 任务工作目录，默认 `process.cwd()`。                                                                                                                                                                                  |
| `registry`                         | 适配器注册表。省略时使用内置注册表并自动释放。调用方传入注册表时负责释放。                                                                                                                                            |
| `filter`                           | `{ variantIds?, taskIds? }`，匹配规则与 CLI 一致。                                                                                                                                                                    |
| `maxConcurrency`、`resourceLimits` | 全局并发上限（默认 1）和对计划中资源组上限的覆盖。                                                                                                                                                                    |
| `signal`                           | 传给适配器的 `AbortSignal`，取消时保留已完成的结果。                                                                                                                                                                  |
| `logger`                           | 提供 `info(message)` 和 `error(message)` 的对象，默认静默。                                                                                                                                                           |
| `hooks`                            | 支持同步或异步的 `onRunStart`、`onRunFinish`、`onStageStart`、`onStageFinish`、`onTaskStart`、`onTaskFinish`、`onAdapterStart`、`onAdapterFinish`。任务和适配器钩子涵盖缓存命中，钩子错误记录在 `result.hookErrors`。 |
| `manifestPath`、`manifestVersion`  | 将报告写入绝对路径或相对 `cwd` 的路径，选择 schema `1`（默认）或 `2`。                                                                                                                                                |
| `cache`                            | 用 `false` 禁用缓存，或用 `{ directory?, backend?, fingerprint? }` 为已声明缓存的任务设置缓存策略。                                                                                                                   |
| `artifacts`                        | `{ cleanup?, transform?, validate? }` 用于清理、转换、校验产物。见[跨阶段传递产物](#跨阶段传递产物)。                                                                                                                 |

`watchPlan(plan, options)` 接受全部执行选项和下列监听选项，监听结束后返回。

| `WatchOptions`                             | 说明                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`、`ignore`                          | 相对 `cwd` 解析监听与排除路径。至少提供一个路径或开启 `incremental`。当前缓存、状态目录、报告和临时产物自动排除。                                                                                                       |
| `incremental`                              | 默认 `false`。开启后从已知输入发现监听路径，并重跑受影响的任务和步骤。依赖信息不全的任务会保守重跑。                                                                                                                    |
| `classifyChanges`                          | API 默认 `true`。将可识别的 `added`、`modified`、`deleted` 和 `renamed` 事件写入 `result.watch.changes`。                                                                                                               |
| `strategy`、`pollIntervalMs`、`debounceMs` | 选择 `"polling"` 或 `"native"`，设置扫描间隔和静默时间，默认值与 CLI 相同。                                                                                                                                             |
| `watchAdapter`                             | 提供自己的 `WatchAdapter`。`watch(context)` 接收绝对 `paths`、`ignore(path)`、`trackedPaths()` 和取消信号。调用并等待 `context.run([])` 启动首轮，后续每批调用并等待 `context.run(changedPaths)`，传相对 `cwd` 的路径。 |
| `onRun(result)`                            | 每轮运行结束并写入报告后调用，可同步或异步。                                                                                                                                                                            |

`pollingWatchAdapter` 和 `nativeWatchAdapter` 是可直接传给 `watchAdapter` 的对象。

### 注册表和适配器

| API                                                         | 参数和用途                                                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new AdapterRegistry()`                                     | 创建空注册表，适合完全自行注册。                                                                                                                                                   |
| `createDefaultRegistry(defaults?, extensions?)`             | 注册内置适配器，`defaults` 接收 `{ shell?, clean?, vite? }`。`extensions.vite` 接收 Vite 编程选项，默认值通过 `defaults.vite` 指定。                                               |
| `registry.register(id, definition)`                         | 注册唯一 ID 并返回注册表。定义支持 `factory`、`defaults?`、`prepare?: true`、`scope?: "invocation"`、`mergeDefaults?: false`。也接受返回适配器或含默认适配器导出的模块的加载函数。 |
| `registry.has(id)`、`registry.getDefaults(id)`              | 检查是否注册或读取默认值。                                                                                                                                                         |
| `registry.invocationScoped(id)`、`registry.prepares(id)`    | 检查是否按调用创建实例，或是否在查询缓存前加载。                                                                                                                                   |
| `registry.load(id, context?)`                               | 加载实例。按调用创建的适配器须传入 `AdapterContext`。                                                                                                                              |
| `registry.mergeTaskOptions(id, options)`                    | 合并默认值，保留维度模板。                                                                                                                                                         |
| `registry.use(middlewareOrPlugin)`、`registry.middleware()` | 注册中间件，或包含 `setup(registry)` 和 `middleware` 数组的插件。中间件接收 `{ context, options }` 和 `next()`。`middleware()` 按注册顺序返回中间件。                              |
| `registry.dispose()`                                        | 等待已加载的共享实例释放资源。                                                                                                                                                     |
| `composeAdapter(steps)`                                     | 用 `AdapterStep` 数组或同步、异步的 `(context, options) => steps` 工厂创建适配器。                                                                                                 |
| `retryAdapter(attempts, shouldRetry?)`                      | 为临时失败创建重试中间件，次数包含首次尝试。可选判断函数接收抛出的错误，默认接受所有错误。取消时停止重试。                                                                         |

工厂可以同步或异步返回适配器。默认按需创建共享实例。设 `scope: "invocation"` 后，每次调用向工厂传入上下文，并在结束时释放实例。注册表合并 JSON 默认值时，任务对象的顶层字段覆盖默认对象，数组、标量和 `null` 整体替换默认值。由适配器自行合并时，设置 `mergeDefaults: false`。

适配器实现 `run(context, options)` 或 `prepare(context, options)`，可选实现 `dispose()`。`run` 可返回 `outputs` 和 JSON `metadata`。`prepare` 可返回 `inputs`、`cacheKey`（`false` 跳过缓存）、`run()` 回调或 `steps`。注册需要在缓存查找前准备的共享适配器时，设置 `prepare: true`。`AdapterContext` 提供 `cwd`、`signal`、`logger`、运行和任务标识、`variant`、`environment`、`artifacts`、`cacheOutputs`、`cacheEnabled`、`watching`、`stepPath`、`trackInputs()`。`taskData` 由任务和步骤共享，`runData` 由整轮运行共享。

自定义注册时，分别从 `@dafengzhen/build-matrix/adapters/shell`、`@dafengzhen/build-matrix/adapters/clean` 和 `@dafengzhen/build-matrix/adapters/vite` 导入 `createShellAdapter()`、`createCleanAdapter()` 和 `createViteAdapter(options?)`。前两个工厂无需参数，可在注册表指定默认值。三个子路径也默认导出可直接使用的实例。

### 报告与 CLI 入口

| API                                  | 参数和用途                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createManifest(plan, result)`       | 从 `/executor` 导入，返回 schema 1 JSON 数据，含计划统计、变体和各任务结果。                                                                                 |
| `createDetailedReport(plan, result)` | 从 `/executor` 导入，返回 schema 2，另含调度设置、按适配器和资源组汇总的指标、缓存未命中原因、文件变更和钩子错误。                                           |
| `writeManifest(path, manifest)`      | 从 `/executor` 导入，原子写入报告，按需创建父目录。相对路径以当前进程目录为基准。                                                                            |
| `runCli(argv?)`                      | 从 `@dafengzhen/build-matrix/cli` 导入，接收配置路径和 CLI 参数，省略可执行文件名。默认 `process.argv.slice(2)`，返回数字退出码，可赋给 `process.exitCode`。 |

## 常见用法

### 在脚本中运行一个变体

将脚本保存为 `build.mjs`，放在快速开始的配置文件旁，再运行 `node build.mjs`。可以修改并发数，或去掉筛选条件来运行完整计划。

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

### 缓存与监听

| `task.cache` | 说明                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | 必填的非空字符串，升级工具或修改会影响输出的适配器行为时更新。                                                                                                          |
| `inputs`     | 必填，输入文件和目录数组。应包含源码、工具配置和锁文件。目录按内容递归计算指纹。                                                                                        |
| `outputs`    | 必填，至少包含一个文件或目录。适配器报告的每个产物均须存在且被这些路径覆盖，才能复用缓存。适配器省略 `outputs` 时，报告采用已存在的声明路径，即使关闭缓存读写也是如此。 |
| `env`        | 影响输出的环境变量名，其值参与指纹计算。                                                                                                                                |
| `shared`     | 设为 `true`，让选项和输出布局一致的可移植任务跨调用或工作区复用缓存。                                                                                                   |

缓存路径须是工作目录内的相对路径，支持模板。可用 `dist/{mode}` 等路径隔离变体输出。启用缓存时，同一阶段内相互冲突的缓存边界会被拒绝。缺失、不可读或经过符号链接的路径可能导致未命中。命中时报告 `cached`，用 `--detailed` 或 `onAdapterFinish` 查看未命中原因。

用 `cache.directory` 更改本地目录，用 `cache.fingerprint(context, components)` 补充字符串指纹。`cache.backend` 可通过 `get(key, signal)` 和 `put(key, payload, signal)` 接入远程缓存。`get` 在未命中时可返回 `undefined`，`CachePayload` 包含缓存条目和文件记录。恢复的输出在发布前验证。依赖和诊断索引默认存放在 `.build-matrix-cache-state`。

适配器可以在读取动态文件前等待 `context.trackInputs(paths)`，读取后发现的输入可传 `{ late: true }`，供后续构建计算指纹。用 `npx build-matrix --watch src --watch-ignore dist` 监听源码，或者用 `npx build-matrix --watch-incremental --watch-strategy native --json --detailed` 查看受影响的任务和变更类型。脚本中可以沿用上一个示例的 `plan` 和工作目录。

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

### 跨阶段传递产物

在后续阶段的任务设置 `consumes: ["bundle"]`，在适配器里用 `context.artifacts.get("bundle")` 读取。变体任务读取匹配变体或全局任务的产物，全局任务可读取所有变体的产物。上游产物参与下游缓存指纹。生产者失败时，消费者可能报告 `ARTIFACT_DEPENDENCY_UNAVAILABLE`。

产物包含 `path` 和可选的 `kind`、`environment`、`sizeBytes`、`sha256`。用 `artifacts.register(artifact)` 记录直接输出，`artifacts.reserve(path)` 在写入前声明独占路径，`artifacts.validate(artifact)` 验证文件。用 `await artifacts.stage(artifact)` 获取临时写入路径，执行器在校验后发布，安装失败时回滚。[发布索引示例](./examples/09-artifact-pipeline/run.ts)

`ExecuteOptions.artifacts.transform(artifact, context, sourcePath?)` 可以替换新产物，`validate(artifact, context, sourcePath?)` 可以抛错拒绝。暂存产物会额外收到临时源路径 `sourcePath`。搭配 `artifacts.cleanup: ["dist"]` 和 `manifestPath`，可在未筛选的运行成功后，按前一份成功报告清理指定目录内的过期产物。目录产物涵盖目录下的内容。

### 组合任务步骤

用 `composeAdapter` 给同一任务的多个步骤设置局部依赖和独立缓存。每步提供 `id`，并指定已注册或内联的 `adapter`，或提供 `run(context)`。可选字段有 `dependsOn`（同级步骤 ID）、`options`、`environment`、`inputs` 和 `cache`。适配器返回步骤列表时，应为需要缓存的步骤单独声明缓存。用 `artifacts.get(stepId)` 读取已完成依赖的产物，或用 `taskData` 共享内存状态。

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

任务的 `adapter` 设置为 `"verify-project"`，并将 `registry` 传给执行器。其他任务也需要某个产物时，可用独立阶段配合 `consumes`。

## 集成 Vite

在执行 Vite 构建的项目安装可选对等依赖。

```sh
npm install -D "vite@^8.3.8"
```

对于已有 `index.html` 的 Vite 应用，用下面的任务替换快速开始中的任务，继续使用原有矩阵，`dev` 和 `prod` 会输出到各自的目录。插件和应用设置照常写在 `vite.config.*` 里。

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

### Vite 任务选项

| `ViteOptions`        | 说明                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution`          | `"process"`（默认）在子进程构建。注入 JavaScript 插件、使用构建钩子或复用构建器时，选择 `"in-process"`。进程内 Vite 调用串行执行，取消会等待正在进行的调用结束。                                                                                         |
| `builder`            | `"once"`（默认）在构建后释放构建器。`"reuse"` 需要 `"in-process"`，供同一注册表后续运行复用。配置依赖、选项或 `cacheKey` 变化，以及构建失败，都会使复用实例失效。                                                                                        |
| `root`、`configFile` | 项目根目录和配置路径，以任务工作目录为基准。`configFile: false` 跳过配置文件。依次从有效根目录、任务工作目录和 Build Matrix 解析 Vite。                                                                                                                  |
| `mode`、`outDir`     | Vite 模式及输出目录。`outDir` 以任务工作目录为基准，并行变体应使用各自的目录。                                                                                                                                                                           |
| `viteConfig`         | JSON 内联 Vite 配置。按 Vite 默认值、项目配置、注册表 `viteConfig`、任务 `viteConfig` 的顺序合并。顶层 `root`、`configFile`、`mode`、`outDir` 优先于内联同类字段，任务的顶层字段优先于注册表的同名字段。`viteConfig.build.outDir` 以 Vite 根目录为基准。 |
| `environments`       | 环境名、按构建顺序排列的数组或 `"all"`。`"all"` 运行应用构建器再构建剩余环境。省略时沿用 Vite 默认选择。                                                                                                                                                 |
| `environmentOptions` | 按环境名指定 `{ config?, build?, root?, mode?, outDir? }`。`config` 和 `build` 合并到对应环境，`root` 和 `outDir` 以任务工作目录为基准。提供 `root` 或 `mode` 会使用同一项目配置为该环境解析独立构建器。                                                 |
| `artifacts`          | `"directories"`（默认）报告输出目录。`"files"` 报告生成或从 public 目录复制的文件，并包含环境、字节数和 SHA-256。内存构建没有自动发现的磁盘产物。                                                                                                        |
| `outputs`            | 显式声明产物，每项须填 `path`，可选 `kind`（`"file"` 或 `"directory"`）、`environment`、`sizeBytes`、`sha256`。支持绝对路径及相对任务路径，指定环境的条目在该环境构建时生效。构建后会校验这些产物，任务声明缓存时必须被 `cache.outputs` 覆盖。           |

在 monorepo 中可用 `root: "apps/{app}"` 和 `outDir: "dist/{app}"` 区分应用。用 `environments: ["client", "ssr"]` 分别构建客户端和服务端，在 `environmentOptions` 中指定各自的 `outDir`。可在环境的 `build.rolldownOptions.output` 中自定义文件名。[多应用示例](./examples/11-vite-monorepo/build-matrix.json) · [客户端和 SSR 示例](./examples/08-vite-environments/build-matrix.json) · [Vite Environment API](https://vite.dev/guide/api-environment-frameworks#environments-during-build)

### Vite 编程选项

将下列选项传给 `createViteAdapter(options?)` 或 `createDefaultRegistry(defaults, { vite: options })`。用后者时，通过 `defaults.vite` 设置适配器默认值。以自定义 ID 注册时，设置 `prepare: true` 以启用缓存和监听准备。

| `ViteAdapterOptions`                                                                                            | 说明                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaults`                                                                                                      | 默认任务选项 `ViteOptions`。                                                                                                                                       |
| `beforeConfig(config, context)`、`configure(config, context)`                                                   | 分别在加载项目配置前和合并后修改或替换内联配置。                                                                                                                   |
| `configureEnvironment(config, context)`、`resolvedConfig(config, context)`                                      | 修改或替换单个环境的配置，或读取最终解析后的配置。配置钩子可用 `context.trackInputs()` 和 `context.onDispose(cleanup)`。按环境解析时可读取 `context.environment`。 |
| `plugins`、`environmentPlugins`                                                                                 | 分别提供构建器的 Vite `PluginOption[]`（支持嵌套和 Promise）及按环境名设置的 `PluginOption`。                                                                      |
| `onBuildStart(context)`、`onBuildEnd(event)`                                                                    | 在构建和产物收集前后调用。                                                                                                                                         |
| `onEnvironmentStart(event)`、`onEnvironmentEnd(event)`                                                          | 在各环境构建前后调用，包括应用构建器发起的构建。结束事件包含 `status` 及 `result` 或 `error`。钩子出错会使任务失败，缓存命中跳过构建钩子。                         |
| `collectArtifacts(outputs, context)`、`transformArtifact(output, context)`、`validateArtifact(output, context)` | 替换候选列表、在校验前处理或替换单个产物，以及通过抛错执行额外校验。                                                                                               |
| `inputs(context)`、`cacheKey`                                                                                   | 在首次构建前声明插件输入。为 `cacheKey` 提供字符串或返回字符串的回调，让带运行时插件或回调的任务可以使用缓存。扩展行为改变时更新该值。                             |
| `builderPool`                                                                                                   | `maxInstances` 限制复用池容量（默认 8，优先回收最近最少使用的实例），`idleTimeoutMs` 设置空闲回收时间。请在使用结束后释放调用方持有的注册表或适配器。              |

适配器跟踪 Vite 配置依赖、环境文件、public 文件、构建模块和插件通过 `this.addWatchFile(path)` 声明的文件。首次构建所需的额外输入可以用 `inputs(context)` 或 `cache.inputs` 提前声明。将脚本保存为 `build-vite.mjs`，放在 Vite 矩阵配置旁，再运行 `node build-vite.mjs`。

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

## 集成第三方构建工具

### 调用工具的 CLI

工具已有 CLI 时，用 `shell`。在项目中安装工具，逐项传参，对随变体变化的参数使用模板。对 npm 安装的 JavaScript CLI，可用 `node` 执行入口文件，绕开不同平台的命令包装脚本。由 Build Matrix 负责监听时，每次调用单独运行一次构建。

例如用 `npm install -D rolldown` 安装 Rolldown，准备 `src/index.js` 入口。将快速开始的矩阵改为 `"dimensions": { "format": ["esm", "cjs"] }` 和 `"idTemplate": "{format}"`，再用以下任务。

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

用 `npx build-matrix --variant esm` 构建 ESM，或用 `npx build-matrix --max-concurrency 2` 构建两种格式。根据实际的工具配置和锁文件调整缓存输入。[Rolldown CLI 指南](https://rolldown.rs/guide/getting-started#using-the-cli)

### 调用工具的 JavaScript API

需要读取工具返回值、注入插件或显式报告产物时，用自定义适配器。保留矩阵和缓存声明，将任务的 `adapter` 改为 `"rolldown"`，将 `options` 改为 `{ "entry": "src/index.js", "format": "{format}", "outDir": "dist/{format}" }`。将以下脚本保存为 `build-rolldown.mjs`，放在配置文件旁，运行 `node build-rolldown.mjs`。

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

适配器报告输出目录供后续任务使用，并在元数据中记录工具生成的产物数量。[Rolldown JavaScript API](https://rolldown.rs/reference/Function.rolldown)

## 开发

```sh
npm ci
npm run check
```

## 许可证

[MIT](./LICENSE)
