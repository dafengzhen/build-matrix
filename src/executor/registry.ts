import type { CleanOptions } from '../adapters/clean.js';
import type { ShellOptions } from '../adapters/shell.js';
import type { ViteOptions } from '../adapters/vite.js';
import type { JsonValue } from '../core/types.js';
import type { Adapter, AdapterDefinition, AdapterFactory, AdapterLoader } from './types.js';

import { asNonemptyString, asRecord, checkKeys, copyJson, invalid } from '../core/validation.js';

export interface BuiltinAdapterDefaults {
  readonly clean?: Partial<CleanOptions>;
  readonly shell?: Partial<ShellOptions>;
  readonly vite?: ViteOptions;
}

interface Registration {
  readonly defaults?: JsonValue;
  readonly factory: AdapterFactory;
}

export class AdapterRegistry {
  readonly #loaded = new Map<string, Promise<Adapter>>();
  readonly #registrations = new Map<string, Registration>();

  getDefaults(id: string): JsonValue | undefined {
    return this.#registrations.get(id)?.defaults;
  }

  has(id: string): boolean {
    return this.#registrations.has(id);
  }

  async load(id: string): Promise<Adapter> {
    const existing = this.#loaded.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const registration = this.#registrations.get(id);
    if (registration === undefined) {
      invalid(`adapter "${id}"`, 'has not been registered');
    }
    const pending = Promise.resolve()
      .then(registration.factory)
      .then((adapter) => {
        if (typeof adapter?.run !== 'function') {
          throw new TypeError(`Adapter "${id}" must implement run()`);
        }
        return adapter;
      })
      .catch((error) => {
        this.#loaded.delete(id);
        throw error;
      });
    this.#loaded.set(id, pending);
    return pending;
  }

  register<Options = unknown>(
    id: string,
    entry: AdapterDefinition<Options> | AdapterLoader<Options>,
  ): this {
    asNonemptyString(id, 'adapter ID');
    const path = `adapter "${id}"`;
    const definition: Record<string, unknown> =
      typeof entry === 'function' ? { factory: factoryFromLoader(entry) } : asRecord(entry, path);
    checkKeys(definition, path, ['defaults', 'factory']);
    const { defaults, factory } = definition;
    if (typeof factory !== 'function') {
      invalid(`${path}.factory`, 'expected a factory function');
    }
    if (this.has(id)) {
      invalid(path, 'already registered');
    }
    this.#registrations.set(id, {
      defaults: defaults === undefined ? undefined : copyJson(defaults, `${path}.defaults`),
      factory: factory as AdapterFactory,
    });
    return this;
  }
}

export function createDefaultRegistry(defaults: BuiltinAdapterDefaults = {}): AdapterRegistry {
  return new AdapterRegistry()
    .register('shell', {
      defaults: defaults.shell,
      factory: async () => (await import('../adapters/shell.js')).createShellAdapter(),
    })
    .register('clean', {
      defaults: defaults.clean,
      factory: async () => (await import('../adapters/clean.js')).createCleanAdapter(),
    })
    .register('vite', {
      defaults: defaults.vite,
      factory: async () => (await import('../adapters/vite.js')).createViteAdapter(),
    });
}

function factoryFromLoader<Options>(loader: AdapterLoader<Options>): AdapterFactory<Options> {
  return async () => {
    const entry = await loader();
    return entry !== null && typeof entry === 'object' && 'default' in entry
      ? entry.default
      : entry;
  };
}
