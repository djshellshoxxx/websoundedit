/** Duration-preserving creative effects for selected PCM.
 * Every stage owns its output. Tails end at the selected interval boundary.
 * Biquad equations: https://www.w3.org/TR/audio-eq-cookbook/
 */
import { validateAudio } from './dsp.js';
import { RACK_EFFECTS, normalizeRackChain, MAX_RACK_EFFECTS } from './rack-config.js';

export const RACK_EFFECT_NAMES = Object.freeze(Object.keys(RACK_EFFECTS));
export const MAX_RACK_STAGES = MAX_RACK_EFFECTS;
const TWO_PI = 2 * Math.PI;
const copy = audio => ({ sampleRate: audio.sampleRate, channels: audio.channels.map(channel => channel.slice()) });

function numeric(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new RangeError(`${label} must be between ${min} and ${max}.`);
  return result;
}

/** Validate the whole chain before allocating any processed audio. */
export function normalizeRackEffect(effect, params = {}, wet = 1) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Rack effect parameters must be an object.');
  const { bpm, ...values } = params;
  const normalized = normalizeRackChain([{ effect, params: values, wet }])[0];
  if (bpm !== undefined) normalized.params.bpm = numeric(bpm, 120, 20, 400, 'BPM');
  return normalized;
}

export function normalizeRack(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Rack parameters must be an object.');
  return normalizeRackChain(params.chain ?? []);
}

function interpolate(channel, position) {
  if (position < 0 || position > channel.length - 1) return 0;
  const index = Math.floor(position), fraction = position - index;
  return channel[index] * (1 - fraction) + (channel[index + 1] ?? channel[index]) * fraction;
}

function echo(channel, sr, params) {
  const out = new Float32Array(channel.length), delay = params.timeMs * sr / 1000;
  for (let tap = 1, gain = 1; tap <= params.repeats; tap++, gain *= params.decay) {
    const offset = tap * delay;
    for (let i = Math.ceil(offset); i < out.length; i++) out[i] += interpolate(channel, i - offset) * gain;
  }
  return out;
}

function delay(channel, sr, params) {
  const out = new Float32Array(channel.length), frames = Math.max(1, Math.round(params.timeMs * sr / 1000));
  const memory = new Float64Array(frames);
  for (let i = 0; i < out.length; i++) {
    const position = i % frames, delayed = memory[position];
    memory[position] = channel[i] + delayed * params.feedback;
    out[i] = delayed;
  }
  return out;
}

function reverb(channel, sr, params, channelIndex) {
  const out = new Float32Array(channel.length), scale = .55 + params.room * .9;
  const delays = [29.7, 37.1, 41.1, 43.7].map((ms, i) => Math.max(1, Math.round((ms * scale + channelIndex * (i + 1) * .31) * sr / 1000)));
  const memories = delays.map(length => new Float64Array(length)), positions = [0, 0, 0, 0], lowpass = [0, 0, 0, 0];
  const feedback = .35 + params.room * .59, damping = .05 + params.damping * .9;
  const predelay = Math.round(params.predelayMs * sr / 1000);
  for (let i = 0; i < out.length; i++) {
    const input = i >= predelay ? channel[i - predelay] : 0;
    let sum = 0;
    for (let comb = 0; comb < memories.length; comb++) {
      const memory = memories[comb], position = positions[comb], value = memory[position];
      lowpass[comb] = value * (1 - damping) + lowpass[comb] * damping;
      memory[position] = input + lowpass[comb] * feedback;
      positions[comb] = (position + 1) % memory.length;
      sum += value;
    }
    out[i] = sum * .25;
  }
  // Two all-pass diffusion stages turn the separate comb echoes into a room tail.
  for (const milliseconds of [5.1, 1.7]) {
    const memory = new Float64Array(Math.max(1, Math.round(milliseconds * sr / 1000)));
    for (let i = 0; i < out.length; i++) {
      const position = i % memory.length, previous = memory[position], input = out[i];
      const value = previous - .5 * input;
      memory[position] = input + .5 * value;
      out[i] = value;
    }
  }
  return out;
}

function modulatedDelay(channel, sr, params, flanger) {
  const out = new Float32Array(channel.length);
  const depth = params.depthMs * sr / 1000, base = (flanger ? 1 : params.delayMs) * sr / 1000;
  const memory = new Float64Array(Math.ceil(base + depth * 2) + 4);
  const feedback = flanger ? params.feedback : 0;
  for (let i = 0; i < out.length; i++) {
    const delayedFrames = base + depth * (1 + Math.sin(TWO_PI * params.rate * i / sr));
    const read = (i - delayedFrames) % memory.length;
    const position = (read + memory.length) % memory.length;
    const index = Math.floor(position), fraction = position - index;
    const delayed = memory[index] * (1 - fraction) + memory[(index + 1) % memory.length] * fraction;
    memory[i % memory.length] = channel[i] + delayed * feedback;
    out[i] = delayed;
  }
  return out;
}

function phaser(channel, sr, params) {
  const out = new Float32Array(channel.length), previousInput = new Float64Array(6), previousOutput = new Float64Array(6);
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const sweep = .5 + .5 * Math.sin(TWO_PI * params.rate * i / sr);
    const frequency = Math.min(sr * .4, 700 * 2 ** ((sweep - .5) * 4 * params.depth));
    const tangent = Math.tan(Math.PI * frequency / sr), coefficient = (tangent - 1) / (tangent + 1);
    let value = channel[i] + last * params.feedback;
    for (let stage = 0; stage < 6; stage++) {
      const next = coefficient * value + previousInput[stage] - coefficient * previousOutput[stage];
      previousInput[stage] = value; previousOutput[stage] = next; value = next;
    }
    last = value;
    out[i] = value;
  }
  return out;
}

function lowpassCoefficient(frequency, sr) { return 1 - Math.exp(-TWO_PI * Math.min(frequency, sr * .45) / sr); }
function distortion(channel, sr, params) {
  const out = new Float32Array(channel.length), coefficient = lowpassCoefficient(params.tone, sr), normalization = Math.tanh(params.drive);
  let filtered = 0;
  for (let i = 0; i < out.length; i++) {
    const shaped = Math.tanh(channel[i] * params.drive) / normalization;
    filtered += coefficient * (shaped - filtered); out[i] = filtered;
  }
  return out;
}

function filter(channel, sr, params) {
  const frequency = Math.min(params.frequency, sr * .499), omega = TWO_PI * frequency / sr;
  const cosine = Math.cos(omega), alpha = Math.sin(omega) / (2 * params.q), a0 = 1 + alpha;
  let b0, b1, b2;
  switch (params.type) {
    case 'lowpass': b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0; break;
    case 'highpass': b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cosine; b2 = 1; break;
    default: throw new RangeError(`Unsupported filter: ${params.type}`);
  }
  b0 /= a0; b1 /= a0; b2 /= a0;
  const a1 = -2 * cosine / a0, a2 = (1 - alpha) / a0, out = new Float32Array(channel.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < out.length; i++) {
    const value = b0 * channel[i] + z1;
    z1 = b1 * channel[i] - a1 * value + z2; z2 = b2 * channel[i] - a2 * value; out[i] = value;
  }
  return out;
}

function tape(channel, sr, params) {
  const out = new Float32Array(channel.length), coefficient = lowpassCoefficient(20000 - params.warmth * 17000, sr);
  const normalization = Math.tanh(params.drive);
  let filtered = 0;
  for (let i = 0; i < out.length; i++) {
    const seconds = i / sr;
    const offset = sr * (.005 * params.wow * Math.sin(TWO_PI * .63 * seconds) + .0004 * params.flutter * Math.sin(TWO_PI * 7.1 * seconds));
    const shaped = Math.tanh(interpolate(channel, i + offset) * params.drive) / normalization;
    filtered += coefficient * (shaped - filtered); out[i] = filtered;
  }
  return out;
}

function stutter(channel, sr, params, bpm) {
  const out = new Float32Array(channel.length);
  const frames = Math.max(1, Math.min(channel.length, Math.round(sr * 60 / bpm / params.division)));
  const open = Math.max(1, Math.round(frames * params.gate));
  const fade = Math.min(Math.floor(open / 2), Math.round(params.fadeMs * sr / 1000));
  for (let i = 0; i < out.length; i++) {
    const position = i % frames;
    if (position >= open) continue;
    const gain = fade > 0 ? Math.min(1, position / fade, (open - 1 - position) / fade) : 1;
    out[i] = channel[position] * Math.max(0, gain);
  }
  return out;
}

function processWet(channel, sr, effect, params, bpm, channelIndex) {
  switch (effect) {
    case 'echo': return echo(channel, sr, params);
    case 'delay': return delay(channel, sr, params);
    case 'reverb': return reverb(channel, sr, params, channelIndex);
    case 'chorus': return modulatedDelay(channel, sr, params, false);
    case 'flanger': return modulatedDelay(channel, sr, params, true);
    case 'phaser': return phaser(channel, sr, params);
    case 'distortion': return distortion(channel, sr, params);
    case 'tremolo': return Float32Array.from(channel, (sample, i) => sample * (1 - params.depth * (.5 + .5 * Math.sin(TWO_PI * params.rate * i / sr))));
    case 'filter': return filter(channel, sr, params);
    case 'tape': return tape(channel, sr, params);
    case 'stutter': return stutter(channel, sr, params, bpm);
    case 'bitcrusher': {
      const levels = 2 ** (params.bits - 1) - 1;
      return Float32Array.from(channel, (_, i) => Math.round(channel[Math.floor(i / params.hold) * params.hold] * levels) / levels);
    }
    default: throw new RangeError(`Unknown rack effect: ${effect}`);
  }
}

function renderStage(audio, stage, context) {
  if (!stage.enabled || stage.wet === 0) return copy(audio);
  const bpm = numeric(stage.params.bpm ?? context.bpm, 120, 20, 400, 'BPM');
  const channels = audio.channels.map((channel, index) => {
    const wetChannel = processWet(channel, audio.sampleRate, stage.effect, stage.params, bpm, index);
    if (stage.wet === 1) return wetChannel;
    for (let i = 0; i < wetChannel.length; i++) wetChannel[i] = channel[i] * (1 - stage.wet) + wetChannel[i] * stage.wet;
    return wetChannel;
  });
  return validateAudio({ sampleRate: audio.sampleRate, channels });
}

export function processRackEffect(audio, effect, params = {}, wet = 1, context = {}) {
  validateAudio(audio);
  return renderStage(audio, { ...normalizeRackEffect(effect, params, wet), enabled: true }, context);
}

export function processRack(audio, params = {}, context = {}) {
  validateAudio(audio);
  const chain = normalizeRack(params);
  const bpm = numeric(params.bpm ?? context.bpm, 120, 20, 400, 'BPM');
  let result = audio;
  for (const stage of chain) result = renderStage(result, stage, { ...context, bpm });
  return chain.length ? result : copy(audio);
}
