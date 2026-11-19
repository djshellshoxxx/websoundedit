import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('public/codecs', { recursive: true });
// Same-origin, single-thread FFmpeg does not require SharedArrayBuffer or COOP/COEP.
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) await copyFile(resolve('node_modules/@ffmpeg/core/dist/esm', file), resolve('public/codecs', file));
await mkdir('public/licenses', { recursive: true });
for (const [folder, name] of [['@ffmpeg/ffmpeg','ffmpeg-wrapper'],['@ffmpeg/core','ffmpeg-core'],['@soundtouchjs/core','soundtouch-core'],['libopus-wasm','libopus-wasm']]) {
  try { await copyFile(resolve('node_modules', folder, 'LICENSE'), resolve('public/licenses', `${name}.txt`)); } catch { /* Included notice below links corresponding source. */ }
}
await copyFile('node_modules/libopus-wasm/THIRD_PARTY_NOTICES.md', 'public/licenses/libopus-notices.md');
await copyFile('docs/licenses/opus.txt', 'public/licenses/opus.txt');
await copyFile('docs/THIRD_PARTY.md', 'public/licenses/THIRD_PARTY.md');
for (const name of ['PRODUCT_SPEC','RESEARCH','API','PROJECT_FORMAT','ACCEPTANCE']) {
  try { await mkdir('public/docs',{recursive:true}); await copyFile(`docs/${name}.md`,`public/docs/${name}.md`); } catch { /* Not present during initial development builds. */ }
}
await writeFile('public/.nojekyll','');
