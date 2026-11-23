import type { JsonObject } from '../core/types.js';
import type { AdapterOutput, TaskError, TaskStatus } from './types.js';

import { asArray, asNonemptyString, asPath, asRecord, copyJson } from '../core/validation.js';

export function createTaskCounts(): Record<TaskStatus, number> {
  return { cached: 0, cancelled: 0, failed: 0, skipped: 0, success: 0 };
}

export function normalizeError(error: unknown): TaskError {
  try {
    if (error instanceof Error) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      const stack = typeof error.stack === 'string' ? error.stack : undefined;
      return {
        message: String(error.message),
        name: String(error.name),
        ...(code === undefined ? {} : { code }),
        ...(stack === undefined ? {} : { stack }),
      };
    }
    return { message: String(error), name: 'Error' };
  } catch {
    return { message: 'Adapter threw an unprintable value', name: 'Error' };
  }
}

export function normalizeOutput(output: unknown): AdapterOutput {
  try {
    const data = asRecord(output, 'adapter output');
    const { metadata, outputs } = data;
    return {
      ...(outputs === undefined
        ? {}
        : {
            outputs: asArray(outputs, 'outputs').map((item, index) => {
              const label = `outputs[${index}]`;
              const artifact = asRecord(item, label);
              const path = asPath(artifact.path, `${label}.path`);
              const kind =
                artifact.kind === undefined
                  ? undefined
                  : asNonemptyString(artifact.kind, `${label}.kind`);
              const environment =
                artifact.environment === undefined
                  ? undefined
                  : asNonemptyString(artifact.environment, `${label}.environment`);
              const { sha256, sizeBytes } = artifact;
              if (
                sha256 !== undefined &&
                (typeof sha256 !== 'string' || !/^[\da-f]{64}$/.test(sha256))
              ) {
                throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest`);
              }
              if (
                sizeBytes !== undefined &&
                (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
              ) {
                throw new TypeError(`${label}.sizeBytes must be a nonnegative safe integer`);
              }
              return {
                ...(environment === undefined ? {} : { environment }),
                ...(kind === undefined ? {} : { kind }),
                path,
                ...(sha256 === undefined ? {} : { sha256 }),
                ...(sizeBytes === undefined ? {} : { sizeBytes }),
              };
            }),
          }),
      ...(metadata === undefined
        ? {}
        : {
            metadata: copyJson(asRecord(metadata, 'metadata'), 'metadata') as JsonObject,
          }),
    };
  } catch (error) {
    throw new TypeError(`Invalid adapter result: ${(error as Error).message}`, { cause: error });
  }
}
