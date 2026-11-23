import { writeFile } from 'node:fs/promises';
import { json } from 'node:stream/consumers';

import type { BuildRequest, ViteApi } from './vite-config.js';

import { inspectVite, withViteEnv } from './vite-config.js';
import { createViteSession } from './vite-session.js';

const [, , viteUrl, reportPath, action] = process.argv;
const request = (await json(process.stdin)) as BuildRequest;
const vite = (await import(viteUrl)) as ViteApi;
try {
  const result = await withViteEnv(async () =>
    action === 'inspect'
      ? { inputs: await inspectVite(vite, request), version: vite.version }
      : (await createViteSession(vite, request)).build(),
  );
  await writeFile(reportPath, JSON.stringify({ result }));
} catch (error) {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'VITE_UNKNOWN_ENVIRONMENT'
  ) {
    throw error;
  }
  await writeFile(
    reportPath,
    JSON.stringify({ error: { code: error.code, message: error.message } }),
  );
}
