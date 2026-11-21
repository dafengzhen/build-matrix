import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { Plan } from '../core/types.js';
import type { ExecuteOptions } from './execute.js';
import type { RunResult, WatchAdapter } from './types.js';

import { pollingWatchAdapter } from '../adapters/watch.js';
import { asArray, asPath, invalid } from '../core/validation.js';
import { defaultCacheDirectory } from './cache.js';
import { runPlan } from './execute.js';
import { createDefaultRegistry } from './registry.js';

export interface WatchOptions extends ExecuteOptions {
  readonly debounceMs?: number;
  readonly ignore?: readonly string[];
  onRun?(result: RunResult): Promise<void> | void;
  readonly paths: readonly string[];
  readonly pollIntervalMs?: number;
  readonly watchAdapter?: WatchAdapter;
}

/** Execute a plan for each run requested by the watch adapter. */
export async function watchPlan(plan: Plan, options: WatchOptions): Promise<void> {
  const cwd = options.cwd === undefined ? process.cwd() : resolve(asPath(options.cwd, 'cwd'));
  const paths = pathsFrom(cwd, options.paths, 'watch.paths');
  if (paths.length === 0) {
    invalid('watch.paths', 'expected at least one path');
  }
  const ignored = pathsFrom(cwd, options.ignore ?? [], 'watch.ignore');
  if (options.cache !== false) {
    ignored.push(
      resolve(cwd, asPath(options.cache?.directory ?? defaultCacheDirectory, 'cache.directory')),
    );
  }
  const manifest =
    options.manifestPath === undefined
      ? undefined
      : resolve(cwd, asPath(options.manifestPath, 'manifestPath'));
  if (manifest !== undefined) {
    ignored.push(manifest);
  }
  const ignore = (path: string) =>
    ignored.some((item) => isWithin(item, path)) ||
    (manifest !== undefined &&
      relative(dirname(manifest), dirname(path)) === '' &&
      /^\.build-matrix-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.tmp$/i.test(basename(path)));

  const signal = options.signal ?? new AbortController().signal;
  const settings: ExecuteOptions = {
    ...options,
    cwd,
    registry: options.registry ?? createDefaultRegistry(),
  };
  let number = 0;
  const adapter = options.watchAdapter ?? pollingWatchAdapter;
  await adapter.watch({
    cwd,
    debounceMs: options.debounceMs,
    ignore,
    paths,
    pollIntervalMs: options.pollIntervalMs,
    async run(changedPaths, watchSignal) {
      const runSignal = watchSignal === undefined ? signal : AbortSignal.any([signal, watchSignal]);
      if (runSignal.aborted) {
        return;
      }
      const watch = Object.freeze({
        changedPaths: Object.freeze([...changedPaths]),
        number: ++number,
      });
      const result = await runPlan(plan, { ...settings, signal: runSignal }, watch);
      await options.onRun?.(result);
    },
    signal,
  });
}

function isWithin(parent: string, path: string): boolean {
  const local = relative(parent, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function pathsFrom(cwd: string, values: readonly string[], field: string): string[] {
  return [
    ...new Set(
      asArray(values, field).map((value, index) =>
        resolve(cwd, asPath(value, `${field}[${index}]`)),
      ),
    ),
  ];
}
