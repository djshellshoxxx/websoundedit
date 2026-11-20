import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { processRackEffect } from '../src/rack-dsp.js';
import { RealtimeRackDSP, renderLiveDSP, estimateRackBytes } from '../src/realtime-dsp.js';

const SR = 8000;
const audio = channels => ({ sampleRate: SR, ...(channels.length > 2 ? { layout: channels.length === 6 ? '5.1' : '7.1' } : {}), channels: channels.map(values => Float32Array.from(values)) });
const gate = (params = {}, extra = {}) => ({ id: 'gate', effect: 'noiseGate', wet: 1, params, ...extra });
const settings = { thresholdDb: -20, hysteresisDb: 6, floorDb: -80, attackMs: 0, holdMs: 0, releaseMs: 1, channelMode: 'linked' };

test('noise gate attenuates quiet passages, opens for real signal and never amplifies input', () => {
  const samples = new Float32Array(2400).fill(.001); samples.fill(.4, 800, 1600);
  const source = audio([samples]), output = processRackEffect(source, 'noiseGate', settings);
  assert.ok(output.channels[0].subarray(0, 800).every(value => Math.abs(value - 1e-7) < 1e-12));
  assert.equal(output.channels[0][800], samples[800]);
  assert.ok(output.channels[0].subarray(2000).every(value => Math.abs(value) < 1.1e-7));
  for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(output.channels[0][i]) <= Math.abs(samples[i]));
  assert.deepEqual(source.channels[0], samples);
});

test('hysteresis and hold prevent chatter, while attack/release follow the selected time constants', () => {
  const samples = new Float32Array(100).fill(.075); samples[0] = .4; samples.fill(.001, 10);
  const output = processRackEffect(audio([samples]), 'noiseGate', { ...settings, holdMs: 2 });
  for (let i = 0; i <= 25; i++) assert.equal(output.channels[0][i], samples[i], `open frame ${i}`);
  const expectedFirstRelease = samples[26] * (1e-4 + (1 - 1e-4) * Math.exp(-1 / (SR * .001)));
  assert.ok(Math.abs(output.channels[0][26] - expectedFirstRelease) < 1e-10);
  const attack = processRackEffect(audio([new Float32Array(80).fill(.4)]), 'noiseGate', { ...settings, attackMs: 10 });
  const expectedAtOneTimeConstant = .4 * (1e-4 + (1 - 1e-4) * (1 - Math.exp(-1)));
  assert.ok(Math.abs(attack.channels[0][79] - expectedAtOneTimeConstant) < 1e-7);
});

test('linked channels preserve relative levels and independent channels gate separately', () => {
  const source = audio([new Float32Array(400).fill(.4), new Float32Array(400).fill(-.001)]);
  const linked = processRackEffect(source, 'noiseGate', settings);
  assert.deepEqual(linked, source);
  const independent = processRackEffect(source, 'noiseGate', { ...settings, channelMode: 'independent' });
  assert.deepEqual(independent.channels[0], source.channels[0]);
  assert.ok(independent.channels[1].every(value => Math.abs(value + 1e-7) < 1e-12));
});

test('selection and live noise gates produce identical PCM across arbitrary block boundaries and layouts', () => {
  for (const count of [1, 2, 6, 8]) for (const channelMode of ['linked', 'independent']) {
    const source = audio(Array.from({ length: count }, (_, channel) => Float32Array.from({ length: 7000 }, (_, i) => Math.sin(i * .13 + channel) * (i < 500 || i > 3500 ? .001 : .2))));
    const params = { ...settings, attackMs: 2, holdMs: 20, releaseMs: 60, channelMode };
    const offline = processRackEffect(source, 'noiseGate', params, .75);
    for (const blockFrames of [1, 128, 137, 2048]) {
      const live = renderLiveDSP(source, { chain: [gate(params, { wet: .75 })], blockFrames });
      assert.deepEqual(live, offline, `${count} channels, ${channelMode}, block ${blockFrames}`);
    }
  }
});

test('noise gate bypass and zero attenuation are exact identity; invalid settings are rejected before mutation', async () => {
  const source = audio([[.4, -.2, .001, 0], [-.1, .02, -.001, 0]]);
  assert.deepEqual(processRackEffect(source, 'noiseGate', settings, 0), source);
  assert.deepEqual(processRackEffect(source, 'noiseGate', { ...settings, floorDb: 0 }), source);
  assert.deepEqual(renderLiveDSP(source, { chain: [gate(settings, { enabled: false })] }), source);
  const editor = new AudioEditor({ sampleRate: SR }); await editor.execute('clip.add', { audio: source });
  const before = await editor.execute('project.save');
  for (const params of [{ thresholdDb: NaN }, { floorDb: 1 }, { holdMs: -1 }, { attackMs: Infinity }, { channelMode: 'sum' }, { releaseMs: 0 }, { hysteresisDb: 25 }]) {
    await assert.rejects(editor.execute('effect.noiseGate', params));
    assert.deepEqual(await editor.execute('project.save'), before);
  }
});

test('noise gate previews preserve unselected PCM and apply as a single undoable edit', async () => {
  const source = audio([new Float32Array(80).fill(.001), new Float32Array(80).fill(.4)]);
  const editor = new AudioEditor({ sampleRate: SR }); await editor.execute('clip.add', { audio: source });
  await editor.execute('selection.set', { start: 20 / SR, end: 60 / SR, channels: 'left' });
  const before = await editor.execute('project.save'), history = editor.getState().history.undo;
  const preview = await editor.execute('effect.preview', { effect: 'noiseGate', params: settings });
  assert.deepEqual(await editor.execute('project.save'), before);
  assert.deepEqual(preview.channels[1], source.channels[1]);
  assert.deepEqual(preview.channels[0].subarray(0, 20), source.channels[0].subarray(0, 20));
  assert.deepEqual(preview.channels[0].subarray(60), source.channels[0].subarray(60));
  await editor.execute('effect.noiseGate', settings);
  assert.equal(editor.getState().history.undo, history + 1);
  assert.deepEqual(await editor.execute('clip.getAudio'), preview);
  await editor.execute('history.undo'); assert.deepEqual(await editor.execute('project.save'), before);
});

test('noise gate state is bounded and survives live parameter updates without block-size discontinuities', () => {
  const dsp = new RealtimeRackDSP({ sampleRate: SR, channels: 2, chain: [gate({ ...settings, attackMs: 10 })] });
  const source = [new Float32Array(128).fill(.4), new Float32Array(128).fill(.001)], output = source.map(channel => new Float32Array(channel.length));
  dsp.process(source, output); const first = output[0][127], state = dsp.stages[0];
  dsp.updateChain([gate({ ...settings, attackMs: 10, holdMs: 100 })]);
  assert.strictEqual(dsp.stages[0], state);
  dsp.process(source, output); assert.ok(output[0][0] >= first);
  dsp.schedule({ slotId: 'gate', param: 'thresholdDb', value: 0, at: dsp.frames / SR });
  for (let i = 0; i < 10; i++) dsp.process(source, output);
  assert.ok(output.every(channel => channel.every(Number.isFinite)));
  assert.ok(estimateRackBytes([gate()], 192000, 8) - estimateRackBytes([], 192000, 8) < 20000);
});

test('live closed-level and hold changes respect their new values without resetting the stage', () => {
  const dsp = new RealtimeRackDSP({ sampleRate: SR, channels: 1, chain: [gate({ ...settings, holdMs: 1000 })] });
  const quiet = [new Float32Array(128).fill(.001)], loud = [new Float32Array(128).fill(.4)], output = [new Float32Array(128)];
  dsp.process(quiet, output); assert.ok(output[0][0] < 1e-6);
  const state = dsp.stages[0];
  dsp.updateChain([gate({ ...settings, floorDb: 0 })]); dsp.process(quiet, output);
  assert.deepEqual(output, quiet); assert.strictEqual(dsp.stages[0], state);
  dsp.updateChain([gate({ ...settings, holdMs: 1000 })]); dsp.process(loud, output); dsp.process(quiet, output);
  assert.deepEqual(output, quiet);
  dsp.updateChain([gate({ ...settings, holdMs: 0 })]); dsp.process(quiet, output);
  assert.ok(output[0][0] < quiet[0][0]); assert.strictEqual(dsp.stages[0], state);
});
