import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeJsonFile(path: string, value: unknown, pretty = false): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.build-matrix-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, undefined, pretty ? 2 : undefined)}\n`, {
    flag: 'wx',
  }).catch(async (error) => {
    if (error.code !== 'EEXIST') {
      await rm(temporary, { force: true }).catch(() => {});
    }
    throw error;
  });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
