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
    recordSession: null, recordSessions: new Set(), state: { sampleRate: 8000 },
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

test('recording completion owns its stream and teardown cancels stale decoded takes', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('async function record()'), source.indexOf('function register('));
  const permissions = [], decodes = [], completions = [], imported = [], errors = [];
  class FakeRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['fixture']) });
      this.onstop?.();
    }
  }
  const button = { classList: { add() {}, remove() {} }, setAttribute() {} };
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => permissions.push(resolve)) } },
    window: { MediaRecorder: FakeRecorder }, MediaRecorder: FakeRecorder, Blob, File,
    recordSession: null, recordSessions: new Set(), state: { sampleRate: 8000 },
    cursor: 12, demo: false, stopPlayback() {}, status() {}, setBusy() {}, fitView() {}, renderSession() {}, $: () => button,
    performance: { now: () => 0 }, setInterval: () => 1, clearInterval() {},
    decodeAudioFile: () => new Promise(resolve => decodes.push(resolve)),
    core: async (method, params) => imported.push({ method, params }),
    safe: fn => { const result = fn().catch(error => errors.push(error)); completions.push(result); return result; },
  });
  vm.runInContext(functions, context);
  const firstTrack = { stopped: 0, stop() { this.stopped++; } }, secondTrack = { stopped: 0, stop() { this.stopped++; } };
  const first = context.record(); permissions.shift()({ getTracks: () => [firstTrack] }); await first;
  context.stopRecording();
  context.cursor = 24;
  const second = context.record(); permissions.shift()({ getTracks: () => [secondTrack] }); await second;
  decodes.shift()({ sampleRate: 8000, channels: [new Float32Array(80)] }); await completions[0];
  assert.equal(imported.length, 1);
  assert.equal(imported[0].params.start, 12);
  assert.equal(context.recordSession.recorder.state, 'recording');
  assert.deepEqual([firstTrack.stopped, secondTrack.stopped], [1, 0]);
  context.stopRecording();
  context.stopRecordingStream();
  decodes.shift()({ sampleRate: 8000, channels: [new Float32Array(80)] }); await completions[1];
  assert.equal(imported.length, 1);
  assert.equal(secondTrack.stopped, 1);
  assert.equal(context.recordSessions.size, 0);
  assert.equal(errors.length, 0);
});
