import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedSpectrum, SpectrumHistory, LiveAnalysisTap, LiveVisualizer, VISUALIZER_LIMITS } from '../src/live-visualizer.js';
import { AudioNodeMock, AudioContextMock } from './audio-test-support.js';

test('linked spectra preserve channel power and finite silence without signed-channel cancellation', () => {
  const left = new Float32Array([-6, -Infinity, 0]), right = new Float32Array([-6, -Infinity, -Infinity]), output = new Float32Array(3);
  assert.equal(linkedSpectrum([left, right], output), output);
  assert.ok(Math.abs(output[0] + 6) < 1e-5);
  assert.equal(output[1], -120);
  assert.ok(Math.abs(output[2] + 3.0103) < 1e-4);
  assert.throws(() => linkedSpectrum([left, new Float32Array(2)], output), /matching/);
});

test('spectral history locates a known tone and stays bounded across thousands of captured frames', () => {
  const history = new SpectrumHistory(48000), store = history.data, times = history.times, spectrum = new Float32Array(1024).fill(-120);
  spectrum[Math.round(1000 / (48000 / VISUALIZER_LIMITS.fftSize))] = -12;
  for (let frame = 0; frame < 2400; frame++) history.push(spectrum, frame / 30);
  assert.equal(history.data, store); assert.equal(history.times, times);
  assert.equal(history.count, 240); assert.equal(history.total, 2400);
  assert.equal(history.data.byteLength, 240 * 192);
  assert.ok(Math.abs(history.windowSeconds - 8) < 1e-8);
  const latest = history.column() * VISUALIZER_LIMITS.bands, peaks = [];
  for (let band = 0; band < VISUALIZER_LIMITS.bands; band++) if (history.data[latest + band] > 200) peaks.push(history.frequencyAt(band / VISUALIZER_LIMITS.bands));
  assert.ok(peaks.length > 0); assert.ok(peaks.every(hz => hz > 900 && hz < 1100));
  history.reset(); assert.equal(history.count, 0); assert.ok(history.data.every(value => value === 0));
  assert.throws(() => history.push(new Float32Array(16), 0), /FFT frame/);
});

test('analysis uses a silent per-channel branch and leaves the original program route connected', () => {
  const context = new AudioContextMock({ sampleRate: 48000 }), source = new AudioNodeMock(), audible = new AudioNodeMock();
  source.connect(audible); let nextChannel = 0;
  context.createAnalyser = () => {
    const channel = nextChannel++, analyser = new AudioNodeMock();
    analyser.getFloatTimeDomainData = data => data.fill(channel ? -.5 : .5);
    analyser.getFloatFrequencyData = data => { data.fill(-Infinity); data[43] = -6; };
    return analyser;
  };
  const tap = new LiveAnalysisTap({ context, node: source, channels: 2 });
  assert.equal(tap.sink.gain.value, 0); assert.equal(source.connections.length, 2);
  assert.equal(tap.splitter.connections[0][1], 0); assert.equal(tap.splitter.connections[1][1], 1);
  const output = tap.read(); assert.ok(Math.abs(output[43] + 6) < 1e-5); assert.equal(tap.peak, .5);
  assert.equal(tap.waves[0][0], .5); assert.equal(tap.waves[1][0], -.5);
  tap.dispose(); tap.dispose(); assert.deepEqual(source.connections, [[audible]]);
});

test('analysis setup failures cannot disconnect the existing output or change its gain', () => {
  const context = new AudioContextMock(), source = new AudioNodeMock(), audible = new AudioNodeMock(); source.connect(audible);
  context.createChannelSplitter = () => { throw new Error('Synthetic allocation failure'); };
  assert.throws(() => new LiveAnalysisTap({ context, node: source, channels: 2 }), /allocation failure/);
  assert.deepEqual(source.connections, [[audible]]);
  assert.throws(() => new LiveAnalysisTap({ context, node: source, channels: 9 }), /eight-channel/);
});

test('waveform drawing preserves both peaks of a tone aligned with display downsampling', () => {
  const samples = Float32Array.from({ length: 2048 }, (_, i) => .5 * Math.cos(Math.PI * i / 2)), points = [];
  const context = { beginPath() {}, stroke() {}, fillText() {},
    moveTo(x, y) { if (this.strokeStyle === 'signal') points.push(y); },
    lineTo(x, y) { if (this.strokeStyle === 'signal') points.push(y); } };
  LiveVisualizer.prototype._waveform.call({ latestWaveforms: [samples], waveGradient: 'signal', history: { sampleRate: 48000 } }, context, { x: 0, y: 0, w: 512, h: 100 });
  assert.equal(Math.min(...points), 28.5); assert.equal(Math.max(...points), 71.5);
});
