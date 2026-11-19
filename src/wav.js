/** RIFF/WAVE PCM and IEEE-float codec. No DOM, native dependency or file upload.
 * Layout: https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html
 * RIFF chunks may be reordered or padded; malformed/truncated input is rejected.
 */
import { normalizeMetadata, RIFF_TAGS } from './metadata.js';
const MAX_BYTES = 256 * 1024 * 1024;
function assertAudio(audio) {
  if (!audio || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 192000) throw new RangeError('WAV sample rate must be an integer between 8000 and 192000.');
  if (!Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2) throw new RangeError('WAV export supports mono or stereo.');
  const n = audio.channels[0].length;
  if (n / audio.sampleRate > 600 || n * audio.channels.length * 4 > MAX_BYTES) throw new RangeError('Audio exceeds the 10-minute / 256 MiB decoded-audio limit.');
  for (const channel of audio.channels) {
    if (!(channel instanceof Float32Array) || channel.length !== n) throw new TypeError('WAV audio requires equal-length Float32Array channels.');
    for (const x of channel) if (!Number.isFinite(x)) throw new RangeError('WAV audio contains a non-finite sample.');
  }
}
const ascii = (view, offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
const text = (view, offset, length) => { let value = ''; for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i)); return value; };

export function encodeWav(audio, { bitDepth = 16, float = false, metadata = {} } = {}) {
  assertAudio(audio);
  if (![16, 24, 32].includes(bitDepth) || (float && bitDepth !== 32)) throw new RangeError('Use PCM 16/24/32-bit, or float with bitDepth: 32.');
  const channels = audio.channels.length, frames = audio.channels[0].length, width = bitDepth / 8;
  const dataSize = frames * channels * width, headerSize = float ? 56 : 44;
  const pad = dataSize % 2;
  const tags = Object.entries(normalizeMetadata(metadata)).filter(([key]) => RIFF_TAGS[key]).map(([key, value]) => [RIFF_TAGS[key], new TextEncoder().encode(value)]);
  const infoSize = tags.length ? 12 + tags.reduce((n, [, value]) => n + 8 + value.length + 1 + ((value.length + 1) % 2), 0) : 0;
  const bytes = new Uint8Array(headerSize + dataSize + pad + infoSize), view = new DataView(bytes.buffer);
  ascii(view, 0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(view, 8, 'WAVE'); ascii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true); view.setUint16(34, bitDepth, true);
  if (float) { ascii(view, 36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true); }
  ascii(view, headerSize - 8, 'data'); view.setUint32(headerSize - 4, dataSize, true);
  let offset = headerSize;
  for (let i = 0; i < frames; i++) for (const channel of audio.channels) {
    const raw = channel[i], sample = Math.max(-1, Math.min(1, raw));
    if (float) view.setFloat32(offset, raw, true);
    else if (bitDepth === 16) view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    else if (bitDepth === 24) {
      const value = Math.round(sample * (sample < 0 ? 8388608 : 8388607));
      view.setUint8(offset, value & 255); view.setUint8(offset + 1, (value >> 8) & 255); view.setUint8(offset + 2, (value >> 16) & 255);
    } else view.setInt32(offset, Math.round(sample * (sample < 0 ? 2147483648 : 2147483647)), true);
    offset += width;
  }
  if (tags.length) {
    offset = headerSize + dataSize + pad; ascii(view, offset, 'LIST'); view.setUint32(offset + 4, infoSize - 8, true); ascii(view, offset + 8, 'INFO'); offset += 12;
    for (const [key, value] of tags) { ascii(view, offset, key); view.setUint32(offset + 4, value.length + 1, true); bytes.set(value, offset + 8); offset += 8 + value.length + 1 + ((value.length + 1) % 2); }
  }
  return bytes;
}

export function decodeWav(input) {
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw new TypeError('Provide WAV bytes as an ArrayBuffer or Uint8Array.');
  if (bytes.length < 12) throw new RangeError('The WAV header is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(view, 0, 4) !== 'RIFF' || text(view, 8, 4) !== 'WAVE') throw new RangeError('Expected a little-endian RIFF/WAVE file.');
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 12) throw new RangeError('The WAV file is truncated or its RIFF length is invalid.');
  let format = null, data = null;
  const metadata = {}, reverseTags = Object.fromEntries(Object.entries(RIFF_TAGS).map(([key, id]) => [id, key]));
  for (let offset = 12; offset + 8 <= end;) {
    const id = text(view, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > end) throw new RangeError(`Truncated WAV ${id} chunk.`);
    if (id === 'fmt ') {
      if (size < 16) throw new RangeError('WAV format chunk is too short.');
      let code = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true), sampleRate = view.getUint32(start + 4, true), blockAlign = view.getUint16(start + 12, true), bits = view.getUint16(start + 14, true);
      if (code === 0xfffe) {
        if (size < 40 || view.getUint16(start + 16, true) < 22) throw new RangeError('Truncated extensible WAV format.');
        code = view.getUint16(start + 24, true);
        const guidTail = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (guidTail.some((value, i) => view.getUint8(start + 26 + i) !== value)) throw new RangeError('Unsupported extensible WAV encoding.');
      }
      format = { code, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data' && data === null) data = { start, size };
    else if (id === 'LIST' && size >= 4 && text(view, start, 4) === 'INFO') {
      if (size > 16384) throw new RangeError('WAV metadata exceeds the supported size.');
      for (let cursor = start + 4; cursor + 8 <= start + size;) {
        const field = text(view, cursor, 4), length = view.getUint32(cursor + 4, true);
        if (cursor + 8 + length > start + size) throw new RangeError('Truncated WAV INFO metadata.');
        if (reverseTags[field]) metadata[reverseTags[field]] = new TextDecoder().decode(bytes.subarray(cursor + 8, cursor + 8 + length)).replace(/\0+$/, '');
        cursor += 8 + length + (length & 1);
      }
    }
    offset = start + size + (size & 1);
  }
  if (!format || !data) throw new RangeError('WAV requires both fmt and data chunks.');
  const { code, channels, sampleRate, blockAlign, bits } = format;
  if (![1, 3].includes(code) || (code === 1 && ![8, 16, 24, 32].includes(bits)) || (code === 3 && ![32, 64].includes(bits))) throw new RangeError('Unsupported WAV encoding; use uncompressed PCM or IEEE float.');
  if (channels < 1 || channels > 2) throw new RangeError('WAV import supports mono or stereo.');
  if (sampleRate < 8000 || sampleRate > 192000) throw new RangeError('WAV sample rate must be between 8000 and 192000.');
  const width = bits / 8;
  if (blockAlign !== channels * width || data.size % blockAlign !== 0) throw new RangeError('Invalid WAV block alignment.');
  const frames = data.size / blockAlign;
  if (frames / sampleRate > 600 || frames * channels * 4 > MAX_BYTES) throw new RangeError('Audio exceeds the 10-minute / 256 MiB decoded-audio limit.');
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  let offset = data.start;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    let value;
    if (code === 3) value = bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    else if (bits === 8) value = (view.getUint8(offset) - 128) / 128;
    else if (bits === 16) value = view.getInt16(offset, true) / 32768;
    else if (bits === 24) {
      let raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (raw & 0x800000) raw |= 0xff000000;
      value = raw / 8388608;
    } else value = view.getInt32(offset, true) / 2147483648;
    if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new RangeError('WAV contains non-finite or unrepresentable float samples.');
    output[c][i] = value;
    offset += width;
  }
  const tags = normalizeMetadata(metadata);
  return { sampleRate, channels: output, ...(Object.keys(tags).length ? { metadata: tags } : {}) };
}
