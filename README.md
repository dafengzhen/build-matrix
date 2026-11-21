# Build Matrix

[简体中文](./README.zh.md) · [Examples](./examples/README.md) · [Reference](./docs/reference.md)

Build Matrix runs build variants through a staged pipeline. Use the CLI with a JSON config or run plans from JavaScript and TypeScript. Built-in adapters run commands, clean files, and build Vite projects.

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

The first command runs both variants. The second runs `prod` only. To use another config, pass its path after `build-matrix`. Tasks run from the config directory.

## Usage

- Run `npx build-matrix --help` for CLI flags.
- See the [runnable examples](./examples/README.md) for matrix filters, caching, watch mode, failure reports, custom adapters, and Vite builds.
- See the [reference](./docs/reference.md) for configuration fields, adapter options, and the JavaScript and TypeScript API.

## Development

```sh
npm ci
npm run check
```

## License

[MIT](./LICENSE)
