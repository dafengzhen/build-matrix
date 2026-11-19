import type { HookFailure, LifecycleHooks } from './types.js';

import { normalizeError } from './result.js';

export function createLifecycle(hooks?: LifecycleHooks) {
  const errors: HookFailure[] = [];

  async function emit<E extends keyof LifecycleHooks>(
    event: E,
    payload: Parameters<NonNullable<LifecycleHooks[E]>>[0],
    identity: Pick<HookFailure, 'stageId' | 'taskId' | 'variantId'> = {},
  ): Promise<void> {
    try {
      const hook = hooks?.[event] as
        | ((snapshot: typeof payload) => Promise<void> | void)
        | undefined;
      if (hook !== undefined) {
        await hook.call(hooks, structuredClone(payload));
      }
    } catch (error) {
      const { stageId, taskId, variantId } = identity;
      errors.push({
        hook: event,
        ...(stageId === undefined ? {} : { stageId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(variantId === undefined ? {} : { variantId }),
        error: normalizeError(error),
      });
    }
  }

  return { emit, errors };
}
