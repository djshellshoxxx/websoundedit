import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_PRESETS, DEFAULT_PRESET_ID, PRESET_CATEGORIES, getAudioPreset } from '../src/presets.js';
import { processPreset } from '../src/preset-dsp.js';
import { autoLimit, deEss, processStereoCenter, repairClipping } from '../src/restoration-dsp.js';
import { dbToGain } from '../src/dsp.js';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { coreCommandDescriptors, validateCommandParams } from '../src/command-schema.js';

const SR = 48000;
const audio = (channels, sampleRate = SR, layout) => ({ sampleRate, ...(layout ? { layout } : {}), channels: channels.map(channel => Float32Array.from(channel)) });
const tone = (frequency, amplitude = .3, frames = SR / 2, sampleRate = SR) => Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
const peak = samples => samples.reduce((p, value) => Math.max(p, Math.abs(value)), 0);
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
const mse = (a, b) => a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0) / a.length;
function amplitude(samples, frequency, sampleRate = SR) {
  const start = Math.floor(samples.length / 4), end = samples.length - start;
  let real = 0, imaginary = 0;
  for (let i = start; i < end; i++) { const angle = 2 * Math.PI * frequency * i / sampleRate; real += samples[i] * Math.cos(angle); imaginary += samples[i] * Math.sin(angle); }
  return 2 * Math.hypot(real, imaginary) / (end - start);
}
async function setup(input, start = 0) {
  const editor = new AudioEditor({ sampleRate: input.sampleRate });
  await editor.execute('clip.add', { audio: input, start, name: 'Preset source' });
  return editor;
}

test('32 immutable named presets cover seven categories with bounded inspectable steps', () => {
  assert.equal(AUDIO_PRESETS.length, 32);
  assert.equal(new Set(AUDIO_PRESETS.map(preset => preset.id)).size, 32);
  assert.deepEqual([...new Set(AUDIO_PRESETS.map(preset => preset.category))], PRESET_CATEGORIES);
  assert.equal(getAudioPreset(DEFAULT_PRESET_ID).id, 'auto-limiter');
  for (const preset of AUDIO_PRESETS) {
    assert.equal(getAudioPreset(preset.id), preset);
    assert.ok(preset.title && preset.description);
    assert.ok(preset.steps.length >= 1 && preset.steps.length <= 4);
    assert.ok(Object.isFrozen(preset) && Object.isFrozen(preset.steps));
    for (const step of preset.steps) assert.ok(typeof step.effect === 'string' && Object.isFrozen(step.params));
    if (preset.stereoOnly) assert.match(preset.limitations, /not AI source separation/);
  }
  assert.throws(() => { AUDIO_PRESETS[0].steps[0].params.threshold = .1; });
  for (const id of ['unknown', '__proto__', 'constructor', null, 1]) assert.throws(() => getAudioPreset(id));
});

test('every preset preserves input, layout and exact dimensions at all supported sample-rate extremes', async () => {
  for (const sampleRate of [8000, 48000, 192000]) {
    const input = audio([tone(300, .45, 513, sampleRate), tone(700, .25, 513, sampleRate)], sampleRate, 'stereo');
    const before = structuredClone(input);
    for (const preset of AUDIO_PRESETS) {
      const result = await processPreset(input, { presetId: preset.id });
      assert.equal(result.sampleRate, sampleRate, preset.id); assert.equal(result.layout, 'stereo', preset.id);
      assert.equal(result.channels.length, 2, preset.id);
      for (const channel of result.channels) {
        assert.equal(channel.length, 513, preset.id);
        assert.ok(channel.every(Number.isFinite), preset.id);
      }
      assert.deepEqual(input, before, preset.id);
    }
  }
});

test('all presets handle a single-frame selection and silent PCM without non-finite output', async () => {
  for (const preset of AUDIO_PRESETS) for (const values of [[.7, -.2], [0, 0]]) {
    const input = audio(values.map(value => [value]));
    const result = await processPreset(input, { presetId: preset.id });
    assert.equal(result.channels.length, 2);
    for (const channel of result.channels) { assert.equal(channel.length, 1); assert.ok(Number.isFinite(channel[0])); }
    if (values[0] === 0) for (const channel of result.channels) assert.equal(Math.abs(channel[0]), 0, preset.id);
  }
});

test('non-stereo presets support surround and arbitrary selected channel groups without layout conversion', async () => {
  for (const count of [1, 3, 6, 8]) {
    const layout = count === 6 ? '5.1' : count === 8 ? '7.1' : undefined;
    const input = audio(Array.from({ length: count }, (_, c) => tone(200 + 300 * c, .2, 257)), SR, layout);
    for (const preset of AUDIO_PRESETS.filter(preset => !preset.stereoOnly)) {
      const output = await processPreset(input, { presetId: preset.id });
      assert.equal(output.channels.length, count, preset.id); assert.equal(output.layout, layout, preset.id);
      assert.ok(output.channels.every(channel => channel.length === 257 && channel.every(Number.isFinite)), preset.id);
    }
  }
});

test('clipped-peak reconstruction materially improves a clipped sine instead of merely scaling its flat tops', () => {
  for (const frequency of [250, 1000]) {
    const original = tone(frequency, 1.2, SR / 4);
    const clipped = original.map(value => Math.max(-1, Math.min(1, value)));
    const input = audio([clipped]), before = structuredClone(input);
    const repaired = repairClipping(input, { ceilingDb: null });
    assert.ok(repaired.repairInfo.repairedPeaks > 50);
    assert.ok(mse(repaired.channels[0], original) < mse(clipped, original) * .02);
    assert.ok(peak(repaired.channels[0]) > 1.1);
    assert.ok(peak(repaired.channels[0]) <= dbToGain(6) + 1e-7);
    assert.deepEqual(input, before);
  }
});

test('clipping repair skips unsupported long/edge/square peaks and does not alter clean PCM', () => {
  const clean = tone(700, .7, 4000), square = Float32Array.from({ length: 4000 }, (_, i) => i % 24 < 12 ? 1 : -1);
  const long = new Float32Array(4000).fill(1), edge = Float32Array.from([1, 1, 1, .95, .8, .6, .3, 0]);
  for (const samples of [clean, square, long, edge]) {
    const result = repairClipping(audio([samples]));
    assert.equal(result.repairInfo.repairedPeaks, 0); assert.equal(result.repairInfo.appliedGain, 1);
    assert.deepEqual(result.channels[0], samples);
  }
});

test('clean near-full-scale peaks do not trigger repair, rounding changes or whole-clip attenuation', () => {
  for (const [sampleRate, frequency, phase] of [[8000, 100, .5], [8000, 250, .5], [48000, 1000, .5], [8000, 1, .5], [44100, 6, 0]]) for (const amplitude of [.99, 1]) {
    // Sampling halfway around a sine maximum produces two exactly equal
    // adjacent samples without clipping the continuous signal. Slow clean
    // peaks can also have several samples within the plateau tolerance.
    const length = Math.max(sampleRate / 10, Math.ceil(2 * sampleRate / frequency));
    const samples = Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * (i + phase) / sampleRate));
    const input = audio([samples], sampleRate), result = repairClipping(input);
    assert.equal(result.repairInfo.repairedPeaks, 0, `${frequency} Hz at ${sampleRate} Hz`);
    assert.equal(result.repairInfo.appliedGain, 1);
    assert.deepEqual(result.channels[0], samples);
  }
});

test('the repair preset restores curvature and reserves sample-peak headroom with linked gain', async () => {
  const signal = tone(1000, 1.2, SR / 4).map(value => Math.max(-1, Math.min(1, value)));
  const originalRight = tone(250, .3, signal.length), input = audio([signal, originalRight], SR, 'stereo');
  const result = await processPreset(input, { presetId: 'repair-clipped-peaks' });
  assert.ok(result.repairInfo.repairedPeaks > 0);
  assert.ok(peak(result.channels[0]) <= dbToGain(-1) + 1e-7);
  assert.ok(peak(result.channels[0]) >= dbToGain(-1) - 1e-6);
  for (let i = 0; i < signal.length; i++) assert.ok(Math.abs(result.channels[1][i] - originalRight[i] * result.repairInfo.appliedGain) < 2e-8);
});

test('de-essing attenuates the sibilance band while retaining low-frequency content', async () => {
  const low = tone(400, .3), high = tone(8000, .3), mixed = low.map((value, i) => value + high[i]);
  const result = await processPreset(audio([mixed, low]), { presetId: 'de-esser-strong' });
  assert.ok(amplitude(result.channels[0], 8000) < amplitude(mixed, 8000) * .45);
  assert.ok(Math.abs(amplitude(result.channels[0], 400) / amplitude(mixed, 400) - 1) < .01);
  assert.ok(Math.abs(amplitude(result.channels[1], 400) / amplitude(low, 400) - 1) < .01);
});

test('de-esser linking retains stereo balance, unity settings bypass exactly, and DC does not trigger it', () => {
  const high = tone(10000, .4), right = high.map(value => value * .5), input = audio([high, right], SR, 'stereo');
  const result = deEss(input, { maxReductionDb: 12 });
  for (let i = 0; i < high.length; i++) assert.ok(Math.abs(result.channels[0][i] * .5 - result.channels[1][i]) < 1e-7);
  for (const params of [{ ratio: 1 }, { maxReductionDb: 0 }]) assert.deepEqual(deEss(input, params), input);
  const dc = audio([new Float32Array(8000).fill(.5)]);
  assert.deepEqual(deEss(dc), dc);
});

test('auto limiter measures RMS, bounds gain, leaves very quiet content alone and catches peaks', async () => {
  const moderate = tone(1000, .15), result = await autoLimit(audio([moderate]));
  assert.ok(Math.abs(rms(result.channels[0]) - dbToGain(-18)) < 1e-6);
  const quiet = tone(1000, .005), boosted = await autoLimit(audio([quiet]));
  assert.ok(Math.abs(rms(boosted.channels[0]) / rms(quiet) - dbToGain(6)) < 1e-6);
  const nearSilence = tone(1000, .0005), unboosted = await autoLimit(audio([nearSilence]));
  assert.deepEqual(unboosted.channels[0], nearSilence);
  const transient = tone(1000, .05); transient[900] = 1; transient[901] = -1;
  const limited = await autoLimit(audio([transient, transient.map(value => value * .5)]));
  assert.ok(peak(limited.channels[0]) <= dbToGain(-1) + 1e-7);
  for (let i = 0; i < transient.length; i++) assert.ok(Math.abs(limited.channels[0][i] * .5 - limited.channels[1][i]) < 1e-7);
});

test('limiting/mastering presets enforce their declared sample ceiling on loud mixed/transient material', async () => {
  const loud = tone(330, 1.2), other = tone(5000, .7); loud[1200] = 2; loud[1600] = -2;
  const input = audio([loud, other]);
  for (const preset of AUDIO_PRESETS.filter(preset => ['Limiting', 'Mastering'].includes(preset.category))) {
    const result = await processPreset(input, { presetId: preset.id });
    const ceiling = dbToGain(preset.steps.at(-1).params.ceilingDb);
    for (const channel of result.channels) assert.ok(peak(channel) <= ceiling + 1e-7, preset.id);
  }
});

test('compression presets produce actual dynamic reduction and cleanup filters attenuate the intended bands', async () => {
  const signal = tone(1000, .8), compressed = await processPreset(audio([signal]), { presetId: 'compression-gentle' });
  assert.ok(rms(compressed.channels[0].subarray(SR / 5)) < rms(signal.subarray(SR / 5)) * .7);
  const rumble = tone(20, .4, SR), noRumble = await processPreset(audio([rumble]), { presetId: 'remove-rumble' });
  assert.ok(amplitude(noRumble.channels[0], 20) < amplitude(rumble, 20) * .1);
  const high = tone(16000, .4), noHiss = await processPreset(audio([high]), { presetId: 'reduce-hiss' });
  assert.ok(amplitude(noHiss.channels[0], 16000) < amplitude(high, 16000) * .2);
});

test('stereo center and side extraction isolate the corresponding synthetic mix components', async () => {
  const center = tone(1000, .2), side = tone(5000, .15);
  const left = center.map((value, i) => value + side[i]), right = center.map((value, i) => value - side[i]);
  const input = audio([left, right], SR, 'stereo');
  const vocal = await processPreset(input, { presetId: 'vocal-center' });
  assert.deepEqual(vocal.channels[0], vocal.channels[1]);
  assert.ok(amplitude(vocal.channels[0], 1000) > .19);
  assert.ok(amplitude(vocal.channels[0], 5000) < 1e-5);
  const instrumental = await processPreset(input, { presetId: 'instrumental-sides' });
  for (let i = 0; i < center.length; i++) {
    assert.ok(Math.abs(instrumental.channels[0][i] - side[i]) < 3e-8);
    assert.equal(instrumental.channels[0][i] + instrumental.channels[1][i], 0);
  }
});

test('vocal reduction attenuates the center speech band while retaining center bass and side information', async () => {
  const bass = tone(40, .2, SR), voice = tone(1000, .2, SR), side = tone(3000, .15, SR);
  const left = bass.map((value, i) => value + voice[i] + side[i]), right = bass.map((value, i) => value + voice[i] - side[i]);
  const result = await processPreset(audio([left, right]), { presetId: 'vocal-reduction' });
  assert.ok(amplitude(result.channels[0], 1000) < .004);
  assert.ok(amplitude(result.channels[0], 40) > .19);
  assert.ok(Math.abs(amplitude(result.channels[0], 3000) - .15) < 1e-4);
  for (let i = 0; i < left.length; i++) assert.ok(Math.abs((result.channels[0][i] - result.channels[1][i]) - (left[i] - right[i])) < 6e-8);
});

test('preset preview, audition and apply agree; the edit preserves selection/alignment and has one undo', async () => {
  const input = audio([tone(1000, .5), tone(7000, .2)], SR, 'stereo'), editor = await setup(input, 3);
  await editor.execute('selection.set', { start: .1, end: .25, channels: 'all' });
  const before = await editor.execute('project.save'), state = editor.getState();
  const args = { effect: 'preset', params: { presetId: 'master-bright' } };
  const preview = await editor.execute('effect.preview', args);
  const audition = await editor.execute('audio.renderPreview', { ...args, scope: 'selection' });
  assert.deepEqual(await editor.execute('project.save'), before);
  assert.deepEqual(editor.getState(), state);
  await editor.execute('effect.preset', { presetId: 'master-bright' });
  assert.deepEqual(await editor.execute('clip.getAudio'), preview);
  assert.deepEqual(await editor.execute('audio.render', { scope: 'selection' }), audition);
  const after = editor.getState();
  assert.deepEqual(after.selection, state.selection); assert.equal(after.tracks[0].clips[0].start, 3);
  assert.equal(after.history.undo, state.history.undo + 1);
  for (let c = 0; c < 2; c++) {
    assert.deepEqual(preview.channels[c].slice(0, .1 * SR), input.channels[c].slice(0, .1 * SR));
    assert.deepEqual(preview.channels[c].slice(.25 * SR), input.channels[c].slice(.25 * SR));
  }
  await editor.execute('history.undo'); assert.deepEqual(await editor.execute('project.save'), before);
  await editor.execute('history.redo'); assert.deepEqual(await editor.execute('clip.getAudio'), preview);
});

test('non-stereo presets process only chosen surround channels and preserve unselected PCM', async () => {
  const input = audio(Array.from({ length: 6 }, (_, c) => tone(300 + 500 * c, 1.2, 4000)), SR, '5.1');
  const editor = await setup(input, 1);
  await editor.execute('selection.set', { start: 100 / SR, end: 3000 / SR, channels: [1, 4, 5] });
  const selection = editor.getState().selection;
  await editor.execute('effect.preset', { params: { presetId: 'limiter-headroom' } });
  const result = await editor.execute('clip.getAudio');
  assert.equal(result.layout, '5.1'); assert.equal(result.channels.length, 6);
  assert.deepEqual(editor.getState().selection, selection);
  for (const c of [0, 2, 3]) assert.deepEqual(result.channels[c], input.channels[c]);
  for (const c of [1, 4, 5]) {
    assert.notDeepEqual(result.channels[c].slice(100, 3000), input.channels[c].slice(100, 3000));
    assert.deepEqual(result.channels[c].slice(0, 100), input.channels[c].slice(0, 100));
    assert.deepEqual(result.channels[c].slice(3000), input.channels[c].slice(3000));
  }
});

test('stereo-only presets reject mono, surround and one-channel targets atomically in every command path', async () => {
  for (const count of [1, 2, 6, 8]) {
    const input = audio(Array.from({ length: count }, () => tone(1000, .3, 1000)), SR, count === 6 ? '5.1' : count === 8 ? '7.1' : undefined);
    const editor = await setup(input);
    await editor.execute('selection.set', { start: 10 / SR, end: 900 / SR, channels: count === 2 ? 'left' : count > 2 ? [0, 1] : 'all' });
    const before = await editor.execute('project.save'), state = editor.getState();
    for (const presetId of ['vocal-center', 'instrumental-sides', 'vocal-reduction']) {
      for (const method of ['effect.preset', 'effect.apply', 'effect.preview', 'audio.renderPreview']) {
        const params = method === 'effect.preset' ? { presetId } : { effect: 'preset', params: { presetId } };
        await assert.rejects(editor.execute(method, params), /stereo clip and both channels/);
        assert.deepEqual(await editor.execute('project.save'), before); assert.deepEqual(editor.getState(), state);
      }
    }
  }
});

test('preset commands reject missing IDs, unknown overrides, invalid BPM and bad audio before mutation', async () => {
  const editor = await setup(audio([tone(400, .2, 1000)])), before = await editor.execute('project.save'), state = editor.getState();
  for (const params of [{}, { presetId: 'unknown' }, { presetId: 'auto-limiter', targetRmsDb: 0 }, { presetId: 'auto-limiter', bpm: NaN }, { presetId: 'auto-limiter', bpm: 401 }]) {
    await assert.rejects(editor.execute('effect.preset', params));
    assert.deepEqual(await editor.execute('project.save'), before); assert.deepEqual(editor.getState(), state);
  }
  for (const bad of [audio([[]]), audio([[NaN]]), audio([[Infinity]]), audio([[0]], 7999), audio([[0], [0, 1]])]) {
    await assert.rejects(processPreset(bad, { presetId: 'auto-limiter' }));
  }
  assert.throws(() => processStereoCenter(audio([[0]]), { mode: 'center' }), /exactly two/);
  assert.throws(() => deEss(audio([[0]]), { thresholdDb: 'bad' }));
  assert.throws(() => repairClipping(audio([[0]]), { maxClipMs: 1e9 }));
});

test('preset schema exposes stable IDs and validates named, preview, renderPreview and apply paths', () => {
  const descriptors = new Map(coreCommandDescriptors(COMMANDS).map(entry => [entry.method, entry]));
  for (const method of ['effect.preset', 'effect.apply', 'effect.preview', 'audio.renderPreview']) {
    const descriptor = descriptors.get(method); assert.ok(descriptor);
    for (const preset of AUDIO_PRESETS) {
      const params = method === 'effect.preset' ? { presetId: preset.id } : { effect: 'preset', params: { presetId: preset.id } };
      assert.doesNotThrow(() => validateCommandParams(params, descriptor));
    }
    const args = options => method === 'effect.preset' ? options : { effect: 'preset', params: options };
    for (const bad of [{}, { presetId: 'not-a-preset' }, { presetId: 'auto-limiter', steps: [] }, { presetId: 'auto-limiter', bpm: 0 }]) assert.throws(() => validateCommandParams(args(bad), descriptor));
  }
  assert.equal(descriptors.get('effect.preset').recordable, true);
  assert.doesNotThrow(() => validateCommandParams({ params: { presetId: 'auto-limiter' }, target: { channels: 'left' } }, descriptors.get('effect.preset')));
});

test('actual engine worker validates preset messages, renders PCM and retains one undo transaction', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'self'), pending = new Map();
  let id = 0;
  const scope = { postMessage(message) {
    const clone = structuredClone(message), entry = pending.get(clone.id);
    if (!entry) return;
    pending.delete(clone.id); clearTimeout(entry.timer);
    if (clone.error) entry.reject(Object.assign(new Error(clone.error.message), { code: clone.error.code })); else entry.resolve(clone);
  } };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => reject(new Error('Preset worker did not reply.')), 2000);
    pending.set(requestId, { resolve, reject, timer });
    scope.onmessage({ data: structuredClone({ id: requestId, method, params }) });
  });
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  try {
    await import('../src/worker.js?preset-worker-regression');
    const input = audio([tone(7000, .5, 4000), tone(7000, .25, 4000)], SR, 'stereo');
    await request('clip.add', { audio: input });
    const before = (await request('project.state')).state;
    const preview = await request('effect.preview', { effect: 'preset', params: { presetId: 'de-esser-strong' } });
    assert.deepEqual(preview.state, before);
    await assert.rejects(request('effect.preset', { presetId: 'auto-limiter', ceilingDb: 0 }), /unknown property/);
    assert.deepEqual((await request('project.state')).state, before);
    const applied = await request('effect.preset', { presetId: 'de-esser-strong' });
    assert.equal(applied.state.history.undo, before.history.undo + 1);
    assert.deepEqual((await request('clip.getAudio')).result, preview.result);
    await request('history.undo'); assert.deepEqual((await request('clip.getAudio')).result, input);
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    if (saved) Object.defineProperty(globalThis, 'self', saved); else delete globalThis.self;
  }
});
