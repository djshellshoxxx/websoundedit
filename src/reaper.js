/** Bounded, local-only REAPER RPP + media exchange.
 * Grammar: Cockos/WDL. Audio semantics are checked against native REAPER by
 * scripts/verify-reaper.mjs; unsupported processing is rejected, never executed.
 */
import { zipSync } from 'fflate';
import { AudioEditor, LIMITS } from './engine.js';
import { validateAudio, resampleAudio } from './dsp.js';
import { decodeWav, encodeWav } from './wav.js';
import { CHANNEL_LAYOUTS, audioLayout, normalizeLayout, layoutForChannels, trackMixMatrix } from './channel-layout.js';
import { normalizeMetadata } from './metadata.js';
import { readProjectZip } from './project-archive.js';
import { parseRpp, writeRpp, rppRecord as record, ReaperFormatError, RPP_LIMITS } from './rpp-text.js';

export { parseRpp, writeRpp, ReaperFormatError, RPP_LIMITS } from './rpp-text.js';
export const REAPER_LIMITS = Object.freeze({ ...RPP_LIMITS, manifestBytes: 32768, fileBytes: 320 * 1024 * 1024, mediaFiles: 20000, pcmBytes: LIMITS.projectBytes, tracks: LIMITS.tracks, clips: LIMITS.clips, seconds: LIMITS.timelineSeconds });
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true });
const TAGS = Object.freeze({ title: 'ID3:TIT2', artist: 'ID3:TPE1', album: 'ID3:TALB', albumArtist: 'ID3:TPE2', composer: 'ID3:TCOM', genre: 'ID3:TCON', date: 'ID3:TDRC', track: 'ID3:TRCK', disc: 'ID3:TPOS', comment: 'ID3:COMM', copyright: 'ID3:TCOP', bpm: 'ID3:TBPM', key: 'ID3:TKEY' });
const TAG_FIELDS = Object.fromEntries(Object.entries(TAGS).map(([field, tag]) => [tag, field]));
const all = (node, tag) => (node.children || []).filter(child => child.tag === tag);
const problem = (message, node) => { throw new ReaperFormatError(message, node?.line); };
function one(node, tag) { const matches = all(node, tag); if (matches.length > 1) problem(`duplicate ${tag} record.`, matches[1]); return matches[0]; }
function numeric(node, index, fallback, min = -Infinity, max = Infinity, integer = false) {
  const raw = node?.args[index], value = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) problem(`invalid ${node?.tag || 'numeric'} value.`, node);
  return value;
}
function field(node, tag, index, fallback, min, max, integer) { return numeric(one(node, tag), index, fallback, min, max, integer); }
function unchanged(node, tag, index, expected, fallback = expected) { if (field(node, tag, index, fallback) !== expected) problem(`${tag} processing is unsupported. Render this project or its stems in REAPER first.`, one(node, tag)); }
function named(value, fallback, warnings) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const trimmed = value.trim(); if (trimmed.length > 200) warnings.push('Names longer than 200 characters were shortened to the editor limit.');
  let out = trimmed.slice(0, 200); if (/^[\uDC00-\uDFFF]$/.test(trimmed[200] || '')) out = out.slice(0, -1); return out;
}
function inputBytes(value, label = 'input') {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  if (!bytes || !bytes.length || bytes.length > REAPER_LIMITS.fileBytes) problem(`${label} must contain 1 byte to 320 MiB.`);
  return bytes;
}
function suppliedFiles(files = new Map()) {
  if (!(files instanceof Map) || files.size > REAPER_LIMITS.mediaFiles) problem('media must be an explicitly supplied Map with at most 20,000 entries.');
  const result = new Map(); let total = 0;
  for (const [alias, value] of files) {
    if (typeof alias !== 'string' || !alias || alias.length > 4096 || /[\u0000-\u001f\u007f]/.test(alias)) problem('invalid supplied media alias.');
    const bytes = inputBytes(value, 'supplied media'); total += bytes.byteLength;
    if (total > REAPER_LIMITS.fileBytes) problem('supplied media exceeds 320 MiB.');
    result.set(alias, bytes);
  }
  return result;
}
const basename = name => name.replaceAll('\\', '/').split('/').at(-1);
function relativeAlias(path) {
  if (/^(?:[A-Za-z]:|\/|[A-Za-z][A-Za-z\d+.-]*:)/.test(path)) return null;
  const parts = [];
  for (const part of path.replaceAll('\\', '/').split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part); }
  return parts.join('/');
}
function mediaResolver(files, projectName, warnings) {
  const directory = String(projectName || '').replaceAll('\\', '/').split('/').slice(0, -1).join('/');
  const byBase = new Map(), byRelative = new Map();
  for (const [alias, bytes] of files) {
    const base = basename(alias), relative = relativeAlias(alias);
    byBase.set(base, [...(byBase.get(base) || []), { alias, bytes }]);
    if (relative) byRelative.set(relative, [...(byRelative.get(relative) || []), { alias, bytes }]);
  }
  return reference => {
    if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\u0000-\u001f\u007f]/.test(reference)) problem('invalid media reference.');
    if (files.has(reference)) return { alias: reference, bytes: files.get(reference) };
    const relative = relativeAlias(reference);
    if (relative) for (const candidate of [relativeAlias(directory ? `${directory}/${reference}` : reference), relative]) {
      const matches = byRelative.get(candidate) || [];
      if (matches.length > 1) problem(`ambiguous supplied media alias: ${reference}. Supply one exact alias.`);
      if (matches.length === 1) return matches[0];
    }
    const matches = byBase.get(basename(reference)) || [];
    if (matches.length !== 1) problem(`${matches.length ? 'Ambiguous' : 'Missing'} media: ${reference}. Supply the referenced file with an exact alias; no host path or URL is opened.`);
    warnings.push(`Media reference “${reference}” was explicitly remapped to the unique uploaded file “${matches[0].alias}”.`);
    return matches[0];
  };
}

const PROJECT_RECORDS = new Set(('RIPPLE GROUPOVERRIDE AUTOXFADE ENVATTACH POOLEDENVATTACH TCPUIFLAGS MIXERUIFLAGS ENVFADESZ10 AUTOBYPASS PEAKGAIN FEEDBACK PANLAW PROJOFFS MAXPROJLEN TEMPO PLAYRATE SELECTION SELECTION2 LOOP LOOPGRAN CURSOR TIMEMODE SAMPLERATE LOCK VZOOM VIEWZOOM HZOOM SCROLL VIDEO_CONFIG MIDI_EDIT MIDIEDITOR REWIRESLAVE RECORD_PATH RENDER_FILE RENDER_PATTERN RENDER_FMT RENDER_1X RENDER_RANGE RENDER_RESAMPLE RENDER_ADDTOPROJ RENDER_QDELAY RENDER_STEMS RENDER_DITHER RENDER_NORMALIZE RENDER_FADELPF RENDER_TRIM RENDER_EXTRAFILEDIR TIMELOCKMODE TIMEBASE_EXTRAFLAGS TEMPOENVLOCKMODE ITEMMIX DEFPITCHMODE MISCOPTS TAKELANE INTMIXMODE GLOBAL_AUTO METRONOMEOUT CLEAR_COMP_GROUP GROUP GROUPS_DISABLED GROUP_NAME GROUP_COLOR GROUP_AUTO MIXERORDER MIXERORDER_MORE MASTER_VOLUME MASTER_PAN MASTER_PAN2 MASTER_WIDTH MASTER_PANMODE MASTER_PANMODE_EX MASTER_PANLAWFLAGS MASTER_NCH MASTERMUTESOLO MASTER_MUTESOLO MASTERHWOUT MASTER_HWOUT MASTER_FX MASTER_TRACKID MASTERAUTOMODE MASTERTRACKHEIGHT MASTERPEAKCOL MASTERTRACKVIEW MASTER_GROUP_FLAGS MASTER_AREASEL MASTER_TRACK_HAS_MORE_THAN_64_CHANNELS RULERLANE RULERLANECFG ENTPROJREGION MARKER TEMPOENV GRID PANMODE PANLAWFLAGS ZOOM VZOOMEX USE_REC_CFG RECMODE SMPTESYNC MASTER_SEL RULERHEIGHT').split(' '));
const TRACK_RECORDS = new Set(('NAME PEAKCOL BEAT VOLPAN PANMODE PANMODE_EX PANLAWFLAGS MUTESOLO IPHASE PLAYOFFS ISBUS BUSCOMP SHOWINMIX TRACKHEIGHT REC AUTO_RECARM VU MIDI_INPUT_CHANMAP MIDICTL MIDIEDITOR SCORE SPACER NCHAN PERF LAYOUTS TRACKID LOCK SEL MAINSEND MAINSEND_NCH MIDIOUT CUSTOM_NOTE_ORDER TRACKIMGFN MIDICOLORMAPFN MIDIBANKPROGFN FX AUTOMODE FREEMODE ITEMLANES FIXEDLANES LANEREC LANENAME LANESOLO GROUP_FLAGS GROUP_FLAGS_HIGH GROUP_FLAGS2 GROUP_FLAGS2_HIGH GROUP_FLAGS3 GROUP_FLAGS3_HIGH GROUP_FLAGS4 GROUP_FLAGS4_HIGH VOLTYPE BUSCOMPACT AREASEL INQ').split(' '));
const ITEM_RECORDS = new Set(('POSITION SNAPOFFS LENGTH LOOP ALLTAKES FADEIN FADEOUT FADEFLAG FADE_NEW_PARAMETERS MUTE SEL IGUID IID NAME VOLPAN TAKEVOLPAN SOFFS PLAYRATE CHANMODE GUID COLOR TAKECOLOR GROUP BEAT POOLEDEVTS LOCK MIXFLAG LANEHEIGHT LANE FADELPF FREEMODE_Y FREEMODE_H UISEL').split(' '));
const PROJECT_UI_BLOCKS = new Set(['NOTES', 'RECORD_CFG', 'RENDER_CFG', 'RENDER_CFG2', 'METRONOME', 'EXTENSIONS', 'EXTSTATE', 'KEYSIG', 'ENTPROJRENDER', 'REGIONRENDER', 'APPLYFX_CFG', 'PROJBAY']);
const TRACK_UI_BLOCKS = new Set(['MIDINOTENAMES', 'RECCFG', 'EXT', 'EXT_TRACK']);
// Native REAPER 7.86 writes these defaults even in a project with no automation.
// An envelope containing a point, pool, nested block or unknown record is not inert.
const EMPTY_ENVELOPE_RECORDS = new Set(['EGUID', 'ACT', 'VIS', 'LANEHEIGHT', 'ARM', 'DEFSHAPE']);
function guardChildren(node, scope, warnings) {
  const safe = scope === 'project' ? PROJECT_RECORDS : scope === 'track' ? TRACK_RECORDS : ITEM_RECORDS;
  for (const child of node.children || []) {
    if (child.children) {
      if ((scope === 'project' && ['TRACK', 'RENDER_METADATA'].includes(child.tag)) || (scope === 'track' && child.tag === 'ITEM') || (scope === 'item' && child.tag === 'SOURCE')) continue;
      if ((scope === 'project' && PROJECT_UI_BLOCKS.has(child.tag)) || (scope === 'track' && TRACK_UI_BLOCKS.has(child.tag)) || (scope === 'item' && ['NOTES', 'EXT', 'EXTI'].includes(child.tag))) continue;
      if (scope === 'project' && ['MASTERPLAYSPEEDENV', 'TEMPOENVEX'].includes(child.tag) && child.children.every(entry => !entry.children && EMPTY_ENVELOPE_RECORDS.has(entry.tag))) continue;
      if (['FXCHAIN', 'FXCHAIN_REC', 'MASTERFXLIST', 'TAKEFX'].includes(child.tag)) {
        if (child.children.every(entry => !entry.children && ['SHOW', 'LASTSEL', 'DOCKED'].includes(entry.tag))) continue;
      }
      problem(`${child.tag} contains unsupported effects, automation, comping or source processing. Render stems in REAPER first.`, child);
    } else if (!safe.has(child.tag) && !/^GROUP_FLAGS\d*(?:_HIGH)?$/.test(child.tag)) {
      problem(`unsupported ${scope} record ${child.tag}. Render stems in REAPER or remove that feature first.`, child);
    }
  }
}
function metadataFromRpp(root, warnings) {
  const tags = {};
  for (const block of all(root, 'RENDER_METADATA')) for (const entry of block.children || []) {
    if (entry.tag !== 'TAG' || entry.children || entry.args.length !== 2) { warnings.push('Unsupported REAPER metadata blocks were not imported.'); continue; }
    const field = TAG_FIELDS[entry.args[0]];
    if (field) tags[field] = entry.args[1]; else warnings.push(`REAPER metadata “${entry.args[0].slice(0, 100)}” is outside the supported tag fields.`);
  }
  return normalizeMetadata(tags);
}
function nativeMix(track, layout, outputLayout) {
  const mono = layout === 'mono' && outputLayout !== 'mono', pan = track.pan, gain = 10 ** (track.gainDb / 20);
  if (layout === 'mono' && outputLayout === 'mono') return { gain, pan: 0 };
  const left = mono ? Math.cos((pan + 1) * Math.PI / 4) : pan > 0 ? Math.cos(pan * Math.PI / 2) : 1;
  const right = mono ? Math.sin((pan + 1) * Math.PI / 4) : pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1;
  const nativePan = left >= right ? right / left - 1 : 1 - left / right;
  return { gain: gain * Math.max(left, right), pan: Math.abs(nativePan) < 1e-14 ? 0 : nativePan };
}
function editorMix(gain, pan, layout, outputLayout) {
  const left = pan > 0 ? 1 - pan : 1, right = pan < 0 ? 1 + pan : 1;
  const mono = layout === 'mono' && outputLayout !== 'mono';
  if (layout === 'mono' && outputLayout === 'mono' && pan) problem('panned mono-output tracks need a rendered stem from REAPER.');
  const translated = mono ? Math.atan2(right, left) * 4 / Math.PI - 1 : Math.sign(pan) * Math.acos(Math.min(left, right)) * 2 / Math.PI;
  const gainDb = gain ? 20 * Math.log10(gain * (mono ? Math.hypot(left, right) : 1)) : 0;
  if (gainDb < -96 - 1e-8 || gainDb > 24 + 1e-8) problem('track gain exceeds the editor range after pan-law conversion. Render audio stems first.');
  return { gainDb: Math.max(-96, Math.min(24, gainDb)), pan: Math.abs(translated) < 1e-14 ? 0 : translated, silent: gain === 0 };
}
function mixedAudio(audio, outputLayout, matrix) {
  const frames = audio.channels[0].length;
  if (frames * matrix.length * 4 > REAPER_LIMITS.pcmBytes) problem('rendered layout conversion exceeds 256 MiB.');
  return { sampleRate: audio.sampleRate, layout: outputLayout, channels: matrix.map(row => {
    const out = new Float32Array(frames);
    for (let ch = 0; ch < row.length; ch++) if (row[ch]) for (let i = 0; i < frames; i++) out[i] += audio.channels[ch][i] * row[ch];
    return out;
  }) };
}

/** Decode only explicit supplied media; this function has no filesystem/network capability.
 * decodeMedia(bytes, {name, sampleRate, maxPcmBytes}) may supply a trusted local
 * decoder for non-WAV sources. It must return bounded, finite canonical PCM.
 */
export async function importReaper(input, { name = 'project.rpp', files = new Map(), decodeMedia } = {}) {
  let bytes = inputBytes(input), media = suppliedFiles(files), projectPath = String(name), manifest;
  const warnings = [];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const unpacked = readProjectZip(bytes, { maxEntryBytes: path => /\.rpp$/i.test(path) ? RPP_LIMITS.bytes : /websoundedit-project\.json$/i.test(path) ? REAPER_LIMITS.manifestBytes : REAPER_LIMITS.pcmBytes });
    const projects = [...unpacked].filter(([path]) => /\.rpp$/i.test(path));
    if (projects.length !== 1) problem('a package must contain exactly one RPP project.');
    [projectPath, bytes] = projects[0];
    for (const [path, value] of unpacked) { if (media.has(path) && media.get(path) !== value) problem(`duplicate supplied/archive media alias: ${path}.`); media.set(path, value); }
    media = suppliedFiles(media);
  }
  const manifestPath = projectPath.replace(/[^/\\]+$/, 'websoundedit-project.json');
  if (media.has(manifestPath)) {
    const data = media.get(manifestPath); if (data.length > REAPER_LIMITS.manifestBytes) problem('package metadata exceeds 32 KiB.');
    manifest = JSON.parse(textDecoder.decode(data));
    if (!manifest || manifest.format !== 'websoundedit-reaper' || manifest.version !== 1 || manifest.project !== basename(projectPath)) problem('unsupported package metadata manifest.');
  }
  const root = parseRpp(bytes); guardChildren(root, 'project', warnings);
  const sampleRate = field(root, 'SAMPLERATE', 0, 48000, 8000, 192000, true), tempo = one(root, 'TEMPO');
  const bpm = numeric(tempo, 0, 120, 20, 400), beatsPerBar = numeric(tempo, 1, 4, 1, 16, true), denominator = numeric(tempo, 2, 4, 1, 64, true);
  if (denominator !== 4) warnings.push('The REAPER time-signature denominator is kept for export; the editor grid counts quarter-note beats.');
  unchanged(root, 'PLAYRATE', 0, 1); unchanged(root, 'MASTER_VOLUME', 0, 1); unchanged(root, 'MASTER_VOLUME', 1, 0);
  const masterLaw = field(root, 'MASTER_VOLUME', 2, -1, -1, 4);
  if ((masterLaw < 0 ? field(root, 'PANLAW', 0, 1, .01, 4) : masterLaw) !== 1) problem('master pan law needs rendering in REAPER. Supported interchange uses 0 dB balance.', one(root, 'MASTER_VOLUME'));
  unchanged(root, 'MASTER_WIDTH', 0, 1); unchanged(root, 'MASTER_PAN', 0, 0); unchanged(root, 'MASTER_PAN2', 0, 0);
  unchanged(root, 'MASTERMUTESOLO', 0, 0); unchanged(root, 'MASTER_MUTESOLO', 0, 0); unchanged(root, 'FEEDBACK', 0, 0);
  const masterChannels = field(root, 'MASTER_NCH', 0, 2, 2, 8, true);
  if (![2, 6, 8].includes(masterChannels)) problem('master must use 2, 6 or 8 channels.');
  const renderChannels = field(root, 'RENDER_FMT', 1, masterChannels, 1, 8, true);
  if (![1, 2, 6, 8].includes(renderChannels) || (masterChannels > 2 && renderChannels !== masterChannels)) problem('render/master channel routing is outside the supported direct layout. Render explicit channel stems in REAPER first.');
  let outputLayout = manifest?.outputLayout ? normalizeLayout(manifest.outputLayout) : renderChannels === 1 ? 'mono' : layoutForChannels(masterChannels);
  if (CHANNEL_LAYOUTS[outputLayout].count > masterChannels || (manifest?.outputLayout && CHANNEL_LAYOUTS[outputLayout].count !== renderChannels)) problem('declared output layout disagrees with native master/render channels.');
  if (masterChannels > 2 && !manifest?.outputLayout) warnings.push(`REAPER’s numbered master channels are interpreted in canonical ${outputLayout} speaker order. Confirm the original speaker routing before playback.`);
  const editor = new AudioEditor({ sampleRate, name: named(manifest?.name || basename(projectPath).replace(/\.rpp$/i, ''), 'REAPER project', warnings), bpm, outputLayout });
  await editor.execute('project.update', { beatsPerBar });
  await editor.execute('metadata.update', { metadata: manifest ? normalizeMetadata(manifest.metadata || {}) : metadataFromRpp(root, warnings) });
  if (denominator !== 4) editor.getProject().settings.reaperTimeSignature = { upper: beatsPerBar, lower: denominator };
  const resolveMedia = mediaResolver(media, projectPath, warnings), decoded = new Map(); let decodedBytes = 0, importedBytes = 0, clipCount = 0;
  async function decode(reference, source) {
    const resolved = resolveMedia(reference);
    if (decoded.has(resolved.alias)) return decoded.get(resolved.alias);
    let audio;
    const signature = String.fromCharCode(...resolved.bytes.subarray(0, 12));
    if (signature.startsWith('RIFF') && signature.slice(8) === 'WAVE') audio = decodeWav(resolved.bytes);
    else if (typeof decodeMedia === 'function') audio = await decodeMedia(resolved.bytes, { name: resolved.alias, sampleRate, maxPcmBytes: REAPER_LIMITS.pcmBytes - decodedBytes });
    else problem(`media “${reference}” needs a supplied local decoder, or a WAV/REAPER rendered stem.`, source);
    validateAudio(audio); audioLayout(audio);
    const nativeSize = audio.channels[0].length * audio.channels.length * 4;
    const size = Math.max(nativeSize, Math.ceil(audio.channels[0].length * sampleRate / audio.sampleRate) * audio.channels.length * 4);
    if ((decodedBytes += size) > REAPER_LIMITS.pcmBytes) problem('decoded media exceeds 256 MiB.');
    if (audio.channels[0].length / audio.sampleRate > REAPER_LIMITS.seconds) problem('a media source exceeds the 10-minute editable limit. Supply a bounded rendered excerpt.');
    if (audio.sampleRate !== sampleRate) { audio = resampleAudio(audio, sampleRate); warnings.push('Media at another sample rate was resampled to the project rate.'); }
    decoded.set(resolved.alias, audio); return audio;
  }
  const nativeTracks = all(root, 'TRACK'); if (nativeTracks.length > REAPER_LIMITS.tracks) problem('project exceeds 64 tracks.');
  for (const nativeTrack of nativeTracks) {
    guardChildren(nativeTrack, 'track', warnings);
    unchanged(nativeTrack, 'IPHASE', 0, 0); unchanged(nativeTrack, 'ISBUS', 0, 0); unchanged(nativeTrack, 'ISBUS', 1, 0);
    unchanged(nativeTrack, 'PLAYOFFS', 0, 0); unchanged(nativeTrack, 'MAINSEND', 0, 1); unchanged(nativeTrack, 'MAINSEND', 1, 0);
    unchanged(nativeTrack, 'MAINSEND_NCH', 0, 0); unchanged(nativeTrack, 'FREEMODE', 0, 0); unchanged(nativeTrack, 'ITEMLANES', 0, 0);
    const fixedLanes = one(nativeTrack, 'FIXEDLANES');
    if (one(nativeTrack, 'LANESOLO') || (fixedLanes && (fixedLanes.args.length !== 5 || fixedLanes.args.some((_, index) => numeric(fixedLanes, index, undefined) !== (index ? 0 : 9))))) problem('fixed lanes/comping need rendering in REAPER first.', nativeTrack);
    const nativePan = field(nativeTrack, 'VOLPAN', 1, 0, -1, 1), gain = field(nativeTrack, 'VOLPAN', 0, 1, 0, 1000);
    const declaredMode = field(nativeTrack, 'PANMODE', 0, -1, -1, 6, true), panMode = declaredMode < 0 ? field(root, 'PANMODE', 0, 3, 0, 6, true) : declaredMode;
    const panLaw = field(nativeTrack, 'VOLPAN', 2, -1, -1, 4);
    const law = panLaw < 0 ? field(root, 'PANLAW', 0, 1, .01, 4) : panLaw;
    if (![0, 3].includes(panMode) || law !== 1 || (nativePan && field(nativeTrack, 'PANLAWFLAGS', 0, field(root, 'PANLAWFLAGS', 0, 0, 0, 3, true), 0, 3, true) !== 2)) problem('this pan mode/law needs rendering in REAPER. Supported interchange uses 0 dB linear balance.', nativeTrack);
    const count = field(nativeTrack, 'NCHAN', 0, 2, 2, 8, true); if (![2, 6, 8].includes(count)) problem('track must use 2, 6 or 8 native channels.', nativeTrack);
    const trackName = named(one(nativeTrack, 'NAME')?.args[0], 'Audio track', warnings), mute = field(nativeTrack, 'MUTESOLO', 0, 0, 0, 1, true) !== 0, soloValue = field(nativeTrack, 'MUTESOLO', 1, 0, 0, 6, true);
    if (![0, 1, 2].includes(soloValue) || field(nativeTrack, 'MUTESOLO', 2, 0) !== 0) problem('solo defeat or special solo routing needs rendering in REAPER.', nativeTrack);
    const clips = [], intervals = [];
    for (const item of all(nativeTrack, 'ITEM')) {
      if (++clipCount > REAPER_LIMITS.clips) problem('project exceeds 512 clips.'); guardChildren(item, 'item', warnings);
      const start = field(item, 'POSITION', 0, 0, 0, REAPER_LIMITS.seconds), duration = field(item, 'LENGTH', 0, undefined, 1 / sampleRate, REAPER_LIMITS.seconds), offset = field(item, 'SOFFS', 0, 0, 0, REAPER_LIMITS.seconds);
      unchanged(item, 'PLAYRATE', 0, 1); unchanged(item, 'PLAYRATE', 2, 0); unchanged(item, 'CHANMODE', 0, 0); unchanged(item, 'MUTE', 0, 0); unchanged(item, 'ALLTAKES', 0, 0);
      unchanged(item, 'VOLPAN', 1, 0); unchanged(item, 'VOLPAN', 2, 1); unchanged(item, 'FADEIN', 1, 0); unchanged(item, 'FADEOUT', 1, 0);
      if (field(item, 'FADEIN', 2, 0) > 0 || field(item, 'FADEOUT', 2, 0) > 0 || one(item, 'TAKEVOLPAN')) problem('take gain or automatic fades need rendering in REAPER first.', item);
      const source = one(item, 'SOURCE'); if (!source?.children || !['WAVE', 'FLAC', 'MP3', 'VORBIS', 'OPUS', 'AIFF'].includes(source.args[0])) problem('this source type requires an audio stem rendered in REAPER.', source || item);
      if (source.children.some(child => child.children || !['FILE'].includes(child.tag))) problem('source transforms, source sections or non-file media are unsupported.', source);
      const file = one(source, 'FILE'); if (!file || file.args.length !== 1) problem('source has no single media file.', source);
      const original = await decode(file.args[0], source), layout = audioLayout(original);
      if (original.channels.length > count || original.channels.length > masterChannels) problem('media channels exceed their direct track/master routing. Render supported stems first.', item);
      const first = Math.round(offset * sampleRate), frames = Math.round(duration * sampleRate), startFrame = Math.round(start * sampleRate);
      if (frames < 1 || startFrame + frames > REAPER_LIMITS.seconds * sampleRate || first + frames > original.channels[0].length) problem('item extends outside its source or the 10-minute timeline; looping sources must be rendered first.', item);
      importedBytes += frames * original.channels.length * 4; if (importedBytes > REAPER_LIMITS.pcmBytes) problem('visible clip audio exceeds 256 MiB.');
      const itemGain = field(item, 'VOLPAN', 0, 1, -1000, 1000);
      const audio = { sampleRate, layout, channels: original.channels.map(channel => { const out = channel.slice(first, first + frames); if (itemGain !== 1) for (let i = 0; i < out.length; i++) out[i] *= itemGain; return out; }) };
      if (itemGain !== 1) warnings.push('Constant item volume/polarity was rendered into its imported PCM.');
      if (first || frames !== original.channels[0].length) warnings.push('Visible source trims were rendered into imported PCM; hidden trimmed audio remains in the original media.');
      const mixFlag = field(item, 'MIXFLAG', 0, field(root, 'ITEMMIX', 0, 0, 0, 2, true), -1, 2, true);
      intervals.push({ start: startFrame, end: startFrame + frames, mix: mixFlag < 0 ? field(root, 'ITEMMIX', 0, 0, 0, 2, true) : mixFlag });
      clips.push({ name: named(one(item, 'NAME')?.args[0], basename(file.args[0]), warnings), start: startFrame / sampleRate, audio, layout });
    }
    for (let i = 0; i < intervals.length; i++) for (let j = 0; j < i; j++) if (intervals[i].start < intervals[j].end && intervals[j].start < intervals[i].end && (intervals[i].mix !== 1 || intervals[j].mix !== 1)) problem('overlapping items use replacement mixing. Set overlapping items to Always mix or render stems in REAPER.', nativeTrack);
    const layouts = [...new Set(clips.map(clip => clip.layout))]; if (!layouts.length) layouts.push('stereo');
    if (layouts.length > 1) warnings.push('Tracks containing different media layouts were split to preserve their pan-law translation.');
    for (const layout of layouts) {
      const suffix = layouts.length > 1 ? ` (${layout})` : '', track = await editor.execute('track.add', { name: trackName.slice(0, 200 - suffix.length) + suffix });
      const translated = editorMix(gain, nativePan, layout, outputLayout);
      await editor.execute('track.update', { trackId: track.id, gainDb: translated.gainDb, pan: translated.pan, mute: mute || translated.silent, solo: soloValue !== 0 });
      for (const clip of clips.filter(clip => clip.layout === layout)) await editor.execute('clip.add', { trackId: track.id, name: clip.name, start: clip.start, audio: clip.audio });
    }
  }
  for (const marker of all(root, 'MARKER')) {
    if (editor.getProject().markers.length >= 1000) problem('project exceeds 1000 markers.');
    if (numeric(marker, 3, 0, 0, 1, true)) problem('REAPER regions need conversion to point markers before import.', marker);
    await editor.execute('markers.add', { time: numeric(marker, 1, undefined, 0, REAPER_LIMITS.seconds), name: named(marker.args[2], 'Marker', warnings) });
  }
  warnings.push('Imported REAPER projects contain committed audio and supported timeline/mix data. Native scripts, device settings and project extensions are never executed or armed.');
  return { project: await editor.execute('project.save'), warnings: [...new Set(warnings)] };
}

/** Genuine project.rpp and float WAV media. Static routing is rendered only when
 * a smaller output layout cannot reproduce the WebSoundEdit downmix directly.
 */
export async function exportReaper(portableProject, { format = 'zip' } = {}) {
  if (format !== 'zip') problem('choose ZIP containing the RPP and its media.');
  const editor = new AudioEditor(); await editor.execute('project.load', { project: portableProject });
  const project = editor.getProject(), outputLayout = normalizeLayout(project.outputLayout), outputCount = CHANNEL_LAYOUTS[outputLayout].count;
  const warnings = ['REAPER saves committed PCM, clip placement, translated track mix, markers, fixed tempo and supported tags. WebSoundEdit live racks, macros, themes and MIDI mappings remain in the native JSON session.'];
  const root = record('REAPER_PROJECT', [0.1, '7.86', 1], [
    record('SAMPLERATE', [project.sampleRate, 1, 0]), record('TEMPO', [project.bpm, project.settings?.reaperTimeSignature?.upper || project.beatsPerBar, project.settings?.reaperTimeSignature?.lower || 4]),
    record('PLAYRATE', [1, 0, .25, 4]), record('PANLAW', [1]), record('ITEMMIX', [1]), record('AUTOXFADE', [0]),
    record('MASTER_NCH', [Math.max(2, outputCount), 2]), record('MASTER_VOLUME', [1, 0, 1, -1, 1]), record('MASTER_PANMODE', [3]), record('MASTER_PANLAWFLAGS', [2]),
    record('RENDER_FMT', [0, outputCount, project.sampleRate]), record('RENDER_DITHER', [0]),
  ]);
  const tags = [];
  for (const [field, value] of Object.entries(normalizeMetadata(project.metadata || {}))) {
    if (/[\r\n\t]/.test(value)) { warnings.push(`Multiline ${field} is kept in the package metadata and WAV tags, but omitted from the RPP text tag.`); continue; }
    tags.push(record('TAG', [TAGS[field], value]));
  }
  if (tags.length) root.children.push(record('RENDER_METADATA', [], tags));
  for (const [i, marker] of project.markers.entries()) root.children.push(record('MARKER', [i + 1, marker.time, marker.name, 0]));
  const files = Object.create(null); let trackCount = 0, clipCount = 0, bytesTotal = 0;
  for (const track of project.tracks) {
    const layouts = [...new Set(track.clips.map(clip => audioLayout(clip.audio)))]; if (!layouts.length) layouts.push(outputLayout);
    if (layouts.length > 1) warnings.push('Tracks with different source layouts are split to preserve their native pan-law translation.');
    for (const sourceLayout of layouts) {
      if (++trackCount > REAPER_LIMITS.tracks) problem('layout splitting exceeds 64 tracks. Export fewer tracks or rendered stems.');
      const bake = CHANNEL_LAYOUTS[sourceLayout].count > 2 && CHANNEL_LAYOUTS[sourceLayout].count > outputCount;
      const layout = bake ? outputLayout : sourceLayout, mix = bake ? { gain: 1, pan: 0 } : nativeMix(track, layout, outputLayout);
      if (bake) warnings.push(`Track “${track.name}” was rendered through its ${sourceLayout}→${outputLayout} routing and static gain/pan into exported PCM to preserve the audible downmix; its native gain/pan are neutral.`);
      const suffix = layouts.length > 1 ? ` (${sourceLayout})` : '';
      const nativeTrack = record('TRACK', [], [record('NAME', [track.name.slice(0, 200 - suffix.length) + suffix]), record('NCHAN', [Math.max(2, CHANNEL_LAYOUTS[layout].count)]),
        record('VOLPAN', [mix.gain, mix.pan, 1, -1, 1]), record('PANMODE', [3]), record('PANLAWFLAGS', [2]), record('MUTESOLO', [track.mute ? 1 : 0, track.solo ? 1 : 0, 0]),
        record('ISBUS', [0, 0]), record('MAINSEND', [1, 0]), record('MAINSEND_NCH', [0])]);
      for (const clip of track.clips.filter(clip => audioLayout(clip.audio) === sourceLayout)) {
        if (++clipCount > REAPER_LIMITS.clips) problem('export exceeds 512 clips.');
        const audio = bake ? mixedAudio(clip.audio, outputLayout, trackMixMatrix(sourceLayout, outputLayout, track)) : clip.audio;
        const mediaAudio = outputLayout === 'mono' && layout === 'mono' ? { ...audio, layout: 'mono' } : audio;
        const filename = `media/${String(trackCount).padStart(3, '0')}-${String(clipCount).padStart(3, '0')}.wav`;
        const wav = encodeWav(mediaAudio, { float: true, bitDepth: 32, metadata: project.metadata });
        if (wav.length > REAPER_LIMITS.pcmBytes) problem('one encoded WAV exceeds the 256 MiB archive-entry limit including its headers/tags. Export that clip in shorter sections.');
        bytesTotal += wav.length; if (bytesTotal > REAPER_LIMITS.pcmBytes + 16 * 1024 * 1024) problem('exported media exceeds the package memory limit.');
        files[filename] = wav;
        nativeTrack.children.push(record('ITEM', [], [record('POSITION', [Math.round(clip.start * project.sampleRate) / project.sampleRate]), record('LENGTH', [audio.channels[0].length / project.sampleRate]),
          record('LOOP', [0]), record('ALLTAKES', [0]), record('MIXFLAG', [1]), record('FADEIN', [1, 0, 0, 1, 0, 0, 0]), record('FADEOUT', [1, 0, 0, 1, 0, 0, 0]),
          record('MUTE', [0, 0]), record('NAME', [clip.name]), record('VOLPAN', [1, 0, 1, -1]), record('SOFFS', [0]), record('PLAYRATE', [1, 1, 0, -1, 0, .0025]), record('CHANMODE', [0]), record('SOURCE', ['WAVE'], [record('FILE', [filename])])]));
      }
      root.children.push(nativeTrack);
    }
  }
  files['project.rpp'] = textEncoder.encode(writeRpp(root));
  files['websoundedit-project.json'] = textEncoder.encode(JSON.stringify({ format: 'websoundedit-reaper', version: 1, project: 'project.rpp', name: project.name, outputLayout, metadata: project.metadata }, null, 2));
  files['README.txt'] = textEncoder.encode(`WebSoundEdit REAPER project\n\nExtract this ZIP, then open project.rpp in REAPER. Keep the media folder beside it.\nSample rate: ${project.sampleRate} Hz\nOutput layout: ${outputLayout}\nChannel order: ${CHANNEL_LAYOUTS[outputLayout].channels.join(', ')}\n\n${warnings.join('\n\n')}\n`);
  return { bytes: zipSync(files, { level: 0 }), mime: 'application/zip', ext: 'zip', warnings: [...new Set(warnings)] };
}
