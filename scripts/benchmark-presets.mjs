#!/usr/bin/env node
/** Reproducible maximum-duration offline preset stress; no timing pass/fail claim.
 * Run: node --expose-gc scripts/benchmark-presets.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { processPreset } from '../src/preset-dsp.js';
import { AUDIO_LIMITS } from '../src/dsp.js';

const sampleRate = 8000, frames = sampleRate * AUDIO_LIMITS.maxDuration;
const input = { sampleRate, layout: 'stereo', channels: [new Float32Array(frames), new Float32Array(frames)] };
for (let i = 0; i < frames; i++) {
  const center = 1.2 * Math.sin(2 * Math.PI * 233 * i / sampleRate), side = .1 * Math.sin(2 * Math.PI * 2900 * i / sampleRate);
  input.channels[0][i] = Math.max(-1, Math.min(1, center + side));
  input.channels[1][i] = Math.max(-1, Math.min(1, center - side));
}
const hash = audio => { const sum = createHash('sha256'); for (const channel of audio.channels) sum.update(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength)); return sum.digest('hex'); };
const sourceHash = hash(input), rows = [];
for (const presetId of ['repair-clipped-peaks', 'de-esser-strong', 'vocal-center', 'instrumental-sides', 'vocal-reduction', 'auto-limiter', 'master-bright']) {
  globalThis.gc?.();
  const before = performance.now(), result = await processPreset(input, { presetId });
  const milliseconds = performance.now() - before;
  assert.equal(result.sampleRate, sampleRate); assert.equal(result.layout, 'stereo'); assert.equal(result.channels.length, 2);
  let peak = 0;
  for (const channel of result.channels) {
    assert.equal(channel.length, frames);
    for (let i = 0; i < frames; i++) { assert.ok(Number.isFinite(channel[i])); peak = Math.max(peak, Math.abs(channel[i])); }
  }
  assert.equal(hash(input), sourceHash);
  rows.push({ presetId, durationSeconds: frames / sampleRate, frames, milliseconds: Math.round(milliseconds), samplePeak: Number(peak.toFixed(7)), outputSha256: hash(result), arrayBufferMiB: Math.round(process.memoryUsage().arrayBuffers / 1048576) });
}
// Preflight rejects one frame beyond duration or byte limits before DSP scans
// PCM, even if the offending buffer is otherwise valid, silent Float32 data.
await assert.rejects(processPreset({ sampleRate, channels: [new Float32Array(frames + 1)] }, { presetId: 'auto-limiter' }), /limit/);
await assert.rejects(processPreset({ sampleRate: 192000, channels: [new Float32Array(AUDIO_LIMITS.maxBytes / 4 + 1)] }, { presetId: 'de-esser-strong' }), /limit/);
console.log(JSON.stringify({ sampleRate, sourceSha256: sourceHash, rows, resourcePreflights: 'passed' }, null, 2));
