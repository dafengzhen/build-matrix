import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Plan } from '../core/types.js';
import type { ExecuteOptions } from './execute.js';
import type { RunResult } from './types.js';

import { asArray, asNonemptyString, asPositiveInteger, invalid } from '../core/validation.js';
import { defaultCacheDirectory } from './cache.js';
import { runPlan } from './execute.js';
import { createDefaultRegistry } from './registry.js';

export interface WatchOptions extends ExecuteOptions {
  readonly debounceMs?: number;
  readonly ignore?: readonly string[];
  onRun?(result: RunResult): Promise<void> | void;
  readonly paths: readonly string[];
  readonly pollIntervalMs?: number;
}

/** Run immediately, then rerun the selected pipeline after a quiet period. */
export async function watchPlan(plan: Plan, options: WatchOptions): Promise<void> {
  const cwd =
    options.cwd === undefined ? process.cwd() : resolve(asNonemptyString(options.cwd, 'cwd'));
  const paths = pathsFrom(cwd, options.paths, 'watch.paths');
  if (paths.length === 0) {
    invalid('watch.paths', 'expected at least one path');
  }
  const ignored = pathsFrom(cwd, options.ignore ?? [], 'watch.ignore');
  const interval =
    options.pollIntervalMs === undefined
      ? 150
      : asPositiveInteger(options.pollIntervalMs, 'watch.pollIntervalMs');
  const debounce =
    options.debounceMs === undefined
      ? 200
      : asPositiveInteger(options.debounceMs, 'watch.debounceMs');
  if (interval > 2_147_483_647) {
    invalid('watch.pollIntervalMs', 'interval exceeds the timer limit');
  }
  if (options.cache !== false) {
    ignored.push(resolve(cwd, options.cache?.directory ?? defaultCacheDirectory));
  }
  const manifest =
    options.manifestPath === undefined ? undefined : resolve(cwd, options.manifestPath);
  if (manifest !== undefined) {
    ignored.push(manifest);
  }
  const ignore = (path: string) =>
    ignored.some((item) => isWithin(item, path)) ||
    (manifest !== undefined &&
      relative(dirname(manifest), dirname(path)) === '' &&
      /^\.build-matrix-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.tmp$/i.test(basename(path)));

  const stop = new AbortController();
  const signal =
    options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
  const settings: ExecuteOptions = {
    ...options,
    cwd,
    registry: options.registry ?? createDefaultRegistry(),
    signal,
  };
  let active: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  let number = 0;
  let lastChange = 0;
  const pending = new Set<string>();
  function start(changedPaths: readonly string[]) {
    const watch = Object.freeze({ changedPaths: Object.freeze(changedPaths), number: ++number });
    active = runPlan(plan, settings, watch)
      .then((result) => options.onRun?.(result))
      .catch((error) => {
        failure = { error };
        stop.abort();
      })
      .finally(() => {
        active = undefined;
      });
  }

  try {
    let before = await snapshot(paths, ignore, signal);
    if (!signal.aborted) {
      start([]);
    }
    while (!signal.aborted) {
      await delay(interval, undefined, { signal });
      const after = await snapshot(paths, ignore, signal);
      for (const [path, signature] of after) {
        if (before.get(path) === signature) {
          continue;
        }
        pending.add(path);
        lastChange = performance.now();
      }
      for (const path of before.keys()) {
        if (after.has(path)) {
          continue;
        }
        pending.add(path);
        lastChange = performance.now();
      }
      before = after;
      if (
        !signal.aborted &&
        active === undefined &&
        pending.size > 0 &&
        performance.now() - lastChange >= debounce
      ) {
        const changedPaths = [...pending].map((path) => relative(cwd, path) || '.').sort();
        pending.clear();
        start(changedPaths);
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    stop.abort();
    await active;
  }
  if (failure !== undefined) {
    throw failure.error;
  }
}

function isWithin(parent: string, path: string): boolean {
  const local = relative(parent, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function pathsFrom(cwd: string, values: readonly string[], field: string): string[] {
  return [
    ...new Set(
      asArray(values, field).map((value, index) => {
        const label = `${field}[${index}]`;
        const path = asNonemptyString(value, label);
        if (path.includes('\0')) {
          invalid(label, 'path contains a NUL character');
        }
        return resolve(cwd, path);
      }),
    ),
  ];
}

async function snapshot(
  paths: readonly string[],
  ignore: (path: string) => boolean,
  signal: AbortSignal,
) {
  const files = new Map<string, string>();
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    signal.throwIfAborted();
    if (ignore(path) || visited.has(path)) {
      return;
    }
    visited.add(path);
    try {
      const stat = await lstat(path, { bigint: true });
      if (stat.isDirectory()) {
        for (const name of await readdir(path)) {
          await visit(join(path, name));
        }
      } else {
        files.set(
          path,
          `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  for (const path of paths) {
    await visit(path);
  }
  return files;
}
