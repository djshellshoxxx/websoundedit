/** Audacity 3.x SQLite / legacy XML project interchange, entirely on device.
 * This is an original implementation of file layouts, not copied Audacity code.
 * Supported fields and source references: docs/AUDACITY.md.
 */
import initSqlJs from 'sql.js';
import { zipSync, unzipSync } from 'fflate';
import { AudioEditor } from './engine.js';
import { resampleAudio } from './dsp.js';
import { normalizeMetadata } from './metadata.js';
import { xmlNode as node, readXML, writeXML, encodeBinaryXML, decodeBinaryXML } from './audacity-xml.js';

const MAX_BYTES = 256 * 1024 * 1024, MAX_FILE_BYTES = 320 * 1024 * 1024, MAX_XML = 8 * 1024 * 1024;
const FLOAT = 0x0004000f, INT16 = 0x00020001, INT24 = 0x00040001, BLOCK_FRAMES = 262144;
const APP_ID = 0x41554459, SCHEMA_VERSION = 0x03000000;
const TAG_NAMES = { title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumArtist: 'ALBUMARTIST', composer: 'COMPOSER', genre: 'GENRE', date: 'YEAR', track: 'TRACKNUMBER', disc: 'DISCNUMBER', comment: 'COMMENTS', copyright: 'COPYRIGHT', bpm: 'BPM', key: 'INITIALKEY' };
let sqlPromise;
export function loadAudacityCodec() {
  if (!sqlPromise) {
    const options = typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node ? {} : {
      locateFile: file => new URL(`codecs/${file}`, typeof document !== 'undefined' ? document.baseURI : new URL('../', import.meta.url)).href,
    };
    sqlPromise = initSqlJs(options).catch(error => { sqlPromise = null; throw new Error(`The local Audacity project codec could not load: ${error.message}`); });
  }
  return sqlPromise;
}
function bytesOf(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes || !bytes.length || bytes.length > MAX_FILE_BYTES) throw new RangeError('Audacity input must contain 1 byte to 320 MiB.');
  return bytes;
}
function number(value, fallback, min, max, label, integer = false) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`Invalid Audacity ${label}.`);
  return n;
}
const bool = value => value === true || value === 1 || value === '1' || value === 'true';
const childNodes = (parent, name) => parent.children.filter(child => child.name === name);
// Pan laws differ. Translate controls so the audible left/right gains agree.
function toAudacityMix(track, channelCount) {
  const p = track.pan, gain = 10 ** (track.gainDb / 20);
  const left = channelCount === 1 ? Math.cos((p + 1) * Math.PI / 4) : p > 0 ? Math.cos(p * Math.PI / 2) : 1;
  const right = channelCount === 1 ? Math.sin((p + 1) * Math.PI / 4) : p < 0 ? Math.cos(-p * Math.PI / 2) : 1;
  const maximum = Math.max(left, right), pan = left >= right ? right / left - 1 : 1 - left / right;
  return { gain: gain * maximum, pan: Math.abs(pan) < 1e-14 ? 0 : pan };
}
function fromAudacityMix(track, channelCount) {
  const left = track.pan > 0 ? 1 - track.pan : 1, right = track.pan < 0 ? 1 + track.pan : 1;
  const pan = channelCount === 1 ? Math.atan2(right, left) * 4 / Math.PI - 1 : Math.sign(track.pan) * Math.acos(Math.min(left, right)) * 2 / Math.PI;
  const gainDb = track.gainDb + (channelCount === 1 ? 20 * Math.log10(Math.hypot(left, right)) : 0);
  if (gainDb > 24 + 1e-8 || gainDb < -96 - 1e-8) throw new Error('This Audacity gain requires more than the editor’s supported range after pan-law conversion. Export audio stems from Audacity.');
  return { gainDb: Math.max(-96, Math.min(24, gainDb)), pan: Math.abs(pan) < 1e-14 ? 0 : pan };
}
function b64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(result);
}
function floatBytes(samples) {
  const bytes = new Uint8Array(samples.length * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
  return bytes;
}
function portablePCM(audio) { return { encoding: 'f32le-base64', sampleRate: audio.sampleRate, frames: audio.channels[0].length, channels: audio.channels.map(channel => b64(floatBytes(channel))) }; }
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => part === '..' || part === '.')) throw new Error('Audacity archive contains an unsafe file path.');
  return value;
}
function baseName(path) { return path.split('/').at(-1); }

/** Correct waveform summary triples for Audacity's 256/65536-sample levels. */
export function summarizeBlock(samples) {
  const groups = Math.ceil(samples.length / 65536), small = new Uint8Array(groups * 256 * 12), large = new Uint8Array(groups * 12);
  const summarize = (size, out, padding = false) => {
    const view = new DataView(out.buffer);
    for (let group = 0; group < out.length / 12; group++) {
      const start = group * size, end = Math.min(samples.length, start + size); let min = 3.4028234663852886e38, max = -min, sum = 0;
      for (let i = start; i < end; i++) { const value = samples[i]; min = Math.min(min, value); max = Math.max(max, value); sum += value * value; }
      if (end <= start && !padding) min = max = 0;
      view.setFloat32(group * 12, min, true); view.setFloat32(group * 12 + 4, max, true); view.setFloat32(group * 12 + 8, end > start ? Math.sqrt(sum / (end - start)) : 0, true);
    }
  };
  summarize(256, small, true); summarize(65536, large);
  let min = Infinity, max = -Infinity, sum = 0;
  for (const sample of samples) { min = Math.min(min, sample); max = Math.max(max, sample); sum += sample * sample; }
  return { summary256: small, summary64k: large, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0, rms: samples.length ? Math.sqrt(sum / samples.length) : 0 };
}
export function encodeAudacityAU(samples, sampleRate) {
  const summary = summarizeBlock(samples), offset = 24 + 20 + summary.summary64k.length + summary.summary256.length;
  const bytes = new Uint8Array(offset + samples.length * 4), view = new DataView(bytes.buffer);
  // Audacity block files support native little-endian AU ("dns.").
  for (const [i, value] of [0x2e736e64, offset, 0xffffffff, 6, sampleRate, 1].entries()) view.setUint32(i * 4, value, true);
  bytes.set(new TextEncoder().encode('AudacityBlockFile112'), 24); bytes.set(summary.summary64k, 44); bytes.set(summary.summary256, 44 + summary.summary64k.length);
  bytes.set(floatBytes(samples), offset); return bytes;
}
export function decodeAudacityAU(input, expectedFrames) {
  const bytes = bytesOf(input), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24) throw new Error('Audacity AU block is truncated.');
  const little = view.getUint32(0, true) === 0x2e736e64;
  if (!little && view.getUint32(0, false) !== 0x2e736e64) throw new Error('Unsupported Audacity AU block header.');
  const offset = view.getUint32(4, little), declared = view.getUint32(8, little), encoding = view.getUint32(12, little), channels = view.getUint32(20, little);
  const width = ({ 2: 1, 3: 2, 4: 3, 5: 4, 6: 4, 7: 8 })[encoding];
  if (!width || channels !== 1 || offset < 24 || offset > bytes.length) throw new Error('Unsupported Audacity AU encoding or channel layout.');
  const length = declared === 0xffffffff ? bytes.length - offset : declared;
  if (offset + length > bytes.length || length % width || length / width !== expectedFrames) throw new Error('Audacity AU block length does not match its project.');
  const output = new Float32Array(expectedFrames);
  for (let i = 0; i < output.length; i++) {
    const at = offset + i * width; let value;
    if (encoding === 2) value = view.getInt8(at) / 128;
    else if (encoding === 3) value = view.getInt16(at, little) / 32768;
    else if (encoding === 4) { let raw = little ? bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 : bytes[at + 2] | bytes[at + 1] << 8 | bytes[at] << 16; if (raw & 0x800000) raw |= 0xff000000; value = raw / 8388608; }
    else if (encoding === 5) value = view.getInt32(at, little) / 2147483648;
    else value = encoding === 6 ? view.getFloat32(at, little) : view.getFloat64(at, little);
    if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error('Audacity block contains non-finite audio.');
    output[i] = value;
  }
  return output;
}

function zipFiles(bytes) {
  // Check central-directory sizes before fflate allocates any decompressed file.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('Invalid Audacity ZIP directory.');
  const entries = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), length = view.getUint32(end + 12, true);
  if (entries > 20000 || entries === 65535 || start + length > end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Unsupported ZIP64, multipart or oversized Audacity archive.');
  let cursor = start, total = 0; const seen = new Set();
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid Audacity ZIP entry.');
    const size = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    if (cursor + 46 + nameLength + extra + comment > end || view.getUint16(cursor + 8, true) & 1) throw new Error('Invalid or encrypted Audacity ZIP entry.');
    const path = safePath(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    if (seen.has(path)) throw new Error('Duplicate Audacity ZIP path.'); seen.add(path);
    total += size; if (total > MAX_FILE_BYTES || size > MAX_BYTES) throw new Error('Audacity archive exceeds the decompressed size limit.');
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== start + length) throw new Error('Invalid Audacity ZIP central-directory length.');
  const output = unzipSync(bytes, { filter: file => /\.(aup|au)$/i.test(file.name) });
  return new Map(Object.entries(output));
}

function ensureSupported(root) {
  if (!['project', 'audacityproject'].includes(root.name)) throw new Error('This file is not an Audacity project.');
  if (root.attrs.version && !/^1\./.test(String(root.attrs.version))) throw new Error('This Audacity project format is newer than the supported 3.x schema. Export audio stems in Audacity.');
  const walk = (current, depth = 0) => {
    if (depth > 64) throw new Error('Audacity project is too deeply nested.');
    if (['effect', 'notetrack', 'timetrack', 'pcmaliasblockfile', 'odpcmaliasblockfile', 'oddecodeblockfile'].includes(current.name)) throw new Error(`Audacity ${current.name} data cannot be reproduced here. Render effects or export audio stems in Audacity first.`);
    if (current.name === 'envelope' && (current.children.length || Number(current.attrs.numpoints || 0))) throw new Error('Audacity volume envelopes need rendering in Audacity before import. Export audio stems to preserve their sound.');
    if (current.name === 'waveclip') {
      if (Number(current.attrs.centShift || 0) !== 0 || Number(current.attrs.clipStretchRatio ?? 1) !== 1 || Number(current.attrs.stretchRatio ?? 1) !== 1) throw new Error('Audacity realtime clip pitch/stretch must be rendered in Audacity before import.');
      if (childNodes(current, 'waveclip').length) throw new Error('Audacity cut-line history is not supported. Remove cut lines or export audio stems in Audacity first.');
    }
    for (const child of current.children) walk(child, depth + 1);
  };
  walk(root);
}
function metadataFromXML(root, warnings) {
  const reverse = Object.fromEntries(Object.entries(TAG_NAMES).map(([key, tag]) => [tag, key])); reverse.DATE = 'date'; reverse.COMMENT = 'comment'; reverse.ALBUM_ARTIST = 'albumArtist';
  const metadata = {};
  for (const tags of childNodes(root, 'tags')) for (const tag of childNodes(tags, 'tag')) {
    const key = reverse[String(tag.attrs.name).toUpperCase()]; if (key) metadata[key] = String(tag.attrs.value ?? ''); else warnings.push(`The Audacity tag “${String(tag.attrs.name).slice(0,100)}” is not a supported metadata field.`);
  }
  return normalizeMetadata(metadata);
}
function makeProject(root, { name, readBlock }) {
  ensureSupported(root); const warnings = [], sampleRate = number(root.attrs.rate, 44100, 8000, 192000, 'sample rate', true);
  const project = { format: 'websoundedit', version: 1, name: String(root.attrs.name || (name || 'Audacity project').replace(/\.(aup3|aup|zip)$/i, '')).slice(0,200), sampleRate,
    bpm: number(root.attrs.time_signature_tempo ?? root.attrs.tempo, 120, 20, 400, 'tempo'), beatsPerBar: number(root.attrs.time_signature_upper, 4, 1, 16, 'beats per bar', true), beatOffset: 0, tracks: [], markers: [], settings: {}, selection: null, selectedTrackId: null, selectedClipId: null, metadata: metadataFromXML(root, warnings) };
  const denominator = number(root.attrs.time_signature_lower, 4, 1, 64, 'time signature denominator', true);
  if (denominator !== 4) { project.settings.audacityTimeSignature = { upper: project.beatsPerBar, lower: denominator }; warnings.push('The original Audacity time signature is kept for export; the editor grid counts quarter-note beats.'); }
  const waveTracks = childNodes(root, 'wavetrack'); let budget = 0, clipCount = 0;
  const parseTrack = element => {
    const a = element.attrs, rate = number(a.rate, sampleRate, 8000, 192000, 'track sample rate', true), gain = number(a.gain, 1, 0, 10 ** (24 / 20), 'track gain');
    const track = { name: String(a.name || 'Audio').slice(0,200), gainDb: gain ? 20 * Math.log10(gain) : 0, pan: number(a.pan, 0, -1, 1, 'track pan'), mute: bool(a.mute) || gain === 0, solo: bool(a.solo), clips: [], rate };
    let clips = childNodes(element, 'waveclip');
    if (!clips.length && childNodes(element, 'sequence').length) clips = [node('waveclip', { offset: a.offset || 0, name: track.name }, element.children)];
    for (const clip of clips) {
      const sequences = childNodes(clip, 'sequence'); if (sequences.length !== 1) throw new Error('Audacity clip has an unsupported channel sequence layout.');
      const sequence = sequences[0], frames = number(sequence.attrs.numsamples, undefined, 1, rate * 600, 'sequence length', true);
      // Reserve both native and destination-rate lengths before allocating or
      // resampling. An 8 kHz source in a 192 kHz project must not bypass limits.
      budget += Math.max(frames, Math.ceil(frames * sampleRate / rate)) * 4; if (budget > MAX_BYTES) throw new Error('Audacity decoded audio exceeds the 256 MiB limit.');
      const samples = new Float32Array(frames); let expectedStart = 0;
      for (const block of childNodes(sequence, 'waveblock')) {
        const start = number(block.attrs.start, 0, 0, frames, 'block start', true);
        if (start !== expectedStart) throw new Error('Audacity sequence blocks contain gaps or overlaps. Repair the project in Audacity first.');
        const piece = readBlock(block, frames - start);
        if (!piece.length || start + piece.length > frames) throw new Error('Audacity block exceeds its sequence.');
        samples.set(piece, start); expectedStart += piece.length;
      }
      if (expectedStart !== frames) throw new Error('Audacity sequence is missing audio blocks.');
      const left = number(clip.attrs.trimLeft, 0, 0, frames / rate, 'left trim'), right = number(clip.attrs.trimRight, 0, 0, frames / rate, 'right trim');
      const first = Math.round(left * rate), last = frames - Math.round(right * rate);
      if (last <= first) throw new Error('Audacity clip trims remove its entire audio.');
      const start = number(clip.attrs.offset, 0, -600, 600, 'clip offset') + left;
      if (start < 0 || start + (last - first) / rate > 600 + 1 / rate) throw new Error('Audacity audio extends before zero or beyond the 10-minute timeline.');
      if (left || right) warnings.push('Audacity clip trims are rendered into the imported PCM; hidden trimmed audio is not retained.');
      if (Number(clip.attrs.rawAudioTempo || 0) && project.bpm !== Number(clip.attrs.rawAudioTempo)) throw new Error('Audacity tempo-stretched audio must be rendered before import.');
      let audio = { sampleRate: rate, channels: [first || last !== frames ? samples.slice(first, last) : samples] };
      if (rate !== sampleRate) { audio = resampleAudio(audio, sampleRate); warnings.push('Tracks with another sample rate were resampled to the project rate.'); }
      track.clips.push({ name: String(clip.attrs.name || track.name).slice(0,200), start, audio });
    }
    return track;
  };
  for (let i = 0; i < waveTracks.length; i++) {
    const track = parseTrack(waveTracks[i]);
    let channelCount = 1;
    if (number(waveTracks[i].attrs.linked, 0, 0, 2, 'stereo link', true)) {
      channelCount = 2;
      if (!waveTracks[i + 1]) throw new Error('Audacity stereo track is missing its right channel.');
      const right = parseTrack(waveTracks[++i]);
      if (track.rate !== right.rate || track.clips.length !== right.clips.length || ['gainDb', 'pan', 'mute', 'solo'].some(key => track[key] !== right[key])) throw new Error('Unaligned Audacity stereo tracks require a stereo audio export from Audacity.');
      for (let c = 0; c < track.clips.length; c++) {
        const leftClip = track.clips[c], rightClip = right.clips[c];
        if (Math.abs(leftClip.start - rightClip.start) > 1e-8 || leftClip.audio.channels[0].length !== rightClip.audio.channels[0].length) throw new Error('Unaligned Audacity stereo clips require a stereo audio export from Audacity.');
        leftClip.audio.channels.push(rightClip.audio.channels[0]);
      }
    }
    Object.assign(track, fromAudacityMix(track, channelCount));
    if (project.tracks.length >= 64) throw new Error('Audacity project exceeds 64 tracks.');
    delete track.rate; track.id = `aud-track-${project.tracks.length + 1}`;
    for (const clip of track.clips) { if (++clipCount > 512) throw new Error('Audacity project exceeds 512 clips.'); clip.id = `aud-clip-${clipCount}`; clip.audio = portablePCM(clip.audio); }
    project.tracks.push(track);
  }
  for (const labelTrack of childNodes(root, 'labeltrack')) for (const label of childNodes(labelTrack, 'label')) {
    if (project.markers.length >= 1000) throw new Error('Audacity project exceeds 1000 labels.');
    const time = number(label.attrs.t, 0, 0, 600, 'label time'), end = number(label.attrs.t1, time, time, 600, 'label end');
    const id = `aud-marker-${project.markers.length + 1}`;
    project.markers.push({ id, name: String(label.attrs.title || 'Label').slice(0,200), time });
    if (end !== time) { project.settings.audacityLabelEnds ||= {}; project.settings.audacityLabelEnds[id] = end; warnings.push('Range label ends are preserved for Audacity export; the editor displays their start markers.'); }
  }
  project.selectedTrackId = project.tracks[0]?.id || null; project.selectedClipId = project.tracks[0]?.clips[0]?.id || null;
  return { project, warnings: [...new Set(warnings)] };
}

function queryOne(db, sql, args = []) {
  const stmt = db.prepare(sql);
  try { stmt.bind(args); if (!stmt.step()) return null; const row = stmt.getAsObject(); if (stmt.step()) throw new Error('Audacity project contains duplicate data records.'); return row; } finally { stmt.free(); }
}
async function importAup3(bytes, name) {
  const SQL = await loadAudacityCodec(); let db;
  try {
    db = new SQL.Database(bytes); db.run('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if (db.exec('PRAGMA application_id')[0]?.values[0][0] !== APP_ID) throw new Error('This SQLite file is not an Audacity AUP3 project.');
    const version = db.exec('PRAGMA user_version')[0]?.values[0][0];
    if (version < SCHEMA_VERSION || version >= 0x04000000) throw new Error('Only Audacity 3.x AUP3 schemas are supported. Export audio stems from this Audacity version.');
    for (const table of ['project', 'sampleblocks']) if (queryOne(db, 'SELECT type FROM sqlite_master WHERE name = ?', [table])?.type !== 'table') throw new Error('Audacity project tables are missing or invalid.');
    const lengths = queryOne(db, 'SELECT length(dict) AS dictionary, length(doc) AS document FROM project WHERE id=1');
    if (!lengths || lengths.dictionary + lengths.document > MAX_XML) throw new Error('Audacity saved project document is missing or too large. Close and save it in Audacity first.');
    if (queryOne(db, 'SELECT type FROM sqlite_master WHERE name = ?', ['autosave'])?.type === 'table' && queryOne(db, 'SELECT id FROM autosave WHERE id=1')) throw new Error('This Audacity project has recovery/autosave state. Open, save and close it in Audacity before importing.');
    const data = queryOne(db, 'SELECT dict,doc FROM project WHERE id=1'), root = decodeBinaryXML(data.dict, data.doc);
    return makeProject(root, { name, readBlock(block, remaining) {
      const id = number(block.attrs.blockid, undefined, -remaining, Number.MAX_SAFE_INTEGER, 'block id', true);
      if (id <= 0) return new Float32Array(-id);
      const info = queryOne(db, 'SELECT sampleformat,length(samples) AS bytes FROM sampleblocks WHERE blockid=?', [id]);
      if (!info) throw new Error(`Audacity audio block ${id} is missing.`);
      const width = info.sampleformat === INT16 ? 2 : [FLOAT, INT24].includes(info.sampleformat) ? 4 : 0;
      if (!width || info.bytes <= 0 || info.bytes > remaining * width || info.bytes % width) throw new Error('Unsupported or oversized Audacity sample block.');
      const data = queryOne(db, 'SELECT samples FROM sampleblocks WHERE blockid=?', [id]).samples, view = new DataView(data.buffer, data.byteOffset, data.byteLength), samples = new Float32Array(data.length / width);
      for (let i = 0; i < samples.length; i++) { const value = info.sampleformat === FLOAT ? view.getFloat32(i * width, true) : info.sampleformat === INT16 ? view.getInt16(i * width, true) / 32768 : view.getInt32(i * width, true) / 8388608; if (!Number.isFinite(value)) throw new Error('Audacity block contains non-finite audio.'); samples[i] = value; }
      if (block.attrs.len !== undefined && Number(block.attrs.len) !== samples.length) throw new Error('Audacity block length does not match its sample data.');
      return samples;
    } });
  } finally { db?.close(); }
}

/** Standalone legacy AUP accepts a Map of supplied relative paths to AU bytes. */
export async function importAudacity(input, { name = 'Audacity project', files = new Map() } = {}) {
  const bytes = bytesOf(input), signature = new TextDecoder().decode(bytes.subarray(0,16));
  if (signature === 'SQLite format 3\0') return importAup3(bytes, name);
  let xmlBytes = bytes, available = files;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    available = zipFiles(bytes); const projects = [...available.keys()].filter(path => /\.aup$/i.test(path));
    if (projects.length !== 1) throw new Error('Choose a ZIP containing exactly one .aup project and its matching _data folder.');
    name = projects[0]; xmlBytes = available.get(name);
  }
  if (!(available instanceof Map)) throw new TypeError('Audacity companion files must be a Map of relative paths to bytes.');
  let total = 0; const byBase = new Map();
  for (const [path, raw] of available) { safePath(path); const data = bytesOf(raw); total += data.length; if (total > MAX_FILE_BYTES) throw new Error('Audacity companion files exceed 320 MiB.'); const base = baseName(path); byBase.set(base, byBase.has(base) ? null : data); }
  const root = readXML(new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes));
  return makeProject(root, { name, readBlock(block, remaining) {
    if (block.children.length !== 1) throw new Error('Audacity legacy block has an unsupported layout.');
    const child = block.children[0], length = number(child.attrs.len, undefined, 1, remaining, 'legacy block length', true);
    if (child.name === 'silentblockfile') return new Float32Array(length);
    if (child.name !== 'simpleblockfile') throw new Error('Audacity external/aliased blocks require a self-contained project or an audio export.');
    const filename = safePath(String(child.attrs.filename || '')), data = available.get(filename) || byBase.get(baseName(filename));
    if (!data) throw new Error(`Missing or ambiguous Audacity data block ${baseName(filename)}. Include the matching _data folder.`);
    return decodeAudacityAU(data, length);
  } });
}

function buildProjectXML(project, { legacy, addBlock }) {
  const root = node('project', { xmlns: 'http://audacity.sourceforge.net/xml/', version: '1.3.0', audacityversion: legacy ? '2.4.2' : '3.0.0', name: project.name,
    ...(legacy ? { projname: 'project_data' } : {}), rate: project.sampleRate, tempo: project.bpm,
    time_signature_tempo: project.bpm, time_signature_upper: project.settings?.audacityTimeSignature?.upper || project.beatsPerBar, time_signature_lower: project.settings?.audacityTimeSignature?.lower || 4,
    sel0: 0, sel1: 0, h: 0, zoom: 100, vpos: 0, snapto: 'off' });
  root.children.push(node('tags', {}, Object.entries(normalizeMetadata(project.metadata || {})).map(([key, value]) => node('tag', { name: TAG_NAMES[key], value }))));
  for (const track of project.tracks) {
    // Audacity track channel layout is fixed; keep mono/stereo PCM unaltered by
    // separating a mixed-layout editor track into two identically placed groups.
    const layouts = [...new Set(track.clips.map(clip => clip.audio.channels.length))];
    if (!layouts.length) layouts.push(1);
    for (const count of layouts) {
    const mix = toAudacityMix(track, count);
    for (let channel = 0; channel < count; channel++) {
      const xmlTrack = node('wavetrack', { name: layouts.length > 1 ? `${track.name} (${count === 1 ? 'mono' : 'stereo'})` : track.name, channel: count === 1 ? 2 : channel, linked: count === 2 && channel === 0 ? legacy ? 1 : 2 : 0,
        rate: project.sampleRate, gain: mix.gain, pan: mix.pan, mute: track.mute ? 1 : 0, solo: track.solo ? 1 : 0, sampleformat: FLOAT, height: 150, minimized: 0, isSelected: 0 });
      for (const clip of track.clips.filter(clip => clip.audio.channels.length === count)) {
        const samples = clip.audio.channels[channel], sequence = node('sequence', { maxsamples: BLOCK_FRAMES, sampleformat: FLOAT, numsamples: samples.length });
        for (let start = 0; start < samples.length; start += BLOCK_FRAMES) {
          const slice = samples.subarray(start, Math.min(samples.length, start + BLOCK_FRAMES));
          const reference = addBlock(slice, project.sampleRate);
          sequence.children.push(legacy ? node('waveblock', { start }, [node('simpleblockfile', reference)]) : node('waveblock', { start, len: slice.length, blockid: reference }));
        }
        xmlTrack.children.push(node('waveclip', { offset: clip.start, name: clip.name, trimLeft: 0, trimRight: 0 }, [sequence, node('envelope', { numpoints: 0 })]));
      }
      root.children.push(xmlTrack);
    }
    }
  }
  if (project.markers.length) root.children.push(node('labeltrack', { name: 'Labels', numlabels: project.markers.length, height: 80, minimized: 0 }, project.markers.map(marker => node('label', {
    t: marker.time, t1: Math.max(marker.time, project.settings?.audacityLabelEnds?.[marker.id] || marker.time), title: marker.name,
  }))));
  return root;
}

/** Export genuine AUP3, or a ZIP containing legacy AUP + its AU data blocks. */
export async function exportAudacity(portableProject, { format = 'aup3' } = {}) {
  if (!['aup3', 'aup'].includes(format)) throw new Error('Choose Audacity AUP3 or legacy AUP ZIP.');
  const editor = new AudioEditor(); await editor.execute('project.load', { project: portableProject });
  const project = editor.getProject(); let id = 0;
  const warnings = ['Audacity saves committed audio, clip placement, track mix, labels and tags. WebSoundEdit rack drafts, key colors, themes and MIDI mappings remain in the native JSON project.'];
  const groupCount = project.tracks.reduce((sum, track) => sum + Math.max(1, new Set(track.clips.map(clip => clip.audio.channels.length)).size), 0);
  if (groupCount > 64) throw new Error('Separating mono and stereo clips would exceed 64 Audacity tracks. Export fewer tracks.');
  if (groupCount > project.tracks.length) warnings.push('Tracks containing both mono and stereo clips are split by channel layout to preserve their PCM and audible mix.');
  warnings.push('Gain and pan controls are translated between Audacity’s linear pan law and this editor’s pan law to preserve the audible mix.');
  if (format === 'aup') {
    const files = {};
    const root = buildProjectXML(project, { legacy: true, addBlock(samples, rate) {
      const filename = `e${(++id).toString(16).padStart(7, '0')}.au`, summary = summarizeBlock(samples);
      const folder = `${filename.slice(0,3)}/d${filename.slice(3,5)}`;
      files[`project_data/${folder}/${filename}`] = encodeAudacityAU(samples, rate);
      return { filename, len: samples.length, min: summary.min, max: summary.max, rms: summary.rms };
    } });
    files['project.aup'] = new TextEncoder().encode(writeXML(root));
    warnings.push('Extract the ZIP, then open project.aup in Audacity. Keep project_data beside it.');
    return { bytes: zipSync(files, { level: 0 }), mime: 'application/zip', ext: 'zip', warnings };
  }
  const SQL = await loadAudacityCodec(), db = new SQL.Database();
  try {
    db.run(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA_VERSION};
      CREATE TABLE project (id INTEGER PRIMARY KEY, dict BLOB, doc BLOB);
      CREATE TABLE autosave (id INTEGER PRIMARY KEY, dict BLOB, doc BLOB);
      CREATE TABLE sampleblocks (blockid INTEGER PRIMARY KEY AUTOINCREMENT, sampleformat INTEGER, summin REAL, summax REAL, sumrms REAL, summary256 BLOB, summary64k BLOB, samples BLOB); BEGIN;`);
    const root = buildProjectXML(project, { legacy: false, addBlock(samples) {
      const summary = summarizeBlock(samples); id++;
      db.run('INSERT INTO sampleblocks VALUES (?,?,?,?,?,?,?,?)', [id, FLOAT, summary.min, summary.max, summary.rms, summary.summary256, summary.summary64k, floatBytes(samples)]); return id;
    } });
    const { dict, doc } = encodeBinaryXML(root); db.run('INSERT INTO project VALUES (1,?,?)', [dict, doc]); db.run('COMMIT;');
    return { bytes: db.export(), mime: 'application/x-audacity-project', ext: 'aup3', warnings };
  } finally { db.close(); }
}

export function exportAudacityLabels(markers) {
  return markers.map(marker => `${marker.time.toFixed(6)}\t${marker.time.toFixed(6)}\t${String(marker.name).replace(/[\r\n\t]/g, ' ')}`).join('\n') + (markers.length ? '\n' : '');
}
