/** Execute a trusted named recipe as one duration-preserving worker operation. */
import { processAudio, validateAudio } from './dsp.js';
import { processRackEffect } from './rack-dsp.js';
import { RACK_EFFECTS } from './rack-config.js';
import { getAudioPreset } from './presets.js';
import { autoLimit, deEss, processStereoCenter, repairClipping } from './restoration-dsp.js';

export function validatePresetOptions(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Preset parameters must be an object.');
  if (Object.keys(params).some(key => key !== 'presetId' && key !== 'bpm')) throw new RangeError('Presets accept presetId and optional BPM only.');
  if (params.bpm !== undefined && (typeof params.bpm !== 'number' || !Number.isFinite(params.bpm) || params.bpm < 20 || params.bpm > 400)) throw new RangeError('BPM must be between 20 and 400.');
  return getAudioPreset(params.presetId);
}

export async function processPreset(audio, params, context = {}) {
  const preset = validatePresetOptions(params);
  validateAudio(audio, { allowEmpty: false });
  if (preset.stereoOnly && audio.channels.length !== 2) throw new RangeError('This preset requires a stereo clip and both channels.');
  const frames = audio.channels[0].length, count = audio.channels.length, sampleRate = audio.sampleRate;
  let result = audio;
  // At most four fixed stages. Release each intermediate as the next is
  // produced; never retain an audio-sized buffer for each catalog stage.
  for (const stage of preset.steps) {
    switch (stage.effect) {
      case 'repairClipping': result = repairClipping(result, stage.params); break;
      case 'deEsser': result = deEss(result, stage.params); break;
      case 'stereoCenter': result = processStereoCenter(result, stage.params); break;
      case 'autoLimiter': result = await autoLimit(result, stage.params); break;
      default: result = Object.hasOwn(RACK_EFFECTS, stage.effect)
        ? processRackEffect(result, stage.effect, stage.params, stage.wet ?? RACK_EFFECTS[stage.effect].wet, context)
        : await processAudio(result, stage.effect, stage.params, context);
    }
    validateAudio(result, { allowEmpty: false });
    if (result.channels.length !== count || result.channels[0].length !== frames || result.sampleRate !== sampleRate) throw new RangeError('Preset processing changed the audio dimensions.');
  }
  return result;
}
