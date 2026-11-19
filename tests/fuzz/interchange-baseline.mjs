/** Deterministic, bounded post-publication audit. This reports observations;
 * it does not modify runtime code or treat arbitrary byte mutations as invalid.
 * Run: node tests/fuzz/interchange-baseline.mjs --out <report.json>
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AudioEditor } from '../../src/engine.js';
import { importAudacity, exportAudacity, encodeAudacityAU, decodeAudacityAU, loadAudacityCodec } from '../../src/audacity.js';
import { readXML, writeXML, encodeBinaryXML, decodeBinaryXML } from '../../src/audacity-xml.js';
import { normalizeMetadata } from '../../src/metadata.js';
import { zipSync } from 'fflate';

const SEED = 0x41554459;
let randomState = SEED;
function random() { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; }
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { seed: SEED, seedHex: `0x${SEED.toString(16)}`, runtime: process.version, platform: process.platform, generatedAt: new Date().toISOString(), limits: { mutationCasesPerFamily: 256, largestFocusedPayloadBytes: 1048629 }, sourceSha256: {}, families: {}, focused: [], unexpected: [] };
for (const file of ['src/audacity.js', 'src/audacity-xml.js', 'src/engine.js', 'src/metadata.js', 'package-lock.json']) report.sourceSha256[file] = digest(await readFile(new URL(`../../${file}`, import.meta.url)));

function mutate(input, index) {
  const result = input.slice();
  if (index % 5 === 0) return result.subarray(0, random() % (result.length + 1));
  if (index % 5 === 1) {
    const out = new Uint8Array(result.length + 1 + random() % 8); out.set(result);
    for (let i = result.length; i < out.length; i++) out[i] = random() & 255;
    return out;
  }
  for (let i = 0, n = 1 + random() % 5; i < n; i++) result[random() % result.length] ^= 1 << (random() % 8);
  return result;
}
function errorText(error) { return `${error?.name || 'Error'}: ${error?.message || error}`.slice(0, 300); }
async function runCase(family, id, input, action, validate) {
  const stats = report.families[family] ||= { total: 0, accepted: 0, rejected: 0, invalidAccepted: 0, inputMutations: 0, errors: {} };
  stats.total++;
  const before = input instanceof Uint8Array ? digest(input) : null;
  let value;
  try { value = await action(input); stats.accepted++; }
  catch (error) { stats.rejected++; const key = errorText(error); stats.errors[key] = (stats.errors[key] || 0) + 1; }
  if (value !== undefined && validate) {
    try { await validate(value); }
    catch (error) { stats.invalidAccepted++; report.unexpected.push({ family, id, inputSha256: before, error: errorText(error) }); }
  }
  if (before && before !== digest(input)) { stats.inputMutations++; report.unexpected.push({ family, id, error: 'Parser modified caller input bytes.' }); }
}
async function loadable({ project }) { await new AudioEditor().execute('project.load', { project }); }
async function focused(id, action) {
  const start = performance.now();
  try { report.focused.push({ id, outcome: 'accepted', result: await action(), elapsedMs: +(performance.now() - start).toFixed(3) }); }
  catch (error) { report.focused.push({ id, outcome: 'rejected', error: errorText(error), elapsedMs: +(performance.now() - start).toFixed(3) }); }
}

const xml = '<project version="1.3.0" name="Audit" rate="8000"><wavetrack name="Track" channel="2" rate="8000"><waveclip name="Clip" offset="0"><sequence numsamples="4"><waveblock start="0"><silentblockfile len="4"/></waveblock></sequence><envelope numpoints="0"/></waveclip></wavetrack></project>';
const xmlBytes = encoder.encode(xml), binary = encodeBinaryXML(readXML(xml));
const samples = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.3) * 0.25);
const au = encodeAudacityAU(samples, 8000), archive = zipSync({ 'project.aup': xmlBytes }, { level: 6 });
const editor = new AudioEditor({ sampleRate: 8000 });
await editor.execute('clip.add', { name: 'Fixture', audio: { sampleRate: 8000, channels: [samples] } });
const aup3 = (await exportAudacity(await editor.execute('project.save'))).bytes;
await loadAudacityCodec();

for (const [family, source, action, validate] of [
  ['xml-bytes', xmlBytes, bytes => importAudacity(bytes), loadable],
  ['binary-xml', binary.doc, bytes => decodeBinaryXML(binary.dict, bytes), value => readXML(writeXML(value))],
  ['au-block', au, bytes => decodeAudacityAU(bytes, samples.length), value => { if (value.length !== samples.length || value.some(x => !Number.isFinite(x))) throw new Error('Non-finite or wrong-length accepted PCM.'); }],
  ['legacy-zip', archive, bytes => importAudacity(bytes), loadable],
  ['aup3-sqlite', aup3, bytes => importAudacity(bytes), loadable],
]) {
  for (let i = 0; i < 256; i++) await runCase(family, i, mutate(source, i), action, validate);
  console.log(`${family}: ${report.families[family].accepted} accepted / ${report.families[family].rejected} rejected`);
}

const values = ['NaN', 'Infinity', '-Infinity', '-1', '0', '0.00001', '1', '2', '64', '65', '512', '600', '601', '8000', '192000', '192001', '9007199254740992', '1e999', '', ' ', '0x10', '1e-300'];
for (const [field, pattern] of [['sample-rate', 'rate="8000"'], ['sequence-length', 'numsamples="4"'], ['block-start', 'start="0"'], ['block-length', 'len="4"'], ['offset', 'offset="0"'], ['envelope-count', 'numpoints="0"']]) {
  for (let i = 0; i < values.length; i++) {
    const changed = encoder.encode(xml.replace(pattern, pattern.replace(/".*"/, `"${values[i]}"`)));
    await runCase(`numeric-${field}`, i, changed, bytes => importAudacity(bytes), loadable);
  }
}

const unsafePaths = ['../project.aup', '/project.aup', 'C:/project.aup', '..\\project.aup', 'x/../project.aup', 'x/./project.aup', 'x\0/project.aup'];
for (const [index, path] of unsafePaths.entries()) await runCase('unsafe-zip-paths', index, zipSync({ [path]: xmlBytes }), bytes => importAudacity(bytes), loadable);
for (const count of [0, 1, 63, 64, 65, 100, 1000, 10000]) {
  const value = `<project>${'<a>'.repeat(count)}${'</a>'.repeat(count)}</project>`;
  await runCase('xml-depth', count, encoder.encode(value), bytes => importAudacity(bytes), loadable);
}
for (const text of [
  '<!DOCTYPE project [<!ENTITY x "bad">]><project/>',
  '<!DOCTYPE project SYSTEM "file:///not-read"><project/>',
  '<!DOCTYPE project SYSTEM "https://not-fetched.invalid/x"><project/>',
  '<project><import filename="external.ogg"/></project>',
  '<project><effect id="example"/></project>',
  '<project><notetrack/></project>',
  '<project><timetrack/></project>',
  '<project constructor="x" __proto__="y"/>',
]) await runCase('xml-trust-boundaries', digest(text).slice(0, 8), encoder.encode(text), bytes => importAudacity(bytes), loadable);

for (let i = 0; i < 256; i++) {
  const keys = ['title', 'artist', 'comment', '__proto__', 'constructor', 'unknown'];
  const key = keys[random() % keys.length], length = random() % 2100;
  const value = i % 4 === 0 ? '\0' : i % 4 === 1 ? 'é'.repeat(length) : i % 4 === 2 ? ['nested'] : 'x'.repeat(length);
  const tags = Object.create(null); tags[key] = value;
  await runCase('metadata', i, tags, data => normalizeMetadata(data), value => { if (JSON.stringify(value).length > 16384) throw new Error('Unexpectedly large normalized metadata.'); });
}

const smallXml = encoder.encode('<project version="1.3.0" name="Bounded" rate="8000"/>');
for (const kind of ['zip-crc-mismatch', 'zip-deflate-size-understatement']) {
  const payload = kind === 'zip-deflate-size-understatement' ? encoder.encode(decoder.decode(smallXml) + ' '.repeat(1024 * 1024)) : smallXml;
  const zip = zipSync({ 'project.aup': payload }, { level: 6 });
  const view = new DataView(zip.buffer), end = zip.length - 22, central = view.getUint32(end + 16, true);
  if (kind === 'zip-crc-mismatch') { view.setUint32(14, 0, true); view.setUint32(central + 16, 0, true); }
  else { view.setUint32(22, smallXml.length, true); view.setUint32(central + 24, smallXml.length, true); }
  await focused(kind, async () => { const value = await importAudacity(zip); await loadable(value); return { archiveBytes: zip.length, declaredBytes: smallXml.length, actualInflatedBytes: payload.length, projectName: value.project.name }; });
}
await focused('xml-attribute-count', () => {
  const text = '<project ' + Array.from({ length: 10000 }, (_, i) => `a${i}="x"`).join(' ') + '/>';
  return { textBytes: encoder.encode(text).length, attributesAccepted: Object.keys(readXML(text).attrs).length };
});
await focused('binary-writer-reader-depth-boundary', () => {
  let root = { name: 'project', attrs: {}, children: [] }, cursor = root;
  for (let i = 0; i < 64; i++) { const child = { name: 'a', attrs: {}, children: [] }; cursor.children.push(child); cursor = child; }
  const bytes = encodeBinaryXML(root); return decodeBinaryXML(bytes.dict, bytes.doc).name;
});
await focused('sqlite-generated-column', async () => {
  const SQL = await loadAudacityCodec(), db = new SQL.Database();
  const data = encodeBinaryXML({ name: 'project', attrs: { version: '1.3.0', rate: 8000, name: 'Computed schema' }, children: [] });
  try {
    // A bounded demonstration of work hidden in a schema expression. Never
    // increase this allocation to exhaust the executing machine.
    db.run(`PRAGMA application_id=1096107097; PRAGMA user_version=50331648;
      CREATE TABLE project (id INTEGER PRIMARY KEY, dict BLOB, source BLOB,
        doc BLOB GENERATED ALWAYS AS (CAST(substr(hex(zeroblob(1048576)),1,0)||source AS BLOB)) VIRTUAL);
      CREATE TABLE sampleblocks (blockid INTEGER PRIMARY KEY, sampleformat INTEGER, samples BLOB);`);
    db.run('INSERT INTO project (id,dict,source) VALUES (1,?,?)', [data.dict, data.doc]);
    const bytes = db.export(), imported = await importAudacity(bytes); await loadable(imported);
    return { fileBytes: bytes.length, projectName: imported.project.name, expressionZeroBlobBytes: 1048576, expressionHexBytes: 2097152, importedDocumentBytes: data.doc.length };
  } finally { db.close(); }
});
await focused('aup3-pcm-outside-editor-range', async () => {
  const SQL = await loadAudacityCodec(), db = new SQL.Database(aup3);
  try {
    const row = db.exec('SELECT samples FROM sampleblocks WHERE blockid=1')[0].values[0][0];
    new DataView(row.buffer, row.byteOffset, row.byteLength).setFloat32(0, 100000000, true);
    db.run('UPDATE sampleblocks SET samples=? WHERE blockid=1', [row]);
    const imported = await importAudacity(db.export());
    try { await loadable(imported); return { importAccepted: true, editorAccepted: true }; }
    catch (error) { return { importAccepted: true, editorAccepted: false, editorError: errorText(error), sampleValue: 100000000 }; }
  } finally { db.close(); }
});
report.totalCases = Object.values(report.families).reduce((sum, stats) => sum + stats.total, 0);
report.focusedCases = report.focused.length;
report.globalPrototypeIntact = Object.getPrototypeOf({}) === Object.prototype && !Object.hasOwn(Object.prototype, 'polluted');
const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1) {
  const path = process.argv[outIndex + 1]; if (!path) throw new Error('--out requires a report filename.');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ totalCases: report.totalCases, focusedCases: report.focusedCases, unexpected: report.unexpected, focused: report.focused, globalPrototypeIntact: report.globalPrototypeIntact }, null, 2));
