import { mkdirSync, writeFileSync } from 'node:fs';

const [out, runtime, format] = process.argv.slice(2);
mkdirSync('out', { recursive: true });
writeFileSync(out, `runtime=${runtime}\nformat=${format}\n`);
console.log(`built ${out}`);
