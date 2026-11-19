import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Adapter } from '../executor/types.js';

import { asNonemptyString, asRecord, checkKeys } from '../core/validation.js';
import { runProcess } from './process.js';

export type ViteOptions = {
  readonly configFile?: string;
  readonly mode?: string;
  readonly outDir?: string;
  readonly root?: string;
};

const packageRequire = createRequire(import.meta.url);
const buildScript = fileURLToPath(import.meta.resolve('#vite-build'));

function resolveVite(cwd: string): string {
  const projectRequire = createRequire(join(cwd, 'package.json'));
  try {
    return projectRequire.resolve('vite');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
  try {
    return packageRequire.resolve('vite');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    throw Object.assign(
      new Error('The Vite adapter requires Vite. Install vite in the project.', { cause: error }),
      {
        code: 'VITE_NOT_INSTALLED',
      },
    );
  }
}

const vite: Adapter<undefined | ViteOptions> = {
  async run(context, input) {
    const options = input === undefined ? {} : asRecord(input, 'vite options');
    checkKeys(options, 'vite options', ['root', 'configFile', 'mode', 'outDir']);
    const { cwd } = context;
    const resolved: ViteOptions = Object.fromEntries(
      Object.entries(options).map(([key, value]) => {
        const option = asNonemptyString(value, `vite options.${key}`);
        return [key, key === 'mode' ? option : resolve(cwd, option)];
      }),
    );
    context.signal.throwIfAborted();
    const viteUrl = pathToFileURL(resolveVite(cwd)).href;
    await runProcess(context, process.execPath, [buildScript, viteUrl, JSON.stringify(resolved)]);
    if (resolved.outDir !== undefined && typeof options.outDir === 'string') {
      const directory = await stat(resolved.outDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
      if (directory?.isDirectory()) {
        return { outputs: [{ kind: 'directory', path: options.outDir }] };
      }
    }
    return {};
  },
};

export default vite;
