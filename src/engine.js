/** Shared, DOM-free editing engine. UI, worker, CLI and HTTP use this registry.
 * All times are seconds; selection positions are relative to their clip.
 * Audio buffers are immutable inside the engine, allowing bounded history to share PCM.
 */
import { processAudio, detectBpm, detectSilence, analyzeAudio, generateAudio, sliceAudio, concatAudio, resampleAudio } from './dsp.js';
import { processRack, processRackEffect } from './rack-dsp.js';
import { RACK_EFFECTS } from './rack-config.js';
import { detectKey, manualKey, validateKeyAnalysis } from './key-detection.js';
import { normalizeMetadata } from './metadata.js';

export const LIMITS = Object.freeze({ projectBytes: 256 * 1024 * 1024, renderBytes: 256 * 1024 * 1024, historyBytes: 256 * 1024 * 1024, historyEntries: 30, tracks: 64, clips: 512, recipeCommands: 256, timelineSeconds: 600 });
export class EditorError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') { super(message); this.name = 'EditorError'; this.code = code; }
}
const fail = (message, code) => { throw new EditorError(message, code); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const copyJSON = (value) => JSON.parse(JSON.stringify(value));
function number(value, fallback, min = -Infinity, max = Infinity, label = 'Value') {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
  return n;
}
function name(value, fallback = 'Untitled') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('Names must contain 1–200 characters.');
  return value.trim();
}
function suffixedName(value, suffix) {
  let prefix = value.slice(0, 200 - suffix.length);
  // Avoid cutting a supplementary Unicode character between its UTF-16 halves.
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}
function id(prefix) { return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`; }
function audioDuration(audio) { return audio.channels[0].length / audio.sampleRate; }
function checkAudio(audio, clone = false, { allowEmpty = false } = {}) {
  if (!audio || !Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2) fail('Audio must contain one or two PCM channels.');
  const sampleRate = number(audio.sampleRate, undefined, 8000, 192000, 'Sample rate');
  if (!Number.isInteger(sampleRate)) fail('Sample rate must be an integer.');
  const length = audio.channels[0]?.length;
  if (!Number.isInteger(length) || (allowEmpty ? length < 0 : length < 1) || length * audio.channels.length * 4 > LIMITS.projectBytes) fail('Audio is empty or exceeds the 256 MiB PCM limit.', 'RESOURCE_LIMIT');
  const channels = audio.channels.map((channel) => {
    if (!(channel instanceof Float32Array) && !Array.isArray(channel)) fail('PCM channels must be Float32Array or numeric arrays.');
    if (channel.length !== length) fail('Audio channels must have equal length.');
    for (let i = 0; i < channel.length; i++) if (!Number.isFinite(channel[i]) || Math.abs(channel[i]) > 1e6) fail('PCM contains a non-finite or unreasonable sample.');
    return clone || !(channel instanceof Float32Array) ? Float32Array.from(channel) : channel;
  });
  return { sampleRate, channels };
}
function emptyProject({ sampleRate = 48000, name: projectName = 'Untitled session', bpm = 120 } = {}) {
  number(sampleRate, undefined, 8000, 192000, 'Sample rate');
  if (!Number.isInteger(sampleRate)) fail('Sample rate must be an integer.');
  return { version: 1, name: name(projectName), sampleRate, bpm: number(bpm, 120, 20, 400, 'BPM'), beatsPerBar: 4, beatOffset: 0, tracks: [], markers: [], selection: null, settings: {}, metadata: {}, selectedTrackId: null, selectedClipId: null };
}
function snapshot(project) {
  return { ...project, tracks: project.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, audio: c.audio })) })), markers: project.markers.map(m => ({ ...m })), selection: project.selection && { ...project.selection }, settings: copyJSON(project.settings), metadata: copyJSON(project.metadata || {}) };
}
function byteUsage(projects) {
  const seen = new Set(); let bytes = 0;
  for (const p of projects) for (const track of p.tracks) for (const clip of track.clips) for (const channel of clip.audio.channels) {
    if (!seen.has(channel.buffer)) { seen.add(channel.buffer); bytes += channel.buffer.byteLength; }
  }
  return bytes;
}
function projectDuration(p) { let end = 0; for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + audioDuration(c.audio)); return end; }
function clipInfo(c, trackId) { return { id: c.id, clipId: c.id, trackId, name: c.name, start: c.start, duration: audioDuration(c.audio), sampleRate: c.audio.sampleRate, channels: c.audio.channels.length, frames: c.audio.channels[0].length, keyAnalysis: c.keyAnalysis ? copyJSON(c.keyAnalysis) : null }; }
function trackInfo(t) { return { id: t.id, name: t.name, gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo, clips: t.clips.map(c => clipInfo(c, t.id)) }; }
function alignChannels(audio, count) {
  if (audio.channels.length === count) return audio;
  if (count === 2) return { ...audio, channels: [audio.channels[0].slice(), audio.channels[0].slice()] };
  const mono = new Float32Array(audio.channels[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = (audio.channels[0][i] + audio.channels[1][i]) / 2;
  return { ...audio, channels: [mono] };
}
function portion(audio, start, end) {
  const a = Math.max(0, Math.min(audio.channels[0].length, Math.round(start * audio.sampleRate)));
  const b = Math.max(a, Math.min(audio.channels[0].length, Math.round(end * audio.sampleRate)));
  return { sampleRate: audio.sampleRate, channels: audio.channels.map(c => c.slice(a, b)) };
}
function spliceAudio(audio, start, end, replacement) {
  const a = Math.round(start * audio.sampleRate), b = Math.round(end * audio.sampleRate);
  const inserted = replacement ? alignChannels(replacement, audio.channels.length) : { sampleRate: audio.sampleRate, channels: audio.channels.map(() => new Float32Array(0)) };
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((c, ch) => {
    const out = new Float32Array(a + inserted.channels[ch].length + c.length - b);
    out.set(c.subarray(0, a)); out.set(inserted.channels[ch], a); out.set(c.subarray(b), a + inserted.channels[ch].length); return out;
  }) };
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0) fail('Project contains invalid base64 PCM.');
  if (text.length > Math.ceil(LIMITS.projectBytes * 4 / 3) + 4) fail('Project PCM exceeds memory limit.', 'RESOURCE_LIMIT');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  // A linear scan has constant stack use even for a full-length session.
  for (let i = 0; i < text.length - padding; i++) {
    const code = text.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) fail('Project contains invalid base64 PCM.');
  }
  if (padding) {
    const code = text.charCodeAt(text.length - padding - 1);
    const sextet = code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : 63;
    if (sextet & (padding === 2 ? 15 : 3)) fail('Project contains noncanonical base64 PCM padding.');
  }
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(text, 'base64'));
  const raw = atob(text), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes;
}
function encodePCM(audio) {
  return { encoding: 'f32le-base64', sampleRate: audio.sampleRate, frames: audio.channels[0].length, channels: audio.channels.map(channel => {
    const bytes = new Uint8Array(channel.length * 4), view = new DataView(bytes.buffer);
    for (let i = 0; i < channel.length; i++) view.setFloat32(i * 4, channel[i], true);
    return bytesToBase64(bytes);
  }) };
}
function decodePCM(data, budget) {
  if (!data || data.encoding !== 'f32le-base64' || !Array.isArray(data.channels) || data.channels.length < 1 || data.channels.length > 2 || !Number.isSafeInteger(data.frames) || data.frames < 1) fail('Invalid project PCM format.');
  const bytes = data.frames * data.channels.length * 4;
  if (bytes > budget.remaining) fail('Project exceeds the 256 MiB PCM limit.', 'RESOURCE_LIMIT');
  budget.remaining -= bytes;
  const channels = data.channels.map(text => {
    if (typeof text !== 'string' || text.length !== Math.ceil(data.frames * 4 / 3) * 4) fail('Project PCM length does not match its frame count.');
    const b = base64ToBytes(text);
    if (b.byteLength !== data.frames * 4) fail('Truncated project PCM.');
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Float32Array(data.frames);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  });
  return checkAudio({ sampleRate: data.sampleRate, channels });
}
const effects = [
  ['gain', 'Adjust amplitude in dB', { db: 0 }], ['fadeIn', 'Fade selected audio in', { duration: 0.05 }], ['fadeOut', 'Fade selected audio out', { duration: 0.05 }],
  ['normalize', 'Normalize sample peaks to a dBFS target', { targetDb: -1 }], ['reverse', 'Reverse selected samples', {}], ['invert', 'Invert sample polarity', {}],
  ['phase', 'Delay samples for phase alignment', { delayMs: 0 }], ['pan', 'Render stereo panning', { pan: 0 }], ['mono', 'Downmix to mono', {}], ['swap', 'Swap left and right channels', {}],
  ['eq', 'Render parametric EQ bands', { bands: [{ type: 'peaking', frequency: 1000, gainDb: 0, q: 1, enabled: true }] }],
  ['compressor', 'Compress dynamic range', { thresholdDb: -18, ratio: 4, attackMs: 10, releaseMs: 120, kneeDb: 6, makeupDb: 0 }],
  ['limiter', 'Limit sample peaks with lookahead', { ceilingDb: -1, lookaheadMs: 5, releaseMs: 60 }],
  ['stretch', 'Change duration while preserving pitch', { ratio: 1, preservePitch: true }], ['pitch', 'Transpose by semitones', { semitones: 0, preserveDuration: true }], ['speed', 'Change speed and pitch together', { rate: 1 }],
  ['silence', 'Replace selected audio with silence', {}], ['removeSilence', 'Remove detected quiet regions', { thresholdDb: -45, minDuration: 0.25, padding: 0.02 }], ['dcRemove', 'Remove DC offset', {}],
  ['duck', 'Tempo-shaped ducking, gating or true sidechain compression', { source: 'tempo', mode: 'volume', depth: 0.8, rate: 1, attack: 0, hold: 0.1, release: 0.7, curve: 1, sourceTrackId: null }],
  ['loop', 'Repeat audio with optional boundary crossfades', { repeats: 4, crossfadeMs: 5 }],
  ['beatRepeat', 'Slice and reorder a rhythm', { division: 4, pattern: [0, 1, 2, 3] }],
  ['granular', 'Build a seeded granular texture', { grainMs: 80, density: 8, spread: 0.2, seed: 1, mix: 0.5 }],
  ['rack', 'Process an ordered creative effects chain as one edit', { chain: [] }],
  ...Object.entries(RACK_EFFECTS).map(([effect, info]) => [effect, info.description || info.title, { ...info.defaults, wet: info.wet }])
];
export const EFFECTS = Object.freeze(effects.map(([effect, description, parameters]) => ({ effect, description, parameters })));
const command = (method, description, parameters = {}, mutates = false) => ({ method, description, parameters, mutates });
export const COMMANDS = Object.freeze([
  command('commands.list', 'Discover all core methods'), command('project.state', 'Read metadata without PCM'), command('project.new', 'Create an empty project', { name: 'Untitled session', sampleRate: 48000, bpm: 120 }, true),
  command('project.update', 'Set project name, tempo, grid and offset', { name: 'Session', bpm: 120, beatsPerBar: 4, beatOffset: 0 }, true), command('project.select', 'Select a track and clip', { trackId: 'track-id', clipId: 'clip-id' }),
  command('project.save', 'Create portable JSON with embedded PCM'), command('project.load', 'Load a portable JSON project', { project: {} }, true),
  command('metadata.update', 'Replace audio export metadata', { metadata: {} }, true),
  command('analysis.key', 'Estimate and store the whole sample key', { clipId: null }, true),
  command('analysis.keyAll', 'Estimate and store each sample key', {}, true),
  command('clip.key', 'Set or clear a manual sample key', { clipId: null, tonic: 0, mode: 'major' }, true),
  command('settings.save', 'Create a settings JSON object'), command('settings.load', 'Replace project settings', { settings: {} }, true),
  command('history.undo', 'Undo the last edit'), command('history.redo', 'Redo an undone edit'),
  command('track.add', 'Create an empty track', { name: 'Track' }, true), command('track.update', 'Set name, gain, pan, mute or solo', { trackId: 'track-id', gainDb: 0, pan: 0, mute: false, solo: false }, true), command('track.remove', 'Remove a track and its clips', { trackId: 'track-id' }, true),
  command('clip.add', 'Import PCM as a clip, creating a track if needed', { trackId: null, name: 'Audio', start: 0, audio: {} }, true), command('clip.update', 'Move or rename a clip', { clipId: 'clip-id', start: 0, name: 'Clip' }, true), command('clip.remove', 'Remove a clip', { clipId: 'clip-id' }, true),
  command('clip.duplicate', 'Duplicate a clip', { clipId: 'clip-id', start: 0, newTrack: false }, true), command('clip.split', 'Split at a clip-relative time', { clipId: 'clip-id', at: 1 }, true), command('clip.getAudio', 'Read a copy of unprocessed clip PCM', { clipId: 'clip-id' }),
  command('selection.set', 'Select a clip-relative interval and channels', { clipId: 'clip-id', start: 0, end: 1, channels: 'all' }), command('selection.clear', 'Clear the current selection'),
  command('edit.copy', 'Copy selected audio internally'), command('edit.cut', 'Copy and remove selected audio', {}, true), command('edit.paste', 'Insert clipboard audio at a clip-relative time', { at: 0 }, true), command('edit.delete', 'Remove selected audio', {}, true), command('edit.trim', 'Keep only selected audio', {}, true),
  command('effect.apply', 'Apply an effect to a selection or clip', { effect: 'gain', params: { db: 0 }, target: null }, true), command('effect.preview', 'Return the changed whole clip without committing', { effect: 'gain', params: { db: 0 }, target: null }),
  ...effects.map(([effect, description, parameters]) => command(`effect.${effect}`, description, { ...parameters, target: null }, true)),
  command('analysis.bpm', 'Estimate tempo and confidence', { minBpm: 60, maxBpm: 200 }), command('analysis.silence', 'Find quiet regions', { thresholdDb: -45, minDuration: 0.25, padding: 0.02 }), command('analysis.stats', 'Measure amplitude, DC and stereo correlation'),
  command('audio.generate', 'Create a tone, noise, sweep or drum clip', { type: 'tone', duration: 4, frequency: 440, amplitude: 0.3, seed: 1 }, true),
  command('audio.render', 'Render mix, track, clip or selection as PCM', { scope: 'mix', trackId: null, clipId: null, start: 0, end: null }),
  command('audio.renderPreview', 'Audition a draft effect through the mixer without committing', { effect: 'gain', params: { db: 0 }, target: null, scope: 'mix' }),
  command('markers.add', 'Add a timeline marker', { time: 0, name: 'Marker' }, true), command('markers.remove', 'Remove a marker', { markerId: 'marker-id' }, true),
  command('loop.create', 'Create a loop clip from selected audio', { repeats: 4, crossfadeMs: 5, newTrack: true }, true),
  command('recipe.run', 'Run a JSON command sequence atomically', { commands: [{ method: 'effect.normalize', params: { targetDb: -1 } }] }, true)
]);
const registry = new Map(COMMANDS.map(c => [c.method, c]));
const lengthEffects = new Set(['stretch', 'speed', 'removeSilence', 'loop', 'beatRepeat']);
const channelEffects = new Set(['mono', 'swap', 'pan']);

export class AudioEditor {
  constructor(options = {}) {
    this.project = emptyProject(options); this.undo = []; this.redo = []; this.clipboard = null; this.revision = 0; this._queue = Promise.resolve();
  }
  getProject() { return this.project; }
  getState() {
    const p = this.project;
    return { version: p.version, name: p.name, sampleRate: p.sampleRate, bpm: p.bpm, beatsPerBar: p.beatsPerBar, beatOffset: p.beatOffset, duration: projectDuration(p), tracks: p.tracks.map(trackInfo), markers: p.markers.map(m => ({ ...m })), selection: p.selection && { ...p.selection }, settings: copyJSON(p.settings), metadata: copyJSON(p.metadata || {}), selectedTrackId: p.selectedTrackId, selectedClipId: p.selectedClipId, history: { undo: this.undo.length, redo: this.redo.length, bytes: byteUsage([p, ...this.undo, ...this.redo]) }, canUndo: this.undo.length > 0, canRedo: this.redo.length > 0, hasClipboard: !!this.clipboard, revision: this.revision };
  }
  execute(method, params = {}) {
    const next = this._queue.then(() => this._execute(method, params)); this._queue = next.catch(() => {}); return next;
  }
  async _execute(method, params = {}) {
    const entry = registry.get(method);
    if (!entry) fail(`Unknown command: ${method}`, 'UNKNOWN_COMMAND');
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('Command parameters must be an object.');
    const before = entry.mutates ? snapshot(this.project) : null;
    const oldClipboard = this.clipboard;
    try {
      const result = await this._dispatch(method, params);
      if (entry.mutates) {
        this._checkLimits(); this.undo.push(before); this.redo = []; this._trimHistory(); this.revision++; }
      return result;
    } catch (error) { if (before) this.project = before; this.clipboard = oldClipboard; throw error; }
  }
  _checkLimits() {
    if (this.project.tracks.length > LIMITS.tracks || this.project.tracks.reduce((n, t) => n + t.clips.length, 0) > LIMITS.clips) fail('Project exceeds its track or clip limit.', 'RESOURCE_LIMIT');
    if (byteUsage([this.project]) > LIMITS.projectBytes) fail('Project exceeds the 256 MiB PCM limit.', 'RESOURCE_LIMIT');
    if (projectDuration(this.project) > LIMITS.timelineSeconds) fail('Timeline exceeds the 10-minute render limit.', 'RESOURCE_LIMIT');
  }
  _trimHistory() {
    while (this.undo.length > LIMITS.historyEntries || (this.undo.length && byteUsage([this.project, ...this.undo, ...this.redo]) > LIMITS.historyBytes)) this.undo.shift();
  }
  _track(trackId = this.project.selectedTrackId) {
    const track = this.project.tracks.find(t => t.id === trackId);
    if (!track) fail('Select an existing track first.', 'NOT_FOUND'); return track;
  }
  _clip(clipId = this.project.selectedClipId, trackId) {
    const tracks = trackId ? [this._track(trackId)] : this.project.tracks;
    for (const track of tracks) { const clip = track.clips.find(c => c.id === clipId); if (clip) return { track, clip }; }
    fail('Select an existing audio clip first.', 'NOT_FOUND');
  }
  _select(track, clip) {
    if (this.project.selectedClipId !== clip?.id) this.project.selection = null;
    this.project.selectedTrackId = track?.id ?? null; this.project.selectedClipId = clip?.id ?? null;
  }
  _repairSelection() {
    let track = this.project.tracks.find(t => t.id === this.project.selectedTrackId) || this.project.tracks[0];
    let clip = track?.clips.find(c => c.id === this.project.selectedClipId) || track?.clips[0];
    this._select(track, clip);
    const s = this.project.selection;
    if (s && (!clip || s.clipId !== clip.id || s.end > audioDuration(clip.audio) + 1e-8)) this.project.selection = null;
  }
  _target(params = {}, { requireSelection = false } = {}) {
    const explicit = own(params, 'target') && params.target !== undefined && params.target !== null;
    let requested = explicit ? params.target : params;
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) fail('Target must be an object.');
    const clipId = requested.clipId ?? this.project.selectedClipId;
    const { track, clip } = this._clip(clipId, requested.trackId);
    const current = this.project.selection?.clipId === clip.id ? this.project.selection : null;
    const hasRange = own(requested, 'start') || own(requested, 'end');
    let range = hasRange ? requested : !explicit && current ? current : null;
    if (requireSelection && !range) fail('Select a nonempty interval first.', 'NO_SELECTION');
    if (hasRange && (!own(requested, 'start') || !own(requested, 'end'))) fail('An explicit selection requires both start and end.');
    const duration = audioDuration(clip.audio), rate = clip.audio.sampleRate;
    const rawStart = range ? number(range.start, undefined, 0, duration, 'Selection start') : 0;
    const rawEnd = range ? number(range.end, undefined, 0, duration, 'Selection end') : duration;
    const start = Math.round(rawStart * rate) / rate, end = Math.round(rawEnd * rate) / rate;
    if (!(end > start)) fail('Selection must contain at least one sample.', 'EMPTY_SELECTION');
    const channels = requested.channels ?? range?.channels ?? 'all';
    if (!['all', 'left', 'right'].includes(channels) || (channels === 'right' && clip.audio.channels.length < 2)) fail('Choose an available channel.');
    return { track, clip, start, end, channels };
  }
  _selectedAudio(target) {
    const audio = portion(target.clip.audio, target.start, target.end);
    if (target.channels !== 'all') audio.channels = [audio.channels[target.channels === 'left' ? 0 : 1]];
    return audio;
  }
  _addTrack(params = {}) {
    const track = { id: id('track'), name: name(params.name, `Track ${this.project.tracks.length + 1}`), gainDb: 0, pan: 0, mute: false, solo: false, clips: [] };
    this.project.tracks.push(track); this._select(track, null); return track;
  }
  async _addClip(params) {
    let audio = checkAudio(params.audio, true);
    if (audio.sampleRate !== this.project.sampleRate) audio = checkAudio(await resampleAudio(audio, this.project.sampleRate));
    const track = params.trackId ? this._track(params.trackId) : this._addTrack({ name: params.trackName || params.name });
    const clip = { id: id('clip'), name: name(params.name, 'Audio clip'), start: number(params.start, 0, 0, LIMITS.timelineSeconds, 'Clip start'), audio };
    track.clips.push(clip); this._select(track, clip); return clipInfo(clip, track.id);
  }
  async _effect(params, preview = false) {
    const effect = params.effect;
    if (!EFFECTS.some(e => e.effect === effect)) fail(`Unknown effect: ${effect}`);
    const target = this._target(params), options = params.params || {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Effect parameters must be an object.');
    if (target.channels !== 'all' && (lengthEffects.has(effect) || channelEffects.has(effect) || (effect === 'pitch' && options.preserveDuration === false))) fail('Time and channel-layout edits require All channels.');
    if (effect === 'mono' && (target.start !== 0 || target.end !== audioDuration(target.clip.audio))) fail('Mono conversion requires the whole clip.');
    const source = this._selectedAudio(target);
    const context = { bpm: this.project.bpm, beatOffset: this.project.beatOffset - target.clip.start - target.start };
    if (effect === 'duck' && options.source === 'track') {
      const sourceTrackId = options.sourceTrackId;
      if (!sourceTrackId || sourceTrackId === target.track.id) fail('Choose another track for the sidechain detector.');
      const sidechainTrack = this._track(sourceTrackId);
      context.sidechain = this._renderTracks([sidechainTrack], target.clip.start + target.start, target.clip.start + target.end, { ignoreMute: true });
    }
    const effectOptions = { ...options, bpm: options.bpm ?? this.project.bpm };
    const { wet, ...rackEffectOptions } = options;
    const rendered = effect === 'rack' ? await processRack(source, effectOptions, context)
      : Object.hasOwn(RACK_EFFECTS, effect) ? await processRackEffect(source, effect, rackEffectOptions, wet ?? RACK_EFFECTS[effect].wet, context)
      : await processAudio(source, effect, effectOptions, context);
    const processed = checkAudio(rendered, false, { allowEmpty: effect === 'removeSilence' });
    let replacement;
    if (target.channels === 'all') {
      let background = alignChannels(target.clip.audio, processed.channels.length);
      if (target.clip.audio.channels.length === 1 && processed.channels.length === 2 && (target.start > 0 || target.end < audioDuration(target.clip.audio))) {
        // A partial mono->stereo edit must not increase untouched audio by 3 dB.
        // Compensate the current track's mono equal-power versus stereo balance laws.
        const pan = target.track.pan;
        const monoGains = [Math.cos((pan + 1) * Math.PI / 4), Math.sin((pan + 1) * Math.PI / 4)];
        const stereoGains = [pan > 0 ? Math.cos(pan * Math.PI / 2) : 1, pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1];
        background = { sampleRate: target.clip.audio.sampleRate, channels: monoGains.map((g, ch) => target.clip.audio.channels[0].map(value => value * (Math.abs(stereoGains[ch]) < 1e-12 ? 0 : g / stereoGains[ch]))) };
      }
      replacement = effect === 'mono' ? processed : spliceAudio(background, target.start, target.end, processed);
    } else {
      if (processed.channels.length !== 1 || processed.channels[0].length !== source.channels[0].length) fail('Single-channel processing changed the selection dimensions.');
      replacement = { sampleRate: target.clip.audio.sampleRate, channels: target.clip.audio.channels.map(c => c.slice()) };
      replacement.channels[target.channels === 'left' ? 0 : 1].set(processed.channels[0], Math.round(target.start * replacement.sampleRate));
    }
    checkAudio(replacement, false, { allowEmpty: effect === 'removeSilence' });
    if (preview) return replacement;
    if (!replacement.channels[0].length) {
      target.track.clips = target.track.clips.filter(c => c.id !== target.clip.id); this.project.selection = null; this._repairSelection();
      return { trackId: target.track.id, clipId: target.clip.id, id: target.clip.id, removed: true, duration: 0 };
    }
    target.clip.audio = replacement;
    target.clip.keyAnalysis = null;
    if (this.project.selection?.clipId === target.clip.id) this.project.selection = processed.channels[0].length ? { trackId: target.track.id, clipId: target.clip.id, start: target.start, end: target.start + audioDuration(processed), channels: target.channels } : null;
    this._select(target.track, target.clip);
    return clipInfo(target.clip, target.track.id);
  }
  _renderTracks(tracks, start, end, { ignoreMute = false } = {}) {
    const sr = this.project.sampleRate, frames = Math.round((end - start) * sr);
    if (!Number.isFinite(frames) || frames <= 0) fail('The render range must contain audio.', 'EMPTY_AUDIO');
    if (frames * 8 > LIMITS.renderBytes) fail('Rendered audio exceeds the 256 MiB PCM limit.', 'RESOURCE_LIMIT');
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    for (const track of tracks) {
      if (track.mute && !ignoreMute) continue;
      const gain = 10 ** (track.gainDb / 20), pan = track.pan;
      for (const clip of track.clips) {
        const begin = Math.round((clip.start - start) * sr), from = Math.max(0, -begin), to = Math.min(clip.audio.channels[0].length, frames - begin);
        if (to <= from) continue;
        const [left, right] = clip.audio.channels;
        // Equal-power mono pan; stereo balance never collapses an opposite channel.
        const gl = right ? (pan > 0 ? Math.cos(pan * Math.PI / 2) : 1) : Math.cos((pan + 1) * Math.PI / 4);
        const gr = right ? (pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1) : Math.sin((pan + 1) * Math.PI / 4);
        for (let i = from; i < to; i++) { channels[0][begin + i] += left[i] * gain * gl; channels[1][begin + i] += (right || left)[i] * gain * gr; }
      }
    }
    return { sampleRate: sr, channels };
  }
  _render(params) {
    const scope = params.scope || 'mix';
    if (scope === 'selection' || scope === 'clip') {
      const target = this._target(scope === 'selection' ? params : { target: { clipId: params.clipId ?? this.project.selectedClipId, trackId: params.trackId, ...(params.start !== undefined ? { start: params.start, end: params.end } : {}) } }, { requireSelection: scope === 'selection' });
      const audio = this._selectedAudio(target);
      if (params.raw === true) return audio;
      const track = { ...target.track, clips: [{ ...target.clip, start: 0, audio }], mute: false };
      const rendered = this._renderTracks([track], 0, audioDuration(audio));
      if (target.channels !== 'all') return { ...rendered, channels: [audio.channels[0].map(v => v * 10 ** (target.track.gainDb / 20))] };
      return rendered;
    }
    if (scope !== 'mix' && scope !== 'track') fail('Render scope must be mix, track, clip or selection.');
    const solo = this.project.tracks.some(t => t.solo);
    const tracks = scope === 'track' ? [this._track(params.trackId)] : this.project.tracks.filter(t => !solo || t.solo);
    const extent = tracks.reduce((max, t) => t.clips.reduce((e, c) => Math.max(e, c.start + audioDuration(c.audio)), max), 0);
    const start = number(params.start, 0, 0, LIMITS.timelineSeconds, 'Render start'), end = number(params.end, extent, 0, LIMITS.timelineSeconds, 'Render end');
    if (end <= start) fail('The render range must contain audio.', 'EMPTY_AUDIO');
    return this._renderTracks(tracks, start, end);
  }
  _saveProject() {
    const p = snapshot(this.project);
    return { format: 'websoundedit', ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, keyAnalysis: c.keyAnalysis ? copyJSON(c.keyAnalysis) : null, audio: encodePCM(c.audio) })) })) };
  }
  _loadProject(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || data.format !== 'websoundedit' || data.version !== 1 || !Array.isArray(data.tracks)) fail('Unsupported WebSoundEdit project format or version.');
    if (data.tracks.length > LIMITS.tracks) fail('Project exceeds track limit.', 'RESOURCE_LIMIT');
    const p = emptyProject(data); p.beatsPerBar = number(data.beatsPerBar, 4, 1, 16, 'Beats per bar'); if (!Number.isInteger(p.beatsPerBar)) fail('Beats per bar must be an integer.'); p.beatOffset = number(data.beatOffset, 0, -LIMITS.timelineSeconds, LIMITS.timelineSeconds, 'Beat offset');
    const ids = new Set(), budget = { remaining: LIMITS.projectBytes }; let count = 0;
    const readId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value) || ids.has(value)) fail('Project IDs must be unique, nonempty safe strings.'); ids.add(value); return value; };
    p.tracks = data.tracks.map(t => {
      if (!t || !Array.isArray(t.clips)) fail('Invalid track.');
      count += t.clips.length; if (count > LIMITS.clips) fail('Project exceeds clip limit.', 'RESOURCE_LIMIT');
      return { id: readId(t.id), name: name(t.name), gainDb: number(t.gainDb, 0, -96, 24, 'Track gain'), pan: number(t.pan, 0, -1, 1, 'Pan'), mute: t.mute === true, solo: t.solo === true, clips: t.clips.map(c => {
        if (!c) fail('Invalid clip.'); const audio = decodePCM(c.audio, budget); if (audio.sampleRate !== p.sampleRate) fail('All project clips must use the project sample rate.');
        return { id: readId(c.id), name: name(c.name), start: number(c.start, 0, 0, LIMITS.timelineSeconds, 'Clip start'), audio, keyAnalysis: validateKeyAnalysis(c.keyAnalysis) };
      }) };
    });
    if (data.markers !== undefined && !Array.isArray(data.markers)) fail('Project markers must be an array.');
    if ((data.markers?.length || 0) > 1000) fail('Too many markers.');
    p.markers = (data.markers || []).map(m => ({ id: readId(m.id), name: name(m.name, 'Marker'), time: number(m.time, 0, 0, LIMITS.timelineSeconds, 'Marker time') }));
    p.settings = this._validateSettings(data.settings || {});
    p.metadata = normalizeMetadata(data.metadata || {});
    p.selectedTrackId = data.selectedTrackId || null; p.selectedClipId = data.selectedClipId || null;
    this.project = p; this._repairSelection();
    if (data.selection) { const target = this._target({ target: data.selection }); this.project.selection = { trackId: target.track.id, clipId: target.clip.id, start: target.start, end: target.end, channels: target.channels }; this._select(target.track, target.clip); this.project.selection = { trackId: target.track.id, clipId: target.clip.id, start: target.start, end: target.end, channels: target.channels }; }
    return this.getState();
  }
  _validateSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || ![Object.prototype, null].includes(Object.getPrototypeOf(settings))) fail('Settings must be a plain JSON object.');
    const serialized = JSON.stringify(settings);
    if (serialized.length > 1024 * 1024) fail('Settings exceed the 1 MiB limit.', 'RESOURCE_LIMIT');
    const visit = object => { if (!Array.isArray(object) && ![Object.prototype, null].includes(Object.getPrototypeOf(object))) fail('Settings contain a non-JSON object.'); for (const [key, value] of Object.entries(object)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe settings key.'); if (typeof value === 'number' && !Number.isFinite(value)) fail('Settings numbers must be finite.'); if (value && typeof value === 'object') visit(value); } };
    visit(settings); return JSON.parse(serialized);
  }
  async _dispatch(method, params) {
    const p = this.project;
    if (method.startsWith('effect.') && !['effect.apply', 'effect.preview'].includes(method)) {
      const { target, params: nested, ...options } = params;
      return this._effect({ effect: method.slice(7), params: nested || options, ...(target ? { target } : {}) });
    }
    switch (method) {
      case 'commands.list': return copyJSON(COMMANDS);
      case 'project.state': return this.getState();
      case 'project.new': this.project = emptyProject(params); return this.getState();
      case 'project.update': {
        if (own(params, 'name')) p.name = name(params.name);
        if (own(params, 'bpm')) p.bpm = number(params.bpm, undefined, 20, 400, 'BPM');
        if (own(params, 'beatsPerBar')) { p.beatsPerBar = number(params.beatsPerBar, undefined, 1, 16, 'Beats per bar'); if (!Number.isInteger(p.beatsPerBar)) fail('Beats per bar must be an integer.'); }
        if (own(params, 'beatOffset')) p.beatOffset = number(params.beatOffset, undefined, -LIMITS.timelineSeconds, LIMITS.timelineSeconds, 'Beat offset'); return this.getState();
      }
      case 'project.select': { const track = params.trackId ? this._track(params.trackId) : params.clipId ? this._clip(params.clipId).track : this._track(); const clip = params.clipId ? this._clip(params.clipId, track.id).clip : track.clips[0]; this._select(track, clip); return this.getState(); }
      case 'project.save': return this._saveProject();
      case 'project.load': return this._loadProject(params.project);
      case 'metadata.update': p.metadata = normalizeMetadata(params.metadata); return copyJSON(p.metadata);
      case 'analysis.key': { const { clip } = this._clip(params.clipId || p.selectedClipId); clip.keyAnalysis = detectKey(clip.audio); return copyJSON(clip.keyAnalysis); }
      case 'analysis.keyAll': { const results = []; for (const track of p.tracks) for (const clip of track.clips) { clip.keyAnalysis = detectKey(clip.audio); results.push({ clipId: clip.id, name: clip.name, ...copyJSON(clip.keyAnalysis) }); } return results; }
      case 'clip.key': { const { clip } = this._clip(params.clipId || p.selectedClipId); clip.keyAnalysis = params.tonic === null ? null : manualKey(params.tonic, params.mode); return clipInfo(clip, this._clip(clip.id).track.id); }
      case 'settings.save': return { format: 'websoundedit-settings', version: 1, settings: copyJSON(p.settings) };
      case 'settings.load': { let settings = params.settings; if (settings?.format === 'websoundedit-settings') { if (settings.version !== 1) fail('Unsupported settings version.'); settings = settings.settings; } p.settings = this._validateSettings(settings); return copyJSON(p.settings); }
      case 'history.undo': { const previous = this.undo.pop(); if (!previous) return false; this.redo.push(snapshot(p)); this.project = previous; this.revision++; return true; }
      case 'history.redo': { const next = this.redo.pop(); if (!next) return false; this.undo.push(snapshot(p)); this.project = next; this._trimHistory(); this.revision++; return true; }
      case 'track.add': return trackInfo(this._addTrack(params));
      case 'track.update': {
        const t = this._track(params.trackId); if (own(params, 'name')) t.name = name(params.name);
        if (own(params, 'gainDb')) t.gainDb = number(params.gainDb, undefined, -96, 24, 'Track gain'); if (own(params, 'pan')) t.pan = number(params.pan, undefined, -1, 1, 'Pan');
        for (const key of ['mute', 'solo']) if (own(params, key)) { if (typeof params[key] !== 'boolean') fail(`${key} must be boolean.`); t[key] = params[key]; } return trackInfo(t);
      }
      case 'track.remove': { const t = this._track(params.trackId); p.tracks = p.tracks.filter(x => x.id !== t.id); this._repairSelection(); return true; }
      case 'clip.add': return this._addClip(params);
      case 'clip.getAudio': { const { clip } = this._clip(params.clipId, params.trackId); return { sampleRate: clip.audio.sampleRate, channels: clip.audio.channels.map(c => c.slice()) }; }
      case 'clip.update': { const { track, clip } = this._clip(params.clipId, params.trackId); if (own(params, 'name')) clip.name = name(params.name); if (own(params, 'start')) clip.start = number(params.start, undefined, 0, LIMITS.timelineSeconds, 'Clip start'); if (params.destinationTrackId && params.destinationTrackId !== track.id) { const destination = this._track(params.destinationTrackId); track.clips = track.clips.filter(c => c.id !== clip.id); destination.clips.push(clip); this._select(destination, clip); if (p.selection?.clipId === clip.id) p.selection.trackId = destination.id; return clipInfo(clip, destination.id); } return clipInfo(clip, track.id); }
      case 'clip.remove': { const { track, clip } = this._clip(params.clipId, params.trackId); track.clips = track.clips.filter(c => c.id !== clip.id); this._repairSelection(); return true; }
      case 'clip.duplicate': { const { track, clip } = this._clip(params.clipId, params.trackId); const dest = params.newTrack ? this._addTrack({ name: suffixedName(track.name, ' copy') }) : track; const duplicate = { ...clip, id: id('clip'), name: suffixedName(clip.name, ' copy'), start: number(params.start, clip.start + audioDuration(clip.audio), 0, LIMITS.timelineSeconds, 'Clip start') }; dest.clips.push(duplicate); this._select(dest, duplicate); return clipInfo(duplicate, dest.id); }
      case 'clip.split': { const { track, clip } = this._clip(params.clipId, params.trackId); const at = number(params.at, p.selection?.clipId === clip.id ? p.selection.start : undefined, 0, audioDuration(clip.audio), 'Split position'); const frame = Math.round(at * clip.audio.sampleRate); if (frame <= 0 || frame >= clip.audio.channels[0].length) fail('Split position must be inside the clip.'); const cut = frame / clip.audio.sampleRate; const right = { ...clip, id: id('clip'), name: suffixedName(clip.name, ' · B'), start: clip.start + cut, keyAnalysis: null, audio: portion(clip.audio, cut, audioDuration(clip.audio)) }; clip.audio = portion(clip.audio, 0, cut); clip.keyAnalysis = null; track.clips.splice(track.clips.indexOf(clip) + 1, 0, right); this._select(track, right); return { left: clipInfo(clip, track.id), right: clipInfo(right, track.id) }; }
      case 'selection.set': {
        const { track, clip } = this._clip(params.clipId, params.trackId); const duration = audioDuration(clip.audio);
        const start = Math.max(0, Math.min(duration, number(params.start, undefined, -LIMITS.timelineSeconds, LIMITS.timelineSeconds, 'Selection start'))), end = Math.max(0, Math.min(duration, number(params.end, undefined, -LIMITS.timelineSeconds, LIMITS.timelineSeconds, 'Selection end')));
        const target = this._target({ target: { trackId: track.id, clipId: clip.id, start, end, channels: params.channels || 'all' } }); this._select(track, clip);
        p.selection = { trackId: track.id, clipId: clip.id, start: target.start, end: target.end, channels: target.channels }; return { ...p.selection };
      }
      case 'selection.clear': p.selection = null; return true;
      case 'edit.copy': { const target = this._target(params); this.clipboard = this._selectedAudio(target); return { duration: audioDuration(this.clipboard), channels: this.clipboard.channels.length }; }
      case 'edit.cut':
      case 'edit.delete': { const target = this._target(params, { requireSelection: true }); if (target.channels !== 'all') fail('Cut and delete require All channels; use Silence for one channel.'); if (method === 'edit.cut') this.clipboard = this._selectedAudio(target); const audio = spliceAudio(target.clip.audio, target.start, target.end, null); if (!audio.channels[0].length) { target.track.clips = target.track.clips.filter(c => c.id !== target.clip.id); } else { target.clip.audio = audio; target.clip.keyAnalysis = null; } p.selection = null; this._repairSelection(); return true; }
      case 'edit.trim': { const target = this._target(params, { requireSelection: true }); if (target.channels !== 'all') fail('Trim requires All channels.'); target.clip.audio = this._selectedAudio(target); target.clip.keyAnalysis = null; if (params.keepTimelinePosition !== false) target.clip.start += target.start; this._select(target.track, target.clip); p.selection = { trackId: target.track.id, clipId: target.clip.id, start: 0, end: audioDuration(target.clip.audio), channels: 'all' }; return clipInfo(target.clip, target.track.id); }
      case 'edit.paste': {
        if (!this.clipboard) fail('The internal clipboard is empty.', 'EMPTY_CLIPBOARD');
        if (!p.selectedClipId && !params.clipId) return this._addClip({ audio: this.clipboard, trackId: params.trackId || p.selectedTrackId || undefined, name: 'Pasted audio', start: params.start || 0 });
        const { track, clip } = this._clip(params.clipId, params.trackId); const at = number(params.at, p.selection?.clipId === clip.id ? p.selection.start : audioDuration(clip.audio), 0, audioDuration(clip.audio), 'Paste position');
        let audio = this.clipboard; if (audio.sampleRate !== p.sampleRate) audio = await resampleAudio(audio, p.sampleRate); clip.audio = spliceAudio(clip.audio, at, at, audio); clip.keyAnalysis = null; this._select(track, clip); p.selection = { trackId: track.id, clipId: clip.id, start: at, end: at + audioDuration(audio), channels: 'all' }; return clipInfo(clip, track.id);
      }
      case 'effect.apply': return this._effect(params);
      case 'effect.preview': return this._effect(params, true);
      case 'analysis.bpm': return detectBpm(this._selectedAudio(this._target(params)), params.params || params);
      case 'analysis.silence': return detectSilence(this._selectedAudio(this._target(params)), params.params || params);
      case 'analysis.stats': return analyzeAudio(this._selectedAudio(this._target(params)));
      case 'audio.generate': { const audio = await generateAudio({ ...params, sampleRate: p.sampleRate, bpm: params.bpm ?? p.bpm }); return this._addClip({ audio, trackId: params.trackId, name: params.name || `${params.type || 'tone'} signal`, start: params.start }); }
      case 'audio.render': return this._render(params);
      case 'audio.renderPreview': {
        const target = this._target(params), preview = await this._effect(params, true), original = this.project;
        const selectionEnd = target.end + audioDuration(preview) - audioDuration(target.clip.audio);
        try {
          this.project = snapshot(original);
          const { clip } = this._clip(target.clip.id, target.track.id); clip.audio = preview;
          this.project.selectedTrackId = target.track.id; this.project.selectedClipId = target.clip.id;
          this.project.selection = { trackId: target.track.id, clipId: target.clip.id, start: target.start, end: selectionEnd, channels: target.channels };
          return this._render({ scope: params.scope || 'mix', clipId: target.clip.id, trackId: target.track.id, ...(params.scope === 'selection' ? { target: this.project.selection } : {}) });
        } finally { this.project = original; }
      }
      case 'markers.add': { if (p.markers.length >= 1000) fail('Marker limit reached.'); const marker = { id: id('marker'), name: name(params.name, `Marker ${p.markers.length + 1}`), time: number(params.time, 0, 0, LIMITS.timelineSeconds, 'Marker time') }; p.markers.push(marker); p.markers.sort((a, b) => a.time - b.time); return { ...marker }; }
      case 'markers.remove': { const index = p.markers.findIndex(m => m.id === params.markerId); if (index < 0) fail('Marker not found.', 'NOT_FOUND'); p.markers.splice(index, 1); return true; }
      case 'loop.create': { const target = this._target(params); const audio = checkAudio(await processAudio(this._selectedAudio(target), 'loop', { repeats: params.repeats ?? 4, crossfadeMs: params.crossfadeMs ?? 5 })); return this._addClip({ audio, trackId: params.newTrack === false ? target.track.id : undefined, name: params.name || suffixedName(target.clip.name, ' loop'), start: params.start ?? target.clip.start + target.start }); }
      case 'recipe.run': {
        const steps = params.commands || params.steps || params.recipe?.commands || params.recipe?.steps || params.recipe;
        if (!Array.isArray(steps) || !steps.length || steps.length > LIMITS.recipeCommands) fail('A recipe requires 1–256 commands.');
        const results = [];
        for (const step of steps) {
          if (!step || typeof step.method !== 'string' || !registry.has(step.method) || ['recipe.run', 'history.undo', 'history.redo'].includes(step.method)) fail('Recipe contains an unknown or recursive/history command.');
          const args = step.params || {}; if (typeof args !== 'object' || Array.isArray(args)) fail('Recipe parameters must be objects.');
          results.push(await this._dispatch(step.method, args)); this._checkLimits();
        }
        return results;
      }
      default: fail(`Unknown command: ${method}`, 'UNKNOWN_COMMAND');
    }
  }
}
