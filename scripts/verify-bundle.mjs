import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
// Links in the published user guide must resolve to the current references.
const guides = ['USER_GUIDE', 'SCRIPTING', 'BROWSER_SUPPORT', 'API', 'VERIFICATION', 'THIRD_PARTY', 'STEM_ISOLATION'].map(name => [`docs/${name}.md`, `docs/${name}.md`]);
guides.push(['docs/audits/BETA_2_QUALIFICATION_20261119.md', 'docs/audits/BETA_2_QUALIFICATION_20261119.md'], ['docs/THIRD_PARTY.md', 'licenses/THIRD_PARTY.md']);
const outputRoot = resolve('dist');
assert.ok((await stat('dist/stem-lab.html')).isFile(), 'The isolated stem prototype must be a built page.');
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  assert.deepEqual(await readFile(`dist/stems-runtime/${file}`), await readFile(`node_modules/onnxruntime-web/dist/${file}`), `Stem runtime ${file} must match the pinned package.`);
}
for (const [sourcePath, publishedPath] of guides) {
  const text = await readFile(`dist/${publishedPath}`, 'utf8');
  assert.equal(text, await readFile(sourcePath, 'utf8'), `Published ${publishedPath} must match its source.`);
  for (const [, href] of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
    const link = href.split(/[?#]/)[0];
    if (!link) continue;
    const target = resolve(dirname(resolve(outputRoot, publishedPath)), decodeURIComponent(link));
    assert.ok(target.startsWith(outputRoot + sep), `${publishedPath} links outside the built site: ${href}`);
    assert.ok((await stat(target)).isFile(), `${publishedPath} links to a missing published file: ${href}`);
  }
}
for (const asset of ['docs/audits/evidence/beta2-local-verification.json', 'docs/audits/evidence/beta2-preset-stress.json', 'docs/screenshots/workbench.png']) {
  assert.deepEqual(await readFile(`dist/${asset}`), await readFile(asset), `Published ${asset} must preserve its source bytes.`);
}
// The public API must remain a real DOM-free ES module after bundling.
const { AudioEditor, COMMANDS, generateAudio, encodeWav, decodeWav, createCoreRuntime, MacroRunner, createBrowserRuntime, importReaper, exportReaper } = await import('../dist/api.js');
assert.equal(typeof AudioEditor, 'function');
assert.ok(COMMANDS.some(command => command.method === 'effect.pitch'));
const editor = new AudioEditor();
const source = generateAudio({ type: 'tone', frequency: 440, duration: 0.1, amplitude: 0.25 });
await editor.execute('clip.add', { audio: source });
await editor.execute('effect.reverse');
const result = await editor.execute('audio.render', { scope: 'clip', raw: true });
assert.equal(result.channels[0].length, source.channels[0].length);
assert.equal(result.channels[0][0], source.channels[0].at(-1));
assert.equal(decodeWav(encodeWav(result)).channels.length, 1);
for(const method of [createBrowserRuntime,importReaper,exportReaper])assert.equal(typeof method,'function');
const runtime=createCoreRuntime({engine:editor}),runner=new MacroRunner({execute:runtime.execute.bind(runtime),getCommands:()=>runtime.commands()});
const macro=await runner.run('effect.reverse({}); let stats=analysis.stats({});');
assert.equal(macro.completedSteps,2);assert.ok(macro.variables.stats.peakDb<0&&macro.variables.stats.peakDb>(-13));
runtime.dispose();
console.log('Built API verified: DOM-free exports, real PCM edit/WAV round trip and interpreted typed macro.');
