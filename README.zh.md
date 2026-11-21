# Build Matrix

[English](./README.md) · [使用示例](./examples/README.zh.md) · [配置与 API 参考](./docs/reference.zh.md)

Build Matrix 将构建矩阵展开为变体，并按阶段执行任务。可以用 CLI 读取 JSON 配置，也可以从 JavaScript 或 TypeScript 执行计划。内置适配器支持运行命令、清理文件和构建 Vite 项目。

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

第一条命令运行两个变体，第二条只运行 `prod`。如需使用其他配置，在 `build-matrix` 后传入配置文件路径。任务以配置文件所在目录为工作目录。

## 使用指南

- 运行 `npx build-matrix --help` 查看命令行参数。
- 矩阵筛选、缓存、文件监听、失败报告、自定义适配器和 Vite 构建见[可运行示例](./examples/README.zh.md)。
- 配置字段、适配器选项和 JavaScript / TypeScript API 见[参考文档](./docs/reference.zh.md)。

## 开发

```sh
npm ci
npm run check
```

## 许可证

[MIT](./LICENSE)
