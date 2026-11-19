import type { BigIntStats } from 'node:fs';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** Hash declared relative paths without traversing symbolic links or special files. */
export async function fingerprintPaths(
  root: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const hash = createHash('sha256');

  async function visit(absolute: string, local: string, before: BigIntStats): Promise<boolean> {
    signal.throwIfAborted();
    const mode = Number(before.mode & 0o777n);
    if (before.isFile()) {
      const contents = createHash('sha256');
      for await (const chunk of createReadStream(absolute, { signal })) {
        contents.update(chunk);
      }
      hash.update(JSON.stringify(['file', local, mode, contents.digest('hex')]));
    } else if (before.isDirectory()) {
      hash.update(JSON.stringify(['directory', local, mode]));
      for (const name of (await readdir(absolute)).sort()) {
        const child = join(absolute, name);
        if (!(await visit(child, join(local, name), await lstat(child, { bigint: true })))) {
          return false;
        }
      }
    } else {
      return false;
    }
    return unchanged(before, await lstat(absolute, { bigint: true }));
  }

  try {
    for (const path of paths) {
      signal.throwIfAborted();
      const segments = path.split(sep);
      let parent = root;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        if (!(await lstat(parent)).isDirectory()) {
          return undefined;
        }
      }
      const absolute = join(parent, segments[segments.length - 1]);
      if (!(await visit(absolute, path, await lstat(absolute, { bigint: true })))) {
        return undefined;
      }
    }
    signal.throwIfAborted();
    return hash.digest('hex');
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
