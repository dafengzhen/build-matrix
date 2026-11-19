import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { WatchAdapter } from '../executor/types.js';

import { asPositiveInteger, invalid } from '../core/validation.js';

export const pollingWatchAdapter: WatchAdapter = {
  async watch({ cwd, debounceMs, ignore, paths, pollIntervalMs, run, signal: parentSignal }) {
    const interval =
      pollIntervalMs === undefined
        ? 150
        : asPositiveInteger(pollIntervalMs, 'watch.pollIntervalMs');
    const debounce =
      debounceMs === undefined ? 200 : asPositiveInteger(debounceMs, 'watch.debounceMs');
    if (interval > 2_147_483_647) {
      invalid('watch.pollIntervalMs', 'interval exceeds the timer limit');
    }

    const stop = new AbortController();
    const signal = AbortSignal.any([parentSignal, stop.signal]);
    let active: Promise<void> | undefined;
    let failure: { error: unknown } | undefined;
    let lastChange = 0;
    const pending = new Set<string>();

    function start(changedPaths: readonly string[]) {
      active = run(changedPaths, signal)
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
          if (before.get(path) !== signature) {
            pending.add(path);
            lastChange = performance.now();
          }
        }
        for (const path of before.keys()) {
          if (!after.has(path)) {
            pending.add(path);
            lastChange = performance.now();
          }
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
  },
};

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
