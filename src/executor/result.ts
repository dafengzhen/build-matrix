import type { JsonObject } from '../core/types.js';
import type { AdapterOutput, TaskError } from './types.js';

import { asArray, asNonemptyString, asRecord, copyJson, invalid } from '../core/validation.js';

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
              const path = asNonemptyString(artifact.path, `${label}.path`);
              if (path.includes('\0')) {
                invalid(`${label}.path`, 'path contains a NUL character');
              }
              const kind =
                artifact.kind === undefined
                  ? undefined
                  : asNonemptyString(artifact.kind, `${label}.kind`);
              return kind === undefined ? { path } : { kind, path };
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
