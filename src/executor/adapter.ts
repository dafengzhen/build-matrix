import type { JsonValue } from '../core/types.js';
import type {
  Adapter,
  AdapterContext,
  AdapterMiddleware,
  AdapterOutput,
  AdapterStep,
} from './types.js';

export function composeAdapter<Options = JsonValue | undefined>(
  steps:
    | ((
        context: AdapterContext,
        options: Options,
      ) => Promise<readonly AdapterStep[]> | readonly AdapterStep[])
    | readonly AdapterStep[],
): Adapter<Options> {
  return {
    async prepare(context, options) {
      return { steps: typeof steps === 'function' ? await steps(context, options) : steps };
    },
  };
}

export function retryAdapter(
  attempts: number,
  shouldRetry: (error: unknown) => boolean = () => true,
): AdapterMiddleware {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('Adapter retry attempts must be a positive safe integer');
  }
  return async ({ context }, next) => {
    let remaining = attempts;
    while (true) {
      context.signal.throwIfAborted();
      try {
        return await next();
      } catch (error) {
        if (--remaining === 0 || context.signal.aborted || !shouldRetry(error)) {
          throw error;
        }
      }
    }
  };
}

export function runMiddleware(
  middleware: readonly AdapterMiddleware[],
  context: AdapterContext,
  options: JsonValue | undefined,
  run: () => Promise<AdapterOutput>,
): Promise<AdapterOutput> {
  return middleware.reduceRight<() => Promise<AdapterOutput>>(
    (next, wrap) => async () => {
      context.signal.throwIfAborted();
      return wrap({ context, options }, next);
    },
    run,
  )();
}
