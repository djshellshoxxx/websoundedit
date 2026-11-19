import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const version=JSON.parse(await readFile('package.json','utf8')).version;
let commit=process.env.GITHUB_SHA || null;
if(!commit&&existsSync('.git'))try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* Source archives also build without Git installed. */}
await mkdir('public',{recursive:true});
await writeFile('public/build.json',JSON.stringify({version,commit,builtAt:new Date().toISOString()})+'\n');
await mkdir('public/codecs', { recursive: true });
// Same-origin, single-thread FFmpeg does not require SharedArrayBuffer or COOP/COEP.
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) await copyFile(resolve('node_modules/@ffmpeg/core/dist/esm', file), resolve('public/codecs', file));
for (const file of ['sql-wasm.wasm', 'sql-wasm-browser.wasm']) await copyFile(resolve('node_modules/sql.js/dist', file), resolve('public/codecs', file));
await mkdir('public/licenses', { recursive: true });
for (const [folder, name] of [['@ffmpeg/ffmpeg','ffmpeg-wrapper'],['@ffmpeg/core','ffmpeg-core'],['@soundtouchjs/core','soundtouch-core'],['libopus-wasm','libopus-wasm'],['sql.js','sql.js'],['fflate','fflate'],['@xmldom/xmldom','xmldom']]) {
  try { await copyFile(resolve('node_modules', folder, 'LICENSE'), resolve('public/licenses', `${name}.txt`)); } catch { /* Included notice below links corresponding source. */ }
}
await copyFile('node_modules/libopus-wasm/THIRD_PARTY_NOTICES.md', 'public/licenses/libopus-notices.md');
await copyFile('docs/licenses/opus.txt', 'public/licenses/opus.txt');
await copyFile('docs/THIRD_PARTY.md', 'public/licenses/THIRD_PARTY.md');
await mkdir('public/docs/specs', { recursive: true });
for(const name of ['CREATIVE_WORKBENCH_V2','BETA_1_0'])await copyFile(`docs/specs/${name}.md`, `public/docs/specs/${name}.md`);
for (const name of ['PRODUCT_SPEC','RESEARCH','API','PROJECT_FORMAT','ACCEPTANCE','ENGINE_CONTRACT','THIRD_PARTY','VERIFICATION','AUDACITY','REAPER','MACROS','COMPANION','USER_GUIDE']) {
  try { await mkdir('public/docs',{recursive:true}); await copyFile(`docs/${name}.md`,`public/docs/${name}.md`); } catch { /* Not present during initial development builds. */ }
}
await writeFile('public/.nojekyll','');
await mkdir('public/docs/audits',{recursive:true});
for(const name of await readdir('docs/audits'))if(/\.(md|json)$/.test(name))await copyFile(`docs/audits/${name}`,`public/docs/audits/${name}`);
