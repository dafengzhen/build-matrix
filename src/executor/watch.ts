import { basename, dirname, relative, resolve, sep } from 'node:path';

import type { Plan } from '../core/types.js';
import type { ExecuteOptions, PlanState } from './execute.js';
import type { RunResult, WatchAdapter, WatchContext } from './types.js';

import { nativeWatchAdapter, pollingWatchAdapter } from '../adapters/watch.js';
import { asArray, asPath, invalid } from '../core/validation.js';
import { containsPath, stagingPrefix } from './artifacts.js';
import { cacheStateDirectory, defaultCacheDirectory } from './cache.js';
import { runPlan } from './execute.js';
import { createDefaultRegistry } from './registry.js';

export interface WatchOptions extends ExecuteOptions {
  readonly classifyChanges?: boolean;
  readonly debounceMs?: number;
  readonly ignore?: readonly string[];
  readonly incremental?: boolean;
  onRun?(result: RunResult): Promise<void> | void;
  readonly paths?: readonly string[];
  readonly pollIntervalMs?: number;
  readonly strategy?: 'native' | 'polling';
  readonly watchAdapter?: WatchAdapter;
}

/** Execute a plan for each run requested by the watch adapter. */
export async function watchPlan(plan: Plan, options: WatchOptions): Promise<void> {
  const cwd = options.cwd === undefined ? process.cwd() : resolve(asPath(options.cwd, 'cwd'));
  const paths = pathsFrom(cwd, options.paths ?? [], 'watch.paths');
  if (paths.length === 0 && options.incremental !== true) {
    invalid('watch.paths', 'expected at least one path, or enable incremental watch');
  }
  const ignored = pathsFrom(cwd, options.ignore ?? [], 'watch.ignore');
  if (options.cache !== false) {
    const cache = resolve(
      cwd,
      asPath(options.cache?.directory ?? defaultCacheDirectory, 'cache.directory'),
    );
    ignored.push(cache, cacheStateDirectory(cache));
  }
  const manifest =
    options.manifestPath === undefined
      ? undefined
      : resolve(cwd, asPath(options.manifestPath, 'manifestPath'));
  if (manifest !== undefined) {
    ignored.push(manifest);
  }
  const ignore = (path: string) =>
    ignored.some((item) => containsPath(item, path)) ||
    relative(cwd, path)
      .split(sep)
      .some((part) => part.startsWith(stagingPrefix)) ||
    (manifest !== undefined &&
      relative(dirname(manifest), dirname(path)) === '' &&
      /^\.build-matrix-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.tmp$/i.test(basename(path)));

  const signal = options.signal ?? new AbortController().signal;
  const registry = options.registry ?? createDefaultRegistry();
  const settings: ExecuteOptions = {
    ...options,
    cwd,
    registry,
  };
  const state: PlanState = new Map();
  let number = 0;
  const adapter =
    options.watchAdapter ??
    (options.strategy === 'native' ? nativeWatchAdapter : pollingWatchAdapter);
  const run = coalesceRuns(async (changedPaths, watchSignal, trackInputs, changes) => {
    const runSignal = watchSignal === undefined ? signal : AbortSignal.any([signal, watchSignal]);
    if (runSignal.aborted) {
      return;
    }
    const watch = Object.freeze({
      changedPaths: Object.freeze([...changedPaths]),
      ...((options.classifyChanges ?? true) && changes?.length
        ? { changes: Object.freeze([...changes]) }
        : {}),
      number: ++number,
    });
    const result = await runPlan(
      plan,
      { ...settings, signal: runSignal },
      watch,
      trackInputs,
      state,
      options.incremental,
    );
    await options.onRun?.(result);
  });
  try {
    await adapter.watch({
      cwd,
      debounceMs: options.debounceMs,
      ignore,
      paths,
      pollIntervalMs: options.pollIntervalMs,
      run: run.request,
      signal,
      trackedPaths() {
        const paths = new Set<string>();
        for (const units of state.values()) {
          for (const { inputs } of units.values()) {
            for (const path of inputs) {
              paths.add(path);
            }
          }
        }
        return [...paths];
      },
    });
  } finally {
    await run.drain();
    if (options.registry === undefined) {
      await registry.dispose();
    }
  }
}

function coalesceRuns(run: WatchContext['run']) {
  type Request = { args: Parameters<WatchContext['run']>; done: PromiseWithResolvers<void> };
  let scheduled: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  const pending: Request[] = [];
  function schedule() {
    scheduled ??= Promise.resolve()
      .then(drain)
      .finally(() => {
        scheduled = undefined;
        if (pending.length) {
          schedule();
        }
      });
  }
  async function drain() {
    while (pending.length) {
      const requests = pending.splice(0);
      const active = requests.filter(({ args }) => !args[1]?.aborted);
      const paths = [...new Set(active.flatMap(({ args }) => args[0]))].sort();
      const signals = active.flatMap(({ args }) => (args[1] === undefined ? [] : [args[1]]));
      const changes = active.flatMap(({ args }) => args[3] ?? []);
      try {
        if (active.length) {
          await run(
            paths,
            signals.length ? AbortSignal.any(signals) : undefined,
            active.at(-1)?.args[2],
            changes,
          );
        }
        for (const request of requests) {
          request.done.resolve();
        }
      } catch (error) {
        failure = { error };
        for (const request of [...requests, ...pending.splice(0)]) {
          request.done.reject(error);
        }
      }
    }
  }
  return {
    async drain() {
      while (scheduled !== undefined) {
        await scheduled;
      }
    },
    request(...args: Parameters<WatchContext['run']>) {
      if (failure !== undefined) {
        return Promise.reject(failure.error);
      }
      const done = Promise.withResolvers<void>();
      pending.push({ args, done });
      schedule();
      return done.promise;
    },
  };
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
