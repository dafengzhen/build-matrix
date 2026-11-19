import { readdirSync } from 'node:fs';

const files = readdirSync('out').sort();
console.log(`${files.length} artifacts: ${files.join(', ')}`);
