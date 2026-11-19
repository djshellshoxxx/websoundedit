import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { deflateSync, zipSync, Zip, ZipDeflate } from 'fflate';
import { inflateBounded, preflightDeflate, MAX_DEFLATE_BLOCKS } from '../src/bounded-inflate.js';
import { readProjectZip, crc32 } from '../src/project-archive.js';
import { importAudacity, exportAudacity, loadAudacityCodec, encodeAudacityAU, decodeAudacityAU } from '../src/audacity.js';
import { xmlNode, readXML, writeXML, encodeBinaryXML, decodeBinaryXML } from '../src/audacity-xml.js';
import { AudioEditor } from '../src/engine.js';

const encoder = new TextEncoder();
const xml = encoder.encode('<project version="1.3.0" name="Bounded" rate="8000"/>');
function directory(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 6, true); }
async function fixture() {
  const editor = new AudioEditor({ sampleRate: 8000 });
  await editor.execute('clip.add', { audio: { sampleRate: 8000, channels: [Float32Array.of(.25, -.5, .75, 0)] } });
  return (await exportAudacity(await editor.execute('project.save'))).bytes;
}

test('DEFLATE preflight agrees with independent zlib across stored, fixed and dynamic blocks', () => {
  let state = 0x1951;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let i = 0; i < 48; i++) {
    const size = i === 0 ? 0 : i === 1 ? 70000 : 1 + random() % 8192;
    const bytes = Uint8Array.from({ length: size }, () => random() % (i % 3 === 0 ? 3 : 256));
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY]) {
      const compressed = deflateRawSync(bytes, { strategy, level: i % 10 });
      assert.equal(preflightDeflate(compressed, size), size);
      assert.deepEqual(inflateBounded(compressed, size), bytes);
      assert.throws(() => inflateBounded(compressed, size + 1), /length/);
      if (size) assert.throws(() => inflateBounded(compressed, size - 1), /declared size/);
      assert.throws(() => inflateBounded(compressed.subarray(0, compressed.length - 1), size), /Truncated|length/);
    }
    for (const level of [0, 6, 9]) assert.deepEqual(inflateBounded(deflateSync(bytes, { level }), size), bytes);
  }
  assert.throws(() => preflightDeflate(Uint8Array.of(7), 0), /Reserved/);
  assert.throws(() => preflightDeflate(Uint8Array.of(1, 0, 0, 0, 0), 0), /stored/);
});

test('ZIP rejects understated DEFLATE size before expanding its larger payload', async () => {
  const payload = encoder.encode(new TextDecoder().decode(xml) + ' '.repeat(1024 * 1024));
  const zip = zipSync({ 'project.aup': payload }, { level: 6 }), view = new DataView(zip.buffer), central = directory(zip);
  view.setUint32(22, xml.length, true); view.setUint32(central + 24, xml.length, true);
  await assert.rejects(importAudacity(zip), /exceeds its declared size/);
});

test('bounded DEFLATE accepts no output-length disagreement in seeded malformed streams', () => {
  let state = 0x1951f00d;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const original = Uint8Array.from({ length: 2048 }, (_, i) => i % 37), source = deflateRawSync(original);
  let accepted = 0;
  for (let i = 0; i < 512; i++) {
    const changed = new Uint8Array(source);
    for (let j = 0, count = 1 + random() % 3; j < count; j++) changed[random() % changed.length] ^= 1 << (random() % 8);
    try { preflightDeflate(changed, original.length); }
    catch { continue; }
    accepted++;
    const independent = inflateRawSync(changed, { maxOutputLength: original.length });
    assert.equal(independent.length, original.length);
    assert.deepEqual(inflateBounded(changed, original.length), new Uint8Array(independent));
  }
  assert.ok(accepted > 0, 'the oracle must exercise accepted mutations too');
});

test('DEFLATE limits zero-output block work per stream and across an archive budget', () => {
  const emptyBlocks = count => {
    const bytes = new Uint8Array(count * 5);
    for (let i = 0; i < count; i++) bytes.set([i === count - 1 ? 1 : 0, 0, 0, 255, 255], i * 5);
    return bytes;
  };
  assert.equal(preflightDeflate(emptyBlocks(MAX_DEFLATE_BLOCKS), 0), 0);
  assert.throws(() => preflightDeflate(emptyBlocks(MAX_DEFLATE_BLOCKS + 1), 0), /block complexity/);
  const blockBudget = { remaining: MAX_DEFLATE_BLOCKS };
  assert.equal(preflightDeflate(emptyBlocks(10000), 0, { blockBudget }), 0);
  assert.equal(preflightDeflate(emptyBlocks(10000), 0, { blockBudget }), 0);
  assert.throws(() => preflightDeflate(emptyBlocks(1), 0, { blockBudget }), /block complexity/);
});

test('ZIP checks CRC, local names and size coherence while accepting valid stored/deflated files', async () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  for (const level of [0, 6]) {
    const original = zipSync({ 'project.aup': xml, 'data.au': Uint8Array.of(1,2,3,4) }, { level });
    assert.deepEqual(readProjectZip(original).get('data.au'), Uint8Array.of(1,2,3,4));
    const corrupt = original.slice(), view = new DataView(corrupt.buffer), central = directory(corrupt);
    view.setUint32(14, 0, true); view.setUint32(central + 16, 0, true);
    await assert.rejects(importAudacity(corrupt), /checksum/);
    const renamed = original.slice(); renamed[30] ^= 1;
    assert.throws(() => readProjectZip(renamed), /filenames disagree/);
    const mismatched = original.slice(); new DataView(mismatched.buffer).setUint32(22, xml.length + 1, true);
    assert.throws(() => readProjectZip(mismatched), /sizes disagree/);
  }
  const au = encodeAudacityAU(Float32Array.of(.1,.2), 8000), zip = zipSync({ 'data.au': au }, { level: 0 });
  const payload = 30 + new DataView(zip.buffer).getUint16(26, true);
  zip[payload + au.length - 1] ^= 1;
  assert.throws(() => readProjectZip(zip), /checksum/);
});

test('ZIP streaming data descriptors are verified against the validated directory', () => {
  const chunks = [], zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
  const file = new ZipDeflate('project.aup'); zip.add(file); file.push(xml, true); zip.end();
  const archive = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0)); let at = 0;
  for (const chunk of chunks) { archive.set(chunk, at); at += chunk.length; }
  assert.deepEqual(readProjectZip(archive).get('project.aup'), xml);
  const broken = archive.slice(), view = new DataView(broken.buffer), central = directory(broken);
  const payload = 30 + view.getUint16(26, true) + view.getUint16(28, true), descriptor = payload + view.getUint32(central + 20, true);
  broken[descriptor + 4] ^= 1;
  assert.throws(() => readProjectZip(broken), /descriptor/);
});

test('AUP3 rejects generated, virtual and incompatible table schemas before reading values', async () => {
  const SQL = await loadAudacityCodec(), data = encodeBinaryXML(xmlNode('project', { version: '1.3.0', name: 'Generated', rate: 8000 }));
  for (const kind of ['VIRTUAL', 'STORED']) {
    const db = new SQL.Database();
    try {
      const document = Buffer.from(data.doc).toString('hex');
      db.run(`PRAGMA application_id=1096107097; PRAGMA user_version=50331648;
        CREATE TABLE project(id INTEGER PRIMARY KEY,dict BLOB,doc BLOB GENERATED ALWAYS AS(CAST(substr(hex(zeroblob(1048576)),1,0)||x'${document}' AS BLOB)) ${kind});
        CREATE TABLE sampleblocks(blockid INTEGER PRIMARY KEY,sampleformat INTEGER,summin REAL,summax REAL,sumrms REAL,summary256 BLOB,summary64k BLOB,samples BLOB);`);
      db.run('INSERT INTO project(id,dict) VALUES(1,?)', [data.dict]);
      await assert.rejects(importAudacity(db.export()), /schema|generated/);
    } finally { db.close(); }
  }
  const valid = await fixture();
  for (const sql of [
    'ALTER TABLE project ADD COLUMN unexpected BLOB',
    'ALTER TABLE autosave ADD COLUMN computed INTEGER AS(1)',
    'ALTER TABLE sampleblocks ADD COLUMN computed INTEGER AS(1)',
    "UPDATE project SET doc='text instead of blob'",
    "UPDATE sampleblocks SET samples='text instead of blob'",
  ]) {
    const db = new SQL.Database(valid);
    try { db.run(sql); await assert.rejects(importAudacity(db.export()), /schema|generated|missing|sample block/); }
    finally { db.close(); }
  }
});

test('Audacity block decoding matches the editor finite magnitude policy', async () => {
  const SQL = await loadAudacityCodec(), original = await fixture();
  for (const value of [1000000, -1000000, 100000000, -100000000, Infinity, NaN]) {
    const accepted = Number.isFinite(value) && Math.abs(value) <= 1e6;
    const au = encodeAudacityAU(Float32Array.of(value), 8000);
    if (accepted) assert.equal(decodeAudacityAU(au, 1)[0], value);
    else assert.throws(() => decodeAudacityAU(au, 1), /non-finite|unreasonable/);
    const db = new SQL.Database(original);
    try {
      const samples = db.exec('SELECT samples FROM sampleblocks WHERE blockid=1')[0].values[0][0];
      new DataView(samples.buffer, samples.byteOffset, samples.byteLength).setFloat32(0, value, true);
      db.run('UPDATE sampleblocks SET samples=? WHERE blockid=1', [samples]);
      if (accepted) { const { project } = await importAudacity(db.export()); await new AudioEditor().execute('project.load', { project }); }
      else await assert.rejects(importAudacity(db.export()), /non-finite|unreasonable/);
    } finally { db.close(); }
  }
});

test('XML preflight bounds attributes before DOM and preserves quoted markup/comments', () => {
  const attrs = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`a${i}`, 'value']));
  assert.equal(Object.keys(readXML(writeXML(xmlNode('project', attrs))).attrs).length, 128);
  const xml = '<project ' + Array.from({ length: 129 }, (_, i) => `a${i}="x"`).join(' ') + '/>';
  assert.throws(() => readXML(xml), /attributes/);
  const repeated = '<a ' + Object.keys(attrs).map(key => `${key}="x"`).join(' ') + '/>';
  assert.throws(() => readXML(`<project>${repeated.repeat(782)}</project>`), /attributes/);
  assert.equal(readXML('<!-- <fake a="b"/> --><project name="a &gt; b"><![CDATA[ ]]><?ignored value?></project>').attrs.name, 'a > b');
  assert.throws(() => encodeBinaryXML(xmlNode('project', { ...attrs, overflow: 'x' })), /attributes/);
  const encoded = encodeBinaryXML(xmlNode('project', attrs)), extraName = encoder.encode('overflow');
  const dict = new Uint8Array(encoded.dict.length + 5 + extraName.length); dict.set(encoded.dict); dict.set([15, 232, 253, extraName.length, 0], encoded.dict.length); dict.set(extraName, encoded.dict.length + 5);
  const doc = new Uint8Array(encoded.doc.length + 8); doc.set(encoded.doc.subarray(0, -3)); doc.set([3,232,253,1,0,0,0,120], encoded.doc.length - 3); doc.set(encoded.doc.subarray(-3), doc.length - 3);
  assert.throws(() => decodeBinaryXML(dict, doc), /attributes/);
});

test('XML text and binary readers/writers share root-zero depth64 boundary', () => {
  const root = xmlNode('project'); let cursor = root;
  for (let i = 0; i < 64; i++) { const child = xmlNode('a'); cursor.children.push(child); cursor = child; }
  assert.equal(readXML(writeXML(root)).name, 'project');
  const encoded = encodeBinaryXML(root); assert.equal(decodeBinaryXML(encoded.dict, encoded.doc).name, 'project');
  cursor.children.push(xmlNode('a'));
  assert.throws(() => writeXML(root), /nesting/); assert.throws(() => encodeBinaryXML(root), /complex/);
  assert.throws(() => readXML('<project>' + '<a>'.repeat(65) + '</a>'.repeat(65) + '</project>'), /complex/);
});
