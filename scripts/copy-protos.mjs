// tsc emits only .ts sources; the vendored KiCad .proto files are loaded at
// runtime by src/kicad/ipc.ts relative to its own module path, so the build
// must mirror them into dist for the published package to work.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
cpSync(`${root}src/kicad/proto`, `${root}dist/kicad/proto`, { recursive: true });
console.log('copied src/kicad/proto -> dist/kicad/proto');
