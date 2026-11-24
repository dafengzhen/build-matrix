import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { containsPath, createArtifactTransaction, stagingPrefix } from './artifacts.js';

export interface CacheBackend {
  get(
    key: string,
    signal: AbortSignal,
  ): CachePayload | Promise<CachePayload | undefined> | undefined;
  put(key: string, payload: CachePayload, signal: AbortSignal): Promise<void> | void;
}

export type CacheFile =
  | { readonly data: string; readonly kind: 'file'; readonly mode: number; readonly path: string }
  | { readonly kind: 'directory'; readonly mode: number; readonly path: string };

export interface CachePayload {
  readonly entry: unknown;
  readonly files: readonly CacheFile[];
}

export async function restoreCacheOutputs(
  cwd: string,
  outputs: readonly string[],
  entries: readonly CacheFile[],
  signal: AbortSignal,
  verify: (stagedRoot: string) => Promise<boolean>,
): Promise<boolean> {
  const staged = await mkdtemp(join(cwd, stagingPrefix));
  try {
    // Mirror the declared paths so the same output fingerprint verifies the restored tree.
    await materialize(staged, cwd, outputs, entries, signal);
    if (!(await verify(staged))) {
      return false;
    }
    const publish = createArtifactTransaction(
      { cwd, signal },
      () => {},
      () => [],
    );
    try {
      for (const output of outputs) {
        const source = await publish.api.stage({ path: output });
        await rename(join(staged, output), source);
      }
      await publish.commit();
      return true;
    } finally {
      await publish.dispose();
    }
  } finally {
    await rm(staged, { force: true, recursive: true });
  }
}

export async function snapshotCacheOutputs(
  root: string,
  outputs: readonly string[],
  signal: AbortSignal,
): Promise<CacheFile[]> {
  const entries: CacheFile[] = [];
  async function visit(path: string) {
    signal.throwIfAborted();
    const absolute = join(root, path);
    const info = await lstat(absolute);
    const mode = info.mode & 0o777;
    const local = path.split(sep).join('/');
    if (info.isDirectory()) {
      entries.push({ kind: 'directory', mode, path: local });
      for (const name of (await readdir(absolute)).sort()) {
        await visit(join(path, name));
      }
    } else if (info.isFile()) {
      entries.push({
        data: await readFile(absolute, { encoding: 'base64', signal }),
        kind: 'file',
        mode,
        path: local,
      });
    } else {
      throw new Error(`Unsupported file type in cache output "${local}"`);
    }
  }
  for (const path of outputs) {
    await visit(path);
  }
  return entries;
}

async function materialize(
  staged: string,
  cwd: string,
  outputs: readonly string[],
  entries: readonly CacheFile[],
  signal: AbortSignal,
) {
  const declared = outputs.map((path) => resolve(cwd, path));
  const seen = new Set<string>();
  const directories: { mode: number; path: string }[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    const parts = entry.path.split('/');
    if (
      isAbsolute(entry.path) ||
      parts.some(
        (part) =>
          !part ||
          part === '..' ||
          part === '.' ||
          /[\\:\0]/.test(part) ||
          (process.platform === 'win32' &&
            /[ .]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
      ) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw new Error('Invalid cache file entry');
    }
    const absolute = resolve(cwd, ...parts);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key) || !declared.some((path) => containsPath(path, absolute))) {
      throw new Error(`Unexpected cache output "${entry.path}"`);
    }
    seen.add(key);
    const path = join(staged, relative(cwd, absolute));
    await mkdir(join(path, '..'), { recursive: true });
    if (entry.kind === 'directory') {
      await mkdir(path, { recursive: true });
      directories.push({ mode: entry.mode, path });
    } else if (entry.kind === 'file' && typeof entry.data === 'string') {
      await writeFile(path, entry.data, {
        encoding: 'base64',
        flag: 'wx',
        mode: entry.mode,
        signal,
      });
      await chmod(path, entry.mode);
    } else {
      throw new Error('Invalid cache file kind');
    }
  }
  for (const { mode, path } of directories.sort((a, b) => b.path.length - a.path.length)) {
    await chmod(path, mode);
  }
}
