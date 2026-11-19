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
export { parseMidiFile, encodeMidiFile, renderMidiSequence } from './midi.js';
