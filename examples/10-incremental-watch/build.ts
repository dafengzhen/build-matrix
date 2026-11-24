import { mkdir, readFile, writeFile } from 'node:fs/promises';

const target = process.argv[2];
const [header, body] = await Promise.all([
  readFile('src/header.txt', 'utf8'),
  readFile(`src/${target}.txt`, 'utf8'),
]);

await mkdir('dist', { recursive: true });
await writeFile(`dist/${target}.txt`, `${header.trimEnd()}\n${body.trimEnd()}\n`);
