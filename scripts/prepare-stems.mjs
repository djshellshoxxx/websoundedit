import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The isolated lab loads these same-version runtime assets only on explicit
// model loading. No pretrained weights are included in builds or fetched here.
await mkdir('public/stems-runtime', { recursive: true });
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(resolve('node_modules/onnxruntime-web/dist', file), resolve('public/stems-runtime', file));
}
await mkdir('public/licenses', { recursive: true });
// The package banner retains the Microsoft MIT notice. The prototype guide
// records the upstream notice links and the outstanding release-source check.
await copyFile('docs/THIRD_PARTY.md', 'public/licenses/THIRD_PARTY.md');
await mkdir('public/docs', { recursive: true });
await copyFile('docs/STEM_ISOLATION.md', 'public/docs/STEM_ISOLATION.md');
