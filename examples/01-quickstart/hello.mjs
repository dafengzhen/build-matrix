import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('out', { recursive: true });
await writeFile('out/hello.txt', 'Hello from Build Matrix\n');
console.log('wrote out/hello.txt');
