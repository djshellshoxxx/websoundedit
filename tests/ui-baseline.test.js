import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the published function with a delayed permission result. No browser
// or physical microphone is used, and the production module is left unchanged.
test('recorder teardown cancels a pending permission request and releases its late stream', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('async function record()'), source.indexOf('function register('));
  assert.ok(functions.includes('function stopRecordingStream()'));
  let resolvePermission, started = 0, stopped = 0;
  const track = { stop() { stopped++; } };
  const stream = { getTracks: () => [track] };
  class FakeRecorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; started++; }
    stop() { this.state = 'inactive'; }
  }
  const button = { classList: { add() {}, remove() {} }, setAttribute() {} };
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolvePermission = resolve; }) } },
    window: { MediaRecorder: FakeRecorder }, MediaRecorder: FakeRecorder,
    recorder: null, recordStream: null, recordChunks: [], recordStarted: 0, recordTimer: null,
    cursor: 0, stopPlayback() {}, status() {}, $: () => button,
    performance: { now: () => 0 }, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(functions, context);
  const pending = context.record();
  context.stopRecordingStream();
  resolvePermission(stream);
  await pending;
  assert.deepEqual({ started, stopped }, { started: 0, stopped: 1 });
});
