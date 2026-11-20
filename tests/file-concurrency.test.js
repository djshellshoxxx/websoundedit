import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { BrowserFileIO } from '../src/file-ui.js';
import { readProjectZip } from '../src/project-archive.js';

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
