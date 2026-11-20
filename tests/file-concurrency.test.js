import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { BrowserFileIO } from '../src/file-ui.js';
import { readProjectZip } from '../src/project-archive.js';
import { zipSync } from 'fflate';
import { decodeWav } from '../src/wav.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(executeCore) {
  const editor = new AudioEditor({ sampleRate: 8000 });
  for (const name of ['Bass', 'Drums']) await editor.execute('clip.add', {
    name, audio: { sampleRate: 8000, channels: [new Float32Array(80).fill(.25)] },
  });
  const downloads = [];
  const io = new BrowserFileIO({
    getState: () => editor.getState(),
    executeCore: executeCore ? (...args) => executeCore(editor, ...args) : (...args) => editor.execute(...args),
    download: (...args) => downloads.push(args),
  });
  return { editor, io, downloads };
}

test('a stem export rejected by a newly started batch preserves that batch output collection', async () => {
  const entered = deferred(), release = deferred();
  const { io, downloads } = await fixture(async (editor, ...args) => {
    const audio = await editor.execute(...args);
    entered.resolve(); await release.promise;
    return audio;
  });
  const exporting = io.exportStems({ format: 'wav', download: false });
  await entered.promise;
  io.beginCollection(); const collection = io.collection;
  io.addAccessGuard(({ context }) => {
    if (context.owner !== 'batch') throw Object.assign(new Error('Batch owns file output'), { code: 'BUSY' });
  });
  io.emit({ bytes: Uint8Array.of(1, 2, 3), ext: 'wav', mime: 'audio/wav' }, 'Completed batch result', false, { owner: 'batch' });
  const rejected = assert.rejects(exporting, error => error.code === 'BUSY');
  release.resolve(); await rejected;
  assert.equal(io.collection, collection, 'an earlier export must not clear or replace a newer collection');
  const retained = io.finishCollection({ owner: 'batch' });
  assert.equal(retained.files.length, 1); assert.equal(retained.total, 3);
  assert.equal(retained.files[0].name, 'Completed batch result.wav');
  assert.equal(downloads.length, 0);
});

test('collected stems retain only the final ZIP without collecting or downloading individual renders', async () => {
  const { io, downloads } = await fixture();
  io.beginCollection(); const collection = io.collection;
  const result = await io.exportStems({ format: 'wav', bitDepth: 32, download: false });
  assert.equal(io.collection, collection);
  const retained = io.finishCollection();
  assert.equal(retained.files.length, 1); assert.equal(retained.files[0].ext, 'zip');
  assert.equal(retained.total, result.bytes.byteLength);
  assert.deepEqual([...readProjectZip(result.bytes).keys()], ['Bass.wav', 'Drums.wav']);
  assert.equal(downloads.length, 0);
});

test('real encoded exports retain unique filenames and distinct audio through collection, download and ZIP', async () => {
  const editor = new AudioEditor({ sampleRate: 8000 });
  const first = await editor.execute('clip.add', { audio: { sampleRate: 8000, channels: [new Float32Array(80).fill(.2)] } });
  const second = await editor.execute('clip.add', { audio: { sampleRate: 8000, channels: [new Float32Array(160).fill(-.35)] } });
  const downloads = [];
  const io = new BrowserFileIO({ getState: editor.getState.bind(editor), executeCore: editor.execute.bind(editor), download: (...args) => downloads.push(args) });
  io.beginCollection({ download: true });
  const firstResult = await io.export({ format: 'wav', scope: 'clip', clipId: first.clipId, name: 'Take', raw: true, bitDepth: 32 });
  const secondResult = await io.export({ format: 'wav', scope: 'clip', clipId: second.clipId, name: 'take', raw: true, bitDepth: 32 });
  assert.equal(firstResult.name, 'WAV · uncompressed PCM', 'codec metadata remains a format description');
  const collected = io.finishCollection();
  assert.deepEqual(collected.files.map(file => file.name), ['Take.wav', 'take (2).wav']);
  assert.deepEqual(downloads.map(([, name]) => name), collected.files.map(file => file.name));
  assert.equal(collected.total, firstResult.bytes.byteLength + secondResult.bytes.byteLength);
  const zip = zipSync(Object.fromEntries(collected.files.map(file => [file.name, file.bytes])), { level: 0 });
  const entries = readProjectZip(zip);
  assert.deepEqual([...entries.keys()], ['Take.wav', 'take (2).wav']);
  const firstAudio = decodeWav(entries.get('Take.wav')), secondAudio = decodeWav(entries.get('take (2).wav'));
  assert.equal(firstAudio.channels[0].length, 80); assert.equal(secondAudio.channels[0].length, 160);
  assert.ok(Math.abs(firstAudio.channels[0][0] - .2) < 1e-7); assert.ok(Math.abs(secondAudio.channels[0][0] + .35) < 1e-7);
});

test('collection names remain authoritative for every named codec descriptor and do not alter descriptor data', async () => {
  const { io } = await fixture(); io.beginCollection();
  const formats = [
    { name: 'MP3 · compatible & compact', ext: 'mp3', mime: 'audio/mpeg' },
    { name: 'FLAC · compressed lossless', ext: 'flac', mime: 'audio/flac' },
    { name: 'M4A / AAC · MPEG-4', ext: 'm4a', mime: 'audio/mp4' },
  ];
  for (const descriptor of formats) {
    const result = { ...descriptor, bytes: Uint8Array.of(1, 2, 3) };
    io.emit(result, 'first', false); io.emit(result, 'second', false);
    assert.equal(result.name, descriptor.name);
  }
  const collected = io.finishCollection();
  assert.deepEqual(collected.files.map(file => file.name), ['first.mp3', 'second.mp3', 'first.flac', 'second.flac', 'first.m4a', 'second.m4a']);
  assert.equal(new Set(collected.files.map(file => file.name)).size, 6);
});
