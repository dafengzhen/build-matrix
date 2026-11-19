import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { JsonObject } from '../core/types.js';
import type { Adapter } from '../executor/types.js';

import { asNonemptyString, asRecord, checkKeys, copyJson } from '../core/validation.js';
import { runProcess } from './process.js';

export type ViteOptions = {
  readonly configFile?: string;
  readonly mode?: string;
  readonly outDir?: string;
  readonly root?: string;
  readonly viteConfig?: JsonObject;
};

const packageRequire = createRequire(import.meta.url);
const buildScript = fileURLToPath(import.meta.resolve('#vite-build'));

export function createViteAdapter(): Adapter<undefined | ViteOptions> {
  return {
    async run(context, input) {
      const options = input === undefined ? {} : asRecord(input, 'vite options');
      checkKeys(options, 'vite options', ['root', 'configFile', 'mode', 'outDir', 'viteConfig']);
      const { viteConfig, ...buildOptions } = options;
      const configPath = 'vite options.viteConfig';
      const inlineConfig = Object.hasOwn(options, 'viteConfig')
        ? copyJson(asRecord(viteConfig, configPath), configPath)
        : undefined;
      const { cwd } = context;
      const resolved: ViteOptions = Object.fromEntries(
        Object.entries(buildOptions).map(([key, value]) => {
          const option = asNonemptyString(value, `vite options.${key}`);
          return [key, key === 'mode' ? option : resolve(cwd, option)];
        }),
      );
      context.signal.throwIfAborted();
      const viteUrl = pathToFileURL(resolveVite(cwd)).href;
      await runProcess(
        context,
        process.execPath,
        [buildScript, viteUrl],
        JSON.stringify({ ...resolved, viteConfig: inlineConfig }),
      );
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
}

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

export default createViteAdapter();
