/** Adapted from Circuit Drift Labs WebMicrophone offline time/pitch engine.
 * https://github.com/djshellshoxxx/webmicrophone/tree/main/src/editing
 * SoundTouchJS core 2.1.1: MPL-2.0, https://github.com/cutterbl/SoundTouchJS
 */
import { Stretch } from '@soundtouchjs/core';
import { getTimePitchPlan, throwIfTimePitchAborted } from './time-pitch-settings.js';

const BLOCK_FRAMES = 4096;
const PHASE_COUNT = 1024;
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

async function assertFiniteChannels(channels, signal, yieldControl) {
  let lastYield = performance.now();
  for (const channel of channels) {
    for (let offset = 0; offset < channel.length; offset += 65536) {
      throwIfTimePitchAborted(signal);
      for (let frame = offset; frame < Math.min(channel.length, offset + 65536); frame += 1) {
        if (!Number.isFinite(channel[frame])) throw new RangeError('Audio processing encountered a non-finite sample.');
      }
      if (performance.now() - lastYield > 12) { await yieldControl(); lastYield = performance.now(); }
    }
  }
}

function sinc(x) {
  if (Math.abs(x) < 1e-12) return 1;
  const angle = Math.PI * x;
  return Math.sin(angle) / angle;
}

/** Windowed-sinc sample-rate conversion, with the low-pass cutoff reduced when
 * downsampling. Tables avoid trigonometry per output sample. Both channels use
 * the same source position and coefficients. Edge extension is bounded. */
function makeResampler(channels, rate) {
  if (Math.abs(rate - 1) < 1e-12) return (position, channel) => channels[channel][Math.min(channels[channel].length - 1, Math.max(0, position))];
  const cutoff = Math.min(1, 1 / rate);
  const radius = Math.ceil(8 / cutoff);
  const taps = radius * 2;
  const table = new Float32Array(PHASE_COUNT * taps);
  for (let phase = 0; phase < PHASE_COUNT; phase += 1) {
    const fraction = phase / PHASE_COUNT;
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = tap - radius + 1 - fraction;
      const weight = Math.abs(distance) < radius ? cutoff * sinc(distance * cutoff) * sinc(distance / radius) : 0;
      table[phase * taps + tap] = weight;
      sum += weight;
    }
    for (let tap = 0; tap < taps; tap += 1) table[phase * taps + tap] /= sum;
  }
  return (position, channel) => {
    const center = Math.floor(position);
    const phase = Math.min(PHASE_COUNT - 1, Math.floor((position - center) * PHASE_COUNT));
    const start = center - radius + 1;
    const source = channels[channel];
    let value = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const index = Math.max(0, Math.min(source.length - 1, start + tap));
      value += source[index] * table[phase * taps + tap];
    }
    return value;
  };
}

async function renderPrefix(channels, plan, outputFrames, { signal, onProgress, yieldControl }) {
  const output = channels.map(() => new Float32Array(outputFrames));
  const resample = makeResampler(channels, plan.rate);
  const resampledFrames = Math.max(1, Math.round(channels[0].length / plan.rate));
  const stretch = Math.abs(plan.tempo - 1) < 1e-12 ? null : new Stretch({ sampleRate: plan.sampleRate, createBuffers: true });
  if (stretch) stretch.tempo = plan.tempo;
  const input = new Float32Array(BLOCK_FRAMES * 2);
  const scratch = new Float32Array(BLOCK_FRAMES * 2);
  // WSOLA requires a complete lookahead window even for a very short clip.
  // Flush with zeros until that window and its overlap have left the pipeline.
  const flushFrames = stretch ? Math.ceil(stretch.sampleReq * 4 + stretch.overlapLength * 4) : 0;
  const feedLimit = resampledFrames + flushFrames;
  let fed = 0;
  let written = 0;
  let lastYield = performance.now();
  try {
    while (fed < feedLimit && written < outputFrames) {
      throwIfTimePitchAborted(signal);
      const count = Math.min(BLOCK_FRAMES, feedLimit - fed);
      for (let frame = 0; frame < count; frame += 1) {
        const sourceFrame = fed + frame;
        for (let channel = 0; channel < 2; channel += 1) {
          const value = channel === 1 && channels.length === 1 ? input[frame * 2] :
            sourceFrame < resampledFrames ? resample(sourceFrame * plan.rate, channel) : 0;
          input[frame * 2 + channel] = value;
        }
      }
      fed += count;
      if (stretch) {
        stretch.inputBuffer.putSamples(input, 0, count);
        stretch.process();
        while (stretch.outputBuffer.frameCount && written < outputFrames) {
          const take = Math.min(BLOCK_FRAMES, stretch.outputBuffer.frameCount, outputFrames - written);
          stretch.outputBuffer.extract(scratch, 0, take);
          stretch.outputBuffer.receive(take);
          for (let channel = 0; channel < channels.length; channel += 1) {
            for (let frame = 0; frame < take; frame += 1) output[channel][written + frame] = scratch[frame * 2 + channel];
          }
          written += take;
        }
      } else {
        const take = Math.min(count, outputFrames - written);
        for (let channel = 0; channel < channels.length; channel += 1) {
          for (let frame = 0; frame < take; frame += 1) output[channel][written + frame] = input[frame * 2 + channel];
        }
        written += take;
      }
      const now = performance.now();
      if (now - lastYield >= 12) {
        onProgress?.(Math.min(1, written / outputFrames));
        await yieldControl();
        lastYield = performance.now();
      }
    }
    if (written < outputFrames) throw new Error('The time-stretch processor could not finish the audio tail.');
    throwIfTimePitchAborted(signal);
    return output;
  } finally { stretch?.clear(); }
}

/** Pure planar-PCM entry point used by the worker and the Node verification.
 * Input arrays are never modified. Identity intentionally returns those arrays.
 * All generated output has the exact requested frame count; WSOLA is an
 * estimated transformation and does not promise transient-perfect reconstruction. */
export async function processTimePitchPCM(channels, sampleRate, settings = {}, { signal, onProgress, yieldControl = nextTask } = {}) {
  throwIfTimePitchAborted(signal);
  if (channels?.length > 2) throw new RangeError('Pitch-preserving stretch and pitch shift currently support mono/stereo. Use speed for linked surround processing.');
  if (!Array.isArray(channels) || !channels.length || channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== channels[0].length)) {
    throw new TypeError('Provide equal-length Float32Array channels.');
  }
  const plan = getTimePitchPlan({ length: channels[0].length, numberOfChannels: channels.length, sampleRate }, settings);
  await assertFiniteChannels(channels, signal, yieldControl);
  if (plan.identity) { onProgress?.({ phase: 'complete', progress: 1 }); return channels; }
  onProgress?.({ phase: 'transforming', progress: 0 });
  const output = await renderPrefix(channels, plan, plan.outputFrames, {
    signal, yieldControl,
    onProgress: (progress) => onProgress?.({ phase: 'transforming', progress: progress * 0.92 }),
  });
  {
    // A forward WSOLA seek can skip a short final transient. Anchor the final
    // boundary using the same processor on a bounded reversed suffix, then
    // crossfade into it. For tiny clips the blend spans the clip and preserves
    // both boundaries. This also prevents a zero-flushed overlap from replacing
    // the meaningful tail with silence when enforcing exact output duration.
    onProgress?.({ phase: 'finishing', progress: 0.93 });
    const anchorFrames = Math.min(plan.outputFrames, Math.round(plan.sampleRate * 0.06));
    const sourceFrames = Math.min(plan.inputFrames, Math.ceil((anchorFrames + plan.sampleRate * 0.25) * plan.speed / plan.stretch));
    const reversed = channels.map((channel) => {
      const suffix = new Float32Array(sourceFrames);
      for (let i = 0; i < sourceFrames; i += 1) suffix[i] = channel[channel.length - 1 - i];
      return suffix;
    });
    const tail = await renderPrefix(reversed, plan, anchorFrames, { signal, yieldControl });
    const start = plan.outputFrames - anchorFrames;
    const blendFrames = plan.outputFrames < anchorFrames * 2 ? anchorFrames : Math.max(1, Math.floor(anchorFrames / 2));
    for (let channel = 0; channel < channels.length; channel += 1) {
      for (let frame = 0; frame < anchorFrames; frame += 1) {
        const mix = blendFrames === 1 ? 1 : Math.min(1, frame / (blendFrames - 1));
        output[channel][start + frame] = output[channel][start + frame] * (1 - mix) + tail[channel][anchorFrames - 1 - frame] * mix;
      }
    }
  }
  await assertFiniteChannels(output, signal, yieldControl);
  throwIfTimePitchAborted(signal);
  onProgress?.({ phase: 'complete', progress: 1 });
  return output;
}

export const transformPCM = processTimePitchPCM;
