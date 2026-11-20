import { STEM_MODEL } from './model.js';

export function assertModelIdentity({ byteLength, sha256 }) {
  if (byteLength !== STEM_MODEL.byteLength) throw new RangeError(`Choose the supported ${STEM_MODEL.filename} model (${STEM_MODEL.byteLength} bytes).`);
  if (sha256 !== STEM_MODEL.sha256) throw new Error('The model SHA-256 does not match the supported research model. Choose the exact model linked in the guide.');
}

export function validateStemAudio(audio) {
  if (!audio || audio.sampleRate !== STEM_MODEL.sampleRate) throw new RangeError('Stem separation requires audio resampled to 44.1 kHz.');
  if (!Array.isArray(audio.channels) || ![1, 2].includes(audio.channels.length)) throw new RangeError('Stem separation accepts mono or stereo audio only.');
  const frames = audio.channels[0]?.length;
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > STEM_MODEL.sampleRate * STEM_MODEL.maxSeconds) throw new RangeError(`Choose a nonempty excerpt of at most ${STEM_MODEL.maxSeconds} seconds.`);
  for (const channel of audio.channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames) throw new TypeError('Stem audio requires equal-length Float32Array channels.');
    for (const value of channel) {
      if (!Number.isFinite(value)) throw new RangeError('Stem audio contains a non-finite sample.');
      if (Math.abs(value) > 1) throw new RangeError('Stem audio exceeds full scale. Normalize the excerpt to below 0 dBFS in the editor before separating.');
    }
  }
  return frames;
}

/** Positive overlap weights preserve both boundary samples of an excerpt. */
export function transitionWindow(segmentFrames = STEM_MODEL.segmentFrames, overlapFrames = STEM_MODEL.overlapFrames) {
  if (!Number.isInteger(segmentFrames) || segmentFrames < 1 || !Number.isInteger(overlapFrames) || overlapFrames < 0 || 2 * overlapFrames > segmentFrames) throw new RangeError('Invalid stem overlap window.');
  const window = new Float32Array(segmentFrames).fill(1);
  for (let frame = 0; frame < overlapFrames; frame++) {
    const weight = (frame + 1) / (overlapFrames + 1);
    window[frame] = weight;
    window[segmentFrames - 1 - frame] = weight;
  }
  return window;
}

function validatePrediction(prediction) {
  const { data, dims } = prediction || {};
  const expected = [1, STEM_MODEL.stemNames.length, 2, STEM_MODEL.segmentFrames];
  if (!(data instanceof Float32Array) || data.length !== expected.reduce((value, size) => value * size, 1)
    || !Array.isArray(dims) || dims.length !== expected.length || dims.some((size, index) => size !== expected[index])) {
    throw new RangeError('The model returned an unsupported stem tensor; expected float32 [1, 4, 2, 343980].');
  }
  for (const value of data) if (!Number.isFinite(value)) throw new RangeError('The model returned a non-finite audio sample.');
  return data;
}

/**
 * Chunked inference for the pinned HTDemucs export. The graph performs its own
 * branch normalization, so it receives raw planar waveform samples here.
 * runChunk returns { data, dims, release? }; release owns any inference tensors.
 * Injected runners let tests verify stitching without claiming model quality.
 */
export async function separateStemAudio(audio, { runChunk, onProgress = () => {} } = {}) {
  const frames = validateStemAudio(audio);
  if (typeof runChunk !== 'function') throw new TypeError('A neural inference runner is required.');
  const started = performance.now();
  const segment = STEM_MODEL.segmentFrames;
  const stride = segment - STEM_MODEL.overlapFrames;
  const chunks = Math.max(1, Math.ceil((frames - segment) / stride) + 1);
  const window = transitionWindow();
  const weights = new Float32Array(frames);
  const input = new Float32Array(2 * segment);
  const stems = Object.fromEntries(STEM_MODEL.stemNames.map(name => [name, {
    sampleRate: STEM_MODEL.sampleRate,
    channels: [new Float32Array(frames), new Float32Array(frames)],
  }]));

  for (let index = 0; index < chunks; index++) {
    const offset = index * stride, length = Math.min(segment, frames - offset);
    input.fill(0);
    for (let channel = 0; channel < 2; channel++) {
      // Mono is duplicated before inference, rather than cancelled or rejected.
      input.set(audio.channels[Math.min(channel, audio.channels.length - 1)].subarray(offset, offset + length), channel * segment);
    }
    onProgress({ phase: 'separating', completed: index, total: chunks, message: `Separating chunk ${index + 1} of ${chunks}…` });
    let prediction;
    try {
      prediction = await runChunk(input);
      const data = validatePrediction(prediction);
      for (let row = 0; row < STEM_MODEL.stemNames.length; row++) {
        const output = stems[STEM_MODEL.stemNames[row]].channels;
        for (let channel = 0; channel < 2; channel++) {
          const base = (row * 2 + channel) * segment;
          for (let frame = 0; frame < length; frame++) output[channel][offset + frame] += data[base + frame] * window[frame];
        }
      }
      for (let frame = 0; frame < length; frame++) weights[offset + frame] += window[frame];
    } finally {
      prediction?.release?.();
    }
    onProgress({ phase: 'separating', completed: index + 1, total: chunks, message: `Separated ${index + 1} of ${chunks} chunks.` });
  }

  const instrumental = { sampleRate: STEM_MODEL.sampleRate, channels: [new Float32Array(frames), new Float32Array(frames)] };
  let squaredError = 0;
  for (let channel = 0; channel < 2; channel++) {
    const source = audio.channels[Math.min(channel, audio.channels.length - 1)];
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0;
      for (const name of STEM_MODEL.stemNames) {
        const output = stems[name].channels[channel];
        output[frame] /= weights[frame];
        if (!Number.isFinite(output[frame])) throw new RangeError('The model produced audio outside the supported numeric range.');
        sum += output[frame];
      }
      // Accompaniment is three predicted stems summed, not a stereo trick or
      // an exact mixture-minus-vocals residual disguised as a prediction.
      instrumental.channels[channel][frame] = stems.drums.channels[channel][frame] + stems.bass.channels[channel][frame] + stems.other.channels[channel][frame];
      if (!Number.isFinite(instrumental.channels[channel][frame])) throw new RangeError('The instrumental stem exceeded the supported numeric range.');
      squaredError += (sum - source[frame]) ** 2;
    }
  }
  stems.instrumental = instrumental;
  return {
    sampleRate: STEM_MODEL.sampleRate,
    stems,
    metrics: {
      modelId: STEM_MODEL.id,
      inputFrames: frames,
      inputChannels: audio.channels.length,
      durationSeconds: frames / STEM_MODEL.sampleRate,
      chunks,
      elapsedMs: performance.now() - started,
      mixtureRmse: Math.sqrt(squaredError / (frames * 2)),
    },
  };
}
