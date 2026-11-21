import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { JsonObject } from '../core/types.js';
import type { Adapter, TaskContext } from '../executor/types.js';

import {
  asArray,
  asNonemptyString,
  asRecord,
  checkKeys,
  copyJson,
  invalid,
} from '../core/validation.js';
import { coversOutputPath } from '../executor/cache.js';
import { runProcess } from './process.js';

export type ViteBuildReport =
  | { readonly environments: readonly string[]; readonly outputs: readonly ViteOutput[] }
  | { readonly error: string };

export type ViteOptions = {
  readonly configFile?: string;
  readonly environments?: readonly string[] | string;
  readonly mode?: string;
  readonly outDir?: string;
  readonly outputs?: readonly ViteOutput[];
  readonly root?: string;
  readonly viteConfig?: JsonObject;
};

export type ViteOutput = {
  readonly environment?: string;
  readonly kind?: 'directory' | 'file';
  readonly path: string;
};

const packageRequire = createRequire(import.meta.url);
const buildScript = fileURLToPath(import.meta.resolve('#vite-build'));

export function createViteAdapter(): Adapter<undefined | ViteOptions> {
  return {
    async run(context, input) {
      const options = input === undefined ? {} : asRecord(input, 'vite options');
      checkKeys(options, 'vite options', [
        'configFile',
        'environments',
        'mode',
        'outDir',
        'outputs',
        'root',
        'viteConfig',
      ]);
      const { environments, outputs, viteConfig, ...buildOptions } = options;
      const configPath = 'vite options.viteConfig';
      const inlineConfig = Object.hasOwn(options, 'viteConfig')
        ? (copyJson(asRecord(viteConfig, configPath), configPath) as JsonObject)
        : undefined;
      const selection = Object.hasOwn(options, 'environments')
        ? readEnvironments(environments)
        : undefined;
      const declared = Object.hasOwn(options, 'outputs') ? readOutputs(outputs) : undefined;
      const { cwd, signal } = context;
      const resolved: ViteOptions = Object.fromEntries(
        Object.entries(buildOptions).map(([key, value]) => {
          const option =
            key === 'mode'
              ? asNonemptyString(value, 'vite options.mode')
              : resolve(cwd, readPath(value, `vite options.${key}`));
          return [key, option];
        }),
      );
      const inlineRoot = inlineConfig?.root;
      const root =
        resolved.root ?? (typeof inlineRoot === 'string' ? resolve(cwd, inlineRoot) : cwd);
      signal.throwIfAborted();
      const viteUrl = pathToFileURL(resolveVite(root, cwd)).href;
      await using directory = await mkdtempDisposable(join(tmpdir(), 'build-matrix-vite-'));
      const reportPath = join(directory.path, 'report.json');
      await runProcess(
        context,
        process.execPath,
        [buildScript, viteUrl, reportPath],
        JSON.stringify({
          ...resolved,
          environments: selection,
          outputs: declared,
          viteConfig: inlineConfig,
        }),
      );
      const report = JSON.parse(
        await readFile(reportPath, { encoding: 'utf8', signal }),
      ) as ViteBuildReport;
      if ('error' in report) {
        throw Object.assign(new Error(report.error), { code: 'VITE_UNKNOWN_ENVIRONMENT' });
      }
      const built = new Set(report.environments);
      const legacyOutDir = selection === undefined && built.size === 1 ? options.outDir : undefined;
      const candidates =
        declared?.filter(
          ({ environment }) => environment === undefined || built.has(environment),
        ) ??
        report.outputs.map(({ environment, kind, path }) => {
          if (
            typeof legacyOutDir === 'string' &&
            resolved.outDir !== undefined &&
            relative(resolved.outDir, path) === ''
          ) {
            return { kind, path: legacyOutDir };
          }
          return { environment, kind, path: (relative(cwd, path) || '.').split(sep).join('/') };
        });
      return { outputs: await collectOutputs(context, candidates, declared !== undefined) };
    },
  };
}

async function collectOutputs(
  { cacheOutputs, cwd, signal }: TaskContext,
  candidates: readonly ViteOutput[],
  declared: boolean,
): Promise<ViteOutput[]> {
  const outputs: ViteOutput[] = [];
  for (const { environment, kind: expectedKind, path } of candidates) {
    signal.throwIfAborted();
    const absolute = resolve(cwd, path);
    // A Vite plugin can remove or move files after the write hook has run.
    const info = await stat(absolute, { throwIfNoEntry: false }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOTDIR') {
          return undefined;
        }
        throw error;
      },
    );
    const kind = info?.isDirectory() ? 'directory' : info?.isFile() ? 'file' : undefined;
    const label = `Vite output "${path}"${environment === undefined ? '' : ` for environment "${environment}"`}`;
    if (kind === undefined || (expectedKind !== undefined && expectedKind !== kind)) {
      if (declared) {
        const expected = expectedKind === undefined ? 'a file or directory' : `a ${expectedKind}`;
        throw Object.assign(
          new Error(`${label} expected ${expected}, found ${kind ?? 'no file or directory'}`),
          {
            code: 'VITE_INVALID_OUTPUT',
          },
        );
      }
      continue;
    }
    if (
      declared &&
      cacheOutputs !== undefined &&
      !coversOutputPath(cacheOutputs, relative(cwd, absolute))
    ) {
      throw Object.assign(new Error(`${label} is not covered by cache.outputs`), {
        code: 'VITE_CACHE_OUTPUT_MISMATCH',
      });
    }
    outputs.push({ ...(environment === undefined ? {} : { environment }), kind, path });
  }
  signal.throwIfAborted();
  return outputs;
}

function readEnvironments(value: unknown): 'all' | readonly string[] {
  const label = 'vite options.environments';
  if (value === 'all') {
    return value;
  }
  if (typeof value === 'string') {
    return [asNonemptyString(value, label)];
  }
  const names = asArray(value, label).map((name, index) =>
    asNonemptyString(name, `${label}[${index}]`),
  );
  if (names.length === 0) {
    invalid(label, 'expected at least one environment name');
  }
  return [...new Set(names)];
}

function readOutputs(value: unknown): readonly ViteOutput[] {
  const label = 'vite options.outputs';
  return asArray(value, label).map((item, index) => {
    const field = `${label}[${index}]`;
    const entry = asRecord(item, field);
    checkKeys(entry, field, ['environment', 'kind', 'path']);
    const { environment, kind, path } = entry;
    if (kind !== undefined && kind !== 'file' && kind !== 'directory') {
      invalid(`${field}.kind`, 'expected "file" or "directory"');
    }
    return {
      environment: Object.hasOwn(entry, 'environment')
        ? asNonemptyString(environment, `${field}.environment`)
        : undefined,
      kind,
      path: readPath(path, `${field}.path`),
    };
  });
}

function readPath(value: unknown, label: string): string {
  const path = asNonemptyString(value, label);
  if (path.includes('\0')) {
    invalid(label, 'path contains a NUL character');
  }
  return path;
}

function resolveVite(root: string, cwd: string): string {
  const directories = root === cwd ? [root] : [root, cwd];
  const resolvers = directories.map((directory) => createRequire(join(directory, 'package.json')));
  let missing: unknown;
  for (const resolver of [...resolvers, packageRequire]) {
    try {
      return resolver.resolve('vite');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
      missing = error;
    }
  }
  throw Object.assign(
    new Error('The Vite adapter requires Vite. Install vite in the project.', { cause: missing }),
    { code: 'VITE_NOT_INSTALLED' },
  );
}

export default createViteAdapter();
