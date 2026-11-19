import type { DimensionValues, JsonValue } from './types.js';

import { invalid } from './validation.js';

/** Render strings recursively, leaving object keys and other JSON values as declared. */
export function renderOptions(
  options: JsonValue,
  values: DimensionValues,
  path = 'options',
): JsonValue {
  if (typeof options === 'string') {
    return renderTemplate(options, values, path);
  }
  if (options === null || typeof options !== 'object') {
    return options;
  }
  if (Array.isArray(options)) {
    return Object.freeze(
      options.map((item, index) => renderOptions(item, values, `${path}[${index}]`)),
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(options).map(([key, value]) => [
        key,
        renderOptions(value, values, `${path}.${key}`),
      ]),
    ),
  );
}

/** Substitute dimension references. Double braces escape a literal reference. */
export function renderTemplate(
  template: string,
  values: DimensionValues,
  path = 'template',
): string {
  return template.replace(
    /\{\{([a-zA-Z_][\w-]*)\}\}|\{([a-zA-Z_][\w-]*)\}/g,
    (_, literal, name) => {
      if (literal !== undefined) {
        return `{${literal}}`;
      }
      if (!Object.hasOwn(values, name)) {
        invalid(path, `unknown dimension "${name}"`);
      }
      return String(values[name]);
    },
  );
}
