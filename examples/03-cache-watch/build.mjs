import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const files = readdirSync('src')
  .filter((name) => name.endsWith('.txt'))
  .sort();
const content = files.map((name) => readFileSync(`src/${name}`, 'utf8').trim()).join('\n');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/bundle.txt', `${content}\n`);
console.log(`bundled ${files.length} file(s)`);
