/** Public-command stress at supported arrangement limits with small synthetic PCM.
 * These exercise object counts, history and repeated I/O without exhausting RAM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor, LIMITS } from '../src/engine.js';
import { encodeWav, decodeWav } from '../src/wav.js';
import { BrowserFileIO } from '../src/file-ui.js';
import { readProjectZip } from '../src/project-archive.js';

const SAMPLE_RATE = 8000, CLIP_FRAMES = 128;
async function fullArrangement() {
  const editor = new AudioEditor({ sampleRate: SAMPLE_RATE });
  for (let track = 0; track < LIMITS.tracks; track++) {
    const { id } = await editor.execute('track.add', { name: `Track ${track + 1}` });
    for (let clip = 0; clip < LIMITS.clips / LIMITS.tracks; clip++) await editor.execute('clip.add', {
      trackId: id, name: `Clip ${clip + 1}`, start: clip * CLIP_FRAMES / SAMPLE_RATE,
      audio: { sampleRate: SAMPLE_RATE, channels: [new Float32Array(CLIP_FRAMES).fill((track + 1) * .0001 * (clip % 2 ? -1 : 1))] },
    });
  }
  return editor;
}
function assertMix(audio) {
  assert.equal(audio.channels.length, 2);
  assert.equal(audio.channels[0].length, CLIP_FRAMES * LIMITS.clips / LIMITS.tracks);
  const sum = LIMITS.tracks * (LIMITS.tracks + 1) / 2 * .0001 * Math.SQRT1_2;
  for (let clip = 0; clip < LIMITS.clips / LIMITS.tracks; clip++) for (const channel of audio.channels) {
    assert.ok(Math.abs(channel[clip * CLIP_FRAMES + 64] - sum * (clip % 2 ? -1 : 1)) < 1e-6);
  }
}

test('64-track / 512-clip arrangements survive limit rejection, full history and 40 save/reopen cycles', async t => {
  const started = performance.now(), editor = await fullArrangement();
  const initial = await editor.execute('project.save');
  assert.equal(initial.tracks.length, LIMITS.tracks);
  assert.equal(initial.tracks.reduce((sum, track) => sum + track.clips.length, 0), LIMITS.clips);
  await assert.rejects(editor.execute('track.add', { name: 'Over capacity' }), error => error.code === 'RESOURCE_LIMIT');
  await assert.rejects(editor.execute('clip.duplicate'), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(await editor.execute('project.save'), initial, 'rejected operations must preserve every clip and selection');
  for (let edit = 0; edit < 40; edit++) await editor.execute('track.update', { trackId: initial.tracks[0].id, name: `History edit ${edit}` });
  const edited = await editor.execute('project.save');
  assert.equal(editor.getState().history.undo, LIMITS.historyEntries);
  for (let i = 0; i < LIMITS.historyEntries; i++) assert.equal(await editor.execute('history.undo'), true);
  for (let i = 0; i < LIMITS.historyEntries; i++) assert.equal(await editor.execute('history.redo'), true);
  assert.deepEqual(await editor.execute('project.save'), edited);
  for (let cycle = 0; cycle < 40; cycle++) {
    const portable = await editor.execute('project.save');
    await editor.execute('project.load', { project: JSON.stringify(portable) });
    const mix = await editor.execute('audio.render', { scope: 'mix' });
    assertMix(mix);
    assertMix(decodeWav(encodeWav(mix, { bitDepth: 32, float: true })));
    const state = editor.getState();
    assert.equal(state.history.undo, LIMITS.historyEntries);
    assert.ok(state.history.bytes <= LIMITS.historyBytes);
  }
  assert.deepEqual(await editor.execute('project.save'), edited);
  t.diagnostic(`64 tracks, 512 clips, 40 edits, 30 undo/redo pairs and 40 JSON/WAV cycles completed in ${Math.round(performance.now() - started)} ms; history retained ${editor.getState().history.bytes} PCM bytes.`);
});

test('three consecutive 64-track stem collections remain bounded and contain every track exactly once', async t => {
  const started = performance.now(), editor = await fullArrangement();
  const io = new BrowserFileIO({ getState: () => editor.getState(), executeCore: (...args) => editor.execute(...args), download: () => assert.fail('A collected stress export must not start downloads') });
  const before = await editor.execute('project.save');
  for (let cycle = 0; cycle < 3; cycle++) {
    io.beginCollection();
    const exported = await io.exportStems({ format: 'wav', bitDepth: 32, download: false });
    const files = readProjectZip(exported.bytes), collection = io.finishCollection();
    assert.equal(files.size, LIMITS.tracks); assert.equal(collection.files.length, 1);
    assert.equal(collection.total, exported.bytes.byteLength);
    for (let track = 0; track < LIMITS.tracks; track++) {
      const audio = decodeWav(files.get(`Track ${track + 1}.wav`));
      assert.equal(audio.channels[0].length, 1024);
      assert.ok(Math.abs(audio.channels[0][64] - (track + 1) * .0001 * Math.SQRT1_2) < 1e-7);
    }
  }
  assert.deepEqual(await editor.execute('project.save'), before);
  t.diagnostic(`192 encoded WAV stems in three independent ZIP collections completed in ${Math.round(performance.now() - started)} ms.`);
});

test('tiny high-rate surround clips reject projected multi-gigabyte timeline renders before allocation', async () => {
  const editor = new AudioEditor({ sampleRate: 192000, outputLayout: '7.1' });
  await editor.execute('clip.add', { name: 'At the end of the timeline', start: 599.99, audio: {
    sampleRate: 192000, layout: '7.1', channels: Array.from({ length: 8 }, () => new Float32Array(32).fill(.1)),
  } });
  const before = await editor.execute('project.save');
  await assert.rejects(editor.execute('audio.render', { scope: 'mix' }), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(await editor.execute('project.save'), before);
  const raw = await editor.execute('audio.render', { scope: 'clip', raw: true });
  assert.equal(raw.channels.length, 8); assert.equal(raw.channels[0].length, 32);
});
