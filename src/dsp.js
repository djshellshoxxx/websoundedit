/** Pure, deterministic audio processing shared by the worker and Node API.
 * EQ coefficients: https://www.w3.org/TR/audio-eq-cookbook/
 * Time/pitch: @soundtouchjs/core 2.1.1 (MPL-2.0), a stereo-linked WSOLA pipeline.
 * All effects return newly owned PCM; inputs are never modified.
 */
import { processTimePitchPCM } from './time-pitch-pcm.js';

export const AUDIO_LIMITS = Object.freeze({ maxDuration: 600, maxBytes: 256 * 1024 * 1024, minSampleRate: 8000, maxSampleRate: 192000 });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (gain) => gain > 0 ? 20 * Math.log10(gain) : -Infinity;
function number(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${label} must be between ${min} and ${max}.`);
  return n;
}
function integer(value, fallback, min, max, label) {
  const n = number(value, fallback, min, max, label);
  if (!Number.isInteger(n)) throw new RangeError(`${label} must be an integer.`);
  return n;
}
function guardAllocation(frames, channels, sampleRate) {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames / sampleRate > AUDIO_LIMITS.maxDuration || frames * channels * 4 > AUDIO_LIMITS.maxBytes) {
    throw new RangeError('Audio exceeds the 10-minute / 256 MiB decoded-audio limit.');
  }
}
export function validateAudio(audio, { allowEmpty = true } = {}) {
  if (!audio || !Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2) throw new TypeError('Audio requires one or two channels.');
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 192000) throw new RangeError('Audio sample rate must be an integer between 8000 and 192000.');
  const frames = audio.channels[0]?.length;
  if (!Number.isSafeInteger(frames) || (!allowEmpty && frames === 0)) throw new RangeError('Select nonempty audio first.');
  guardAllocation(frames, audio.channels.length, audio.sampleRate);
  for (const channel of audio.channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames) throw new TypeError('Audio channels must be equal-length Float32Arrays.');
    for (let i = 0; i < frames; i++) if (!Number.isFinite(channel[i])) throw new RangeError('Audio contains a non-finite sample.');
  }
  return audio;
}
const copy = (audio) => ({ sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.slice()) });
const withChannels = (audio, channels) => ({ sampleRate: audio.sampleRate, channels });

export function sliceAudio(audio, start = 0, end = audio.channels[0].length / audio.sampleRate) {
  validateAudio(audio);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new RangeError('Audio range must have finite ordered boundaries.');
  const a = clamp(Math.round(start * audio.sampleRate), 0, audio.channels[0].length);
  const b = clamp(Math.round(end * audio.sampleRate), a, audio.channels[0].length);
  return withChannels(audio, audio.channels.map((channel) => channel.slice(a, b)));
}
export function concatAudio(parts) {
  if (!Array.isArray(parts) || !parts.length) throw new TypeError('Provide at least one audio part.');
  parts.forEach((part) => validateAudio(part));
  const { sampleRate, channels } = parts[0];
  if (parts.some((part) => part.sampleRate !== sampleRate || part.channels.length !== channels.length)) throw new RangeError('Concatenated audio must have the same sample rate and channel count.');
  const frames = parts.reduce((sum, part) => sum + part.channels[0].length, 0);
  guardAllocation(frames, channels.length, sampleRate);
  const output = channels.map(() => new Float32Array(frames));
  let offset = 0;
  for (const part of parts) {
    for (let c = 0; c < channels.length; c++) output[c].set(part.channels[c], offset);
    offset += part.channels[0].length;
  }
  return { sampleRate, channels: output };
}

/** Band-limited windowed-sinc resampling; the same kernel positions link stereo. */
export function resampleAudio(audio, sampleRate) {
  validateAudio(audio);
  sampleRate = integer(sampleRate, 48000, 8000, 192000, 'Sample rate');
  if (sampleRate === audio.sampleRate) return copy(audio);
  const rate = audio.sampleRate / sampleRate;
  const frames = Math.round(audio.channels[0].length / rate);
  guardAllocation(frames, audio.channels.length, sampleRate);
  const cutoff = Math.min(1, 1 / rate), radius = Math.ceil(12 / cutoff), taps = radius * 2, phases = 512;
  const sinc = (x) => Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const table = new Float64Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = j - radius + 1 - p / phases;
      const weight = Math.abs(d) < radius ? cutoff * sinc(d * cutoff) * sinc(d / radius) : 0;
      table[p * taps + j] = weight;
      sum += weight;
    }
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  const output = audio.channels.map(() => new Float32Array(frames));
  const last = audio.channels[0].length - 1;
  for (let i = 0; i < frames; i++) {
    const position = i * rate, center = Math.floor(position), phase = Math.min(phases - 1, Math.floor((position - center) * phases));
    const begin = center - radius + 1;
    for (let c = 0; c < output.length; c++) {
      let value = 0;
      for (let j = 0; j < taps; j++) value += audio.channels[c][clamp(begin + j, 0, last)] * table[phase * taps + j];
      output[c][i] = value;
    }
  }
  return validateAudio({ sampleRate, channels: output });
}

export function analyzeAudio(audio) {
  validateAudio(audio);
  const frames = audio.channels[0].length, count = frames * audio.channels.length;
  let peak = 0, sumSquares = 0, sum = 0, clippedSamples = 0, cross = 0, leftSq = 0, rightSq = 0;
  const offsets = [];
  for (const channel of audio.channels) {
    let channelSum = 0;
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
      channelSum += sample;
      if (Math.abs(sample) >= 1) clippedSamples++;
    }
    sum += channelSum;
    offsets.push(frames ? channelSum / frames : 0);
  }
  if (audio.channels.length === 2) for (let i = 0; i < frames; i++) {
    const a = audio.channels[0][i], b = audio.channels[1][i];
    cross += a * b; leftSq += a * a; rightSq += b * b;
  }
  return { peakDb: gainToDb(peak), rmsDb: gainToDb(Math.sqrt(count ? sumSquares / count : 0)), duration: frames / audio.sampleRate,
    channels: audio.channels.length, sampleRate: audio.sampleRate, clippedSamples, dcOffset: count ? sum / count : 0,
    dcOffsets: offsets, correlation: audio.channels.length === 2 ? (leftSq * rightSq > 0 ? clamp(cross / Math.sqrt(leftSq * rightSq), -1, 1) : 0) : 1 };
}

/** Silence is a run of 10 ms windows with every channel below threshold RMS.
 * Padding shrinks only boundaries adjacent to retained sound; it never extends removal. */
export function detectSilence(audio, params = {}) {
  validateAudio(audio);
  const threshold = dbToGain(number(params.thresholdDb, -45, -100, 0, 'Silence threshold'));
  const minimum = number(params.minDuration, 0.2, 0.005, 60, 'Minimum silence');
  const padding = number(params.padding, 0.02, 0, 5, 'Silence padding');
  const n = audio.channels[0].length, sr = audio.sampleRate, hop = Math.max(1, Math.round(sr * 0.01)), ranges = [];
  let start = -1;
  const endRange = (end) => {
    if (start < 0) return;
    if ((end - start) / sr >= minimum - 1 / sr) {
      const a = start / sr + (start > 0 ? padding : 0);
      const b = end / sr - (end < n ? padding : 0);
      if (b > a) ranges.push({ start: a, end: b });
    }
    start = -1;
  };
  for (let i = 0; i < n; i += hop) {
    const end = Math.min(n, i + hop);
    let maxRms = 0;
    for (const channel of audio.channels) {
      let energy = 0;
      for (let j = i; j < end; j++) energy += channel[j] * channel[j];
      maxRms = Math.max(maxRms, Math.sqrt(energy / (end - i)));
    }
    if (maxRms <= threshold) { if (start < 0) start = i; }
    else endRange(i);
  }
  endRange(n);
  return ranges;
}

/** Tempo estimate from onset-envelope autocorrelation. Confidence is heuristic,
 * not a statistical probability; weak/short/nonrhythmic material returns null. */
export function detectBpm(audio, params = {}) {
  validateAudio(audio);
  const minBpm = number(params.minBpm, 60, 30, 300, 'Minimum BPM');
  const maxBpm = number(params.maxBpm, 200, minBpm, 400, 'Maximum BPM');
  const none = { bpm: null, confidence: 0, candidates: [], beatOffset: 0 };
  const sr = audio.sampleRate, n = audio.channels[0].length;
  if (n / sr < 1.5) return none;
  const hop = Math.round(sr / 200), rate = sr / hop, bins = Math.ceil(n / hop);
  const energy = new Float64Array(bins), onset = new Float64Array(bins);
  let maxEnergy = 0, mean = 0, variance = 0;
  for (let i = 0; i < bins; i++) {
    let sum = 0;
    const end = Math.min(n, (i + 1) * hop);
    for (const channel of audio.channels) for (let j = i * hop; j < end; j++) sum += channel[j] * channel[j];
    energy[i] = Math.sqrt(sum / ((end - i * hop) * audio.channels.length));
    maxEnergy = Math.max(maxEnergy, energy[i]); mean += energy[i];
  }
  if (maxEnergy < 1e-5) return none;
  mean /= bins;
  for (const x of energy) variance += (x - mean) ** 2;
  if (Math.sqrt(variance / bins) / Math.max(mean, 1e-12) < 0.08) return none;
  let baseline = 0, onsetEnergy = 0;
  for (let i = 0; i < bins; i++) {
    onset[i] = Math.max(0, energy[i] - baseline - maxEnergy * 0.01);
    baseline = baseline * 0.7 + energy[i] * 0.3;
    onsetEnergy += onset[i] ** 2;
  }
  if (onsetEnergy < 1e-10) return none;
  let largestOnset = 0;
  for (const value of onset) largestOnset = Math.max(largestOnset, value);
  const events = [];
  for (let i = 0; i < bins; i++) if (onset[i] > largestOnset * 0.2 && onset[i] >= (onset[i - 1] || 0) && onset[i] >= (onset[i + 1] || 0)) {
    if (!events.length || i - events[events.length - 1] > rate * 0.08) events.push(i);
    else if (onset[i] > onset[events[events.length - 1]]) events[events.length - 1] = i;
  }
  const intervals = events.slice(1).map((event, i) => event - events[i]);
  const minLag = Math.max(1, Math.floor(rate * 60 / maxBpm)), maxLag = Math.min(bins - 1, Math.ceil(rate * 60 / minBpm));
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    for (let i = lag; i < bins; i++) dot += onset[i] * onset[i - lag];
    scores[lag] = dot / onsetEnergy;
  }
  const candidates = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] < 0.1 || scores[lag] < scores[lag - 1] || scores[lag] < scores[lag + 1]) continue;
    const denominator = scores[lag - 1] - 2 * scores[lag] + scores[lag + 1];
    const correction = denominator ? clamp(0.5 * (scores[lag - 1] - scores[lag + 1]) / denominator, -0.5, 0.5) : 0;
    let bpm = rate * 60 / (lag + correction);
    if (bpm < minBpm || bpm > maxBpm) continue;
    // Fractional lags can favor a twice-longer period; direct adjacent-onset
    // evidence distinguishes that artifact from the actual pulse period.
    const matchingIntervals = intervals.filter((interval) => Math.abs(interval / (lag + correction) - 1) < 0.06);
    const directSupport = intervals.length ? matchingIntervals.length / intervals.length : 0;
    if (matchingIntervals.length >= 3) bpm = rate * 60 / (matchingIntervals.reduce((sum, interval) => sum + interval, 0) / matchingIntervals.length);
    const prior = 0.9 + 0.1 * Math.exp(-0.5 * (Math.log(bpm / 120) / 0.5) ** 2);
    candidates.push({ bpm: Math.round(bpm * 100) / 100, score: scores[lag], confidence: Math.min(0.98, scores[lag]), rank: scores[lag] * prior * (0.8 + 0.4 * directSupport) });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  if (!candidates.length) return none;
  const best = candidates[0], period = 60 / best.bpm;
  // Choose a phase that maximizes onset energy on the inferred beat grid.
  const periodBins = rate * period;
  let bestPhase = 0, bestPhaseScore = -1;
  for (let phase = 0; phase < Math.ceil(periodBins); phase++) {
    let score = 0;
    for (let position = phase; position < bins; position += periodBins) score += onset[Math.min(bins - 1, Math.round(position))];
    if (score > bestPhaseScore) { bestPhase = phase; bestPhaseScore = score; }
  }
  return { bpm: best.bpm, confidence: Math.round(best.confidence * 100) / 100,
    candidates: candidates.filter((candidate, i, list) => !list.slice(0, i).some((previous) => Math.abs(candidate.bpm / previous.bpm - 1) < 0.03)).slice(0, 5).map(({ bpm, score, confidence }) => ({ bpm, score, confidence })), beatOffset: bestPhase / rate };
}

/** RBJ biquad coefficients, normalized a0. Public for drawing the actual EQ response. */
export function eqCoefficients(band = {}, sampleRate = 48000) {
  number(sampleRate, 48000, 8000, 192000, 'Sample rate');
  const type = band.type || 'peaking';
  const f = Math.min(sampleRate * 0.499, number(band.frequency, 1000, 5, 96000, 'EQ frequency'));
  const q = number(band.q, 0.707, 0.1, 30, 'EQ Q');
  const gain = number(band.gainDb, 0, -36, 36, 'EQ gain');
  const w = 2 * Math.PI * f / sampleRate, c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q), A = 10 ** (gain / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A; break;
    case 'lowpass': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'lowshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * c + beta); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - beta);
      a0 = (A + 1) + (A - 1) * c + beta; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - beta; break;
    }
    case 'highshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * c + beta); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - beta);
      a0 = (A + 1) - (A - 1) * c + beta; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - beta; break;
    }
    default: throw new RangeError(`Unsupported EQ filter: ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function equalize(audio, params) {
  if (!Array.isArray(params.bands) || params.bands.length > 12) throw new RangeError('EQ requires up to 12 bands.');
  const output = copy(audio);
  for (const band of params.bands) {
    if (band.enabled === false) continue;
    const { b0, b1, b2, a1, a2 } = eqCoefficients(band, audio.sampleRate);
    for (const channel of output.channels) {
      let z1 = 0, z2 = 0;
      for (let i = 0; i < channel.length; i++) {
        const input = channel[i], y = b0 * input + z1;
        z1 = b1 * input - a1 * y + z2;
        z2 = b2 * input - a2 * y;
        channel[i] = y;
      }
    }
  }
  return output;
}
function compressorGainDb(levelDb, threshold, ratio, knee) {
  const over = levelDb - threshold;
  if (over <= -knee / 2) return 0;
  if (knee > 0 && over < knee / 2) return (1 / ratio - 1) * (over + knee / 2) ** 2 / (2 * knee);
  return (1 / ratio - 1) * over;
}
function compress(audio, params, detectorAudio = audio, depth = 1) {
  const threshold = number(params.thresholdDb, -18, -80, 0, 'Compressor threshold');
  const ratio = number(params.ratio, 4, 1, 100, 'Compressor ratio');
  const attack = number(params.attackMs, 10, 0, 500, 'Compressor attack');
  const release = number(params.releaseMs, 120, 1, 5000, 'Compressor release');
  const knee = number(params.kneeDb, 6, 0, 40, 'Compressor knee');
  const makeup = dbToGain(number(params.makeupDb, 0, -24, 36, 'Makeup gain'));
  const a = attack === 0 ? 0 : Math.exp(-1 / (audio.sampleRate * attack / 1000));
  const r = Math.exp(-1 / (audio.sampleRate * release / 1000));
  const output = copy(audio);
  let envelopeDb = 0;
  for (let i = 0; i < audio.channels[0].length; i++) {
    let peak = 0;
    for (const channel of detectorAudio.channels) peak = Math.max(peak, Math.abs(channel[i] || 0));
    const desired = compressorGainDb(gainToDb(peak), threshold, ratio, knee);
    const coefficient = desired < envelopeDb ? a : r;
    envelopeDb = coefficient * envelopeDb + (1 - coefficient) * desired;
    const gain = ((1 - depth) + depth * dbToGain(envelopeDb)) * makeup;
    for (const channel of output.channels) channel[i] *= gain;
  }
  return output;
}
function limit(audio, params) {
  const ceiling = dbToGain(number(params.ceilingDb, -1, -24, 0, 'Limiter ceiling'));
  const release = number(params.releaseMs, 80, 1, 5000, 'Limiter release');
  const lookahead = Math.round(number(params.lookaheadMs, 5, 0, 50, 'Limiter lookahead') * audio.sampleRate / 1000);
  const n = audio.channels[0].length, peaks = new Float32Array(n), output = copy(audio);
  for (let i = 0; i < n; i++) for (const channel of audio.channels) peaks[i] = Math.max(peaks[i], Math.abs(channel[i]));
  // Monotonic ring deque gives the maximum future peak in O(n), without shifting arrays.
  const capacity = Math.min(n, lookahead + 1) + 1, deque = new Uint32Array(capacity);
  let head = 0, tail = 0, inserted = 0, gain = 1;
  const releaseCoefficient = Math.exp(-1 / (audio.sampleRate * release / 1000));
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + lookahead);
    while (head !== tail && deque[head] < i) head = (head + 1) % capacity;
    while (inserted <= end) {
      while (head !== tail && peaks[deque[(tail - 1 + capacity) % capacity]] <= peaks[inserted]) tail = (tail - 1 + capacity) % capacity;
      deque[tail] = inserted++; tail = (tail + 1) % capacity;
    }
    while (head !== tail && deque[head] < i) head = (head + 1) % capacity;
    const maximum = head === tail ? 0 : peaks[deque[head]], desired = maximum > ceiling ? ceiling / maximum : 1;
    gain = desired < gain ? desired : desired + releaseCoefficient * (gain - desired);
    for (const channel of output.channels) channel[i] *= gain;
  }
  return output;
}

/** Envelope is normalized output gain: 0 is closed and 1 is open. */
export function duckEnvelope(phase, params = {}) {
  const x = ((phase % 1) + 1) % 1;
  if (Array.isArray(params.points) && params.points.length) {
    const points = params.points;
    if (x <= points[0].x) return points[0].y;
    for (let j = 1; j < points.length; j++) if (x <= points[j].x) {
      const previous = points[j - 1], current = points[j];
      const u = (x - previous.x) / (current.x - previous.x);
      return previous.y + (current.y - previous.y) * u;
    }
    return points[points.length - 1].y;
  }
  const attack = params.attack ?? 0.01, hold = params.hold ?? 0.05, release = params.release ?? 0.8, curve = params.curve ?? 2;
  if (attack > 0 && x < attack) return 1 - x / attack;
  if (x < attack + hold) return 0;
  if (release > 0 && x < attack + hold + release) return ((x - attack - hold) / release) ** curve;
  return 1;
}
function normalizeDuck(params) {
  const p = { ...params };
  p.depth = number(p.depth, 0.8, 0, 1, 'Ducking depth');
  p.rate = number(p.rate, 1, 0.0625, 16, 'Beats per duck cycle');
  p.attack = number(p.attack, 0.01, 0, 1, 'Envelope attack fraction');
  p.hold = number(p.hold, 0.05, 0, 1, 'Envelope hold fraction');
  p.release = number(p.release, 0.8, 0, 1, 'Envelope release fraction');
  p.curve = number(p.curve, 2, 0.1, 10, 'Envelope curve');
  if (p.attack + p.hold + p.release > 1 + 1e-9) throw new RangeError('Envelope attack, hold and release must fit inside one cycle.');
  if (p.points !== undefined) {
    if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 64) throw new RangeError('A custom envelope needs 2–64 points.');
    p.points = p.points.map((point) => ({ x: number(point.x, 0, 0, 1, 'Envelope time'), y: number(point.y, 1, 0, 1, 'Envelope gain') }));
    for (let i = 1; i < p.points.length; i++) if (p.points[i].x <= p.points[i - 1].x) throw new RangeError('Envelope points must have strictly increasing times.');
  }
  if (!['tempo', 'track'].includes(p.source || 'tempo')) throw new RangeError('Sidechain source must be tempo or track.');
  if (!['volume', 'compressor'].includes(p.mode || 'volume')) throw new RangeError('Ducking mode must be volume or compressor.');
  return p;
}
function duck(audio, params, context) {
  const p = normalizeDuck(params), sr = audio.sampleRate, n = audio.channels[0].length;
  let sidechain;
  if (p.source === 'track') {
    if (!context.sidechain) throw new RangeError('Select a sidechain source track.');
    validateAudio(context.sidechain);
    sidechain = context.sidechain.sampleRate === sr ? context.sidechain : resampleAudio(context.sidechain, sr);
  } else {
    const bpm = number(context.bpm ?? p.bpm, 120, 20, 400, 'BPM');
    const offset = number(context.beatOffset, 0, -600, 600, 'Beat offset');
    const cycle = 60 / bpm * p.rate;
    sidechain = { sampleRate: sr, channels: [new Float32Array(n)] };
    for (let i = 0; i < n; i++) sidechain.channels[0][i] = 1 - duckEnvelope((i / sr - offset) / cycle, p);
  }
  if (p.mode === 'compressor') return compress(audio, p, sidechain, p.depth);
  const output = copy(audio);
  if (p.source === 'track') {
    const attack = number(p.attackMs, 5, 0, 500, 'Sidechain attack');
    const release = number(p.releaseMs, 180, 1, 5000, 'Sidechain release');
    const threshold = dbToGain(number(p.thresholdDb, -18, -80, 0, 'Sidechain sensitivity'));
    const a = attack === 0 ? 0 : Math.exp(-1 / (sr * attack / 1000)), r = Math.exp(-1 / (sr * release / 1000));
    let envelope = 0;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (const channel of sidechain.channels) peak = Math.max(peak, Math.abs(channel[i] || 0));
      const target = clamp(peak / threshold, 0, 1), coefficient = target > envelope ? a : r;
      envelope = coefficient * envelope + (1 - coefficient) * target;
      const gain = 1 - p.depth * envelope;
      for (const channel of output.channels) channel[i] *= gain;
    }
  } else for (let i = 0; i < n; i++) {
    const gain = 1 - p.depth * sidechain.channels[0][i];
    for (const channel of output.channels) channel[i] *= gain;
  }
  return output;
}
function randomGenerator(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function granular(audio, params) {
  const n = audio.channels[0].length, sr = audio.sampleRate;
  const grain = Math.min(n, Math.max(8, Math.round(number(params.grainMs, 80, 5, 500, 'Grain size') * sr / 1000)));
  const density = number(params.density, 4, 1, 12, 'Grain overlap');
  const spread = number(params.spread, 0.4, 0, 1, 'Grain spread');
  const mix = number(params.mix, 0.7, 0, 1, 'Granular mix');
  const seed = integer(params.seed, 7, 0, 4294967295, 'Grain seed');
  if (n < 2 || mix === 0) return copy(audio);
  const random = randomGenerator(seed), hop = Math.max(1, Math.floor(grain / density));
  const output = audio.channels.map(() => new Float32Array(n)), weights = new Float32Array(n), window = new Float32Array(grain);
  for (let i = 0; i < grain; i++) window[i] = Math.sin(Math.PI * (i + 0.5) / grain) ** 2;
  for (let start = -grain + hop; start < n; start += hop) {
    const offset = Math.round((random() * 2 - 1) * spread * Math.min(n, sr * 0.5));
    const frozen = params.freeze ? Math.floor(number(params.position, 0.5, 0, 1, 'Freeze position') * (n - 1)) : start;
    for (let j = Math.max(0, -start); j < Math.min(grain, n - start); j++) {
      const position = start + j, source = ((frozen + offset + j) % n + n) % n;
      weights[position] += window[j];
      for (let c = 0; c < output.length; c++) output[c][position] += audio.channels[c][source] * window[j];
    }
  }
  for (let c = 0; c < output.length; c++) for (let i = 0; i < n; i++) {
    const wet = weights[i] > 1e-8 ? output[c][i] / weights[i] : audio.channels[c][i];
    output[c][i] = audio.channels[c][i] * (1 - mix) + wet * mix;
  }
  return withChannels(audio, output);
}
function repeatLoop(audio, params) {
  const repeats = integer(params.repeats, 2, 1, 64, 'Loop repeats'), n = audio.channels[0].length;
  const overlap = Math.min(Math.floor(n / 2), Math.round(number(params.crossfadeMs, 5, 0, 500, 'Loop crossfade') * audio.sampleRate / 1000));
  const length = n * repeats - overlap * (repeats - 1);
  guardAllocation(length, audio.channels.length, audio.sampleRate);
  const output = audio.channels.map(() => new Float32Array(length));
  for (let c = 0; c < output.length; c++) for (let repeat = 0; repeat < repeats; repeat++) {
    const start = repeat * (n - overlap);
    for (let i = 0; i < n; i++) {
      if (repeat > 0 && i < overlap) {
        const mix = (i + 1) / (overlap + 1);
        output[c][start + i] = output[c][start + i] * (1 - mix) + audio.channels[c][i] * mix;
      } else output[c][start + i] = audio.channels[c][i];
    }
  }
  return withChannels(audio, output);
}
function beatRepeat(audio, params, context) {
  const bpm = number(params.bpm ?? context.bpm, 120, 20, 400, 'BPM');
  const division = integer(params.division, 4, 1, 16, 'Slices per beat');
  const frames = Math.max(1, Math.round(audio.sampleRate * 60 / bpm / division));
  const slices = Math.ceil(audio.channels[0].length / frames);
  let pattern = params.pattern;
  if (pattern === undefined) pattern = Array.from({ length: slices }, (_, i) => i);
  if (!Array.isArray(pattern) || !pattern.length || pattern.length > 1024) throw new RangeError('A beat pattern needs 1–1024 slice indexes.');
  pattern = pattern.map((index) => integer(index, 0, 0, slices - 1, 'Slice index'));
  const length = frames * pattern.length;
  guardAllocation(length, audio.channels.length, audio.sampleRate);
  const output = audio.channels.map(() => new Float32Array(length));
  const fade = Math.min(Math.round(audio.sampleRate * 0.002), Math.floor(frames / 4));
  for (let step = 0; step < pattern.length; step++) for (let c = 0; c < output.length; c++) {
    for (let i = 0; i < frames; i++) {
      let gain = 1;
      if (fade > 0) gain = Math.min(1, i / fade, (frames - 1 - i) / fade);
      output[c][step * frames + i] = (audio.channels[c][pattern[step] * frames + i] || 0) * gain;
    }
  }
  return withChannels(audio, output);
}

export async function processAudio(audio, effect, params = {}, context = {}) {
  validateAudio(audio, { allowEmpty: false });
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Effect parameters must be an object.');
  let output;
  const n = audio.channels[0].length, sr = audio.sampleRate;
  switch (effect) {
    case 'gain': {
      const gain = dbToGain(number(params.db, 0, -96, 36, 'Gain'));
      output = withChannels(audio, audio.channels.map((channel) => Float32Array.from(channel, (sample) => sample * gain))); break;
    }
    case 'normalize': {
      const target = dbToGain(number(params.targetDb, -1, -60, 0, 'Normalization target'));
      let peak = 0;
      for (const channel of audio.channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
      const gain = peak > 0 ? target / peak : 1;
      output = withChannels(audio, audio.channels.map((channel) => Float32Array.from(channel, (sample) => sample * gain))); break;
    }
    case 'fadeIn': case 'fadeOut': {
      const duration = number(params.duration, n / sr, 0, 600, 'Fade duration');
      const frames = Math.min(n, Math.max(0, Math.round(duration * sr)));
      output = copy(audio);
      for (const channel of output.channels) for (let i = 0; i < frames; i++) {
        const gain = frames === 1 ? 0 : i / (frames - 1);
        const at = effect === 'fadeIn' ? i : n - 1 - i;
        channel[at] *= gain;
      }
      break;
    }
    case 'reverse': output = withChannels(audio, audio.channels.map((channel) => channel.slice().reverse())); break;
    case 'invert': output = withChannels(audio, audio.channels.map((channel) => Float32Array.from(channel, (sample) => -sample))); break;
    case 'silence': output = withChannels(audio, audio.channels.map(() => new Float32Array(n))); break;
    case 'dcRemove': output = withChannels(audio, audio.channels.map((channel) => {
      let sum = 0; for (const sample of channel) sum += sample; const mean = sum / n;
      return Float32Array.from(channel, (sample) => sample - mean);
    })); break;
    case 'phase': {
      const delay = number(params.delayMs, 0, -50, 50, 'Channel delay') * sr / 1000;
      output = withChannels(audio, audio.channels.map((channel) => Float32Array.from({ length: n }, (_, i) => {
        const position = i - delay, j = Math.floor(position), fraction = position - j;
        return (channel[j] || 0) * (1 - fraction) + (channel[j + 1] || 0) * fraction;
      }))); break;
    }
    case 'pan': {
      const pan = number(params.pan, 0, -1, 1, 'Pan');
      if (audio.channels.length === 1) {
        const angle = (pan + 1) * Math.PI / 4;
        output = withChannels(audio, [Float32Array.from(audio.channels[0], (x) => x * Math.cos(angle)), Float32Array.from(audio.channels[0], (x) => x * Math.sin(angle))]);
      } else output = withChannels(audio, [Float32Array.from(audio.channels[0], (x) => x * (pan > 0 ? Math.cos(pan * Math.PI / 2) : 1)), Float32Array.from(audio.channels[1], (x) => x * (pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1))]);
      break;
    }
    case 'mono': output = withChannels(audio, [Float32Array.from({ length: n }, (_, i) => audio.channels.reduce((sum, channel) => sum + channel[i], 0) / audio.channels.length)]); break;
    case 'swap': output = withChannels(audio, audio.channels.slice().reverse().map((channel) => channel.slice())); break;
    case 'eq': output = equalize(audio, params); break;
    case 'compressor': output = compress(audio, params); break;
    case 'limiter': output = limit(audio, params); break;
    case 'duck': output = duck(audio, params, context); break;
    case 'loop': output = repeatLoop(audio, params); break;
    case 'beatRepeat': output = beatRepeat(audio, params, context); break;
    case 'granular': output = granular(audio, params); break;
    case 'removeSilence': {
      const ranges = detectSilence(audio, params), parts = [];
      let start = 0;
      for (const range of ranges) { if (range.start > start) parts.push(sliceAudio(audio, start, range.start)); start = range.end; }
      if (start < n / sr) parts.push(sliceAudio(audio, start, n / sr));
      output = parts.length ? concatAudio(parts) : withChannels(audio, audio.channels.map(() => new Float32Array(0)));
      break;
    }
    case 'speed': {
      const rate = number(params.rate, 1, 0.5, 2, 'Playback rate');
      output = withChannels(audio, await processTimePitchPCM(audio.channels, sr, { speed: rate })); break;
    }
    case 'stretch': {
      const ratio = number(params.ratio, 1, 0.5, 2, 'Time-stretch ratio');
      const settings = params.preservePitch === false ? { speed: 1 / ratio } : { stretch: ratio };
      output = withChannels(audio, await processTimePitchPCM(audio.channels, sr, settings)); break;
    }
    case 'pitch': {
      const semitones = number(params.semitones, 0, -12, 12, 'Pitch semitones');
      const settings = params.preserveDuration === false ? { speed: 2 ** (semitones / 12) } : { pitchSemitones: semitones };
      output = withChannels(audio, await processTimePitchPCM(audio.channels, sr, settings)); break;
    }
    default: throw new RangeError(`Unknown audio effect: ${effect}`);
  }
  // Identity time/pitch processors may return input references; public effects own their output.
  if (output.channels.some((channel, i) => channel === audio.channels[i])) output = copy(output);
  return validateAudio(output);
}

export function generateAudio(params = {}) {
  const sampleRate = integer(params.sampleRate, 48000, 8000, 192000, 'Sample rate');
  const duration = number(params.duration, 4, 1 / sampleRate, 600, 'Generator duration');
  const amplitude = number(params.amplitude, 0.5, 0, 1, 'Generator amplitude');
  const frequency = number(params.frequency, 220, 1, sampleRate * 0.49, 'Generator frequency');
  const type = params.type || 'tone';
  const channels = integer(params.channels, type === 'drums' ? 2 : 1, 1, 2, 'Generator channels');
  const n = Math.max(1, Math.round(duration * sampleRate));
  guardAllocation(n, channels, sampleRate);
  const output = Array.from({ length: channels }, () => new Float32Array(n));
  const random = randomGenerator(integer(params.seed, 42, 0, 4294967295, 'Generator seed'));
  if (type === 'drums') {
    const bpm = number(params.bpm, 120, 20, 400, 'Generator BPM'), beat = 60 / bpm;
    for (let i = 0; i < n; i++) {
      const time = i / sampleRate, phase = time % beat, beatIndex = Math.floor(time / beat + 1e-9);
      const kick = Math.sin(2 * Math.PI * (48 * phase + 16 * (1 - Math.exp(-phase * 35)) / 35)) * Math.exp(-phase * 16);
      const hatPhase = time % (beat / 2), hat = (random() * 2 - 1) * Math.exp(-hatPhase * 100) * 0.16;
      const snare = beatIndex % 2 === 1 ? (random() * 2 - 1) * Math.exp(-phase * 28) * 0.42 : 0;
      const value = (kick * 0.7 + snare + hat) * amplitude * 0.8;
      output[0][i] = value;
      if (channels === 2) output[1][i] = value * 0.94 + hat * amplitude * 0.1;
    }
  } else if (type === 'tone' || type === 'noise' || type === 'sweep') {
    const endFrequency = type === 'sweep' ? number(params.endFrequency, Math.min(12000, sampleRate * 0.45), 1, sampleRate * 0.49, 'Sweep end frequency') : frequency;
    const ratio = endFrequency / frequency, logRatio = Math.log(ratio);
    const edge = Math.min(Math.round(sampleRate * 0.005), Math.floor(n / 2));
    for (let i = 0; i < n; i++) {
      const time = i / sampleRate;
      const phase = type === 'sweep' && Math.abs(logRatio) > 1e-10 ? frequency * duration / logRatio * (Math.exp(time / duration * logRatio) - 1) : frequency * time;
      const envelope = edge ? Math.min(1, i / edge, (n - 1 - i) / edge) : 1;
      const value = (type === 'noise' ? random() * 2 - 1 : Math.sin(2 * Math.PI * phase)) * amplitude * envelope;
      for (const channel of output) channel[i] = value;
    }
  } else throw new RangeError(`Unknown generator type: ${type}`);
  return validateAudio({ sampleRate, channels: output });
}
