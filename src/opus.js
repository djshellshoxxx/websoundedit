/** Self-contained Opus export, independent of the FFmpeg core stack.
 * libopus-wasm 0.3.0 / libopus 1.6.1, pinned by package-lock.json.
 * Primary references:
 * https://libopus-wasm.dev/encoding.html
 * https://libopus-wasm.dev/api-reference.html
 * https://www.rfc-editor.org/rfc/rfc7845.html (Opus headers, pre-skip, end trimming)
 * https://www.rfc-editor.org/rfc/rfc3533.html (Ogg lacing and CRC)
 * No runtime network access; the package embeds its WASM in a local ES module.
 */
import { createEncoder, loadLibopus, Application, Signal, EncoderCtl } from 'libopus-wasm';

const RATE = 48000;
const FRAME = 960; // 20 ms; granules always count 48 kHz samples per channel.
const MAX_BYTES = 256 * 1024 * 1024;
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let value = i << 24;
  for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  CRC_TABLE[i] = value >>> 0;
}

/** Ogg's non-reflected CRC-32, initial register 0, no final XOR. */
export function oggCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]) >>> 0;
  return crc;
}
function uint(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`${name} is outside its supported integer range.`);
  return value;
}

/** Packet-complete Ogg page. No packet is continued onto another page.
 * A packet whose length is divisible by 255 requires a final zero lacing byte.
 */
export function createOggPage(packets, { serial, sequence, granule, flags = 0 }) {
  uint(serial, 0xffffffff, 'Ogg serial'); uint(sequence, 0xffffffff, 'Ogg page sequence');
  uint(granule, Number.MAX_SAFE_INTEGER, 'Ogg granule'); uint(flags, 7, 'Ogg flags');
  if (!Array.isArray(packets) || !packets.length) throw new TypeError('An Ogg page needs at least one packet.');
  let segments = 0, length = 0;
  for (const packet of packets) {
    if (!(packet instanceof Uint8Array)) throw new TypeError('Ogg packets must be Uint8Arrays.');
    segments += Math.floor(packet.length / 255) + 1;
    length += packet.length;
  }
  if (segments > 255) throw new RangeError('Ogg page exceeds its 255-segment limit.');
  const page = new Uint8Array(27 + segments + length), view = new DataView(page.buffer);
  page.set([79, 103, 103, 83], 0); // OggS
  page[4] = 0; page[5] = flags;
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 4294967296), true);
  view.setUint32(14, serial, true); view.setUint32(18, sequence, true);
  page[26] = segments;
  let lace = 27, payload = 27 + segments;
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) { page[lace++] = 255; remaining -= 255; }
    page[lace++] = remaining;
    page.set(packet, payload); payload += packet.length;
  }
  // Checksum bytes 22..25 are still zero while computing the checksum.
  view.setUint32(22, oggCrc(page), true);
  return page;
}
function opusHead(channels, preSkip) {
  const header = new Uint8Array(19), view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('OpusHead'));
  header[8] = 1; header[9] = channels;
  view.setUint16(10, uint(preSkip, 65535, 'Opus pre-skip'), true);
  view.setUint32(12, RATE, true);
  view.setInt16(16, 0, true); // No implicit playback gain.
  header[18] = 0; // Mapping family 0: one mono or coupled stereo stream.
  return header;
}
function opusTags() {
  const vendor = new TextEncoder().encode('Circuit Drift Labs WebSoundEdit / libopus-wasm 0.3.0');
  const tags = new Uint8Array(16 + vendor.length), view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode('OpusTags'));
  view.setUint32(8, vendor.length, true); tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // Zero user comments.
  return tags;
}
function streamSerial() {
  const value = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(value);
  else value[0] = Math.floor(Math.random() * 4294967296);
  return value[0];
}
const abortIfRequested = (signal) => {
  if (signal?.aborted) throw new DOMException('Opus encoding cancelled.', 'AbortError');
};
function validate(audio, bitrate) {
  if (!audio || audio.sampleRate !== RATE || !Array.isArray(audio.channels) || ![1, 2].includes(audio.channels.length)) throw new RangeError('Opus export requires 48 kHz mono or stereo PCM.');
  const frames = audio.channels[0]?.length;
  if (!Number.isSafeInteger(frames) || frames < 1) throw new RangeError('Opus export requires nonempty audio.');
  if (frames / RATE > 600 || frames * audio.channels.length * 4 > MAX_BYTES) throw new RangeError('Opus export exceeds the 10-minute / 256 MiB decoded-audio limit.');
  for (const channel of audio.channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames) throw new TypeError('Opus export requires equal-length Float32Array channels.');
    for (const sample of channel) if (!Number.isFinite(sample)) throw new RangeError('Opus input contains non-finite audio.');
  }
  if (!Number.isFinite(bitrate) || bitrate < 6 || bitrate > 510) throw new RangeError('Opus bitrate must be between 6 and 510 kb/s.');
  return frames;
}

/** Encode planar 48 kHz PCM to a genuine .opus (Ogg Opus) file.
 * bitrate is kb/s. onProgress receives a fraction in [0,1]. The final frame is
 * zero padded, enough extra input flushes encoder lookahead, and the EOS granule
 * trims padding back to the exact original sample count after pre-skip.
 */
export async function encodeOpus(audio, { bitrate = 192, onProgress, signal } = {}) {
  abortIfRequested(signal);
  const frames = validate(audio, bitrate), channels = audio.channels.length;
  const encoder = await createEncoder({ sampleRate: RATE, channels, application: Application.Audio,
    signal: Signal.Music, bitrate: Math.round(bitrate * 1000), complexity: 10, vbr: true, frameSize: FRAME });
  try {
    abortIfRequested(signal);
    encoder.encoderCtl(EncoderCtl.SetForceChannels, channels);
    const preSkip = encoder.getLookahead();
    uint(preSkip, 65535, 'Opus encoder lookahead');
    const totalFrames = frames + preSkip;
    const packetCount = Math.ceil(totalFrames / FRAME);
    const serial = streamSerial();
    const pages = [createOggPage([opusHead(channels, preSkip)], { serial, sequence: 0, granule: 0, flags: 2 }),
      createOggPage([opusTags()], { serial, sequence: 1, granule: 0 })];
    const pcm = new Float32Array(FRAME * channels);
    let pagePackets = [], pageSegments = 0, sequence = 2, decodedFrames = 0;
    onProgress?.(0);
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex++) {
      abortIfRequested(signal);
      const start = packetIndex * FRAME;
      pcm.fill(0);
      for (let i = 0; i < FRAME && start + i < frames; i++) for (let c = 0; c < channels; c++) {
        pcm[i * channels + c] = Math.max(-1, Math.min(1, audio.channels[c][start + i]));
      }
      const packet = encoder.encodeFloat(pcm);
      const segments = Math.floor(packet.length / 255) + 1;
      if (pagePackets.length && (pageSegments + segments > 255 || pagePackets.length >= 50)) {
        pages.push(createOggPage(pagePackets, { serial, sequence: sequence++, granule: decodedFrames }));
        pagePackets = []; pageSegments = 0;
      }
      pagePackets.push(packet); pageSegments += segments; decodedFrames += FRAME;
      if (packetIndex === packetCount - 1) {
        pages.push(createOggPage(pagePackets, { serial, sequence: sequence++, granule: totalFrames, flags: 4 }));
      }
      if ((packetIndex + 1) % 64 === 0) {
        onProgress?.(Math.min(1, (packetIndex + 1) / packetCount));
        // Also keep direct library callers responsive; the web app runs this in a worker.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    abortIfRequested(signal);
    const length = pages.reduce((sum, page) => sum + page.length, 0), bytes = new Uint8Array(length);
    let offset = 0;
    for (const page of pages) { bytes.set(page, offset); offset += page.length; }
    onProgress?.(1);
    return bytes;
  } finally { encoder.free(); }
}

/** Capability checks perform an actual full-complexity mono and stereo encode. */
export async function probeOpus() {
  const { version } = await loadLibopus();
  for (const channels of [1, 2]) {
    const encoder = await createEncoder({ sampleRate: RATE, channels, bitrate: 192000, complexity: 10, application: Application.Audio });
    try {
      const frame = Float32Array.from({ length: FRAME * channels }, (_, i) => Math.sin(i * 0.173) * 0.5);
      if (!encoder.encodeFloat(frame).length) throw new Error('Opus encoder did not produce a packet.');
    } finally { encoder.free(); }
  }
  return { available: true, version, sampleRate: RATE, channels: [1, 2], container: 'ogg', complexity: 10 };
}
