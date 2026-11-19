import type { Adapter, AdapterLoader } from './types.js';

import { asNonemptyString, invalid } from '../core/validation.js';

export class AdapterRegistry {
  readonly #loaded = new Map<string, Promise<Adapter>>();
  readonly #loaders = new Map<string, AdapterLoader>();

  has(id: string): boolean {
    return this.#loaders.has(id);
  }

  async load(id: string): Promise<Adapter> {
    const existing = this.#loaded.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const loader = this.#loaders.get(id);
    if (loader === undefined) {
      invalid(`adapter "${id}"`, 'has not been registered');
    }
    const pending = Promise.resolve()
      .then(loader)
      .then((module) => {
        const adapter =
          module !== null && typeof module === 'object' && 'default' in module
            ? module.default
            : module;
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

  register<Options = unknown>(id: string, loader: AdapterLoader<Options>): this {
    asNonemptyString(id, 'adapter ID');
    if (typeof loader !== 'function') {
      invalid(`adapter "${id}"`, 'expected a loader function');
    }
    if (this.has(id)) {
      invalid(`adapter "${id}"`, 'already registered');
    }
    this.#loaders.set(id, loader as AdapterLoader);
    return this;
  }
}

export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register('shell', () => import('../adapters/shell.js'))
    .register('clean', () => import('../adapters/clean.js'))
    .register('vite', () => import('../adapters/vite.js'));
}
