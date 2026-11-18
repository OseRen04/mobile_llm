import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const entry = require.resolve('@huggingface/transformers');
const directory = path.dirname(require.resolve('onnxruntime-web/wasm', { paths: [path.dirname(entry)] }));
const output = path.resolve('apps/web/public/runtime');
await mkdir(output, { recursive: true });
for (const file of await readdir(directory)) {
  if (/^ort-wasm-simd-threaded(?:\.jsep)?\.(mjs|wasm)$/.test(file)) await copyFile(path.join(directory, file), path.join(output, file));
}
console.log('Local WASM runtime prepared.');
