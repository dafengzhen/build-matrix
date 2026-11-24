import type { BigIntStats, FSWatcher } from 'node:fs';

import { watch } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { WatchAdapter, WatchChange } from '../executor/types.js';

import { asPositiveInteger, invalid } from '../core/validation.js';

export const nativeWatchAdapter: WatchAdapter = createWatcher(true);
export const pollingWatchAdapter: WatchAdapter = createWatcher(false);

function classifyChanges(
  cwd: string,
  pending: ReadonlyMap<string, { after?: string; before?: string }>,
): WatchChange[] {
  const changes: WatchChange[] = [];
  const old = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  for (const [absolute, { after, before }] of pending) {
    const path = relative(cwd, absolute) || '.';
    if (before !== undefined && after !== undefined) {
      changes.push({ kind: 'modified', path });
    } else {
      const signature = (before ?? after)!.split(':', 2).join(':');
      const index = before === undefined ? added : old;
      const paths = index.get(signature) ?? [];
      paths.push(path);
      index.set(signature, paths);
    }
  }
  for (const [signature, paths] of old) {
    const destinations = added.get(signature);
    if (paths.length === 1 && destinations?.length === 1) {
      changes.push({ from: paths[0], kind: 'renamed', path: destinations[0] });
      added.delete(signature);
    } else {
      changes.push(...paths.map((path): WatchChange => ({ kind: 'deleted', path })));
    }
  }
  for (const paths of added.values()) {
    changes.push(...paths.map((path): WatchChange => ({ kind: 'added', path })));
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function createWatcher(native: boolean): WatchAdapter {
  return {
    async watch({
      cwd,
      debounceMs,
      ignore,
      paths,
      pollIntervalMs,
      run,
      signal: parentSignal,
      trackedPaths,
    }) {
      const interval =
        pollIntervalMs === undefined
          ? native
            ? 1_000
            : 150
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
      const pending = new Map<string, { after?: string; before?: string }>();
      const tracked = new Map<string, Promise<Map<string, string>>>();
      const watchers = new Map<string, FSWatcher>();
      let wake = new AbortController();

      async function trackInputs(inputs: readonly string[]) {
        await Promise.all(
          inputs.map(async (input) => {
            const path = resolve(cwd, input);
            if (ignore(path)) {
              return;
            }
            let baseline = tracked.get(path);
            if (baseline === undefined) {
              baseline = snapshot([path], ignore, signal, true);
              tracked.set(path, baseline);
              if (native) {
                wake.abort();
              }
            }
            await baseline;
          }),
        );
      }

      function markChanged(path: string, before?: string, after?: string) {
        const original = pending.get(path);
        const earliest = original === undefined ? before : original.before;
        if (earliest === after) {
          pending.delete(path);
        } else {
          pending.set(path, { after, before: earliest });
        }
        lastChange = performance.now();
      }

      function recordChanges(before: Map<string, string>, after: Map<string, string>) {
        for (const [path, signature] of after) {
          if (before.get(path) !== signature) {
            markChanged(path, before.get(path), signature);
          }
        }
        for (const path of before.keys()) {
          if (!after.has(path)) {
            markChanged(path, before.get(path));
          }
        }
      }

      function start(changedPaths: readonly string[], changes?: readonly WatchChange[]) {
        active = run(changedPaths, signal, trackInputs, changes)
          .catch((error) => {
            failure = { error };
            stop.abort();
          })
          .finally(() => {
            if (trackedPaths !== undefined) {
              const paths = new Set(trackedPaths());
              for (const path of tracked.keys()) {
                if (!paths.has(path)) {
                  tracked.delete(path);
                }
              }
            }
            active = undefined;
          });
      }

      async function installNative() {
        const desired = new Set<string>();
        for (const path of [...paths, ...tracked.keys()]) {
          const candidate = await nativeRoot(path, signal);
          // Keep watching the parent when the root is initially absent.
          desired.add(candidate);
        }
        for (const [root, watcher] of watchers) {
          if (!desired.has(root)) {
            watcher.close();
            watchers.delete(root);
          }
        }
        for (const root of desired) {
          if (watchers.has(root)) {
            continue;
          }
          try {
            const watcher = watch(root, { recursive: true, signal }, () => wake.abort());
            watcher.on('error', () => watcher.close());
            watcher.on('close', () => {
              if (watchers.get(root) === watcher) {
                watchers.delete(root);
              }
            });
            watchers.set(root, watcher);
          } catch {
            // The periodic snapshots also cover platforms without recursive watching.
          }
        }
      }

      try {
        if (native) {
          await installNative();
        }
        let before = await snapshot(paths, ignore, signal);
        if (!signal.aborted) {
          start([]);
        }
        while (!signal.aborted) {
          try {
            const remaining =
              pending.size && active === undefined
                ? Math.max(1, debounce - (performance.now() - lastChange))
                : interval;
            await delay(Math.min(interval, remaining), undefined, {
              signal: AbortSignal.any([signal, wake.signal]),
            });
          } catch (error) {
            if (signal.aborted || !wake.signal.aborted) {
              throw error;
            }
          }
          wake = new AbortController();
          if (native) {
            await installNative();
          }
          const after = await snapshot(paths, ignore, signal);
          recordChanges(before, after);
          await Promise.all(
            [...tracked].map(async ([path, baseline]) => {
              const next = snapshot([path], ignore, signal, true);
              const [previous, current] = await Promise.all([baseline, next]);
              if (tracked.get(path) === baseline) {
                recordChanges(previous, current);
                tracked.set(path, next);
              }
            }),
          );
          before = after;
          if (
            !signal.aborted &&
            active === undefined &&
            pending.size > 0 &&
            performance.now() - lastChange >= debounce
          ) {
            const changedPaths = [...pending.keys()]
              .map((path) => relative(cwd, path) || '.')
              .sort();
            const changes = classifyChanges(cwd, pending);
            pending.clear();
            start(changedPaths, changes);
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
}

async function nativeRoot(path: string, signal: AbortSignal): Promise<string> {
  let directory = path;
  while (true) {
    signal.throwIfAborted();
    try {
      if ((await stat(directory)).isDirectory()) {
        return directory;
      }
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return directory;
    }
    directory = parent;
  }
}

function signature({ ctimeNs, dev, ino, mode, mtimeNs, size }: BigIntStats): string {
  return `${dev}:${ino}:${mode}:${size}:${mtimeNs}:${ctimeNs}`;
}

async function snapshot(
  paths: readonly string[],
  ignore: (path: string) => boolean,
  signal: AbortSignal,
  followRoots = false,
) {
  const files = new Map<string, string>();
  const visited = new Set<string>();
  async function visit(path: string, follow = false): Promise<void> {
    signal.throwIfAborted();
    if (ignore(path) || visited.has(path)) {
      return;
    }
    visited.add(path);
    try {
      const info = follow
        ? await stat(path, { bigint: true })
        : await lstat(path, { bigint: true });
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
    await visit(path, followRoots);
  }
  return files;
}
