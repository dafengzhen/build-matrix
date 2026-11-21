import { mkdir, readFile, writeFile } from 'node:fs/promises';

const locale = process.argv[2];
const label = process.env.BUILD_MATRIX_EXAMPLE_LABEL ?? 'local';
const message = await readFile(`src/${locale}.txt`, 'utf8');

await mkdir('dist', { recursive: true });
await writeFile(`dist/${locale}.txt`, `[${label}] ${message.trimEnd()}\n`);
