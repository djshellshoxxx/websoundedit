/** Shared local audio-editing API. No requests or server required.
 * Import the built api.js in an ES-module script, or src/engine.js in Node.
 */
export { AudioEditor, COMMANDS } from './engine.js';
export { processAudio, detectBpm, detectSilence, analyzeAudio, generateAudio, resampleAudio } from './dsp.js';
export { encodeWav, decodeWav } from './wav.js';
export { processRack, processRackEffect } from './rack-dsp.js';
export { RACK_EFFECTS, createRackEffect, normalizeRackChain } from './rack-config.js';
export { detectKey, manualKey, keyColor } from './key-detection.js';
export { normalizeMetadata, METADATA_FIELDS, metadataSupport } from './metadata.js';
export { parseMidiFile, encodeMidiFile, renderMidiSequence, MidiController, MidiSampler } from './midi.js';
export { CommandRuntime } from './command-runtime.js';
export { coreCommandDescriptors, validateCommandParams, schema } from './command-schema.js';
export { MacroRunner, MacroError, MACRO_LIMITS, parseMacro, validateMacro, formatMacro, macroToSteps, stepsToMacro } from './macro.js';
export { ActionRecorder } from './macro-recorder.js';
export { createCoreRuntime, createBrowserRuntime } from './sdk-runtime.js';
export { LiveAudioRuntime, LIVE_COMMANDS, LIVE_LIMITS } from './live-audio.js';
export { CompanionBridge, COMPANION_COMMANDS } from './companion.js';
export { FILE_COMMANDS } from './file-commands.js';
export { CHANNEL_LAYOUTS, normalizeLayout, convertLayout, conversionMatrix } from './channel-layout.js';
export { RealtimeRackDSP, renderLiveDSP, normalizeAutomation } from './realtime-dsp.js';
export { RecordingStore } from './recording-store.js';
export { createStreamWavHeader } from './wav-stream.js';
export { importReaper, exportReaper, parseRpp, writeRpp } from './reaper.js';
export { importAudacity, exportAudacity, exportAudacityLabels } from './audacity.js';
