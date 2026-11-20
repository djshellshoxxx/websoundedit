import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor, COMMANDS, LIMITS } from '../src/engine.js';
import { coreCommandDescriptors, validateCommandParams } from '../src/command-schema.js';

const SR = 8000;
const pcm = (channels, layout) => ({ sampleRate: SR, ...(layout ? { layout } : {}), channels: channels.map(channel => Float32Array.from(channel)) });
async function setup(audio = pcm([[1, 2, 3, 4], [-1, -2, -3, -4]]), start = 0) {
  const editor = new AudioEditor({ sampleRate: SR });
  await editor.execute('clip.add', { audio, name: 'Original', start });
  return editor;
}
const raw = editor => editor.execute('clip.getAudio');

test('insert silence is sample-exact, selects the new interval and is one reversible edit', async () => {
  const editor = await setup(undefined, 1), before = await editor.execute('project.save'), history = editor.getState().history.undo;
  await editor.execute('edit.insertSilence', { at: 2 / SR, duration: 3 / SR });
  assert.deepEqual(await raw(editor), pcm([[1, 2, 0, 0, 0, 3, 4], [-1, -2, 0, 0, 0, -3, -4]]));
  const state = editor.getState();
  assert.equal(state.tracks[0].clips[0].start, 1);
  assert.equal(state.selection.start, 2 / SR);
  assert.equal(state.selection.end, 5 / SR);
  assert.equal(state.selection.channels, 'all');
  assert.equal(state.history.undo, history + 1);
  await editor.execute('history.undo'); assert.deepEqual(await editor.execute('project.save'), before);
  await editor.execute('history.redo'); assert.equal((await raw(editor)).channels[0].length, 7);
});

test('silence supports exact beginning/end insertion and rejects empty, partial-channel and over-budget edits atomically', async () => {
  const editor = await setup();
  await editor.execute('edit.insertSilence', { at: 0, duration: 1 / SR });
  await editor.execute('edit.insertSilence', { at: 5 / SR, duration: 1 / SR });
  assert.deepEqual((await raw(editor)).channels[0], Float32Array.from([0, 1, 2, 3, 4, 0]));
  for (const params of [{ duration: 0 }, { duration: .4 / SR }, { duration: Infinity }, { at: -1, duration: 1 }, { at: 1, duration: 1 }, { channels: 'left', duration: 1 }]) {
    const before = await editor.execute('project.save'), history = editor.getState().history.undo;
    await assert.rejects(editor.execute('edit.insertSilence', params));
    assert.deepEqual(await editor.execute('project.save'), before);
    assert.equal(editor.getState().history.undo, history);
  }
  await editor.execute('selection.set', { start: 0, end: 2 / SR, channels: 'right' });
  await assert.rejects(editor.execute('edit.insertSilence', { duration: 1 / SR }), /All channels/);
  const limited = new AudioEditor({ sampleRate: 192000 });
  await limited.execute('clip.add', { audio: { sampleRate: 192000, layout: '7.1', channels: Array.from({ length: 8 }, () => new Float32Array(1)) } });
  const before = await limited.execute('project.save');
  await assert.rejects(limited.execute('edit.insertSilence', { duration: 60 }), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(await limited.execute('project.save'), before);
  const late = await setup(undefined, 599.99);
  await assert.rejects(late.execute('edit.insertSilence', { duration: .02 }), error => error.code === 'RESOURCE_LIMIT');
});

test('zero crossing snaps both boundaries within the radius, keeps PCM/history unchanged and uses deterministic ties', async () => {
  const editor = await setup(pcm([[1, 1, -1, -1, -1, -1, 1, 1, 1, -1]]));
  await editor.execute('selection.set', { start: 3 / SR, end: 8 / SR });
  const before = await raw(editor), history = editor.getState().history.undo;
  const result = await editor.execute('selection.zeroCrossing', { radiusMs: 1 });
  assert.equal(result.start, 2 / SR); assert.equal(result.end, 9 / SR);
  assert.deepEqual(await raw(editor), before); assert.equal(editor.getState().history.undo, history);
  await editor.execute('selection.set', { start: 4 / SR, end: 8 / SR });
  assert.equal((await editor.execute('selection.zeroCrossing', { radiusMs: 1 })).start, 2 / SR);
});

test('zero crossing handles exact zero, clip edges, antiphase and nonmatching channel crossings without collapsing the range', async () => {
  const samples = [0, 1, 1, -1, -1, 1, 1, 0];
  const editor = await setup(pcm([samples, samples.map(value => -value)]));
  await editor.execute('selection.set', { start: 0, end: 8 / SR });
  const edges = await editor.execute('selection.zeroCrossing', { radiusMs: 1 });
  assert.equal(edges.start, 0); assert.equal(edges.end, 8 / SR);
  await editor.execute('selection.set', { start: 2 / SR, end: 6 / SR });
  const shared = await editor.execute('selection.zeroCrossing', { radiusMs: 1 });
  assert.equal(shared.start, 3 / SR); assert.equal(shared.end, 5 / SR);
  const different = await setup(pcm([[1, 1, -1, -1, 1, 1, -1], [1, 1, 1, -1, -1, -1, -1]]));
  await different.execute('selection.set', { start: 1 / SR, end: 5 / SR });
  const unchanged = await different.execute('selection.zeroCrossing', { radiusMs: .2 });
  assert.equal(unchanged.start, 1 / SR); assert.equal(unchanged.end, 5 / SR);
  const oneChannel = await different.execute('selection.zeroCrossing', { channels: 'left', radiusMs: .2 });
  assert.equal(oneChannel.start, 2 / SR); assert.equal(oneChannel.end, 4 / SR);
  await editor.execute('selection.set', { start: 2 / SR, end: 3 / SR });
  const narrow = await editor.execute('selection.zeroCrossing', { radiusMs: 50 });
  assert.ok(narrow.end > narrow.start);
  await assert.rejects(editor.execute('selection.zeroCrossing', { radiusMs: 51 }));
  await editor.execute('selection.clear');
  await assert.rejects(editor.execute('selection.zeroCrossing'), /Select a nonempty interval/);
});

test('exact-zero snapping includes a zero-valued first and last sample instead of stopping immediately after or before it', async () => {
  const editor = await setup(pcm([[1, 0, 1, 1, 0, 1]]));
  await editor.execute('selection.set', { start: 2 / SR, end: 4 / SR });
  const selection = await editor.execute('selection.zeroCrossing', { radiusMs: .125 });
  assert.equal(selection.start, 1 / SR); assert.equal(selection.end, 5 / SR);
  const selected = await editor.execute('audio.render', { scope: 'selection', raw: true });
  assert.equal(selected.channels[0][0], 0); assert.equal(selected.channels[0].at(-1), 0);
});

test('channel extraction creates muted speaker-named mono tracks at the original position and preserves the source', async () => {
  const channels = Array.from({ length: 6 }, (_, channel) => [channel + 1, channel + .25, -channel]);
  const editor = await setup(pcm(channels, '5.1'), 2);
  await editor.execute('track.update', { gainDb: -3, solo: true });
  const before = await editor.execute('project.save'), source = editor.getState().tracks[0].clips[0], history = editor.getState().history.undo;
  const result = await editor.execute('clip.extractChannels');
  const state = editor.getState();
  assert.equal(state.tracks.length, 7); assert.equal(result.sourceClipId, source.id);
  assert.deepEqual(state.tracks[0].clips[0], source);
  for (let channel = 0; channel < 6; channel++) {
    const track = state.tracks[channel + 1], clip = track.clips[0];
    assert.equal(track.mute, true); assert.equal(track.solo, false); assert.equal(track.gainDb, -3);
    assert.match(track.name, new RegExp(`5.1 ${['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'][channel]}`));
    assert.equal(clip.start, 2); assert.equal(clip.channels, 1); assert.equal(clip.layout, 'mono');
    assert.deepEqual((await editor.execute('clip.getAudio', { clipId: clip.id })).channels[0], Float32Array.from(channels[channel]));
  }
  assert.equal(state.history.undo, history + 1);
  const saved = await editor.execute('project.save'), reopened = new AudioEditor();
  await reopened.execute('project.load', { project: saved });
  assert.deepEqual(await reopened.execute('project.save'), saved);
  await editor.execute('history.undo'); assert.deepEqual(await editor.execute('project.save'), before);
});

test('editing extracted PCM never changes source or siblings and extraction fails before track/clip limits', async () => {
  const editor = await setup(), sourceId = editor.getState().selectedClipId, source = await raw(editor);
  const result = await editor.execute('clip.extractChannels');
  assert.equal(result.tracks[0].pan, -1); assert.equal(result.tracks[1].pan, 1);
  await editor.execute('effect.invert');
  assert.deepEqual(await editor.execute('clip.getAudio', { clipId: sourceId }), source);
  assert.deepEqual((await editor.execute('clip.getAudio', { clipId: result.tracks[1].clips[0].id })).channels[0], source.channels[1]);
  await editor.execute('history.undo');
  while (editor.getState().tracks.length < LIMITS.tracks - 1) await editor.execute('track.add');
  const before = editor.getState();
  await assert.rejects(editor.execute('clip.extractChannels', { clipId: sourceId }), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(editor.getState(), before);
  const mono = await setup(pcm([[1, -1]]));
  await assert.rejects(mono.execute('clip.extractChannels'), /already mono/);
});

test('new editing operations have strict, discoverable macro/API contracts', () => {
  const descriptors = coreCommandDescriptors(COMMANDS);
  for (const [method, params] of [['edit.insertSilence', { at: 0, duration: .25 }], ['selection.zeroCrossing', { radiusMs: 5 }], ['clip.extractChannels', {}]]) {
    const descriptor = descriptors.find(item => item.method === method);
    assert.ok(descriptor, method); assert.equal(descriptor.recordable, true);
    assert.doesNotThrow(() => validateCommandParams(params, descriptor));
    assert.throws(() => validateCommandParams({ ...params, unknown: 1 }, descriptor));
  }
});

test('channel extraction respects portable PCM and clip-count limits even when copies share resident memory', async () => {
  const editor = await setup({ sampleRate: SR, layout: '7.1', channels: Array.from({ length: 8 }, () => new Float32Array(32768)) });
  const sourceId = editor.getState().selectedClipId;
  for (let index = 1; index < 256; index++) await editor.execute('clip.duplicate', { clipId: sourceId, start: 0 });
  const before = editor.getState();
  assert.ok(before.history.bytes < 2 * 1024 * 1024);
  await assert.rejects(editor.execute('clip.extractChannels', { clipId: sourceId }), /portable project PCM limit/);
  assert.deepEqual(editor.getState(), before);
  const tiny = await setup(), tinyId = tiny.getState().selectedClipId;
  for (let index = 1; index < LIMITS.clips; index++) await tiny.execute('clip.duplicate', { clipId: tinyId, start: 0 });
  const full = tiny.getState();
  await assert.rejects(tiny.execute('clip.extractChannels', { clipId: tinyId }), /track or clip limit/);
  assert.deepEqual(tiny.getState(), full);
});
