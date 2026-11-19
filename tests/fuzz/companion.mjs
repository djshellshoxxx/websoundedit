/** Deterministic bounded companion corpus; no external receiver or encoder.
 * node tests/fuzz/companion.mjs [report.json]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { UdpStreams } from '../../scripts/udp-streams.mjs';
import { NodeWorkbench } from '../../scripts/node-runtime.mjs';
import { startApiServer } from '../../scripts/server.mjs';
import { CompanionBridge } from '../../src/companion.js';
import { validateCommandParams } from '../../src/command-schema.js';

const SEED = 0x434f4d31;
let randomState = SEED;
const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const started = performance.now(), hash = createHash('sha256'), failures = [], phaseTimes = {};
const counts = { cases: 0, passed: 0, failed: 0, schema: 0, schemaValid: 0, schemaInvalid: 0, pcm: 0, pcmValid: 0, pcmInvalid: 0, pcmOutputComparisons: 0, lifecycle: 0, http: 0, invariantFailures: 0 };
const sourceFilesSha256 = Object.fromEntries(await Promise.all(['scripts/server.mjs', 'scripts/node-runtime.mjs', 'scripts/udp-streams.mjs', 'src/companion.js', 'src/command-schema.js', 'tests/fuzz/companion.mjs'].map(async file => [file, createHash('sha256').update(await readFile(new URL(`../../${file}`, import.meta.url))).digest('hex')])));
function digest(source) { const value = typeof source === 'string' ? source : JSON.stringify(source); hash.update(value); hash.update('\0'); return createHash('sha256').update(value).digest('hex'); }
async function exercise(phase, index, description, action) {
  const sha256 = digest(description); counts.cases++;
  try { await action(); counts.passed++; }
  catch (error) { counts.failed++; counts.invariantFailures++; if (failures.length < 40) failures.push({ phase, index, description, sha256, name: error.name, code: error.code, message: error.message }); }
}
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); } throw new Error('A bounded fixture condition did not become ready.'); }
const destination = { id: 'test', label: 'Synthetic socket only', address: '127.0.0.1', port: 5004 };
const caps = { nativeFFmpeg: false, formats: ['wav'] };
const rawStart = { destination: 'test', profile: 'f32le', inputSampleRate: 48000, inputLayout: 'mono' };
class Socket extends EventEmitter {
  constructor({ gate, hold = false } = {}) { super(); this.gate = gate; this.hold = hold; this.closed = false; this.bytes = []; this.callbacks = []; }
  connect(_port, _address, callback) { this.connecting = true; if (this.gate) this.gate.promise.then(callback); else queueMicrotask(callback); }
  send(bytes, callback) { this.bytes.push(Buffer.from(bytes)); if (this.hold) this.callbacks.push(callback); else queueMicrotask(() => callback(null)); }
  release() { this.hold = false; for (const callback of this.callbacks.splice(0)) queueMicrotask(() => callback(null)); }
  close() { this.closed = true; }
}
function streamFixture(options = {}) {
  const socket = options.socket || new Socket(), streams = new UdpStreams({ destinations: [destination], getCapabilities: async () => caps, socketFactory: () => socket, ...options });
  return { streams, socket };
}
function encoder(exitCode) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.emit('close', null, signal); return true; };
  child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', exitCode, null)));
  queueMicrotask(() => child.emit('spawn')); return child;
}
function http(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, response => {
      let text = ''; response.on('data', bytes => { text += bytes; if (text.length > 65536) req.destroy(new Error('Unexpected response expansion')); });
      response.once('end', () => resolve({ status: response.statusCode, body: text, headers: response.headers })); response.once('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Synthetic HTTP request timed out'))); req.once('error', reject); req.end(body);
  });
}

const catalogOwner = new NodeWorkbench(), descriptors = new Map(catalogOwner.commands().map(item => [item.method, item]));
await catalogOwner.dispose();
const schemaStarted = performance.now();
for (let index = 0; index < 1024; index++) {
  const variant = index % 8, valid = (Math.floor(index / 8) & 1) === 0, value = random(); let method, params;
  if (variant === 0) { method = 'stream.start'; params = valid ? { ...rawStart, bitrate: 16 + value % 497, layout: ['mono', 'stereo', '5.1', '7.1'][value % 4] } : { ...rawStart, profile: ['opus;bad', '', 'https://invalid'][value % 3] }; }
  if (variant === 1) { method = 'stream.start'; params = valid ? { ...rawStart, sampleRate: 8000 + value % 184001 } : { ...rawStart, destination: 'x'.repeat(65), url: 'udp://invalid' }; }
  if (variant === 2) { method = 'stream.stop'; params = valid ? { id: `id-${value}` } : { id: value & 1 ? 42 : 'x'.repeat(81) }; }
  if (variant === 3) { method = 'file.export'; params = valid ? { format: 'wav', bitDepth: [16, 24, 32][value % 3], outputLayout: ['mono', 'stereo', '5.1', '7.1'][value % 4], name: '../take-' + value } : { format: 'wav', bitDepth: 17 + value % 6 }; }
  if (variant === 4) { method = 'file.input.remove'; params = valid ? { input: `input-${value}` } : { input: value & 1 ? '' : null }; }
  if (variant === 5) { method = 'macro.run'; params = valid ? { text: `let value=${value};`, variables: { input: 'alias' } } : { text: value & 1 ? false : ['text'] }; }
  if (variant === 6) { method = 'macro.batch'; params = valid ? { text: 'let value=1;', inputIds: ['a', 'b'], continueOnError: !!(value & 1) } : { text: 'let value=1;', inputIds: value & 1 ? [] : Array(129).fill('a') }; }
  if (variant === 7) { method = 'macro.status'; params = valid ? {} : { execute: 'unexpected' }; }
  counts.schema++; counts[valid ? 'schemaValid' : 'schemaInvalid']++;
  await exercise('schema', index, { method, params, valid }, () => valid ? validateCommandParams(params, descriptors.get(method)) : assert.throws(() => validateCommandParams(params, descriptors.get(method)), { name: 'CommandValidationError' }));
}
phaseTimes.schemaMs = Math.round(performance.now() - schemaStarted);

const pcmStarted = performance.now(), layoutCounts = { mono: 1, stereo: 2, '5.1': 6, '7.1': 8 };
for (const [layout, channelCount] of Object.entries(layoutCounts)) for (const profile of ['f32le', 's16le']) {
  const { streams, socket } = streamFixture(), expectedAudio = []; let sequence = 0, frame = 0, receivedFrames = 0, receivedPackets = 0;
  try {
    const session = await streams.start({ ...rawStart, inputLayout: layout, profile });
    for (let index = 0; index < 96; index++) {
      const variant = index % 12, value = random(), frames = 1 + value % 64, valid = variant < 4;
      let bytes = Buffer.alloc(frames * channelCount * 4), packet = { sequence, startFrame: frame, frames, droppedFrames: 0 };
      for (let i = 0; i < frames * channelCount; i++) bytes.writeFloatLE(((i + value % 101) % 67 - 33) / 40, i * 4);
      if (variant === 1) packet.sequence += 1 + value % 3;
      if (variant === 2) { packet.startFrame += 1 + value % 17; packet.droppedFrames = packet.startFrame - frame; }
      if (variant === 4) bytes = bytes.subarray(0, bytes.length - 1);
      if (variant === 5) packet.frames = 0;
      if (variant === 6) packet.sequence = -1;
      if (variant === 7) packet.startFrame = Number.MAX_SAFE_INTEGER;
      if (variant === 8) bytes.writeFloatLE(NaN, 0);
      if (variant === 9) bytes.writeFloatLE(Infinity, 0);
      if (variant === 10) bytes.writeFloatLE(1000001, 0);
      if (variant === 11) packet.droppedFrames = 192000 * 60 + 1;
      counts.pcm++; counts[valid ? 'pcmValid' : 'pcmInvalid']++;
      await exercise('pcm', `${layout}/${profile}/${index}`, { layout, profile, variant, packet, pcmSha256: createHash('sha256').update(bytes).digest('hex') }, () => {
        const before = streams.status();
        if (!valid) { assert.throws(() => streams.feed(session.id, bytes, packet)); assert.deepEqual(streams.status(), before, 'Rejected PCM must leave sequence and counters unchanged'); return; }
        const result = streams.feed(session.id, bytes, packet); assert.equal(result.accepted, true);
        receivedFrames += frames; receivedPackets++; sequence = packet.sequence + 1; frame = packet.startFrame + frames;
        assert.equal(result.receivedFrames, receivedFrames); assert.equal(result.receivedPackets, receivedPackets); assert.equal(result.udpDroppedPackets, 0);
        if (profile === 'f32le') expectedAudio.push(Buffer.from(bytes));
        else {
          const output = Buffer.alloc(frames * channelCount * 2);
          for (let i = 0; i < frames * channelCount; i++) { const sample = Math.max(-1, Math.min(1, bytes.readFloatLE(i * 4))); output.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), i * 2); }
          expectedAudio.push(output);
        }
      });
    }
    counts.pcmOutputComparisons++;
    await exercise('pcm-final', `${layout}/${profile}`, { layout, profile }, async () => { const stopped = await streams.stop(); assert.equal(stopped.error, null); assert.ok(socket.closed); assert.deepEqual(Buffer.concat(socket.bytes), Buffer.concat(expectedAudio)); });
  } finally { await streams.dispose(); }
}
phaseTimes.pcmMs = Math.round(performance.now() - pcmStarted);

const lifecycleStarted = performance.now();
for (let index = 0; index < 128; index++) {
  const variant = index % 8, exitCode = 2 + random() % 30; counts.lifecycle++;
  await exercise('lifecycle', index, { variant, exitCode }, async () => {
    if ([0, 1, 5, 6].includes(variant)) {
      const gate = deferred(), fixture = streamFixture({ getCapabilities: () => gate.promise }), { streams, socket } = fixture;
      let workbench, first; const controller = new AbortController();
      try {
        if (variant === 1) { workbench = new NodeWorkbench({ streams }); first = workbench.execute('stream.start', rawStart, { signal: controller.signal }); controller.abort(); }
        else first = streams.start(rawStart);
        const result = first.then(value => ({ value }), error => ({ error }));
        let stopped;
        if (variant === 0) stopped = streams.stop();
        if (variant === 5) stopped = streams.dispose();
        if (variant === 6) await assert.rejects(streams.start(rawStart), { code: 'STREAM_BUSY' });
        gate.resolve(caps); const outcome = await result; if (stopped) await stopped;
        if (variant === 6) { assert.equal(outcome.value?.active, true); await streams.stop(); assert.ok(socket.closed); }
        else { assert.equal(streams.status().active, false, 'Canceled startup became active'); assert.ok(outcome.error || outcome.value?.active === false); }
      } finally { gate.resolve(caps); controller.abort(); if (first) await Promise.allSettled([first]); if (workbench) await workbench.dispose(); else await streams.dispose(); }
    } else if (variant === 2) {
      const gate = deferred(); let requested = false, subscriptions = 0;
      class Input extends EventTarget { getState() { return { input: { active: true, sampleRate: 48000, layout: 'mono' } }; } subscribeInputPCM() { subscriptions++; return () => subscriptions--; } }
      const bridge = new CompanionBridge({ live: new Input(), fetchImpl: async (url, options) => {
        if (url.endsWith('/v1/capabilities')) return Response.json({ streaming: { destinations: [{ id: 'test' }], profiles: [{ id: 'f32le' }] } });
        if (JSON.parse(options.body).method === 'stream.start') { requested = true; await gate.promise; return Response.json({ result: { id: 'late', active: true, inputSampleRate: 48000, inputLayout: 'mono' } }); }
        return Response.json({ result: { id: 'late', active: false } });
      } });
      let first;
      try { await bridge.connect({ token: 'a'.repeat(32) }); first = bridge.start({ destination: 'test', profile: 'f32le' }).catch(error => error); await until(() => requested); await bridge.disconnect(); gate.resolve(); await first; assert.equal(bridge.getState().stream.active, false); assert.equal(subscriptions, 0); }
      finally { gate.resolve(); await first; await bridge.dispose(); }
    } else if (variant === 3) {
      const { streams } = streamFixture({ getCapabilities: async () => ({ nativeFFmpeg: true, formats: ['opus'] }), spawnEncoder: () => encoder(exitCode) });
      try { await streams.start({ ...rawStart, profile: 'opus' }); const state = await streams.stop(); assert.ok(state.error, 'Nonzero flush exit must be reported'); }
      finally { await streams.dispose(); }
    } else if (variant === 4) {
      const { streams, socket } = streamFixture();
      try { const state = await streams.start(rawStart); streams.feed(state.id, Buffer.alloc(32), { sequence: 0, startFrame: 0, frames: 8 }); await streams.stop(); assert.equal(streams.status().active, false); assert.equal(socket.closed, true); assert.equal(Buffer.concat(socket.bytes).length, 32); }
      finally { await streams.dispose(); }
    } else {
      const socket = new Socket({ hold: true }), { streams } = streamFixture({ socket });
      try {
        const state = await streams.start(rawStart), bytes = Buffer.alloc(1316 * 140);
        streams.feed(state.id, bytes, { sequence: 0, startFrame: 0, frames: bytes.length / 4 });
        streams.feed(state.id, Buffer.alloc(1316), { sequence: 1, startFrame: bytes.length / 4, frames: 329 });
        // The implementation has 128 waiting packets plus at most one active send.
        assert.ok(streams.status().udpQueuePackets <= 129); assert.ok(streams.status().udpDroppedPackets > 0);
        socket.release(); await streams.stop(); assert.equal(socket.closed, true); assert.equal(streams.status().udpQueuePackets, 0);
      } finally { socket.release(); await streams.dispose(); }
    }
  });
}
phaseTimes.lifecycleMs = Math.round(performance.now() - lifecycleStarted);

const httpStarted = performance.now(), api = await startApiServer({ port: 0, allowedOrigin: 'https://djshellshoxxx.github.io', maxJsonBytes: 4096 });
try {
  for (let index = 0; index < 128; index++) {
    const variant = index % 8, value = random(); counts.http++;
    await exercise('http', index, { variant, value }, async () => {
      let method = 'GET', path = '/v1/state', headers = { Authorization: 'Bearer ' + api.token }, body, status;
      if (variant === 0) { headers.Authorization = 'Bearer ' + 'x'.repeat(24 + value % 16); status = 401; }
      if (variant === 1) { headers.Origin = `https://untrusted-${value}.example`; status = 403; }
      if (variant === 2) { headers.Host = `invalid-${value}.example`; status = 403; }
      if (variant >= 3) { method = 'POST'; path = '/v1/execute'; headers['Content-Type'] = 'application/json'; }
      if (variant === 3) { body = '{"method":"track.add","params":{"name":"x"}}'.slice(0, 1 + value % 35); status = 400; }
      if (variant === 4) { body = JSON.stringify({ method: 'track.add', params: { name: value } }); status = 400; }
      if (variant === 5) { body = JSON.stringify({ method: 'track.add', params: [null, false, 0, [], 'bad'][value % 5] }); status = 400; }
      if (variant === 6) { body = JSON.stringify({ method: 'track.add', params: { name: 'x'.repeat(4100) } }); status = 413; }
      if (variant === 7) { body = JSON.stringify({ method: 'project.state', params: {} }); status = 200; }
      const response = await http(api.url + path, { method, headers, body }); assert.equal(response.status, status, response.body);
      assert.equal(api.editor.getState().tracks.length, 0); await until(() => api.diagnostics().jobs === 0); assert.equal(api.diagnostics().bytes, 0);
    });
  }
} finally { await api.workbench.dispose(); api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
phaseTimes.httpMs = Math.round(performance.now() - httpStarted);
const report = { seed: `0x${SEED.toString(16)}`, node: process.version, corpusSha256: hash.digest('hex'), sourceFilesSha256, counts, elapsedMs: Math.round(performance.now() - started), phaseTimes, networkScope: 'Synthetic UDP sockets/encoders and authenticated 127.0.0.1 HTTP only; no external datagrams or native encoder spawned.', failures };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (counts.failed) process.exitCode = 1;
