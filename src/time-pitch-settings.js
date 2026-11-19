/** Adapted from Circuit Drift Labs WebMicrophone offline time/pitch engine.
 * https://github.com/djshellshoxxx/webmicrophone/tree/main/src/editing
 * SoundTouchJS core 2.1.1: MPL-2.0, https://github.com/cutterbl/SoundTouchJS
 */
export const TIME_PITCH_LIMITS = Object.freeze({
  maxDurationSeconds: 600,
  maxBytes: 256 * 1024 * 1024,
  minSpeed: 0.5,
  maxSpeed: 2,
  minStretch: 0.5,
  maxStretch: 2,
  minSemitones: -12,
  maxSemitones: 12,
});

export function normalizeTimePitchSettings(settings = {}) {
  const speed = Number(settings.speed ?? 1);
  const stretch = Number(settings.stretch ?? 1);
  const pitchSemitones = Number(settings.pitchSemitones ?? 0);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new RangeError('Speed must be between 0.5 and 2.0.');
  if (!Number.isFinite(stretch) || stretch < 0.5 || stretch > 2) throw new RangeError('Stretch must be between 50% and 200%.');
  if (!Number.isFinite(pitchSemitones) || pitchSemitones < -12 || pitchSemitones > 12) throw new RangeError('Pitch must be between −12 and +12 semitones.');
  return { speed, stretch, pitchSemitones };
}

export function getTransformedFrameCount(frameCount, settings = {}) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError('Select a nonempty audio region first.');
  const { speed, stretch } = normalizeTimePitchSettings(settings);
  return Math.max(1, Math.round(frameCount * stretch / speed));
}

export function getTimePitchPlan(buffer, settings = {}) {
  const normalized = normalizeTimePitchSettings(settings);
  const sampleRate = Number(buffer.sampleRate);
  const channelCount = Number(buffer.numberOfChannels);
  const inputFrames = Number(buffer.length);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Audio must use a sample rate between 8 and 192 kHz.');
  if (channelCount !== 1 && channelCount !== 2) throw new RangeError('Time and pitch editing supports mono or stereo audio.');
  const outputFrames = getTransformedFrameCount(inputFrames, normalized);
  for (const [label, frames] of [['Source', inputFrames], ['Transformed audio', outputFrames]]) {
    if (frames / sampleRate > TIME_PITCH_LIMITS.maxDurationSeconds || frames * channelCount * 4 > TIME_PITCH_LIMITS.maxBytes) {
      throw new RangeError(`${label} exceeds the 10-minute / 256 MiB audio limit. Shorten the selection or reduce Stretch.`);
    }
  }
  const pitchRatio = 2 ** (normalized.pitchSemitones / 12);
  const effectiveRate = normalized.speed * pitchRatio;
  const effectiveTempo = 1 / (normalized.stretch * pitchRatio);
  const rate = Math.abs(effectiveRate - 1) < 1e-12 ? 1 : effectiveRate;
  const tempo = Math.abs(effectiveTempo - 1) < 1e-12 ? 1 : effectiveTempo;
  return { ...normalized, inputFrames, outputFrames, sampleRate, channelCount, rate, tempo,
    identity: Math.abs(rate - 1) < 1e-12 && Math.abs(tempo - 1) < 1e-12 };
}

export function throwIfTimePitchAborted(signal) {
  if (signal?.aborted) throw new DOMException('Audio preparation cancelled.', 'AbortError');
}
