import test from 'node:test';
import assert from 'node:assert/strict';
import { RACK_EFFECTS } from '../src/rack-config.js';
import { processRack, processRackEffect, RACK_EFFECT_NAMES } from '../src/rack-dsp.js';

const SR = 16000;
const tone = (frequency = 440, seconds = 1, sr = SR) => ({ sampleRate: sr, channels: [Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => .4 * Math.sin(2 * Math.PI * frequency * i / sr))] });
const impulse = (seconds = 1, sr = SR) => { const audio = { sampleRate: sr, channels: [new Float32Array(Math.round(seconds * sr))] }; audio.channels[0][0] = 1; return audio; };
const rms = channel => Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length);
const stage = (effect, params = {}, wet = 1, id = effect) => ({ id, effect, params, wet, enabled: true });

test('every creative effect changes PCM, owns output, preserves stereo dimensions, and is deterministic', () => {
  assert.ok(RACK_EFFECT_NAMES.includes('noiseGate'));
  const source = tone(413, 1);
  source.channels.push(Float32Array.from(source.channels[0], sample => -.3 * sample));
  const before = source.channels.map(channel => channel.slice());
  for (const effect of RACK_EFFECT_NAMES) {
    const output = processRackEffect(source, effect);
    assert.equal(output.sampleRate, source.sampleRate, effect);
    assert.equal(output.channels.length, 2, effect);
    for (let channel = 0; channel < output.channels.length; channel++) {
      assert.equal(output.channels[channel].length, source.channels[channel].length, effect);
      assert.notStrictEqual(output.channels[channel], source.channels[channel], effect);
      assert.ok(output.channels[channel].every(Number.isFinite), effect);
    }
    assert.notDeepEqual(output, source, effect);
    assert.deepEqual(output, processRackEffect(source, effect), `${effect} repeatability`);
  }
  assert.deepEqual(source.channels, before);
});

test('zero wet, bypass and empty chains are exact identity with separately owned output', () => {
  const source = tone(331, .1);
  for (const effect of RACK_EFFECT_NAMES) {
    const zero = processRackEffect(source, effect, {}, 0);
    assert.deepEqual(zero, source, effect);
    assert.notStrictEqual(zero.channels[0], source.channels[0]);
    assert.deepEqual(processRack(source, { chain: [{ ...stage(effect), enabled: false }] }), source, effect);
  }
  assert.deepEqual(processRack(source, { chain: [] }), source);
  assert.notStrictEqual(processRack(source).channels[0], source.channels[0]);
});

test('wet/dry blends the stage input and its processed output with the stated linear mix', () => {
  const source = tone(440, .1), wet = processRackEffect(source, 'distortion', { drive: 6 });
  const mixed = processRackEffect(source, 'distortion', { drive: 6 }, .25);
  for (let i = 0; i < source.channels[0].length; i++) assert.ok(Math.abs(mixed.channels[0][i] - (source.channels[0][i] * .75 + wet.channels[0][i] * .25)) < 1e-7);
});

test('echo and feedback delay produce correctly timed decaying impulses without extending audio', () => {
  const source = impulse(.1, 8000);
  const echoed = processRackEffect(source, 'echo', { timeMs: 10, repeats: 3, decay: .5 });
  assert.equal(echoed.channels[0][0], 0);
  assert.equal(echoed.channels[0][80], 1);
  assert.equal(echoed.channels[0][160], .5);
  assert.equal(echoed.channels[0][240], .25);
  assert.equal(echoed.channels[0][320], 0);
  const delayed = processRackEffect(source, 'delay', { timeMs: 10, feedback: .5 });
  assert.equal(delayed.channels[0][80], 1);
  assert.equal(delayed.channels[0][160], .5);
  assert.equal(delayed.channels[0][240], .25);
  assert.equal(delayed.channels[0][320], .125);
  assert.equal(delayed.channels[0].length, source.channels[0].length);
});

test('reverb generates a diffuse decaying tail and honors predelay', () => {
  const source = impulse(2);
  const room = processRackEffect(source, 'reverb', { room: .7, damping: .3, predelayMs: 50 });
  assert.ok(room.channels[0].subarray(0, SR * .05).every(value => value === 0));
  const early = rms(room.channels[0].subarray(SR * .05, SR * .5));
  const late = rms(room.channels[0].subarray(SR * 1.5));
  assert.ok(early > .001);
  assert.ok(late < early * .25);
  assert.ok(room.channels[0].filter(value => Math.abs(value) > 1e-6).length > 1000);
});

test('filters suppress measured stop-band frequencies and preserve the intended pass band', () => {
  const low = tone(100, .5, 48000), high = tone(6000, .5, 48000);
  const ratio = (source, type) => rms(processRackEffect(source, 'filter', { type, frequency: 800, q: .707 }).channels[0].subarray(4000)) / rms(source.channels[0].subarray(4000));
  assert.ok(ratio(low, 'lowpass') > .95);
  assert.ok(ratio(high, 'lowpass') < .03);
  assert.ok(ratio(low, 'highpass') < .03);
  assert.ok(ratio(high, 'highpass') > .95);
  const center = tone(800, .5, 48000);
  assert.ok(ratio(center, 'notch') < .0001);
  assert.ok(ratio(center, 'bandpass') > .99);
});

test('stutter repeats the first tempo-sized slice, gates it, and retains exact output length', () => {
  const source = { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => i / 10000)] };
  const output = processRackEffect(source, 'stutter', { division: 4, gate: 1, fadeMs: 0 }, 1, { bpm: 120 });
  for (let i = 0; i < output.channels[0].length; i++) assert.equal(output.channels[0][i], source.channels[0][i % 1000]);
  const gated = processRackEffect(source, 'stutter', { division: 4, gate: .5, fadeMs: 0 }, 1, { bpm: 120 });
  assert.equal(gated.channels[0][499], source.channels[0][499]);
  assert.equal(gated.channels[0][500], 0);
  const faster = processRackEffect(source, 'stutter', { division: 4, gate: 1, fadeMs: 0 }, 1, { bpm: 240 });
  assert.equal(faster.channels[0][750], source.channels[0][250]);
});

test('bitcrusher reduces actual precision and sample changes; tremolo depth zero is transparent', () => {
  const source = tone(251, .1);
  const output = processRackEffect(source, 'bitcrusher', { bits: 3, hold: 5 });
  for (let i = 0; i < output.channels[0].length; i++) {
    assert.ok(Math.abs(output.channels[0][i] * 3 - Math.round(output.channels[0][i] * 3)) < 1e-6);
    assert.equal(output.channels[0][i], output.channels[0][Math.floor(i / 5) * 5]);
  }
  assert.deepEqual(processRackEffect(source, 'tremolo', { depth: 0 }), source);
});

test('serial rack order changes the rendered audio and composition matches standalone stages', () => {
  const source = tone(401, .5), saturation = stage('distortion', { drive: 7 }), tremolo = stage('tremolo', { depth: .95, rate: 3 });
  const a = processRack(source, { chain: [saturation, tremolo] });
  const b = processRack(source, { chain: [tremolo, saturation] });
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, processRackEffect(processRackEffect(source, 'distortion', saturation.params), 'tremolo', tremolo.params));
  assert.ok(Math.abs(rms(a.channels[0]) - rms(b.channels[0])) > .05);
});

test('declared parameter extremes remain finite, including resonance and negative feedback', () => {
  const source = tone(317, .15, 8000);
  for (const [name, definition] of Object.entries(RACK_EFFECTS)) for (const edge of ['min', 'max']) {
    const params = Object.fromEntries(definition.fields.map(field => [field.key, field.type === 'select' ? field.options[0] : field[edge]]));
    assert.ok(processRackEffect(source, name, params).channels[0].every(Number.isFinite), `${name} ${edge}`);
  }
  for (const length of [0, 1, 2, 32]) for (const name of RACK_EFFECT_NAMES) {
    const output = processRackEffect({ sampleRate: SR, channels: [new Float32Array(length)] }, name);
    assert.equal(output.channels[0].length, length);
    assert.ok(output.channels[0].every(Number.isFinite));
  }
});

test('invalid effects, PCM, ranges and stages reject atomically even if bypassed', () => {
  const source = tone(440, .05), before = source.channels[0].slice();
  for (const chain of [Array.from({ length: 13 }, (_, i) => stage('echo', {}, 1, `slot${i}`)), [stage('unknown')], [stage('delay', { feedback: 1 })], [stage('echo', { repeats: 1.2 })], [stage('filter', { type: 'bad' })], [stage('tape', { wow: NaN })], [stage('echo', { irrelevant: 3 })], [stage('tape', {}, Infinity)], [{ ...stage('echo'), enabled: 'false' }], [{ ...stage('delay', { feedback: Infinity }), enabled: false }]]) {
    assert.throws(() => processRack(source, { chain }));
  }
  assert.throws(() => processRack(source, { bpm: Infinity }));
  assert.throws(() => processRackEffect({ sampleRate: SR, channels: [Float32Array.of(NaN)] }, 'echo'));
  assert.deepEqual(source.channels[0], before);
});
