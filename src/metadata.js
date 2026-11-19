/** Bounded, container-independent audio tags. Values never become shell or HTML. */
export const METADATA_FIELDS = Object.freeze([
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['composer', 'Composer'], ['genre', 'Genre'], ['date', 'Date / year'], ['track', 'Track number'],
  ['disc', 'Disc number'], ['comment', 'Comment'], ['copyright', 'Copyright'], ['bpm', 'BPM'], ['key', 'Musical key'],
].map(([key, label]) => Object.freeze({ key, label, maxLength: key === 'comment' ? 2048 : 1024 })));
const allowed = new Map(METADATA_FIELDS.map(field => [field.key, field]));
export const RIFF_TAGS = Object.freeze({ title: 'INAM', artist: 'IART', album: 'IPRD', genre: 'IGNR', date: 'ICRD', track: 'ITRK', comment: 'ICMT', copyright: 'ICOP' });
const FFMPEG_TAGS = Object.freeze({ albumArtist: 'album_artist', key: 'initial_key' });
const VORBIS_TAGS = Object.freeze({ albumArtist: 'ALBUMARTIST', track: 'TRACKNUMBER', disc: 'DISCNUMBER', comment: 'DESCRIPTION', key: 'INITIALKEY' });

export function normalizeMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Metadata must be a plain object.');
  const output = {}; let size = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key)) throw new RangeError(`Unknown metadata field: ${key}`);
    if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) throw new TypeError(`Metadata ${key} must be text.`);
    const value = String(raw).trim();
    if (value.length > allowed.get(key).maxLength) throw new RangeError(`Metadata ${key} is too long.`);
    if ((key === 'comment' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw new RangeError(`Metadata ${key} contains unsupported control characters.`);
    size += new TextEncoder().encode(value).length;
    if (size > 8192) throw new RangeError('Metadata exceeds the 8 KiB text limit.');
    if (value) output[key] = value;
  }
  return output;
}

export function metadataSupport(format) {
  if (format === 'aac') return { supported: false, fields: [], note: 'Raw AAC / ADTS cannot store these tags. Choose M4A, WAV, MP3, FLAC, Ogg or Opus to embed metadata.' };
  if (format === 'wav') return { supported: true, fields: Object.keys(RIFF_TAGS), note: 'WAV stores title, artist, album, genre, date, track, comment and copyright as RIFF INFO. Other fields remain in the project.' };
  return { supported: true, fields: METADATA_FIELDS.map(field => field.key), note: 'Tags are written using this container’s metadata support. Player display varies by format and player.' };
}

export function metadataWarnings(metadata, format) {
  const tags = normalizeMetadata(metadata), support = metadataSupport(format);
  const missing = Object.keys(tags).filter(key => !support.fields.includes(key));
  return missing.length ? [`${format.toUpperCase()} does not embed: ${missing.join(', ')}. These tags remain in the project.`] : [];
}

export function ffmpegMetadataArgs(metadata = {}, format) {
  const tags = normalizeMetadata(metadata);
  if (format === 'aac') return ['-map_metadata', '-1'];
  const args = ['-map_metadata', '-1'];
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${FFMPEG_TAGS[key] || key}=${value}`);
  if (format === 'aiff' && Object.keys(tags).length) args.push('-write_id3v2', '1', '-id3v2_version', '3');
  return args;
}

export function vorbisComments(metadata = {}) {
  return Object.entries(normalizeMetadata(metadata)).map(([key, value]) => `${VORBIS_TAGS[key] || key.toUpperCase()}=${value}`);
}
