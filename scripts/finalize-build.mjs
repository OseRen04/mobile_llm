import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const target = process.argv[2];
if (!['web', 'extension'].includes(target)) throw new Error('Expected web or extension');
const output = path.resolve('dist', target);
const require = createRequire(import.meta.url);
const transformerPackage = require.resolve('@huggingface/transformers');
const ortEntry = require.resolve('onnxruntime-web/wasm', { paths: [path.dirname(transformerPackage)] });
const ortDist = path.dirname(ortEntry);
await mkdir(path.join(output, 'runtime'), { recursive: true });
for (const name of await readdir(ortDist)) {
  if (/^ort-wasm-simd-threaded(?:\.jsep)?\.(wasm|mjs)$/.test(name)) await copyFile(path.join(ortDist, name), path.join(output, 'runtime', name));
}
await copyFile('THIRD_PARTY_NOTICES.md', path.join(output, 'THIRD_PARTY_NOTICES.md'));
await mkdir(path.join(output, 'licenses'), { recursive: true });
for (const name of ['react', 'react-dom', '@huggingface/transformers', 'onnxruntime-web']) {
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === name) break;
    } catch { /* Look in the parent package directory. */ }
    directory = path.dirname(directory);
  }
  const licenseName = (await readdir(directory)).find(file => /^licen[cs]e(?:\.txt|\.md)?$/i.test(file));
  if (!licenseName && name !== 'onnxruntime-web') throw new Error(`Missing license for ${name}`);
  await copyFile(licenseName ? path.join(directory, licenseName) : 'licenses/onnxruntime.txt', path.join(output, 'licenses', name.replaceAll('/', '-') + '.txt'));
}

if (target === 'web') {
  async function filesIn(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
    return nested.flat();
  }
  const files = (await filesIn(output)).filter(file => !file.endsWith('/sw.js') && !file.endsWith('/_headers'));
  const paths = files.map(file => './' + path.relative(output, file).split(path.sep).join('/')).sort();
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(await readFile(file));
  const version = hash.digest('hex').slice(0, 16);
  const template = await readFile('apps/web/public/sw.js', 'utf8');
  await writeFile(path.join(output, 'sw.js'), template.replace('__BUILD_VERSION__', version).replace('/*__PRECACHE__*/[]', JSON.stringify(paths)));
}
console.log(`Prepared ${target}: bundled WASM runtime${target === 'web' ? ' and complete offline app shell' : ''}.`);
