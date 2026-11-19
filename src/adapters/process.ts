import type { SpawnOptions } from 'node:child_process';

import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';

import type { TaskContext } from '../executor/types.js';

export async function runProcess(
  context: TaskContext,
  command: string,
  args: readonly string[],
  input?: string,
): Promise<void> {
  context.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const options = {
      cwd: context.cwd,
      killSignal: 'SIGKILL',
      signal: context.signal,
      windowsHide: true,
    } satisfies SpawnOptions;
    const child =
      input === undefined
        ? spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure: { error: unknown } | undefined;
    const discardOutput = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abortListener = addAbortListener(context.signal, discardOutput);

    function forward(stream: typeof child.stdout, log: 'error' | 'info') {
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        if (failure !== undefined) {
          return;
        }
        try {
          context.logger[log](chunk);
        } catch (error) {
          failure = { error };
          child.kill('SIGKILL');
          discardOutput();
        }
      });
      stream.on('error', (error) => {
        failure ??= { error };
      });
    }

    forward(child.stdout, 'info');
    forward(child.stderr, 'error');
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        failure ??= { error };
      }
    });
    child.on('error', (error) => {
      failure ??= { error };
    });
    child.once('close', (code, signal) => {
      abortListener[Symbol.dispose]();
      if (failure !== undefined) {
        reject(failure.error);
      } else if (code === 0) {
        resolve();
      } else {
        const reason = signal === null ? `exited with code ${code}` : `was terminated by ${signal}`;
        reject(Object.assign(new Error(`"${command}" ${reason}`), { code: 'PROCESS_FAILED' }));
      }
    });
    child.stdin?.end(input);
  });
}
