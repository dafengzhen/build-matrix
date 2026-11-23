import type { CleanOptions } from '../adapters/clean.js';
import type { ShellOptions } from '../adapters/shell.js';
import type { ViteAdapterOptions, ViteOptions } from '../adapters/vite.js';
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
  readonly mergeDefaults?: false;
  readonly prepare?: true;
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

  mergeTaskOptions(id: string, options: JsonValue | undefined): JsonValue | undefined {
    const entry = this.#registrations.get(id);
    const defaults = entry?.mergeDefaults === false ? undefined : entry?.defaults;
    if (
      typeof defaults === 'object' &&
      defaults !== null &&
      !Array.isArray(defaults) &&
      typeof options === 'object' &&
      options !== null &&
      !Array.isArray(options)
    ) {
      return { ...defaults, ...options };
    }
    return options === undefined ? defaults : options;
  }

  prepares(id: string): boolean {
    return this.#registrations.get(id)?.prepare === true;
  }

  register<Options = unknown>(
    id: string,
    entry: AdapterDefinition<Options> | AdapterLoader<Options>,
  ): this {
    asNonemptyString(id, 'adapter ID');
    const path = `adapter "${id}"`;
    const definition: Record<string, unknown> =
      typeof entry === 'function' ? { factory: factoryFromLoader(entry) } : asRecord(entry, path);
    checkKeys(definition, path, ['defaults', 'factory', 'mergeDefaults', 'prepare']);
    const { defaults, factory, mergeDefaults, prepare } = definition;
    if (typeof factory !== 'function') {
      invalid(`${path}.factory`, 'expected a factory function');
    }
    if (this.has(id)) {
      invalid(path, 'already registered');
    }
    if (prepare !== undefined && prepare !== true) {
      invalid(`${path}.prepare`, 'expected true');
    }
    if (mergeDefaults !== undefined && mergeDefaults !== false) {
      invalid(`${path}.mergeDefaults`, 'expected false');
    }
    this.#registrations.set(id, {
      defaults: defaults === undefined ? undefined : copyJson(defaults, `${path}.defaults`),
      factory: factory as AdapterFactory,
      mergeDefaults,
      prepare,
    });
    return this;
  }
}

export function createDefaultRegistry(
  defaults: BuiltinAdapterDefaults = {},
  extensions: { readonly vite?: Omit<ViteAdapterOptions, 'defaults'> } = {},
): AdapterRegistry {
  const viteDefaults =
    defaults.vite === undefined
      ? undefined
      : (copyJson(defaults.vite, 'adapter "vite".defaults') as ViteOptions);
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
      defaults: viteDefaults as JsonValue | undefined,
      factory: async () =>
        (await import('../adapters/vite.js')).createViteAdapter({
          ...extensions.vite,
          defaults: viteDefaults,
        }),
      mergeDefaults: false,
      prepare: true,
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
