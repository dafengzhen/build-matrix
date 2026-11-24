import type { BigIntStats } from 'node:fs';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export type PathKind = 'directory' | 'file';

interface PathFingerprint {
  readonly digest: string;
  readonly matchedPaths: ReadonlyMap<string, PathKind>;
}

/** Hash adapter-discovered paths, including paths that have not been created yet. */
export async function fingerprintInputFiles(
  paths: readonly string[],
  signal: AbortSignal,
  components?: Map<string, string>,
  cwd?: string,
): Promise<string | undefined> {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    signal.throwIfAborted();
    const local = cwd === undefined ? path : relative(cwd, path);
    const key = local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) ? path : local;
    try {
      const before = await stat(path, { bigint: true });
      if (before.isDirectory()) {
        const contents = await fingerprintPaths(dirname(path), [basename(path)], signal);
        if (contents === undefined) {
          return undefined;
        }
        components?.set(key, contents.digest);
        hash.update(JSON.stringify([key, 'directory', contents.digest]));
        continue;
      }
      if (!before.isFile()) {
        return undefined;
      }
      const contents = createHash('sha256');
      for await (const chunk of createReadStream(path, { signal })) {
        contents.update(chunk);
      }
      if (!unchanged(before, await stat(path, { bigint: true }))) {
        return undefined;
      }
      const digest = contents.digest('hex');
      components?.set(key, digest);
      hash.update(JSON.stringify([key, digest]));
    } catch (error) {
      signal.throwIfAborted();
      if (!isFileError(error)) {
        throw error;
      }
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return undefined;
      }
      components?.set(key, 'missing');
      hash.update(JSON.stringify([key, null]));
    }
  }
  return hash.digest('hex');
}

/** Hash declared relative paths without traversing symbolic links or special files. */
export async function fingerprintPaths(
  root: string,
  paths: readonly string[],
  signal: AbortSignal,
  requiredPaths?: readonly string[],
  components?: Map<string, string>,
): Promise<PathFingerprint | undefined> {
  const hash = createHash('sha256');
  const pending = requiredPaths === undefined ? undefined : new Set(requiredPaths.map(pathKey));
  const matchedPaths = new Map<string, PathKind>();

  async function visit(
    absolute: string,
    local: string,
    before: BigIntStats,
    component?: ReturnType<typeof createHash>,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const mode = Number(before.mode & 0o777n);
    let kind: PathKind;
    if (before.isFile()) {
      kind = 'file';
      const contents = createHash('sha256');
      for await (const chunk of createReadStream(absolute, { signal })) {
        contents.update(chunk);
      }
      const entry = JSON.stringify([kind, local, mode, contents.digest('hex')]);
      hash.update(entry);
      component?.update(entry);
    } else if (before.isDirectory()) {
      kind = 'directory';
      const entry = JSON.stringify([kind, local, mode]);
      hash.update(entry);
      component?.update(entry);
      for (const name of (await readdir(absolute)).sort()) {
        const child = join(absolute, name);
        if (
          !(await visit(child, join(local, name), await lstat(child, { bigint: true }), component))
        ) {
          return false;
        }
      }
    } else {
      return false;
    }
    if (pending?.delete(pathKey(local))) {
      matchedPaths.set(local, kind);
    }
    return unchanged(before, await lstat(absolute, { bigint: true }));
  }

  try {
    for (const path of paths) {
      const stats = await statWorkspacePath(root, path, signal);
      const component = components === undefined ? undefined : createHash('sha256');
      if (stats === undefined || !(await visit(join(root, path), path, stats, component))) {
        return undefined;
      }
      if (component !== undefined) {
        components?.set(path, component.digest('hex'));
      }
    }
    signal.throwIfAborted();
    return pending?.size ? undefined : { digest: hash.digest('hex'), matchedPaths };
  } catch (error) {
    signal.throwIfAborted();
    if (isFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

export function isFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'syscall' in error;
}

export function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export async function statWorkspacePath(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<BigIntStats | undefined> {
  signal.throwIfAborted();
  let parent = root;
  const segments = path.split(sep);
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    if (!(await lstat(parent)).isDirectory()) {
      return undefined;
    }
    signal.throwIfAborted();
  }
  return lstat(join(root, path), { bigint: true });
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
