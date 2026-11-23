import type { BigIntStats } from 'node:fs';

import { lstat, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
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
    const tracked = new Map<string, Promise<string | undefined>>();

    async function trackInputs(inputs: readonly string[]) {
      await Promise.all(
        inputs.map(async (input) => {
          const path = resolve(cwd, input);
          if (ignore(path)) {
            return;
          }
          let baseline = tracked.get(path);
          if (baseline === undefined) {
            baseline = fileSignature(path, signal);
            tracked.set(path, baseline);
          }
          await baseline;
        }),
      );
    }

    function markChanged(path: string) {
      pending.add(path);
      lastChange = performance.now();
    }

    function recordChanges(before: Map<string, string>, after: Map<string, string>) {
      for (const [path, signature] of after) {
        if (before.get(path) !== signature) {
          markChanged(path);
        }
      }
      for (const path of before.keys()) {
        if (!after.has(path)) {
          markChanged(path);
        }
      }
    }

    function start(changedPaths: readonly string[]) {
      active = run(changedPaths, signal, trackInputs)
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
        recordChanges(before, after);
        await Promise.all(
          [...tracked].map(async ([path, baseline]) => {
            const next = fileSignature(path, signal);
            const [previous, current] = await Promise.all([baseline, next]);
            if (previous !== current) {
              markChanged(path);
            }
            tracked.set(path, next);
          }),
        );
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

async function fileSignature(path: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  try {
    return signature(await stat(path, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
    return undefined;
  }
}

function signature({ ctimeNs, dev, ino, mode, mtimeNs, size }: BigIntStats): string {
  return `${dev}:${ino}:${mode}:${size}:${mtimeNs}:${ctimeNs}`;
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
      const info = await lstat(path, { bigint: true });
      if (info.isDirectory()) {
        for (const name of await readdir(path)) {
          await visit(join(path, name));
        }
      } else {
        files.set(path, signature(info));
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
