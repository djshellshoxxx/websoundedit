import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKey, manualKey, validateKeyAnalysis, keyColor, NOTE_NAMES, UNKNOWN_KEY_COLOR } from '../src/key-detection.js';

const SR = 16000;
function chord(tonic, mode, sampleRate = SR, duration = 1.5, harmonics = false) {
  const notes = [48 + tonic, 60 + tonic, 60 + tonic + (mode === 'minor' ? 3 : 4), 67 + tonic];
  const channel = Float32Array.from({ length: Math.round(duration * sampleRate) }, (_, i) => notes.reduce((sum, note, voice) => {
    const phase = 2 * Math.PI * 440 * 2 ** ((note - 69) / 12) * i / sampleRate;
    return sum + (voice === 1 ? .18 : .1) * (Math.sin(phase) + (harmonics ? .25 * Math.sin(phase * 2) + .12 * Math.sin(phase * 3) : 0));
  }, 0));
  return { sampleRate, channels: [channel] };
}

test('major and minor triads across all pitch classes produce the expected key and color', () => {
  for (const mode of ['major', 'minor']) for (let tonic = 0; tonic < 12; tonic++) {
    const result = detectKey(chord(tonic, mode));
    assert.equal(result.key, `${NOTE_NAMES[tonic]} ${mode}`, JSON.stringify(result));
    assert.equal(result.tonic, tonic);
    assert.equal(result.mode, mode);
    assert.ok(result.confidence > .5 && result.confidence <= 1);
    assert.equal(result.color, keyColor(tonic, mode));
    assert.equal(result.chroma.length, 12);
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(validateKeyAnalysis(result), result);
  }
});

test('harmonic tones survive sample-rate changes and opposite-polarity stereo', () => {
  for (const sampleRate of [8000, 44100, 96000]) {
    const audio = chord(9, 'minor', sampleRate, 1.5, true);
    audio.channels.push(Float32Array.from(audio.channels[0], sample => -sample));
    const before = audio.channels.map(channel => channel.slice());
    const result = detectKey(audio);
    assert.equal(result.key, 'A minor', `${sampleRate}: ${JSON.stringify(result)}`);
    assert.deepEqual(audio.channels, before);
  }
});

test('silence, short sounds, one pitch and broadband noise do not invent musical keys', () => {
  let random = 73;
  const noise = Float32Array.from({ length: SR * 2 }, () => { random = (random * 1664525 + 1013904223) >>> 0; return (random / 4294967296 - .5) * .5; });
  const examples = [
    { sampleRate: SR, channels: [new Float32Array(SR)] },
    { sampleRate: SR, channels: [new Float32Array(0)] },
    chord(0, 'major', SR, .1),
    { sampleRate: SR, channels: [Float32Array.from({ length: SR }, (_, i) => .5 * Math.sin(2 * Math.PI * 440 * i / SR))] },
    { sampleRate: SR, channels: [noise] },
  ];
  for (const audio of examples) {
    const result = detectKey(audio);
    assert.equal(result.key, null, JSON.stringify(result));
    assert.equal(result.confidence, 0);
    assert.equal(result.color, UNKNOWN_KEY_COLOR);
    assert.ok(result.reason.length > 10);
    assert.deepEqual(validateKeyAnalysis(result), result);
  }
});

test('analysis samples across the clip rather than inspecting only the start', () => {
  const musical = chord(5, 'major', SR, 3);
  const channel = new Float32Array(SR * 6);
  channel.set(musical.channels[0], SR * 3);
  assert.equal(detectKey({ sampleRate: SR, channels: [channel] }).key, 'F major');
});

test('manual assignments are exact, have distinct major/minor colors and validate safely', () => {
  const key = manualKey(1, 'minor');
  assert.equal(key.key, 'C♯ minor');
  assert.equal(key.source, 'manual');
  assert.notEqual(keyColor(1, 'major'), keyColor(1, 'minor'));
  assert.equal(keyColor(null, null), UNKNOWN_KEY_COLOR);
  assert.deepEqual(validateKeyAnalysis(key), key);
  const unsafe = { ...key, color: 'url(javascript:bad)', unrelated: { evil: true } };
  assert.deepEqual(validateKeyAnalysis(unsafe), key);
  assert.equal(validateKeyAnalysis(null), null);
  assert.throws(() => manualKey(12, 'minor'));
  assert.throws(() => manualKey(1, 'dorian'));
});

test('saved analysis rejects malformed metadata and analysis rejects nonfinite PCM', () => {
  const key = manualKey(0, 'major');
  for (const override of [{ tonic: 24 }, { mode: 'bad' }, { key: '<script>bad</script>' }, { confidence: Infinity }, { chroma: [1] }, { chroma: Array(12).fill(NaN) }, { candidates: Array(4).fill({}) }, { candidates: [{ key: 'C major', tonic: 0, mode: 'major', score: Infinity }] }, { reason: 'a'.repeat(257) }, { source: 'invented' }, { method: 'invented' }]) assert.throws(() => validateKeyAnalysis({ ...key, ...override }));
  assert.throws(() => detectKey({ sampleRate: SR, channels: [Float32Array.of(Infinity)] }));
});
