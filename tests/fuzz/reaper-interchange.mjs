/** Deterministic REAPER grammar/container/import mutation corpus.
 * node tests/fuzz/reaper-interchange.mjs [report.json]
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { zipSync } from 'fflate';
import { AudioEditor } from '../../src/engine.js';
import { encodeWav } from '../../src/wav.js';
import { parseRpp, writeRpp, importReaper } from '../../src/reaper.js';

const seed = 0x52505031; let state = seed;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const original = `<REAPER_PROJECT 0.1 "7.86" 1
SAMPLERATE 8000 1 0
TEMPO 127 4 4
PANLAW 1
MASTER_NCH 2 2
MASTER_VOLUME 1 0 1 1 1
ITEMMIX 1
<TRACK
NAME "Fuzz track"
VOLPAN 0.5 0.25 1 1
PANMODE 3
PANLAWFLAGS 2
NCHAN 2
MUTESOLO 0 0 0
<ITEM
POSITION 0
LENGTH 0.001
SOFFS 0
VOLPAN 1 0 1 -1
MIXFLAG 1
PLAYRATE 1 1 0 -1 0 0.0025
NAME "Tone"
<SOURCE WAVE
FILE "tone.wav"
>
>
>
>
`;
const encoder = new TextEncoder(), source = encoder.encode(original), originalHash = createHash('sha256').update(source).digest('hex');
const audio = { sampleRate: 8000, channels: [Float32Array.of(.1, -.2, .3, -.4, .5, -.6, .7, -.8)] }, wav = encodeWav(audio, { float: true, bitDepth: 32 });
const aliases = new Map([['tone.wav', wav]]), archive = zipSync({ 'project.rpp': source, 'tone.wav': wav }, { level: 0, mtime: new Date('2020-01-01T00:00:00Z') });
const counts = { textMutations: 1536, importMutations: 512, zipMutations: 256, boundaryCases: 0, syntaxAccepted: 0, serializable: 0, imported: 0, rejected: 0, invalidAccepted: 0, inputMutations: 0, ambientNetworkCalls: 0 };
const started = performance.now(), corpusHash = createHash('sha256'), errors = [];
const shape = node => ({ tag: node.tag, args: node.args, ...(node.children ? { children: node.children.map(shape) } : {}) });
function mutation(bytes) {
  const kind = random() % 4, at = random() % bytes.length;
  if (kind === 0) { const out = bytes.slice(); out[at] ^= 1 << (random() % 8); return out; }
  if (kind === 1) return bytes.slice(0, at);
  if (kind === 2) { const out = new Uint8Array(bytes.length + 1); out.set(bytes.subarray(0, at)); out[at] = random() & 255; out.set(bytes.subarray(at), at + 1); return out; }
  const out = bytes.slice(); out.fill(random() & 255, at, Math.min(out.length, at + 1 + random() % 16)); return out;
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { counts.ambientNetworkCalls++; throw new Error('Import tried ambient networking'); };
try {
  for (let index = 0; index < counts.textMutations; index++) {
    const input = mutation(source); corpusHash.update(input); const saved = input.slice();
    try {
      const parsed = parseRpp(input); counts.syntaxAccepted++;
      let encoded;
      try { encoded = writeRpp(parsed); } catch { continue; }
      counts.serializable++; assert.deepEqual(shape(parseRpp(encoded)), shape(parsed));
    } catch (error) { if (error.name === 'AssertionError') { counts.invalidAccepted++; errors.push({ phase: 'text', index, error: error.message }); } else counts.rejected++; }
    if (!input.every((value, i) => value === saved[i])) counts.inputMutations++;
  }
  for (const [phase, base, total] of [['import', source, counts.importMutations], ['zip', archive, counts.zipMutations]]) {
    for (let index = 0; index < total; index++) {
      const input = mutation(base), saved = input.slice(); corpusHash.update(input);
      try {
        const result = await importReaper(input, phase === 'import' ? { files: aliases } : {});
        const editor = new AudioEditor();
        try { await editor.execute('project.load', { project: result.project }); assert.ok(editor.getState().duration <= 600); }
        catch (error) { counts.invalidAccepted++; errors.push({ phase, index, sha256: createHash('sha256').update(input).digest('hex'), error: error.message }); }
        counts.imported++;
      } catch { counts.rejected++; }
      if (!input.every((value, i) => value === saved[i])) counts.inputMutations++;
    }
  }
  const bad = [
    '<REAPER_PROJECT\n' + '\n'.repeat(50001) + '>\n',
    '<REAPER_PROJECT\n' + '<X\n'.repeat(65) + '>\n'.repeat(66),
    '<REAPER_PROJECT\nNAME "' + 'x'.repeat(16385) + '"\n>',
    '<REAPER_PROJECT\n' + 'NAME x\n'.repeat(20000) + '>',
    original.replace('FILE "tone.wav"', 'FILE "https://example.invalid/secret.wav"'),
    original.replace('NCHAN 2', 'NCHAN 128'),
    original.replace('VOLPAN 0.5', 'VOLPAN NaN'),
    original.replace('POSITION 0', 'POSITION -1'),
    original.replace('SOURCE WAVE', 'SOURCE SECTION'),
    original.replace('NCHAN 2', 'NCHAN 2\nAUXRECV 0 0 1'),
  ];
  for (const text of bad) { counts.boundaryCases++; const input = encoder.encode(text); corpusHash.update(input); await assert.rejects(importReaper(input, { files: aliases })); }
} finally { globalThis.fetch = originalFetch; }
const report = { seed: `0x${seed.toString(16)}`, node: process.version, fixtureSha256: originalHash, corpusSha256: corpusHash.digest('hex'), counts, elapsedMs: Math.round(performance.now() - started), errors };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.equal(counts.invalidAccepted, 0); assert.equal(counts.inputMutations, 0); assert.equal(counts.ambientNetworkCalls, 0);
