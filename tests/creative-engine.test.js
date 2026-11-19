import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { RACK_EFFECTS, createRackEffect } from '../src/rack-config.js';
import { processRackEffect } from '../src/rack-dsp.js';

const SR = 8000;
const tone = (frequency = 317, length = SR) => ({ sampleRate: SR, channels: [Float32Array.from({ length }, (_, i) => .4 * Math.sin(2 * Math.PI * frequency * i / SR))] });
const chord = () => ({ sampleRate: SR, channels: [Float32Array.from({ length: SR * 2 }, (_, i) => [48, 60, 64, 67].reduce((sum, note, index) => sum + (index === 1 ? .18 : .1) * Math.sin(2 * Math.PI * 440 * 2 ** ((note - 69) / 12) * i / SR), 0))] });
const firstClip = editor => editor.getState().tracks[0].clips[0];
const raw = editor => editor.execute('clip.getAudio');
async function setup(audio = tone()) { const editor = new AudioEditor({ sampleRate: SR }); await editor.execute('clip.add', { name: 'Fixture', audio }); return editor; }
const rack = [
  { id: 'saturate', effect: 'distortion', wet: .8, params: { drive: 5 } },
  { id: 'pulse', effect: 'tremolo', wet: 1, params: { depth: .8, rate: 4 } },
];

test('creative effects expose matching defaults and named commands, including zero-wet calls', async () => {
  for (const [effect, definition] of Object.entries(RACK_EFFECTS)) {
    const command = COMMANDS.find(entry => entry.method === `effect.${effect}`);
    assert.ok(command, effect);
    assert.equal(command.parameters.wet, definition.wet);
    const editor = await setup(tone(317, 800));
    const before = await raw(editor);
    await editor.execute(`effect.${effect}`, { wet: 0 });
    assert.deepEqual(await raw(editor), before, effect);
  }
  const editor = await setup();
  const before = await raw(editor);
  await editor.execute('effect.distortion', { drive: 6 });
  assert.deepEqual(await raw(editor), processRackEffect(before, 'distortion', { drive: 6 }, RACK_EFFECTS.distortion.wet));
});

test('rack preview and apply process one selected channel with exact untouched boundaries and one undo step', async () => {
  const audio = tone(); audio.channels.push(Float32Array.from(audio.channels[0], sample => -sample * .5));
  const editor = await setup(audio);
  await editor.execute('selection.set', { start: .2, end: .7, channels: 'right' });
  const before = await raw(editor), state = editor.getState();
  const preview = await editor.execute('effect.preview', { effect: 'rack', params: { chain: rack } });
  assert.deepEqual(editor.getState(), state);
  assert.deepEqual(await raw(editor), before);
  assert.deepEqual(preview.channels[0], before.channels[0]);
  assert.deepEqual(preview.channels[1].slice(0, SR * .2), before.channels[1].slice(0, SR * .2));
  assert.deepEqual(preview.channels[1].slice(SR * .7), before.channels[1].slice(SR * .7));
  assert.notDeepEqual(preview.channels[1].slice(SR * .2, SR * .7), before.channels[1].slice(SR * .2, SR * .7));
  await editor.execute('effect.rack', { chain: rack });
  assert.deepEqual(await raw(editor), preview);
  assert.equal(editor.getState().history.undo, state.history.undo + 1);
  assert.deepEqual(editor.getState().selection, state.selection);
  await editor.execute('history.undo'); assert.deepEqual(await raw(editor), before);
  await editor.execute('history.redo'); assert.deepEqual(await raw(editor), preview);
});

test('rack audition renders processed PCM without committing or changing sample key metadata', async () => {
  const editor = await setup();
  await editor.execute('clip.key', { tonic: 9, mode: 'minor' });
  await editor.execute('selection.set', { start: .25, end: .75 });
  const before = await editor.execute('project.save');
  const output = await editor.execute('audio.renderPreview', { effect: 'rack', params: { chain: rack }, scope: 'selection' });
  assert.equal(output.channels[0].length, SR * .5);
  assert.deepEqual(await editor.execute('project.save'), before);
});

test('invalid later rack stages and invalid standalone wet amounts roll back audio and metadata', async () => {
  const editor = await setup();
  await editor.execute('clip.key', { tonic: 0, mode: 'major' });
  const before = await editor.execute('project.save'), history = editor.getState().history.undo;
  await assert.rejects(editor.execute('effect.rack', { chain: [...rack, { id: 'bad', effect: 'delay', wet: 1, params: { feedback: 2 } }] }));
  await assert.rejects(editor.execute('effect.tape', { wet: NaN }));
  await assert.rejects(editor.execute('effect.rack', { chain: Array.from({ length: 13 }, (_, i) => ({ ...createRackEffect('delay'), id: `delay${i}` })) }));
  assert.deepEqual(await editor.execute('project.save'), before);
  assert.equal(editor.getState().history.undo, history);
});

test('key detection analyzes whole clips independently of the current channel or selection', async () => {
  const editor = await setup(chord());
  await editor.execute('selection.set', { start: 0, end: .05 });
  const result = await editor.execute('analysis.key');
  assert.equal(result.key, 'C major');
  assert.deepEqual(firstClip(editor).keyAnalysis, result);
  result.chroma[0] = 0; result.reason = 'Caller mutation';
  assert.notEqual(firstClip(editor).keyAnalysis.reason, result.reason);
  await editor.execute('clip.add', { audio: { sampleRate: SR, channels: [new Float32Array(SR)] }, name: 'Silence' });
  const all = await editor.execute('analysis.keyAll');
  assert.equal(all.length, 2);
  assert.equal(all[0].key, 'C major');
  assert.equal(all[1].key, null);
});

test('manual key survives movement and duplication, clears on each PCM edit, and restores through undo', async () => {
  const editor = await setup();
  await editor.execute('clip.key', { tonic: 2, mode: 'minor' });
  await editor.execute('clip.update', { start: .5, name: 'Moved' });
  assert.equal(firstClip(editor).keyAnalysis.key, 'D minor');
  const duplicate = await editor.execute('clip.duplicate');
  assert.equal(duplicate.keyAnalysis.key, 'D minor');
  const edited = await editor.execute('effect.rack', { chain: rack });
  assert.equal(edited.keyAnalysis, null);
  assert.equal(editor.getState().tracks[0].clips[1].keyAnalysis, null);
  assert.equal(firstClip(editor).keyAnalysis.key, 'D minor');
  await editor.execute('history.undo');
  assert.equal(editor.getState().tracks[0].clips[1].keyAnalysis.key, 'D minor');
  const split = await editor.execute('clip.split', { at: .5 });
  assert.equal(split.left.keyAnalysis, null);
  assert.equal(split.right.keyAnalysis, null);
  assert.ok(editor.getState().tracks[0].clips.slice(1).every(clip => clip.keyAnalysis === null));
});

test('trim, delete and paste invalidate a key immediately, including returned clip data', async () => {
  for (const method of ['edit.trim', 'edit.delete', 'edit.paste']) {
    const editor = await setup();
    await editor.execute('clip.key', { tonic: 5, mode: 'major' });
    await editor.execute('selection.set', { start: .2, end: .4 });
    if (method === 'edit.paste') await editor.execute('edit.copy');
    const result = await editor.execute(method);
    assert.equal(firstClip(editor).keyAnalysis, null, method);
    if (typeof result === 'object') assert.equal(result.keyAnalysis, null, method);
  }
});

test('recipes invalidate analysis made before an edit and retain analysis computed after it', async () => {
  const editor = await setup(chord());
  await editor.execute('recipe.run', { commands: [
    { method: 'analysis.key' }, { method: 'effect.pitch', params: { semitones: 2 } },
  ] });
  assert.equal(firstClip(editor).keyAnalysis, null);
  await editor.execute('recipe.run', { commands: [
    { method: 'effect.gain', params: { db: -1 } }, { method: 'analysis.key' },
  ] });
  assert.equal(firstClip(editor).keyAnalysis.key, 'D major');
  const before = await editor.execute('project.save');
  await assert.rejects(editor.execute('recipe.run', { commands: [
    { method: 'effect.silence' }, { method: 'clip.key', params: { tonic: 19, mode: 'major' } },
  ] }));
  assert.deepEqual(await editor.execute('project.save'), before);
});

test('project save/load preserves exact PCM, key, metadata and rack settings without exposing mutable metadata', async () => {
  const editor = await setup();
  await editor.execute('clip.key', { tonic: 11, mode: 'major' });
  await editor.execute('metadata.update', { metadata: { title: 'A <title>', artist: 'Stereo & Mono', comment: 'First line\nSecond line', track: 2 } });
  const settings = { ui: { theme: 'light', inspectorCollapsed: true, rack: { version: 1, chain: rack, xy: { x: { id: 'saturate', key: 'wet' }, y: { id: 'pulse', key: 'depth' } } } } };
  await editor.execute('settings.load', { settings });
  const saved = await editor.execute('project.save'), other = new AudioEditor({ sampleRate: SR });
  await other.execute('project.load', { project: structuredClone(saved) });
  assert.deepEqual(await raw(other), await raw(editor));
  assert.deepEqual(firstClip(other).keyAnalysis, firstClip(editor).keyAnalysis);
  assert.deepEqual(other.getState().settings, settings);
  assert.deepEqual(other.getState().metadata, { title: 'A <title>', artist: 'Stereo & Mono', comment: 'First line\nSecond line', track: '2' });
  saved.tracks[0].clips[0].keyAnalysis.chroma.fill(1);
  saved.tracks[0].clips[0].keyAnalysis.reason = 'Corrupted caller value';
  saved.metadata.title = 'Corrupted';
  assert.equal(firstClip(editor).keyAnalysis.reason, 'Manually assigned');
  assert.equal(editor.getState().metadata.title, 'A <title>');
});

test('metadata-only commands leave PCM and key untouched, are undoable, and reject malformed input', async () => {
  const editor = await setup();
  await editor.execute('clip.key', { tonic: 4, mode: 'minor' });
  const before = await raw(editor), key = firstClip(editor).keyAnalysis;
  await editor.execute('metadata.update', { metadata: { title: 'Title' } });
  assert.deepEqual(await raw(editor), before);
  assert.deepEqual(firstClip(editor).keyAnalysis, key);
  await editor.execute('history.undo'); assert.deepEqual(editor.getState().metadata, {});
  await editor.execute('history.redo'); assert.equal(editor.getState().metadata.title, 'Title');
  for (const metadata of [{ invalid: 'value' }, { title: 'Bad\u0000title' }, { artist: 'a'.repeat(1025) }, []]) await assert.rejects(editor.execute('metadata.update', { metadata }));
  const saved = await editor.execute('project.save');
  const malformed = structuredClone(saved); malformed.tracks[0].clips[0].keyAnalysis.chroma = [NaN];
  await assert.rejects(editor.execute('project.load', { project: malformed }));
  assert.deepEqual(await editor.execute('project.save'), saved);
});
