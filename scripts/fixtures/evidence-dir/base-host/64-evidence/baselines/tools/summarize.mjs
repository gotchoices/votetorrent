import { readFileSync } from 'node:fs';
console.log(readFileSync(process.argv[2], 'utf8').split('\n').length);
