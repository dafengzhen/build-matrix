import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

import type { Adapter } from '../executor/types.js';

import { asNonemptyString, asRecord, checkKeys, invalid } from '../core/validation.js';

export type CleanOptions = {
  readonly path: string;
};

export function createCleanAdapter(): Adapter<CleanOptions> {
  return {
    async run(context, input) {
      const options = asRecord(input, 'clean options');
      checkKeys(options, 'clean options', ['path']);
      const path = asNonemptyString(options.path, 'clean options.path');
      if (parse(path).root !== '') {
        invalid('clean options.path', 'expected a relative path');
      }

      context.signal.throwIfAborted();
      const root = await realpath(context.cwd);
      const target = resolve(root, path);
      if (!isDescendant(root, target)) {
        invalid('clean options.path', 'expected a path inside cwd');
      }
      const segments = relative(root, target).split(sep);
      if (process.platform === 'win32' && segments.some((segment) => /[:]|[ .]$/.test(segment))) {
        invalid('clean options.path', 'invalid Windows path segment');
      }

      try {
        let current = root;
        for (const segment of segments) {
          context.signal.throwIfAborted();
          current = resolve(current, segment);
          if ((await lstat(current)).isSymbolicLink()) {
            invalid('clean options.path', 'symbolic links and junctions cannot be traversed');
          }
        }
        if (!isDescendant(root, await realpath(target))) {
          invalid('clean options.path', 'expected a path inside cwd');
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { metadata: { removed: false } };
        }
        throw error;
      }
      context.signal.throwIfAborted();
      await rm(target, { force: true, recursive: true });
      return { metadata: { removed: true } };
    },
  };
}

function isDescendant(parent: string, child: string): boolean {
  const local = relative(parent, child);
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

export default createCleanAdapter();
