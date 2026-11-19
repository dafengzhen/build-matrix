import type { JsonValue, ResourceLimits } from './types.js';

export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

export function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(path, 'expected an array');
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    invalid(path, 'array must be dense and contain only indexed values');
  }
  for (let index = 0; index < value.length; index++) {
    if (!hasEnumerableDataProperty(value, index)) {
      invalid(`${path}[${index}]`, 'expected an array element');
    }
  }
  return value;
}

export function asNonemptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(path, 'expected a non-empty string');
  }
  return value;
}

export function asPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(path, 'expected a positive safe integer');
  }
  return value;
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    invalid(path, 'expected a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    invalid(path, 'expected a plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !hasEnumerableDataProperty(value, key)) {
      invalid(path, 'object must contain only enumerable string-keyed data properties');
    }
  }
  return value as Record<string, unknown>;
}

export function asResourceGroup(value: unknown, path: string): string {
  const group = asNonemptyString(value, path);
  if (!/^[A-Za-z_][\w-]*$/.test(group)) {
    invalid(path, 'invalid resource group name');
  }
  return group;
}

export function asResourceLimits(value: unknown, path: string): ResourceLimits {
  const limits = asRecord(value, path);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(limits).map(([name, value]) => {
        const field = `${path}.${name}`;
        return [asResourceGroup(name, field), asPositiveInteger(value, field)];
      }),
    ),
  );
}

export function checkKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      invalid(`${path}.${key}`, 'unknown field');
    }
  }
}

export function copyJson(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'object') {
    invalid(path, 'expected a JSON value');
  }
  if (ancestors.has(value)) {
    invalid(path, 'circular reference');
  }
  ancestors.add(value);

  const copy = Array.isArray(value)
    ? asArray(value, path).map((item, index) => copyJson(item, `${path}[${index}]`, ancestors))
    : Object.fromEntries(
        Object.entries(asRecord(value, path)).map(([key, item]) => [
          key,
          copyJson(item, `${path}.${key}`, ancestors),
        ]),
      );
  ancestors.delete(value);
  return Object.freeze(copy);
}

export function invalid(path: string, message: string): never {
  throw new ConfigurationError(`${path}: ${message}`);
}

function hasEnumerableDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && 'value' in descriptor;
}
