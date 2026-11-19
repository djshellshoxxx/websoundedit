/** Bounded chroma analysis of actual PCM; confidence is a heuristic, not probability.
 * Major/minor profiles: Krumhansl–Kessler, documented by the Humdrum authors:
 * https://extras.humdrum.org/man/keycor/
 * Stereo power is accumulated independently so opposite-polarity audio cannot cancel.
 */
import { validateAudio, resampleAudio } from './dsp.js';

export const NOTE_NAMES = Object.freeze(['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']);
export const UNKNOWN_KEY_COLOR = '#8999a7';
export const KEY_COLORS = Object.freeze({
  major: Object.freeze(['#f06c64', '#ed9360', '#dab74f', '#b9c75a', '#83c581', '#56c4a5', '#48bec6', '#5ca6e6', '#818de5', '#ad80df', '#d07dcb', '#e681a5']),
  minor: Object.freeze(['#d95d58', '#d98050', '#c89f3f', '#9faf47', '#6ba96e', '#43aa8f', '#36a5ae', '#4c8dcb', '#7077ce', '#946bc8', '#b86bb5', '#d06b90']),
});
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const FFT_SIZE = 8192;
const MAX_WINDOWS = 32;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = value => Math.round(value * 10000) / 10000;
const validTonic = value => Number.isInteger(value) && value >= 0 && value < 12;
const validMode = value => value === 'major' || value === 'minor';
const keyName = (tonic, mode) => `${NOTE_NAMES[tonic]} ${mode}`;

export function keyColor(tonic, mode) {
  return validTonic(tonic) && validMode(mode) ? KEY_COLORS[mode][tonic] : UNKNOWN_KEY_COLOR;
}

function emptyResult(reason, chroma = Array(12).fill(0), candidates = []) {
  return { key: null, tonic: null, mode: null, confidence: 0, candidates, chroma, color: UNKNOWN_KEY_COLOR, reason, source: 'detected', method: 'chroma-profile-v1' };
}

export function manualKey(tonic, mode) {
  if (!validTonic(tonic) || !validMode(mode)) throw new RangeError('A key needs a pitch class from 0 to 11 and major or minor mode.');
  return { key: keyName(tonic, mode), tonic, mode, confidence: 1, candidates: [], chroma: Array(12).fill(0), color: keyColor(tonic, mode), reason: 'Manually assigned', source: 'manual', method: 'manual' };
}

/** Accept only bounded, safe musical metadata when loading an untrusted project. */
export function validateKeyAnalysis(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid saved key analysis.');
  const unknown = value.key === null;
  if (unknown ? value.tonic !== null || value.mode !== null : !validTonic(value.tonic) || !validMode(value.mode) || value.key !== keyName(value.tonic, value.mode)) throw new TypeError('Invalid saved musical key.');
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new RangeError('Invalid key confidence.');
  if (!Array.isArray(value.chroma) || value.chroma.length !== 12 || value.chroma.some(item => !Number.isFinite(item) || item < 0 || item > 1)) throw new RangeError('Invalid key chroma.');
  if (!Array.isArray(value.candidates) || value.candidates.length > 3) throw new RangeError('Invalid key candidates.');
  const candidates = value.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || !validTonic(candidate.tonic) || !validMode(candidate.mode) || candidate.key !== keyName(candidate.tonic, candidate.mode) || !Number.isFinite(candidate.score) || candidate.score < -1 || candidate.score > 1) throw new TypeError('Invalid key candidate.');
    return { key: keyName(candidate.tonic, candidate.mode), tonic: candidate.tonic, mode: candidate.mode, score: candidate.score };
  });
  if (typeof value.reason !== 'string' || value.reason.length > 256) throw new TypeError('Invalid key analysis explanation.');
  if (!['manual', 'detected'].includes(value.source) || value.method !== (value.source === 'manual' ? 'manual' : 'chroma-profile-v1')) throw new TypeError('Invalid key analysis method.');
  if (value.source === 'manual' && unknown) throw new TypeError('A manually assigned key cannot be unknown.');
  return {
    key: unknown ? null : keyName(value.tonic, value.mode), tonic: value.tonic, mode: value.mode,
    confidence: unknown ? 0 : value.confidence, candidates, chroma: value.chroma.slice(),
    color: keyColor(value.tonic, value.mode), reason: value.reason, source: value.source, method: value.method,
  };
}

function fft(real, imaginary) {
  const length = real.length;
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) { const value = real[i]; real[i] = real[j]; real[j] = value; }
  }
  for (let size = 2; size <= length; size *= 2) {
    const stepReal = Math.cos(-2 * Math.PI / size), stepImaginary = Math.sin(-2 * Math.PI / size);
    for (let start = 0; start < length; start += size) {
      let twiddleReal = 1, twiddleImaginary = 0;
      for (let offset = 0; offset < size / 2; offset++) {
        const a = start + offset, b = a + size / 2;
        const r = real[b] * twiddleReal - imaginary[b] * twiddleImaginary;
        const im = real[b] * twiddleImaginary + imaginary[b] * twiddleReal;
        real[b] = real[a] - r; imaginary[b] = imaginary[a] - im; real[a] += r; imaginary[a] += im;
        const next = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal; twiddleReal = next;
      }
    }
  }
}

function correlation(chroma, profile, tonic) {
  const meanChroma = chroma.reduce((sum, value) => sum + value, 0) / 12;
  const meanProfile = profile.reduce((sum, value) => sum + value, 0) / 12;
  let numerator = 0, varianceChroma = 0, varianceProfile = 0;
  for (let i = 0; i < 12; i++) {
    const a = chroma[i] - meanChroma, b = profile[(i - tonic + 12) % 12] - meanProfile;
    numerator += a * b; varianceChroma += a * a; varianceProfile += b * b;
  }
  return varianceChroma > 0 ? clamp(numerator / Math.sqrt(varianceChroma * varianceProfile), -1, 1) : 0;
}

/** Analyze at most 32 distributed windows (about 24 seconds of material), regardless
 * of clip duration. Very short, noisy, silent or ambiguous samples remain unknown.
 */
export function detectKey(audio) {
  validateAudio(audio);
  const duration = audio.channels[0].length / audio.sampleRate;
  if (duration < .25) return emptyResult('The sample is too short for a reliable musical-key estimate.');
  const sampleRate = Math.min(11025, audio.sampleRate), sourceFrames = Math.round(FFT_SIZE * audio.sampleRate / sampleRate);
  const windowCount = Math.min(MAX_WINDOWS, Math.max(1, Math.ceil(duration / .55)));
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const chroma = new Float64Array(12);
  let analyzedEnergy = 0, tonalEnergy = 0, spectralEnergy = 0, activeWindows = 0;
  for (let frame = 0; frame < windowCount; frame++) {
    const start = Math.round(Math.max(0, audio.channels[0].length - sourceFrames) * (windowCount === 1 ? .5 : frame / (windowCount - 1)));
    const section = { sampleRate: audio.sampleRate, channels: audio.channels.map(channel => channel.subarray(start, Math.min(channel.length, start + sourceFrames))) };
    const data = sampleRate === audio.sampleRate ? section : resampleAudio(section, sampleRate);
    const power = new Float64Array(FFT_SIZE / 2);
    let frameEnergy = 0;
    for (const channel of data.channels) {
      const real = new Float64Array(FFT_SIZE), imaginary = new Float64Array(FFT_SIZE);
      let mean = 0;
      for (const value of channel) mean += value;
      mean /= channel.length;
      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i] - mean; frameEnergy += sample * sample; real[i] = sample * window[i];
      }
      fft(real, imaginary);
      for (let i = 1; i < power.length; i++) power[i] += (real[i] ** 2 + imaginary[i] ** 2) / data.channels.length;
    }
    analyzedEnergy += frameEnergy / (data.channels.length * data.channels[0].length);
    if (frameEnergy / (data.channels.length * data.channels[0].length) < 1e-9) continue;
    activeWindows++;
    const firstBin = Math.ceil(55 * FFT_SIZE / sampleRate), lastBin = Math.min(power.length - 2, Math.floor(3200 * FFT_SIZE / sampleRate));
    let frameSpectrum = 0, largest = 0;
    for (let bin = firstBin; bin <= lastBin; bin++) { frameSpectrum += power[bin]; largest = Math.max(largest, power[bin]); }
    spectralEnergy += frameSpectrum;
    for (let bin = firstBin + 1; bin < lastBin; bin++) {
      if (power[bin] <= power[bin - 1] || power[bin] < power[bin + 1] || power[bin] < largest * .003) continue;
      // Parabolic interpolation in log-power improves tuning resolution between bins.
      const a = Math.log(Math.max(1e-30, power[bin - 1])), b = Math.log(Math.max(1e-30, power[bin])), c = Math.log(Math.max(1e-30, power[bin + 1]));
      const denominator = a - 2 * b + c, offset = denominator ? clamp(.5 * (a - c) / denominator, -.5, .5) : 0;
      const frequency = (bin + offset) * sampleRate / FFT_SIZE;
      const note = 69 + 12 * Math.log2(frequency / 440), nearest = Math.round(note), distance = Math.abs(note - nearest);
      if (distance > .35) continue;
      const energy = power[bin - 1] + power[bin] + power[bin + 1];
      tonalEnergy += energy;
      chroma[((nearest % 12) + 12) % 12] += energy ** .65 * (1 - distance);
    }
  }
  if (analyzedEnergy / windowCount < 1e-9 || !activeWindows) return emptyResult('The sample is silent or too quiet to identify a key.');
  const sum = chroma.reduce((total, value) => total + value, 0);
  if (sum <= 0) return emptyResult('No stable pitched content was detected.');
  const normalized = Array.from(chroma, value => value / sum), publicChroma = normalized.map(rounded);
  const concentration = normalized.reduce((total, value) => total + value * value, 0);
  const significant = normalized.filter(value => value > .065).length;
  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic++) for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
    candidates.push({ key: keyName(tonic, mode), tonic, mode, score: correlation(normalized, profile, tonic) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const alternatives = candidates.slice(0, 3).map(candidate => ({ ...candidate, score: rounded(candidate.score) }));
  const best = candidates[0], margin = best.score - candidates[1].score;
  const tonalRatio = Math.min(1, tonalEnergy / Math.max(spectralEnergy, 1e-30));
  if (significant < 3 || concentration > .65) return emptyResult('Too few distinct pitches to distinguish a major or minor key.', publicChroma, alternatives);
  if (tonalRatio < .55 || concentration < .10 || best.score < .58) return emptyResult('The sample has insufficient stable tonal evidence.', publicChroma, alternatives);
  if (margin < .025) return emptyResult('Several keys fit similarly; assign a key manually if known.', publicChroma, alternatives);
  const confidence = rounded(clamp(best.score * .55 + Math.min(.35, margin * 2) + Math.min(.1, duration / 40), 0, .98));
  return {
    key: best.key, tonic: best.tonic, mode: best.mode, confidence, candidates: alternatives,
    chroma: publicChroma, color: keyColor(best.tonic, best.mode),
    reason: 'Estimated from distributed chroma windows; verify by ear for ambiguous or changing-key material.',
    source: 'detected', method: 'chroma-profile-v1',
  };
}
