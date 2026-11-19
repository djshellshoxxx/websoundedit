import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { Playback } from '../src/playback.js';
import { createBrowserRuntime } from '../src/sdk-runtime.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** Real SDK/live/engine composition; only external capabilities are inert. */
function fixture({ playback = new Playback() } = {}) {
  const calls = { microphone: 0, display: 0, context: 0, capture: 0, storage: 0, storageDisposed: 0 };
  const denied = key => { calls[key]++; throw new Error(`Unexpected external capability: ${key}`); };
  const navigator = { mediaDevices: { getUserMedia: async () => denied('microphone'), getDisplayMedia: async () => denied('display'), enumerateDevices: async () => [] } };
  const storage = { queuedBytes: 0, execute: async () => denied('storage'), dispose: () => { calls.storageDisposed++; } };
  const engine = new AudioEditor({ sampleRate: 8000, outputLayout: 'stereo', name: 'SDK fixture' });
  const runtime = createBrowserRuntime({ engine, playback, navigator, storage, contextFactory: () => denied('context'), captureFactory: async () => denied('capture') });
  const assertSilent = () => {
    for (const key of ['microphone', 'display', 'context', 'capture', 'storage']) assert.equal(calls[key], 0, key);
    assert.equal(runtime.live.context, null); assert.equal(runtime.live.getState().input.active, false); assert.equal(playback.playing, false);
  };
  return { runtime, engine, calls, assertSilent };
}

async function populated(fixture, name = 'Saved') {
  const { runtime } = fixture;
  const clip = await runtime.execute('clip.add', { name: `${name} clip`, audio: { sampleRate: 8000, channels: [Float32Array.from({ length: 400 }, (_, i) => .2 * Math.sin(i / 8))] }, start: .005 });
  await runtime.execute('track.update', { trackId: clip.trackId, name: `${name} track` });
  await runtime.execute('project.update', { name });
  await runtime.execute('live.rack.set', { chain: [{ id: 'master-delay', effect: 'delay', wet: .35, params: { timeMs: 10, feedback: .2 } }] });
  await runtime.execute('live.rack.set', { target: { trackId: clip.trackId }, chain: [{ id: 'track-filter', effect: 'filter', wet: .6, params: { frequency: 1700 } }] });
  await runtime.execute('automation.set', { target: { trackId: clip.trackId }, lanes: [{ slotId: 'track-filter', param: 'wet', points: [{ time: 0, value: .2, curve: 'linear' }, { time: .05, value: .8, curve: 'step' }] }] });
  const saved = await runtime.execute('project.save'); fixture.assertSilent(); return { saved, clip };
}

test('browser SDK construction, save and serialized load retain live racks without requesting permission', async () => {
  const current = fixture();
  try {
    current.assertSilent(); const { saved, clip } = await populated(current), expectedSettings = structuredClone(saved.settings.live);
    assert.ok(expectedSettings.racks[clip.trackId]);
    const expectedAudio = await current.runtime.execute('live.render', { scope: 'mix' });
    await current.runtime.execute('project.new', { name: 'Replacement', sampleRate: 8000 });
    await current.runtime.execute('live.rack.set', { chain: [{ id: 'unrelated', effect: 'tremolo', wet: .9 }] });
    await current.runtime.execute('project.load', { project: JSON.stringify(saved) });
    // Facade state events trigger asynchronous live resets; restored settings
    // must still exist after that event/reset continuation has had time to run.
    await nextTask();
    assert.deepEqual(current.runtime.live.getSettings(), expectedSettings);
    const reopened = await current.runtime.execute('project.save');
    assert.equal(reopened.name, saved.name); assert.deepEqual(reopened.tracks, saved.tracks); assert.deepEqual(reopened.settings.live, expectedSettings);
    assert.deepEqual(await current.runtime.execute('live.render', { scope: 'mix' }), expectedAudio);
    current.assertSilent();
  } finally { await current.runtime.dispose(); }
});

test('browser SDK recipe aliases restore final saved live settings after project replacement', async t => {
  const source = fixture(); let saved;
  try { ({ saved } = await populated(source, 'Recipe source')); } finally { await source.runtime.dispose(); }
  const finalSettings = structuredClone(saved.settings);
  finalSettings.live.racks.master.chain[0].wet = .81;
  const aliases = {
    commands: commands => ({ commands }),
    steps: steps => ({ steps }),
    'recipe array': recipe => ({ recipe }),
    'recipe commands': commands => ({ recipe: { commands } }),
    'recipe steps': steps => ({ recipe: { steps } }),
  };
  for (const [name, wrap] of Object.entries(aliases)) await t.test(name, async () => {
    const current = fixture();
    try {
      await current.runtime.execute('live.rack.set', { chain: [{ id: 'old', effect: 'tremolo', wet: .4 }] });
      await current.runtime.execute('recipe.run', wrap([
        { method: 'project.new', params: { sampleRate: 8000 } },
        { method: 'project.load', params: { project: JSON.stringify(saved) } },
        { method: 'settings.load', params: { settings: finalSettings } },
      ]));
      await nextTask();
      assert.deepEqual(current.runtime.live.getSettings(), finalSettings.live);
      const reopened = await current.runtime.execute('project.save');
      assert.deepEqual(reopened.settings.live, finalSettings.live); assert.deepEqual(reopened.tracks, saved.tracks);
      current.assertSilent();
    } finally { await current.runtime.dispose(); }
  });
  await t.test('a final project.new clears the earlier loaded racks', async () => {
    const current = fixture();
    try {
      await current.runtime.execute('recipe.run', { recipe: { steps: [{ method: 'project.load', params: { project: saved } }, { method: 'project.new', params: { sampleRate: 8000 } }] } });
      await nextTask();
      assert.deepEqual(current.runtime.live.getSettings(), { version: 1, racks: { master: { chain: [], automation: [] } } });
      assert.equal(current.engine.getState().tracks.length, 0); current.assertSilent();
    } finally { await current.runtime.dispose(); }
  });
});

test('invalid serialized live settings reject before replacing the current SDK project or racks', async () => {
  const current = fixture();
  try {
    const { saved } = await populated(current), before = await current.runtime.execute('project.save'), invalid = structuredClone(saved);
    invalid.settings.live.racks.master.chain[0].wet = 9;
    await assert.rejects(current.runtime.execute('project.load', { project: JSON.stringify(invalid) }), /wet/);
    assert.deepEqual(await current.runtime.execute('project.save'), before); current.assertSilent();
  } finally { await current.runtime.dispose(); }
});

test('SDK disposal closes command admission before asynchronous owned-resource teardown', async () => {
  const entered = deferred(), release = deferred(), playback = new Playback(), originalDispose = playback.dispose.bind(playback);
  playback.dispose = async () => { entered.resolve(); await release.promise; await originalDispose(); };
  const current = fixture({ playback }); let disposing;
  try {
    await current.runtime.execute('track.add', { name: 'Keep' });
    const before = await current.engine.execute('project.save');
    disposing = current.runtime.dispose();
    await assert.rejects(current.runtime.execute('track.add', { name: 'Too late' }), { code: 'DISPOSED' });
    await entered.promise;
    await assert.rejects(current.runtime.execute('project.new'), { code: 'DISPOSED' });
    assert.deepEqual(await current.engine.execute('project.save'), before);
    assert.equal(current.calls.storageDisposed, 1); current.assertSilent();
    release.resolve(); await disposing;
    await assert.rejects(current.runtime.execute('project.state'), { code: 'DISPOSED' });
  } finally { release.resolve(); if (disposing) await disposing; else await current.runtime.dispose(); }
});
