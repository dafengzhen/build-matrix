import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  AdapterContext,
  Artifact,
  ArtifactContext,
  TaskContext,
  TaskResult,
} from './types.js';

import { isFileError, statWorkspacePath } from './fingerprint.js';
import { normalizeOutput } from './result.js';

export interface ArtifactOptions {
  /** Clean obsolete artifacts inside these workspace directories using the previous manifest. */
  readonly cleanup?: readonly string[];
  transform?(
    artifact: Artifact,
    context: AdapterContext,
    sourcePath?: string,
  ): Artifact | Promise<Artifact>;
  validate?(artifact: Artifact, context: AdapterContext, sourcePath?: string): Promise<void> | void;
}

export const stagingPrefix = '.build-matrix-stage-';

interface StagedArtifact {
  readonly artifact: Artifact;
  readonly backup: string;
  readonly destination: string;
  readonly source: string;
}

export class ArtifactClaims {
  readonly #claims = new Map<string, Set<string>>();

  claim(owner: string, paths: readonly string[]): void {
    if (paths.length === 0) {
      return;
    }
    const canonical = paths.map(physicalPath);
    for (const [previousOwner, claims] of this.#claims) {
      if (previousOwner === owner) {
        continue;
      }
      for (const [index, path] of canonical.entries()) {
        const conflict = [...claims].find((claimed) => pathsOverlap(path, claimed));
        if (conflict !== undefined) {
          throw Object.assign(
            new Error(
              `Output "${paths[index]}" of ${owner} overlaps "${conflict}" of ${previousOwner}`,
            ),
            {
              code: 'ARTIFACT_CONFLICT',
            },
          );
        }
      }
    }
    const own = this.#claims.get(owner) ?? new Set<string>();
    for (const path of canonical) {
      own.add(path);
    }
    this.#claims.set(owner, own);
  }
}

export function containsPath(parent: string, path: string): boolean {
  const local = relative(parent, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

export function createArtifactTransaction(
  { cwd, signal }: Pick<TaskContext, 'cwd' | 'signal'>,
  reserve: (paths: readonly string[]) => void,
  get: ArtifactContext['get'],
) {
  let committing = false;
  let directory: Promise<string> | undefined;
  let retainBackup = false;
  const pending: StagedArtifact[] = [];
  const registered: Artifact[] = [];
  function assertOpen() {
    if (committing) {
      throw new Error('Artifact registration is closed during publication');
    }
  }
  const api: ArtifactContext = {
    get,
    register(artifact) {
      assertOpen();
      registered.push(normalizeOutput({ outputs: [artifact] }).outputs![0]);
    },
    async reserve(path) {
      signal.throwIfAborted();
      reserve([resolve(cwd, path)]);
    },
    async stage(artifact) {
      assertOpen();
      signal.throwIfAborted();
      const entry = normalizeOutput({ outputs: [artifact] }).outputs![0];
      const destination = workspaceDestination(cwd, entry.path);
      const root = await (directory ??= mkdtemp(join(cwd, stagingPrefix)));
      assertOpen();
      if (
        containsPath(root, destination) ||
        pending.some((item) => pathsOverlap(item.destination, destination))
      ) {
        throw new Error(`Invalid staging destination "${entry.path}"`);
      }
      reserve([destination]);
      const slot = pending.length;
      const source = join(root, `output-${slot}`, 'data');
      pending.push({ artifact: entry, backup: join(root, `backup-${slot}`), destination, source });
      await mkdir(dirname(source));
      return source;
    },
    async validate(artifact) {
      return validateArtifact(cwd, signal, artifact);
    },
  };

  return {
    api,
    async commit(transform?: (artifact: Artifact, source: string) => Artifact | Promise<Artifact>) {
      assertOpen();
      committing = true;
      const outputs: Artifact[] = [];
      for (const { artifact, source } of pending) {
        const info = await lstat(source);
        if (info.isSymbolicLink()) {
          throw new Error(`Staged artifact "${artifact.path}" is a symbolic link`);
        }
        const mapped = (await transform?.(artifact, source)) ?? artifact;
        if (relative(resolve(cwd, mapped.path), resolve(cwd, artifact.path)) !== '') {
          throw new Error('The destination of a staged artifact is fixed when it is staged');
        }
        if ((await lstat(source)).isSymbolicLink()) {
          throw new Error(`Staged artifact "${artifact.path}" is a symbolic link`);
        }
        const validated = await validateArtifact(cwd, signal, { ...mapped, path: source });
        outputs.push({ ...validated, path: mapped.path });
      }
      const installed: StagedArtifact[] = [];
      const backedUp: StagedArtifact[] = [];
      try {
        for (const entry of pending) {
          signal.throwIfAborted();
          await makeSafeParents(cwd, dirname(entry.destination));
          const existing = await lstat(entry.destination).catch((error) => {
            if (isFileError(error) && error.code === 'ENOENT') {
              return undefined;
            }
            throw error;
          });
          if (existing !== undefined) {
            await rename(entry.destination, entry.backup);
            backedUp.push(entry);
          }
          await rename(entry.source, entry.destination);
          installed.push(entry);
        }
        signal.throwIfAborted();
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const entry of installed.reverse()) {
          await rename(entry.destination, entry.source).catch((failure) =>
            rollbackErrors.push(failure),
          );
        }
        for (const entry of backedUp.reverse()) {
          await rename(entry.backup, entry.destination).catch((failure) =>
            rollbackErrors.push(failure),
          );
        }
        if (rollbackErrors.length > 0) {
          retainBackup = true;
          throw new AggregateError(
            [error, ...rollbackErrors],
            `Artifact rollback failed. Backups are in ${await directory}`,
          );
        }
        throw error;
      }
      return outputs;
    },
    async dispose() {
      const root = await directory?.catch(() => undefined);
      if (root !== undefined && !retainBackup) {
        await rm(root, { force: true, recursive: true });
      }
    },
    get registered(): readonly Artifact[] {
      return registered;
    },
    get staged(): readonly Artifact[] {
      return pending.map(({ artifact }) => artifact);
    },
  };
}

export function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

export function physicalPath(path: string): string {
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      return join(realpathSync.native(cursor), ...missing.reverse());
    } catch (error) {
      const parent = dirname(cursor);
      if (
        parent === cursor ||
        !isFileError(error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      ) {
        return path;
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function reconcileArtifacts(
  cwd: string,
  manifest: string,
  roots: readonly string[],
  tasks: readonly TaskResult[],
  signal: AbortSignal,
): Promise<void> {
  const previous: unknown = await readFile(manifest, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
  if (!isManifest(previous)) {
    return;
  }
  const boundaries = roots.map((path) => workspaceDestination(cwd, path));
  const retained = tasks.flatMap(({ outputs }) =>
    (outputs ?? []).map(({ path }) => resolve(cwd, path)),
  );
  const obsolete = new Map<string, Artifact>();
  for (const stage of previous.stages) {
    for (const task of stage.tasks) {
      if (
        task.status !== 'success' &&
        task.status !== 'cached' &&
        task.skipReason !== 'unchanged'
      ) {
        continue;
      }
      for (const artifact of normalizeOutput(task).outputs ?? []) {
        const destination = resolve(cwd, artifact.path);
        if (
          relative(destination, manifest) !== '' &&
          boundaries.some((root) => containsPath(root, destination)) &&
          !retained.some((path) => containsPath(path, destination))
        ) {
          obsolete.set(destination, artifact);
        }
      }
    }
  }
  for (const [path, artifact] of [...obsolete].sort(([a], [b]) => b.length - a.length)) {
    signal.throwIfAborted();
    try {
      const info = await statWorkspacePath(cwd, relative(cwd, path), signal);
      if (info?.isFile() && (artifact.kind === 'file' || artifact.kind === undefined)) {
        if (artifact.sha256 !== undefined || artifact.sizeBytes !== undefined) {
          await validateArtifact(cwd, signal, artifact);
        }
        await rm(path);
      } else if (
        info?.isDirectory() &&
        artifact.kind === 'directory' &&
        !retained.some((entry) => containsPath(path, entry)) &&
        !containsPath(path, manifest)
      ) {
        await rm(path, { recursive: true });
      }
    } catch (error) {
      if (
        !(isFileError(error) && ['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(error.code ?? '')) &&
        !(error instanceof Error && 'code' in error && error.code === 'ARTIFACT_INVALID')
      ) {
        throw error;
      }
    }
  }
}

export async function validateArtifact(
  cwd: string,
  signal: AbortSignal,
  input: Artifact,
): Promise<Artifact> {
  const artifact = normalizeOutput({ outputs: [input] }).outputs![0];
  signal.throwIfAborted();
  const absolute = resolve(cwd, artifact.path);
  const info = await stat(absolute).catch((error) => {
    if (isFileError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return undefined;
    }
    throw error;
  });
  const kind = info?.isFile() ? 'file' : info?.isDirectory() ? 'directory' : undefined;
  const invalid = (reason: string) =>
    Object.assign(new Error(`Artifact "${artifact.path}" ${reason}`), {
      code: 'ARTIFACT_INVALID',
    });
  if (kind === undefined || (artifact.kind !== undefined && artifact.kind !== kind)) {
    throw invalid('has an unexpected file type');
  }
  if (artifact.sizeBytes !== undefined && (kind !== 'file' || info?.size !== artifact.sizeBytes)) {
    throw invalid('has an unexpected size');
  }
  if (artifact.sha256 !== undefined) {
    if (kind !== 'file') {
      throw invalid('must be a file to verify its digest');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute, { signal })) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== artifact.sha256) {
      throw invalid('has an unexpected SHA-256 digest');
    }
  }
  return { ...artifact, kind };
}

function isManifest(value: unknown): value is { stages: { tasks: TaskResult[] }[] } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    value.status !== 'success' ||
    !('schemaVersion' in value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !('stages' in value) ||
    !Array.isArray(value.stages)
  ) {
    return false;
  }
  return value.stages.every((stage) => Array.isArray(stage?.tasks));
}

async function makeSafeParents(cwd: string, destination: string) {
  let parent = cwd;
  const local = relative(cwd, destination);
  for (const segment of local === '' ? [] : local.split(sep)) {
    parent = join(parent, segment);
    try {
      await mkdir(parent);
    } catch (error) {
      if (!isFileError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
    if (!(await lstat(parent)).isDirectory()) {
      throw new Error(`Artifact destination traverses a non-directory "${parent}"`);
    }
  }
}

function workspaceDestination(cwd: string, path: string): string {
  const destination = resolve(cwd, path);
  if (relative(cwd, destination) === '' || !containsPath(cwd, destination)) {
    throw new Error(`Artifact destination "${path}" must be inside cwd`);
  }
  if (
    process.platform === 'win32' &&
    relative(cwd, destination)
      .split(sep)
      .some(
        (segment) =>
          /:|[ .]$/.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      )
  ) {
    throw new Error(`Invalid Windows artifact destination "${path}"`);
  }
  return destination;
}
