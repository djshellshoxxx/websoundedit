/** Independent bounded companion regression cases. No external UDP destination. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request } from 'node:http';
import { UdpStreams } from '../scripts/udp-streams.mjs';
import { NodeWorkbench } from '../scripts/node-runtime.mjs';
import { startApiServer } from '../scripts/server.mjs';
import { CompanionBridge } from '../src/companion.js';
import { encodeWav } from '../src/wav.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); } assert.fail('Bounded test condition did not become ready.'); }
const destination = { id: 'test', label: 'No-network synthetic socket', address: '127.0.0.1', port: 5004 };
const rawStart = { destination: 'test', profile: 'f32le', inputSampleRate: 48000, inputLayout: 'mono' };
const capabilities = { nativeFFmpeg: false, formats: ['wav'] };
class SyntheticSocket extends EventEmitter {
  constructor(connectGate = null) { super(); this.connectGate = connectGate; this.connected = false; this.closed = false; }
  connect(_port, _address, callback) { this.connecting = true; const finish = () => { this.connected = true; callback(); }; if (this.connectGate) this.connectGate.promise.then(finish); else queueMicrotask(finish); }
  send(_bytes, callback) { queueMicrotask(() => callback(null)); }
  close() { this.closed = true; }
}
async function withApi(callback, options = {}) {
  const api = await startApiServer({ port: 0, ...options });
  try { return await callback(api); }
  finally { await api.workbench.dispose(); api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
}
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject); });
    req.once('error', reject); req.end();
  });
}

test('audit: stopping during capability discovery invalidates the pending UDP start', async () => {
  const gate = deferred(), sockets = [], streams = new UdpStreams({ destinations: [destination], getCapabilities: () => gate.promise, socketFactory: () => { const socket = new SyntheticSocket(); sockets.push(socket); return socket; } });
  try {
    const pending = streams.start(rawStart), stopped = streams.stop();
    gate.resolve(capabilities);
    const result = await Promise.allSettled([pending, stopped]);
    assert.equal(streams.status().active, false, 'Stop must not permit a late active session');
    assert.ok(result[0].status === 'rejected' || result[0].value.active === false, 'Canceled start must not report active');
    assert.ok(sockets.every(socket => socket.closed), 'Any startup socket must be released');
  } finally { gate.resolve(capabilities); await streams.dispose(); }
});

test('audit: nonzero encoder exit during flush is visible in the stopped result', async () => {
  let child;
  const streams = new UdpStreams({ destinations: [destination], getCapabilities: async () => ({ nativeFFmpeg: true, formats: ['opus'] }), socketFactory: () => new SyntheticSocket(), spawnEncoder: () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { child.emit('close', null, signal); return true; };
    child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', 17, null)));
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  try {
    await streams.start({ ...rawStart, profile: 'opus' });
    const stopped = await streams.stop();
    assert.equal(stopped.active, false);
    assert.match(stopped.error || '', /17|encoder|flush/i, 'A failed final encoder flush must not appear successful');
  } finally { await streams.dispose(); }
});

test('audit: a slow successful encoder flush preserves its tail instead of being killed after two seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let kills = 0;
  const streams = new UdpStreams({ destinations: [destination], getCapabilities: async () => ({ nativeFFmpeg: true, formats: ['opus'] }), socketFactory: () => { const socket = new SyntheticSocket(); socket.send = (_bytes, callback) => callback(null); return socket; }, spawnEncoder: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { kills++; child.emit('close', null, signal); return true; };
    child.stdin.once('finish', () => setTimeout(() => { child.stdout.emit('data', Buffer.from('tail')); child.emit('close', 0, null); }, 2500));
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  try {
    await streams.start({ ...rawStart, profile: 'opus' });
    const stopping = streams.stop();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(2500);
    const stopped = await stopping;
    assert.equal(kills, 0); assert.equal(stopped.error, null);
    assert.equal(stopped.sentBytes, 4); assert.equal(stopped.active, false);
  } finally { await streams.dispose(); }
});

test('audit: an unresponsive encoder still has a finite advertised flush deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let kills = 0, socket;
  const streams = new UdpStreams({ destinations: [destination], getCapabilities: async () => ({ nativeFFmpeg: true, formats: ['opus'] }), socketFactory: () => (socket = new SyntheticSocket()), spawnEncoder: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { kills++; child.emit('close', null, signal); return true; };
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  try {
    await streams.start({ ...rawStart, profile: 'opus' });
    const stopping = streams.stop();
    const seconds = (await streams.capabilities()).limits.encoderFlushSeconds;
    assert.equal(seconds, 10);
    t.mock.timers.tick(seconds * 1000 - 1); assert.equal(kills, 0);
    t.mock.timers.tick(1);
    const stopped = await stopping;
    assert.equal(kills, 1); assert.match(stopped.error || '', /SIGKILL|Encoder/);
    assert.equal(stopped.active, false); assert.equal(socket.closed, true);
  } finally {
    // Also release a failing baseline's synthetic encoder before ending the test.
    t.mock.timers.tick(10000); await streams.dispose();
  }
});

test('audit: an abandoned HTTP stream start releases its pending socket', async () => {
  const gate = deferred(), socket = new SyntheticSocket(gate), streams = new UdpStreams({ destinations: [destination], getCapabilities: async () => capabilities, socketFactory: () => socket });
  const workbench = new NodeWorkbench({ streams });
  await withApi(async api => {
    const controller = new AbortController();
    const pending = fetch(api.url + '/v1/execute', { method: 'POST', headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'stream.start', params: rawStart }), signal: controller.signal }).catch(error => error);
    try {
      await until(() => socket.connecting); controller.abort(); await pending; await pause(20);
      gate.resolve(); await until(() => api.diagnostics().jobs === 0);
      assert.equal(streams.status().active, false, 'The HTTP abort signal must reach stream startup');
      assert.equal(socket.closed, true);
    } finally { controller.abort(); gate.resolve(); await pending; }
  }, { workbench });
});

test('audit: a completed start response cannot resurrect a disconnected browser bridge', async () => {
  const gate = deferred(); let startRequested = false, subscriptions = 0;
  class Input extends EventTarget {
    getState() { return { input: { active: true, sampleRate: 48000, layout: 'mono' } }; }
    subscribeInputPCM(callback) { subscriptions++; this.callback = callback; return () => { subscriptions--; this.callback = null; }; }
  }
  const live = new Input(), bridge = new CompanionBridge({ live, fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/capabilities')) return Response.json({ streaming: { destinations: [{ id: 'test' }], profiles: [{ id: 'f32le' }] } });
    const body = options.body ? JSON.parse(options.body) : {};
    if (body.method === 'stream.start') { startRequested = true; await gate.promise; return Response.json({ result: { id: 'late', active: true, inputSampleRate: 48000, inputLayout: 'mono' } }); }
    return Response.json({ result: { id: 'late', active: false } });
  } });
  try {
    await bridge.connect({ token: 'a'.repeat(32) }); const pending = bridge.start({ destination: 'test', profile: 'f32le' }).catch(error => error);
    await until(() => startRequested); await bridge.disconnect(); gate.resolve(); await pending;
    assert.equal(bridge.getState().connected, false); assert.equal(bridge.getState().stream.active, false);
    assert.equal(subscriptions, 0, 'A stale completed response must not reacquire the input subscription');
  } finally { gate.resolve(); await bridge.dispose(); }
});

test('audit: rejected competing macro run leaves the active macro status running', async () => {
  const workbench = new NodeWorkbench(); let first;
  try {
    first = workbench.execute('macro.run', { text: 'wait({seconds:1});' }).catch(error => error);
    await until(() => workbench.macroState.type === 'start');
    await assert.rejects(workbench.execute('macro.run', { text: 'let value=1;' }), { code: 'MACRO_BUSY' });
    assert.equal((await workbench.execute('macro.status')).running, true, 'The first macro still owns the runner');
  } finally { await workbench.macro('macro.cancel', {}); await first; await workbench.dispose(); }
});

test('audit: HTTP exact Host, Origin and token checks precede state access', async () => {
  await withApi(async api => {
    const headers = { Authorization: 'Bearer ' + api.token }, goodOrigin = 'https://djshellshoxxx.github.io';
    for (const [extra, status] of [[{ Authorization: '' }, 401], [{ Authorization: 'Bearer ' + 'x'.repeat(32) }, 401], [{ Host: 'remote.example' }, 403], [{ Origin: 'https://untrusted.example' }, 403], [{ Origin: goodOrigin }, 200], [{}, 200]]) {
      // Fetch normalizes Host; raw node:http is needed to exercise the server's
      // actual Host boundary rather than the fetch implementation's header rules.
      assert.equal(await rawGet(api.url + '/v1/state', { ...headers, ...extra }), status, JSON.stringify(extra));
    }
    const preflight = await fetch(api.url + '/v1/execute', { method: 'OPTIONS', headers: { Origin: goodOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), goodOrigin);
  }, { allowedOrigin: 'https://djshellshoxxx.github.io' });
});

test('audit: oversized authenticated bodies release admission without mutating the editor', async () => {
  await withApi(async api => {
    const response = await fetch(api.url + '/v1/execute', { method: 'POST', headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'track.add', params: { name: 'x'.repeat(2048) } }) });
    assert.equal(response.status, 413); await response.arrayBuffer(); await until(() => api.diagnostics().jobs === 0);
    assert.equal(api.diagnostics().bytes, 0); assert.equal(api.editor.getState().tracks.length, 0);
  }, { maxJsonBytes: 1024 });
});

test('audit: isolated batch exports account for all outputs and preserve the parent project', async () => {
  const workbench = new NodeWorkbench();
  try {
    await workbench.execute('track.add', { name: 'Parent' }); const before = await workbench.editor.execute('project.save');
    const bytes = encodeWav({ sampleRate: 8000, channels: [Float32Array.of(.1, .2, -.1, -.2)] });
    const inputIds = [workbench.supply(bytes, { name: '../../take.wav' }).id, workbench.supply(bytes, { name: '../../take.wav' }).id];
    const result = await workbench.execute('macro.batch', { inputIds, text: 'file.export({format:"wav",name:input.stem});' });
    assert.equal(result.outputCount, 2); assert.equal(result.results.length, 2); assert.ok(result.results.every(item => item.success && item.outputs.length === 1));
    const names = result.results.map(item => item.outputs[0].name); assert.equal(new Set(names).size, 2); assert.ok(names.every(name => !/[\\/]/.test(name)));
    assert.equal(workbench.artifacts.size, 2); assert.equal(workbench.artifactBytes, [...workbench.artifacts.values()].reduce((sum, item) => sum + item.bytes.length, 0));
    assert.deepEqual(await workbench.editor.execute('project.save'), before);
  } finally { await workbench.dispose(); }
});
