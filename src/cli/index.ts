import { readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { ExecuteOptions, RunResult } from '../executor/index.js';

import { createDetailedReport, createManifest, executePlan, watchPlan } from '../executor/index.js';
import { ConfigurationError, createPlan } from '../index.js';
import { formatResult } from './report.js';

const help = `Usage: build-matrix [config.json] [options]

  -j, --max-concurrency <n>   Maximum concurrent tasks (default: 1)
  --variant <id>              Select a variant by exact ID (repeatable)
  --task <id>                 Select a task by exact ID (repeatable)
  --resource <group>=<n>      Override a resource group concurrency limit (repeatable)
  --json                      Print a versioned JSON report
  --manifest <path>           Write the JSON report to a file
  --detailed                  Include detailed timing and scheduling (report schema 2)
  --cache-dir <path>          Set the local cache directory (default: .build-matrix-cache)
  --no-cache                  Bypass the local task cache
  --watch <path>              Watch a source file or directory recursively (repeatable)
  --watch-ignore <path>       Exclude a file or directory from watch (repeatable)
  --debounce <ms>             Watch quiet period (default: 200)
  --poll-interval <ms>        Watch scan interval (default: 150)
  -h, --help                  Show usage

The default config is build-matrix.json. Tasks run from the config directory.`;

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  let cancellationExitCode = 130;
  const cancelWith = (code: number) => {
    if (controller.signal.aborted) {
      return;
    }
    cancellationExitCode = code;
    controller.abort();
  };
  const interrupt = () => cancelWith(130);
  const terminate = () => cancelWith(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const { positionals, values } = parseCliArgs(argv);
    if (values.help) {
      process.stdout.write(`${help}\n`);
      return 0;
    }
    if (positionals.length > 1) {
      throw new ConfigurationError('expected at most one configuration path');
    }
    const path = resolve(positionals[0] ?? 'build-matrix.json');
    const maxConcurrency = parseNumber(values['max-concurrency'], 'max-concurrency');
    const debounceMs = parseNumber(values.debounce, 'debounce');
    const pollIntervalMs = parseNumber(values['poll-interval'], 'poll-interval');
    if (
      values.watch === undefined &&
      (values['watch-ignore'] !== undefined ||
        debounceMs !== undefined ||
        pollIntervalMs !== undefined)
    ) {
      throw new ConfigurationError('watch-ignore, debounce and poll-interval require --watch');
    }
    const resourceLimits = Object.fromEntries(
      (values.resource ?? []).map((entry) => {
        const match = /^([A-Za-z_][\w-]*)=(\d+)$/.exec(entry);
        if (match === null) {
          throw new ConfigurationError(`invalid resource limit "${entry}", expected group=limit`);
        }
        return [match[1], Number(match[2])];
      }),
    );
    const plan = createPlan(await loadConfig(path, controller.signal));
    const cwd = dirname(path);
    if (values.manifest !== undefined) {
      if (values.manifest.trim() === '' || values.manifest.includes('\0')) {
        throw new ConfigurationError('manifest path must be a non-empty path');
      }
      await checkManifestDestination(path, resolve(cwd, values.manifest));
    }
    const writeLog = (message: string) =>
      process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
    const settings: ExecuteOptions = {
      cache: values['no-cache'] ? false : { directory: values['cache-dir'] },
      cwd,
      filter: { taskIds: values.task, variantIds: values.variant },
      logger: { error: writeLog, info: writeLog },
      manifestPath: values.manifest,
      manifestVersion: values.detailed ? 2 : 1,
      maxConcurrency,
      resourceLimits,
      signal: controller.signal,
    };
    const printRun = (result: RunResult) => {
      const detailed = values.detailed ? createDetailedReport(plan, result) : undefined;
      const output = values.json
        ? JSON.stringify(
            detailed ?? createManifest(plan, result),
            undefined,
            result.watch === undefined ? 2 : undefined,
          )
        : formatResult(result, detailed);
      process.stdout.write(`${output}\n`);
    };
    if (values.watch !== undefined) {
      await watchPlan(plan, {
        ...settings,
        debounceMs,
        ignore: values['watch-ignore'],
        onRun: printRun,
        paths: values.watch,
        pollIntervalMs,
      });
      return cancellationExitCode;
    }
    const result = await executePlan(plan, settings);
    printRun(result);
    return result.status === 'success' ? 0 : result.status === 'failed' ? 1 : cancellationExitCode;
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Build cancelled.\n');
      return cancellationExitCode;
    }
    const label = error instanceof ConfigurationError ? 'Configuration error' : 'Execution error';
    process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function checkManifestDestination(configPath: string, manifestPath: string): Promise<void> {
  const config = await realpath(configPath);
  const destination = await realpath(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return manifestPath;
    }
    throw error;
  });
  if (relative(configPath, manifestPath) === '' || relative(config, destination) === '') {
    throw new ConfigurationError('manifest path must be different from the configuration path');
  }
}

async function loadConfig(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const source = await readFile(path, { encoding: 'utf8', signal });
    return JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`${path}: ${message}`, { cause: error });
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      allowPositionals: true,
      args: [...argv],
      options: {
        'cache-dir': { type: 'string' },
        debounce: { type: 'string' },
        detailed: { type: 'boolean' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        manifest: { type: 'string' },
        'max-concurrency': { short: 'j', type: 'string' },
        'no-cache': { type: 'boolean' },
        'poll-interval': { type: 'string' },
        resource: { multiple: true, type: 'string' },
        task: { multiple: true, type: 'string' },
        variant: { multiple: true, type: 'string' },
        watch: { multiple: true, type: 'string' },
        'watch-ignore': { multiple: true, type: 'string' },
      },
    });
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

function parseNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(`${flag} must be a positive integer`);
  }
  return Number(value);
}
