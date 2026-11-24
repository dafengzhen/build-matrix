import type { Adapter, TaskContext } from '../executor/types.js';

import { asArray, asNonemptyString, asRecord, checkKeys, invalid } from '../core/validation.js';
import { runProcess } from './process.js';

export type ShellOptions = {
  readonly args?: readonly string[];
  readonly command: string;
};

export function createShellAdapter() {
  return {
    async run(context, input) {
      const options = asRecord(input, 'shell options');
      checkKeys(options, 'shell options', ['command', 'args']);
      const command = asNonemptyString(options.command, 'shell options.command');
      const args =
        options.args === undefined
          ? []
          : asArray(options.args, 'shell options.args').map((arg, index) => {
              if (typeof arg !== 'string') {
                invalid(`shell options.args[${index}]`, 'expected a string');
              }
              return arg;
            });
      await runProcess(context, command, args);
      return {};
    },
  } satisfies Adapter<ShellOptions, TaskContext>;
}

export default createShellAdapter();
