import test from 'node:test';
import assert from 'node:assert/strict';
import { channelPeaks, spectrumData, mixerGains } from '../src/visuals.js';

test('waveform pyramid retains exact positive and negative boundary transients at every zoom', () => {
  const samples = Float32Array.from({ length: 15003 }, (_, i) => Math.sin(i * 0.23) * 0.4);
  samples[63] = -0.9; samples[64] = 0.95; samples[8191] = -1.2; samples[8192] = 1.4; samples[15002] = -0.99;
  for (const [start, end] of [[0, 15003], [61, 65], [65, 8192], [64, 8193], [71, 14444], [8192, 15003], [8192, 8193], [1, 4500]]) {
    const slice = samples.slice(start, end), actual = channelPeaks(samples, start, end);
    assert.equal(actual.min, Math.min(...slice));
    assert.equal(actual.max, Math.max(...slice));
  }
});

test('spectrum displays an octave pitch change as an octave frequency change', () => {
  const sampleRate = 48000, size = 48000;
  const tone = frequency => ({ sampleRate, channels: [Float32Array.from({ length: size }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / sampleRate))] });
  const before = spectrumData(tone(440)), after = spectrumData(tone(880));
  assert.ok(Math.abs(before.peakHz - 440) < before.binHz);
  assert.ok(Math.abs(after.peakHz - 880) < after.binHz);
  assert.ok(Math.abs(after.peakHz / before.peakHz - 2) < 0.03);
  assert.ok(before.peakDb < -5 && before.peakDb > -8);
});

test('spectrum averages stereo power without hiding antiphase material', () => {
  const sampleRate = 48000;
  const left = Float32Array.from({ length: 8192 }, (_, i) => 0.7 * Math.sin(2 * Math.PI * 750 * i / sampleRate));
  const mono = spectrumData({ sampleRate, channels: [left] });
  const stereo = spectrumData({ sampleRate, channels: [left, left.map(v => -v)] });
  assert.ok(Math.abs(mono.peakDb - stereo.peakDb) < 0.00001);
  assert.equal(stereo.peakHz, 750);
});

test('waveform mixer uses equal-power mono pan and non-collapsing stereo balance', () => {
  const center = mixerGains({ pan: 0, gainDb: 0 }, 1);
  assert.ok(Math.abs(center[0] ** 2 + center[1] ** 2 - 1) < 1e-12);
  assert.deepEqual(mixerGains({ pan: 0, gainDb: 0 }, 2), [1, 1]);
  assert.ok(mixerGains({ pan: -1, gainDb: 0 }, 2)[1] < 1e-12);
  assert.equal(mixerGains({ pan: -1, gainDb: 0 }, 2)[0], 1);
  assert.ok(Math.abs(mixerGains({ pan: 0, gainDb: 6 }, 2)[0] - 10 ** 0.3) < 1e-12);
});

test('empty and silent visual data stay finite', () => {
  assert.deepEqual(channelPeaks(new Float32Array(), 0, 10), { min: 0, max: 0 });
  assert.equal(spectrumData({ sampleRate: 48000, channels: [new Float32Array()] }), null);
  const silent = spectrumData({ sampleRate: 48000, channels: [new Float32Array(8192)] });
  assert.ok(silent.db.every(Number.isFinite));
  assert.ok(silent.peakDb <= -100);
});
