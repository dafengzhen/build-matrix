import type { BigIntStats } from 'node:fs';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

export type PathKind = 'directory' | 'file';

interface PathFingerprint {
  readonly digest: string;
  readonly matchedPaths: ReadonlyMap<string, PathKind>;
}

/** Hash declared relative paths without traversing symbolic links or special files. */
export async function fingerprintPaths(
  root: string,
  paths: readonly string[],
  signal: AbortSignal,
  requiredPaths?: readonly string[],
): Promise<PathFingerprint | undefined> {
  const hash = createHash('sha256');
  const pending = requiredPaths === undefined ? undefined : new Set(requiredPaths);
  const matchedPaths = new Map<string, PathKind>();

  async function visit(absolute: string, local: string, before: BigIntStats): Promise<boolean> {
    signal.throwIfAborted();
    const mode = Number(before.mode & 0o777n);
    let kind: PathKind;
    if (before.isFile()) {
      kind = 'file';
      const contents = createHash('sha256');
      for await (const chunk of createReadStream(absolute, { signal })) {
        contents.update(chunk);
      }
      hash.update(JSON.stringify([kind, local, mode, contents.digest('hex')]));
    } else if (before.isDirectory()) {
      kind = 'directory';
      hash.update(JSON.stringify([kind, local, mode]));
      for (const name of (await readdir(absolute)).sort()) {
        const child = join(absolute, name);
        if (!(await visit(child, join(local, name), await lstat(child, { bigint: true })))) {
          return false;
        }
      }
    } else {
      return false;
    }
    if (pending?.delete(local)) {
      matchedPaths.set(local, kind);
    }
    return unchanged(before, await lstat(absolute, { bigint: true }));
  }

  try {
    for (const path of paths) {
      const stats = await statWorkspacePath(root, path, signal);
      if (stats === undefined || !(await visit(join(root, path), path, stats))) {
        return undefined;
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
