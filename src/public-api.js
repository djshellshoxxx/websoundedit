/** Shared local audio-editing API. No requests or server required.
 * Import the built api.js in an ES-module script, or src/engine.js in Node.
 */
export { AudioEditor, COMMANDS } from './engine.js';
export { processAudio, detectBpm, detectSilence, analyzeAudio, generateAudio, resampleAudio } from './dsp.js';
export { encodeWav, decodeWav } from './wav.js';
