/** Bounded offline restoration primitives used by named presets.
 * All channels and frames are retained; inputs are immutable. Center processing
 * is mid/side algebra, not source separation. De-essing attenuates a high band.
 */
import { dbToGain, eqCoefficients, gainToDb, processAudio, validateAudio } from './dsp.js';
import { layoutMetadata } from './channel-layout.js';

const withChannels = (audio, channels) => ({ sampleRate: audio.sampleRate, ...layoutMetadata(audio), channels });
function number(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) throw new RangeError(`${label} must be a finite number between ${min} and ${max}.`);
  return result;
}
function options(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Processing parameters must be an object.');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RangeError('Unknown processing parameter.');
}

/** Forward/backward biquad with bounded odd-reflected edge padding.
 * Zero phase is essential when a filtered band is subtracted from dry audio:
 * a phase-shifted crossover can amplify some frequencies instead of reducing them.
 * Only one output channel plus <=4096 padding samples is allocated per call.
 */
function zeroPhaseFilter(input, sampleRate, type, frequency) {
  const cutoff = Math.min(sampleRate * .45, Math.max(5, frequency));
  const { b0, b1, b2, a1, a2 } = eqCoefficients({ type, frequency: cutoff, q: Math.SQRT1_2 }, sampleRate);
  const n = input.length, padding = Math.min(n - 1, 4096, Math.ceil(8 * sampleRate / cutoff));
  const output = new Float32Array(n), tail = new Float32Array(padding);
  const dcGain = type === 'highpass' ? 0 : 1;
  let z1 = 0, z2 = 0;
  const initialize = sample => { const y = dcGain * sample; z1 = y - b0 * sample; z2 = b2 * sample - a2 * y; };
  const tick = sample => { const y = b0 * sample + z1; z1 = b1 * sample - a1 * y + z2; z2 = b2 * sample - a2 * y; return y; };
  initialize(padding ? 2 * input[0] - input[padding] : input[0]);
  for (let i = padding; i > 0; i--) tick(2 * input[0] - input[i]);
  for (let i = 0; i < n; i++) output[i] = tick(input[i]);
  for (let i = 0; i < padding; i++) tail[i] = tick(2 * input[n - 1] - input[n - 2 - i]);
  initialize(padding ? tail[padding - 1] : output[n - 1]);
  for (let i = padding - 1; i >= 0; i--) tick(tail[i]);
  for (let i = n - 1; i >= 0; i--) output[i] = tick(output[i]);
  return output;
}

export function repairClipping(audio, params = {}) {
  validateAudio(audio, { allowEmpty: false });
  options(params, ['threshold', 'maxClipMs', 'maxBoostDb', 'ceilingDb']);
  const threshold = number(params.threshold, .98, .5, 1, 'Clip threshold');
  const maxFrames = Math.max(2, Math.round(number(params.maxClipMs, 4, .05, 10, 'Maximum clipped span') * audio.sampleRate / 1000));
  const maxBoost = dbToGain(number(params.maxBoostDb, 6, 0, 12, 'Maximum reconstruction boost'));
  const ceiling = params.ceilingDb === null ? null : dbToGain(number(params.ceilingDb, -1, -24, 0, 'Repair ceiling'));
  const channels = audio.channels.map(channel => channel.slice());
  let repairedPeaks = 0, repairedFrames = 0;
  for (let c = 0; c < channels.length; c++) {
    const input = audio.channels[c], output = channels[c], n = input.length;
    for (let start = 0; start < n;) {
      const sign = input[start] < 0 ? -1 : 1, plateau = Math.abs(input[start]);
      if (plateau < threshold) { start++; continue; }
      const tolerance = plateau * 1e-6;
      let end = start + 1;
      while (end < n && Math.abs(input[end] * sign - plateau) <= tolerance) end++;
      const width = end - start;
      if (width >= 2 && width <= maxFrames && start >= 3 && end + 2 < n) {
        const y0 = sign * input[start - 1], y1 = sign * input[end];
        const p1 = sign * input[start - 2], p2 = sign * input[start - 3];
        const q1 = sign * input[end + 1], q2 = sign * input[end + 2];
        // Smooth shoulders must point into/out of this peak. Constant/square
        // plateaus, unsupported edges and long clipping are left untouched.
        if (y0 < plateau - tolerance && y1 < plateau - tolerance && y0 > p1 && p1 > p2 && y1 > q1 && q1 > q2) {
          const m0 = (3 * y0 - 4 * p1 + p2) / 2, m1 = (-3 * y1 + 4 * q1 - q2) / 2;
          if (m0 > 0 && m1 < 0) {
            const span = width + 1;
            let changed = false;
            for (let i = 0; i < width; i++) {
              const t = (i + 1) / span, t2 = t * t, t3 = t2 * t;
              const interpolated = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * span * m0
                + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * span * m1;
              const value = Math.max(plateau, Math.min(plateau * maxBoost, interpolated));
              if (value > plateau + tolerance) changed = true;
              output[start + i] = sign * value;
            }
            if (changed) { repairedPeaks++; repairedFrames += width; }
          }
        }
      }
      start = end;
    }
  }
  let appliedGain = 1;
  if (repairedPeaks && ceiling !== null) {
    let peak = 0;
    for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
    if (peak > ceiling) {
      appliedGain = ceiling / peak;
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= appliedGain;
    }
  }
  return { ...validateAudio(withChannels(audio, channels)), repairInfo: { repairedPeaks, repairedFrames, appliedGain } };
}

export function deEss(audio, params = {}) {
  validateAudio(audio, { allowEmpty: false });
  options(params, ['frequency', 'thresholdDb', 'ratio', 'maxReductionDb', 'attackMs', 'releaseMs']);
  const frequency = number(params.frequency, 5500, 1000, 16000, 'De-esser frequency');
  const threshold = number(params.thresholdDb, -26, -80, 0, 'De-esser threshold');
  const ratio = number(params.ratio, 3, 1, 20, 'De-esser ratio');
  const maxReduction = number(params.maxReductionDb, 6, 0, 24, 'Maximum de-essing');
  const attackMs = number(params.attackMs, 1, 0, 100, 'De-esser attack');
  const releaseMs = number(params.releaseMs, 70, 1, 2000, 'De-esser release');
  const attack = attackMs === 0 ? 0 : Math.exp(-1 / (audio.sampleRate * attackMs / 1000));
  const release = Math.exp(-1 / (audio.sampleRate * releaseMs / 1000));
  const channels = audio.channels.map(channel => zeroPhaseFilter(channel, audio.sampleRate, 'highpass', Math.min(frequency, audio.sampleRate * .4)));
  const n = channels[0].length;
  let reduction = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i]));
    const over = Math.max(0, gainToDb(peak) - threshold);
    const desired = Math.min(maxReduction, over * (1 - 1 / ratio));
    const coefficient = desired > reduction ? attack : release;
    reduction = desired + coefficient * (reduction - desired);
    const removed = 1 - dbToGain(-reduction);
    // The shared envelope preserves stereo/surround balance. Only the high
    // band is attenuated; dry - high = the complementary low band.
    for (let c = 0; c < channels.length; c++) channels[c][i] = audio.channels[c][i] - channels[c][i] * removed;
  }
  return validateAudio(withChannels(audio, channels));
}

export function processStereoCenter(audio, params = {}) {
  validateAudio(audio, { allowEmpty: false });
  options(params, ['mode', 'lowHz', 'highHz', 'amount']);
  if (audio.channels.length !== 2) throw new RangeError('Stereo center processing requires exactly two channels.');
  const mode = params.mode;
  if (!['center', 'sides', 'reduce'].includes(mode)) throw new RangeError('Choose center, sides or reduce processing.');
  const lowHz = number(params.lowHz, 120, 20, 2000, 'Center low cutoff');
  const highHz = number(params.highHz, 8500, 2000, 20000, 'Center high cutoff');
  const amount = number(params.amount, 1, 0, 1, 'Center reduction');
  const [left, right] = audio.channels, n = left.length;
  if (mode === 'sides') {
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { const side = (left[i] - right[i]) / 2; l[i] = side; r[i] = -side; }
    return validateAudio(withChannels(audio, [l, r]));
  }
  let center = new Float32Array(n);
  for (let i = 0; i < n; i++) center[i] = (left[i] + right[i]) / 2;
  center = zeroPhaseFilter(center, audio.sampleRate, 'highpass', lowHz);
  center = zeroPhaseFilter(center, audio.sampleRate, 'lowpass', Math.min(highHz, audio.sampleRate * .45));
  if (mode === 'center') return validateAudio(withChannels(audio, [center, center.slice()]));
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { const subtract = center[i] * amount; l[i] = left[i] - subtract; r[i] = right[i] - subtract; }
  return validateAudio(withChannels(audio, [l, r]));
}

export async function autoLimit(audio, params = {}) {
  validateAudio(audio, { allowEmpty: false });
  options(params, ['targetRmsDb', 'maxBoostDb', 'ceilingDb', 'lookaheadMs', 'releaseMs']);
  const target = dbToGain(number(params.targetRmsDb, -18, -36, -6, 'RMS target'));
  const maxBoost = dbToGain(number(params.maxBoostDb, 6, 0, 12, 'Automatic gain cap'));
  const ceilingDb = number(params.ceilingDb, -1, -24, 0, 'Limiter ceiling');
  const lookaheadMs = number(params.lookaheadMs, 5, 0, 50, 'Limiter lookahead');
  const releaseMs = number(params.releaseMs, 120, 1, 5000, 'Limiter release');
  let sum = 0;
  for (const channel of audio.channels) for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  const rms = Math.sqrt(sum / (audio.channels.length * audio.channels[0].length));
  const gain = rms >= .001 ? Math.min(maxBoost, target / rms) : 1;
  const scaled = withChannels(audio, audio.channels.map(channel => {
    const output = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) output[i] = channel[i] * gain;
    return output;
  }));
  return processAudio(scaled, 'limiter', { ceilingDb, lookaheadMs, releaseMs });
}
