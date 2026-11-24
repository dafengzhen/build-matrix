import type { CleanOptions } from '../adapters/clean.js';
import type { ShellOptions } from '../adapters/shell.js';
import type { ViteAdapterOptions, ViteOptions } from '../adapters/vite.js';
import type { JsonValue } from '../core/types.js';
import type {
  Adapter,
  AdapterContext,
  AdapterDefinition,
  AdapterFactory,
  AdapterLoader,
  AdapterMiddleware,
  AdapterPlugin,
  InvocationAdapterFactory,
} from './types.js';

import { asNonemptyString, asRecord, checkKeys, copyJson, invalid } from '../core/validation.js';

export interface BuiltinAdapterDefaults {
  readonly clean?: Partial<CleanOptions>;
  readonly shell?: Partial<ShellOptions>;
  readonly vite?: ViteOptions;
}

interface Registration {
  readonly defaults?: JsonValue;
  readonly factory: InvocationAdapterFactory;
  readonly mergeDefaults?: false;
  readonly prepare?: true;
  readonly scope?: 'invocation';
}

export class AdapterRegistry {
  readonly #loaded = new Map<string, Promise<Adapter>>();
  readonly #middleware: AdapterMiddleware[] = [];
  readonly #registrations = new Map<string, Registration>();

  async dispose(): Promise<void> {
    const pending = [...this.#loaded.values()];
    this.#loaded.clear();
    const settled = await Promise.allSettled(
      pending.map(async (entry) => (await entry).dispose?.()),
    );
    const errors = settled.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason] : []));
    if (errors.length) {
      throw new AggregateError(errors, 'Adapter disposal failed');
    }
  }

  getDefaults(id: string): JsonValue | undefined {
    return this.#registrations.get(id)?.defaults;
  }

  has(id: string): boolean {
    return this.#registrations.has(id);
  }

  invocationScoped(id: string): boolean {
    return this.#registrations.get(id)?.scope === 'invocation';
  }

  async load(id: string, context?: AdapterContext): Promise<Adapter> {
    const existing = this.#loaded.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const registration = this.#registrations.get(id);
    if (registration === undefined) {
      invalid(`adapter "${id}"`, 'has not been registered');
    }
    const check = (adapter: Adapter) => {
      if (typeof adapter?.run !== 'function' && typeof adapter?.prepare !== 'function') {
        throw new TypeError(`Adapter "${id}" must implement run() or prepare()`);
      }
      return adapter;
    };
    if (registration.scope === 'invocation') {
      if (context === undefined) {
        throw new TypeError(`Adapter "${id}" requires an invocation context`);
      }
      return check(await registration.factory(context));
    }
    const pending = Promise.resolve()
      .then(registration.factory as AdapterFactory)
      .then(check)
      .catch((error) => {
        if (this.#loaded.get(id) === pending) {
          this.#loaded.delete(id);
        }
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

  middleware(): readonly AdapterMiddleware[] {
    return [...this.#middleware];
  }

  prepares(id: string): boolean {
    return this.invocationScoped(id) || this.#registrations.get(id)?.prepare === true;
  }

  register<Options = unknown>(id: string, entry: AdapterDefinition<Options, undefined>): this;
  register<Options = unknown>(id: string, entry: AdapterDefinition<Options, 'invocation'>): this;
  register<Options = unknown>(id: string, entry: AdapterLoader<Options>): this;
  register<Options = unknown>(
    id: string,
    entry: AdapterDefinition<Options> | AdapterLoader<Options>,
  ): this;
  register<Options = unknown>(
    id: string,
    entry: AdapterDefinition<Options> | AdapterLoader<Options>,
  ): this {
    asNonemptyString(id, 'adapter ID');
    const path = `adapter "${id}"`;
    const definition: Record<string, unknown> =
      typeof entry === 'function' ? { factory: factoryFromLoader(entry) } : asRecord(entry, path);
    checkKeys(definition, path, ['defaults', 'factory', 'mergeDefaults', 'prepare', 'scope']);
    const { defaults, factory, mergeDefaults, prepare, scope } = definition;
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
    if (scope !== undefined && scope !== 'invocation') {
      invalid(`${path}.scope`, 'expected "invocation"');
    }
    this.#registrations.set(id, {
      defaults: defaults === undefined ? undefined : copyJson(defaults, `${path}.defaults`),
      factory: factory as InvocationAdapterFactory,
      mergeDefaults,
      prepare,
      scope,
    });
    return this;
  }

  use(plugin: AdapterMiddleware | AdapterPlugin): this {
    if (typeof plugin === 'function') {
      this.#middleware.push(plugin);
    } else {
      plugin.setup?.(this);
      this.#middleware.push(...(plugin.middleware ?? []));
    }
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
