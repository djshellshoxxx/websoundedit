import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAudioFile } from '../src/codecs.js';
import { encodeWav } from '../src/wav.js';

const originalContext = globalThis.OfflineAudioContext;
const contexts = [];
let nativeCalls = 0, result;
globalThis.OfflineAudioContext = class {
  constructor(channels, length, sampleRate) { contexts.push({ channels, length, sampleRate }); }
  async decodeAudioData() { nativeCalls++; return result; }
};
after(() => {
  if (originalContext === undefined) delete globalThis.OfflineAudioContext;
  else globalThis.OfflineAudioContext = originalContext;
});
const compressedFile = () => new File([Uint8Array.of(1, 2, 3, 4)], 'fixture.mp3', { type: 'audio/mpeg' });
function nativeAudio(channels, sampleRate = 48000) {
  return { sampleRate, length: channels[0].length, numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate, getChannelData: index => channels[index] };
}

test('native imports preserve mono and stereo, copy PCM, and reuse a decoder at one working rate', async () => {
  const mono = Float32Array.of(0.1, -0.25, 0.7);
  result = nativeAudio([mono]);
  const first = await decodeAudioFile(compressedFile());
  assert.equal(first.channels.length, 1);
  assert.deepEqual(first.channels[0], mono);
  assert.notEqual(first.channels[0], mono);
  const contextCount = contexts.length;
  result = nativeAudio([mono, Float32Array.of(0.4, -0.4, 0.2)]);
  const second = await decodeAudioFile(compressedFile());
  assert.equal(second.channels.length, 2);
  assert.equal(contexts.length, contextCount);
  result = nativeAudio([mono], 44100);
  assert.equal((await decodeAudioFile(compressedFile(), 44100)).sampleRate, 44100);
  assert.equal(contexts.length, contextCount + 1);
});

test('unsupported native channel layouts fail validation instead of entering a downmix fallback', async () => {
  result = { numberOfChannels: 6, getChannelData() { throw new Error('Must validate before copying PCM'); } };
  await assert.rejects(decodeAudioFile(compressedFile()), /multichannel audio is not silently downmixed/);
});

test('native duration and decoded memory bounds are validated before copying PCM', async () => {
  const noCopy = () => { throw new Error('Must validate before copying PCM'); };
  result = { numberOfChannels: 1, length: 48000 * 601, duration: 601, getChannelData: noCopy };
  await assert.rejects(decodeAudioFile(compressedFile()), /10-minute \/ 256 MiB/);
  result = { numberOfChannels: 2, length: 40_000_000, duration: 40_000_000 / 192000, getChannelData: noCopy };
  await assert.rejects(decodeAudioFile(compressedFile(), 192000), /10-minute \/ 256 MiB/);
});

test('malformed PCM WAV is rejected directly without trying another decoder', async () => {
  const wav = encodeWav({ sampleRate: 48000, channels: [Float32Array.of(0, 0.2, -0.2)] });
  const file = new File([wav.subarray(0, wav.length - 2)], 'truncated.wav');
  const calls = nativeCalls;
  await assert.rejects(decodeAudioFile(file), /truncated|RIFF length/);
  assert.equal(nativeCalls, calls);
});

test('invalid working sample rates are rejected before reading or decoding the file', async () => {
  const file = { arrayBuffer() { throw new Error('Must validate rate first'); } };
  for (const rate of [7999, 192001, 44100.5, NaN]) {
    await assert.rejects(decodeAudioFile(file, rate), /Working sample rate/);
  }
});
