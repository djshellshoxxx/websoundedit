import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav } from '../src/wav.js';

function wav({ seconds = .02, channels = 2 } = {}) {
  const sampleRate = 8000;
  return encodeWav({
    sampleRate,
    channels: Array.from({ length: channels }, () => new Float32Array(Math.round(sampleRate * seconds)).fill(.25)),
    ...(channels === 6 ? { layout: '5.1' } : channels === 8 ? { layout: '7.1' } : {}),
  }, { bitDepth: 32, float: true });
}

function rejectsBeforePCMAllocation(bytes, options, message) {
  const OriginalFloat32Array = globalThis.Float32Array;
  let allocations = 0;
  globalThis.Float32Array = class extends OriginalFloat32Array {
    constructor(...args) { allocations++; super(...args); }
  };
  try { assert.throws(() => decodeWav(bytes, options), message); }
  finally { globalThis.Float32Array = OriginalFloat32Array; }
  assert.equal(allocations, 0, 'Rejected WAV must not allocate decoded PCM channels.');
}

test('stem duration limit rejects a normal 31-second WAV before allocating decoded PCM', () => {
  rejectsBeforePCMAllocation(wav({ seconds: 31 }), { maxDurationSeconds: 30, maxChannels: 2 }, /no longer than 30 seconds/);
});

test('stem channel limit rejects normal surround WAVs before allocating decoded PCM', () => {
  for (const channels of [6, 8]) rejectsBeforePCMAllocation(wav({ channels }), { maxDurationSeconds: 30, maxChannels: 2 }, /mono or stereo WAV/);
  rejectsBeforePCMAllocation(wav({ channels: 2 }), { maxChannels: 1 }, /1-channel limit/);
});

test('WAV admission rejects invalid optional limits without allocating decoded PCM', () => {
  const bytes = wav();
  for (const maxDurationSeconds of [0, -1, 601, Infinity, NaN, '30', null, true]) {
    rejectsBeforePCMAllocation(bytes, { maxDurationSeconds }, /maxDurationSeconds/);
  }
  for (const maxChannels of [0, -1, 3, 4, 5, 7, 9, 1.5, Infinity, NaN, '2', null, true]) {
    rejectsBeforePCMAllocation(bytes, { maxChannels }, /maxChannels/);
  }
});

test('exactly 30 seconds of stereo WAV remains valid under stem admission limits', () => {
  const audio = decodeWav(wav({ seconds: 30 }), { maxDurationSeconds: 30, maxChannels: 2 });
  assert.equal(audio.sampleRate, 8000);
  assert.equal(audio.channels.length, 2);
  for (const channel of audio.channels) {
    assert.equal(channel.length, 240000);
    assert.equal(channel[0], .25);
    assert.equal(channel.at(-1), .25);
  }
});

test('omitting admission limits preserves existing longer and surround WAV decoding', () => {
  for (const options of [{ seconds: 31 }, { channels: 6 }, { channels: 8 }]) {
    const bytes = wav(options);
    const implicit = decodeWav(bytes);
    const explicit = decodeWav(bytes, { maxDurationSeconds: 600, maxChannels: 8 });
    assert.deepEqual(implicit, explicit);
    assert.equal(implicit.channels.length, options.channels || 2);
    assert.equal(implicit.channels[0].length, Math.round((options.seconds || .02) * 8000));
  }
});
