import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor, COMMANDS, EFFECTS } from '../src/engine.js';
const sr = 8000;
const pcm = (channels, sampleRate = sr) => ({ sampleRate, channels: channels.map(x => Float32Array.from(x)) });
const constant = (length = 8000, value = 0.2, channelCount = 1) => ({ sampleRate: sr, channels: Array.from({ length: channelCount }, () => new Float32Array(length).fill(value)) });
const makeEditor = () => new AudioEditor({ sampleRate: sr });
async function raw(editor, clipId) { return editor.execute('clip.getAudio', { clipId }); }

test('all DSP features have named API methods', () => {
  for (const effect of EFFECTS) assert.ok(COMMANDS.find(c => c.method === `effect.${effect.effect}`));
  assert.equal(new Set(COMMANDS.map(c => c.method)).size, COMMANDS.length);
});

test('selection-only gain changes actual PCM and preserves untouched samples', async () => {
  const editor = makeEditor(); const clip = await editor.execute('clip.add', { audio: constant(), name: 'Source' });
  await editor.execute('selection.set', { start: .25, end: .5 });
  await editor.execute('effect.gain', { db: -6.020599913279624 });
  const audio = await raw(editor);
  assert.ok(Math.abs(audio.channels[0][1999] - .2) < 1e-7);
  assert.ok(Math.abs(audio.channels[0][2000] - .1) < 1e-7);
  assert.ok(Math.abs(audio.channels[0][3999] - .1) < 1e-7);
  assert.ok(Math.abs(audio.channels[0][4000] - .2) < 1e-7);
  assert.equal(editor.getState().selectedClipId, clip.clipId);
  assert.equal(await editor.execute('history.undo'), true);
  assert.deepEqual((await raw(editor)).channels[0], constant().channels[0]);
  await editor.execute('history.redo'); assert.deepEqual((await raw(editor)).channels[0], audio.channels[0]);
});

test('right-channel preview is isolated and does not alter history or PCM', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant(8000, .3, 2) });
  await editor.execute('selection.set', { start: .1, end: .2, channels: 'right' });
  const before = editor.getState();
  const preview = await editor.execute('effect.preview', { effect: 'invert' });
  assert.equal(preview.channels[0][1000], (await raw(editor)).channels[0][1000]);
  assert.equal(preview.channels[1][1000], -(await raw(editor)).channels[1][1000]);
  assert.deepEqual(editor.getState(), before);
  await editor.execute('effect.invert');
  assert.deepEqual((await raw(editor)).channels, preview.channels);
  await assert.rejects(editor.execute('effect.stretch', { ratio: 2 }), /All channels/);
});

test('an invalid explicit selection never falls back to the whole clip', async () => {
  const editor = makeEditor(); const clip = await editor.execute('clip.add', { audio: constant() });
  const before = await raw(editor);
  await assert.rejects(editor.execute('effect.reverse', { target: { clipId: clip.clipId, start: .5, end: .5 } }), /at least one sample/);
  await assert.rejects(editor.execute('effect.reverse', { target: { start: .25 } }), /both start and end/);
  await assert.rejects(editor.execute('selection.set', { start: 2, end: 3 }), /at least one sample/);
  assert.deepEqual((await raw(editor)).channels, before.channels);
});

test('copy, cut, paste and trim preserve clip-relative selection semantics', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant(), start: 2 });
  await editor.execute('selection.set', { start: .2, end: .4 });
  await editor.execute('edit.cut'); assert.equal(editor.getState().tracks[0].clips[0].duration, .8);
  await editor.execute('edit.paste', { at: .3 }); assert.equal(editor.getState().tracks[0].clips[0].duration, 1);
  assert.equal(editor.getState().selection.start, .3); assert.equal(editor.getState().selection.end, .5);
  await editor.execute('edit.trim'); assert.equal(editor.getState().tracks[0].clips[0].start, 2.3); assert.equal(editor.getState().tracks[0].clips[0].duration, .2);
  assert.equal(editor.getState().selection.start, 0);
});

test('split and duplicate keep independent editable clip buffers', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant(), start: 1 });
  const split = await editor.execute('clip.split', { at: .4 });
  assert.equal(split.left.duration, .4); assert.equal(split.right.duration, .6); assert.equal(split.right.start, 1.4);
  const duplicate = await editor.execute('clip.duplicate'); assert.equal(duplicate.start, 2);
  await editor.execute('effect.silence');
  assert.ok((await raw(editor, split.right.id)).channels[0].every(v => v > .1));
  assert.ok((await raw(editor, duplicate.id)).channels[0].every(v => v === 0));
});

test('mixing honors clip offsets, gain, pan, mute and solo', async () => {
  const editor = makeEditor(); const first = await editor.execute('clip.add', { audio: constant(), start: .25 });
  await editor.execute('track.update', { trackId: first.trackId, pan: -1 });
  const second = await editor.execute('clip.add', { audio: constant(), start: .5 });
  await editor.execute('track.update', { trackId: second.trackId, pan: 1, gainDb: -6.020599913279624 });
  let mix = await editor.execute('audio.render');
  assert.equal(mix.channels[0].length, 12000); assert.equal(mix.channels[0][0], 0);
  assert.ok(Math.abs(mix.channels[0][6000] - .2) < 1e-7); assert.ok(Math.abs(mix.channels[1][6000] - .1) < 1e-7);
  await editor.execute('track.update', { trackId: second.trackId, solo: true });
  mix = await editor.execute('audio.render'); assert.ok(Math.abs(mix.channels[0][6000]) < 1e-7);
  await editor.execute('track.update', { trackId: second.trackId, mute: true });
  mix = await editor.execute('audio.render'); assert.ok(mix.channels.every(c => c.every(v => v === 0)));
});

test('portable JSON round trip retains exact float PCM and selection', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: pcm([[0, -.25, .5, 1.25], [.3, .1, -.6, 0]]) });
  await editor.execute('selection.set', { start: 0, end: 2 / sr, channels: 'left' });
  await editor.execute('project.update', { name: 'Round trip', bpm: 137.25 });
  await editor.execute('settings.load', { settings: { shortcuts: { play: 'Space' }, effects: { gain: { db: -3 } } } });
  const exported = await editor.execute('project.save'); const other = makeEditor();
  await other.execute('project.load', { project: JSON.parse(JSON.stringify(exported)) });
  assert.deepEqual((await raw(other)).channels, (await raw(editor)).channels);
  assert.deepEqual(other.getState().selection, editor.getState().selection);
  assert.equal(other.getState().name, 'Round trip'); assert.equal(other.getState().bpm, 137.25);
  assert.deepEqual(other.getState().settings, editor.getState().settings);
});

test('malformed project and invalid edit roll back atomically', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant() });
  const before = await editor.execute('project.save');
  const invalid = structuredClone(before); invalid.tracks[0].clips[0].audio.frames = 999;
  await assert.rejects(editor.execute('project.load', { project: invalid }), /length/);
  assert.deepEqual(await editor.execute('project.save'), before);
  await assert.rejects(editor.execute('track.update', { gainDb: -6, pan: 8 }), /Pan/);
  assert.equal(editor.getState().tracks[0].gainDb, 0);
  await assert.rejects(editor.execute('recipe.run', { commands: [{ method: 'effect.gain', params: { db: -6 } }, { method: 'effect.pitch', params: { semitones: NaN } }] }));
  assert.deepEqual(await editor.execute('project.save'), before);
});

test('history invalidates redo after a new edit and raw buffers cannot mutate engine', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant() });
  const audio = await raw(editor); audio.channels[0].fill(0); assert.ok((await raw(editor)).channels[0][0] > 0);
  await editor.execute('effect.invert'); await editor.execute('history.undo'); assert.equal(editor.getState().canRedo, true);
  await editor.execute('effect.gain', { db: -1 }); assert.equal(editor.getState().canRedo, false);
});

test('concurrent callers are serialized and a failed command does not poison the queue', async () => {
  const editor = makeEditor();
  const results = await Promise.allSettled([editor.execute('clip.add', { audio: constant() }), editor.execute('effect.gain', { db: -6 }), editor.execute('invalid.method'), editor.execute('project.update', { bpm: 90 })]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']); assert.equal(editor.getState().bpm, 90);
});

test('channel-layout change upmixes a mono clip instead of discarding panning', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant() });
  await editor.execute('effect.pan', { pan: -1 }); const audio = await raw(editor);
  assert.equal(audio.channels.length, 2); assert.ok(audio.channels[1].every(v => Math.abs(v) < 1e-7));
});

test('true sidechain requires a different existing track and renders the aligned trigger', async () => {
  const editor = makeEditor(); const source = await editor.execute('clip.add', { audio: constant(4000, .8), start: .5 });
  const target = await editor.execute('clip.add', { audio: constant(8000, .5) });
  await assert.rejects(editor.execute('effect.duck', { source: 'track', sourceTrackId: target.trackId }), /another track/);
  await editor.execute('effect.duck', { source: 'track', sourceTrackId: source.trackId, mode: 'compressor', thresholdDb: -20, ratio: 8, attackMs: 1, releaseMs: 20, depth: 1 });
  const audio = await raw(editor); assert.ok(audio.channels[0][1000] > audio.channels[0][6000] * 2);
});

test('selection export honors isolated channel and track gain without altering the source', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: pcm([new Array(8000).fill(.25), new Array(8000).fill(.5)]) });
  await editor.execute('selection.set', { start: .25, end: .5, channels: 'right' });
  await editor.execute('track.update', { gainDb: -6.020599913279624 });
  const rendered = await editor.execute('audio.render', { scope: 'selection' });
  assert.equal(rendered.channels.length, 1); assert.equal(rendered.channels[0].length, 2000); assert.ok(Math.abs(rendered.channels[0][0] - .25) < 1e-7);
  assert.equal((await raw(editor)).channels[1][0], .5);
});

test('draft effect renders through the mixer and leaves project, selection and history untouched', async () => {
  const editor = makeEditor(); await editor.execute('clip.add', { audio: constant(), start: .5 });
  await editor.execute('selection.set', { start: .25, end: .5 });
  const state = editor.getState(), original = await raw(editor);
  const preview = await editor.execute('audio.renderPreview', { effect: 'gain', params: { db: -6.020599913279624 }, scope: 'mix' });
  assert.equal(preview.channels[0].length, 12000);
  assert.ok(Math.abs(preview.channels[0][6500] - .1 / Math.sqrt(2)) < 1e-7);
  assert.ok(Math.abs(preview.channels[0][4500] - .2 / Math.sqrt(2)) < 1e-7);
  assert.deepEqual(editor.getState(), state); assert.deepEqual((await raw(editor)).channels, original.channels);
  const stretched = await editor.execute('audio.renderPreview', { effect: 'stretch', params: { ratio: 2 }, scope: 'selection' });
  assert.equal(stretched.channels[0].length, 4000); assert.deepEqual(editor.getState(), state);
});

test('removing a completely silent clip removes it and remains undoable', async () => {
  const editor = makeEditor(); const added = await editor.execute('clip.add', { audio: constant(8000, 0) });
  const result = await editor.execute('effect.removeSilence', { thresholdDb: -40, minDuration: .1, padding: 0 });
  assert.equal(result.removed, true); assert.equal(editor.getState().tracks[0].clips.length, 0); assert.equal(editor.getState().selection, null);
  await editor.execute('history.undo'); assert.equal(editor.getState().selectedClipId, added.clipId); assert.equal((await raw(editor)).channels[0].length, 8000);
});

test('partial mono pan preserves audible samples outside the selection under the track pan law', async () => {
  for (const pan of [0, .55, -.8, 1, -1]) {
    const editor = makeEditor(); await editor.execute('clip.add', { audio: constant() });
    await editor.execute('track.update', { pan });
    const before = await editor.execute('audio.render', { scope: 'mix' });
    await editor.execute('selection.set', { start: .25, end: .5 });
    await editor.execute('effect.pan', { pan: .9 });
    const after = await editor.execute('audio.render', { scope: 'mix' });
    for (const ch of [0, 1]) for (const index of [10, 1999, 4000, 7999]) assert.ok(Math.abs(before.channels[ch][index] - after.channels[ch][index]) < 1e-7, `outside selection changed at pan ${pan}`);
  }
});
