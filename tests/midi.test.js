import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMidiMessage, midiValue, normalizeMidiMappings, parseMidiFile, encodeMidiFile,
  renderMidiSequence, MidiController, MidiSampler,
} from '../src/midi.js';

function vlq(number) {
  const bytes = [number & 127];
  while ((number = Math.floor(number / 128))) bytes.unshift((number & 127) | 128);
  return bytes;
}
function midiFixture(tracks, { format = tracks.length === 1 ? 0 : 1, ppq = 480 } = {}) {
  const bytes = new Uint8Array(14 + tracks.reduce((size, track) => size + track.length + 8, 0));
  const view = new DataView(bytes.buffer);
  bytes.set([77, 84, 104, 100, 0, 0, 0, 6]);
  view.setUint16(8, format); view.setUint16(10, tracks.length); view.setUint16(12, ppq);
  let offset = 14;
  for (const track of tracks) { bytes.set([77, 84, 114, 107], offset); view.setUint32(offset + 4, track.length); bytes.set(track, offset + 8); offset += 8 + track.length; }
  return bytes;
}
const end = [0, 0xff, 0x2f, 0];
const sequence = { version: 1, notes: [{ note: 60, velocity: 105, channel: 2, start: 0, duration: .5 }, { note: 64, velocity: 78, channel: 2, start: .5, duration: 1 }] };

test('MIDI messages preserve channel and velocity and normalize zero-velocity note-off', () => {
  assert.deepEqual(parseMidiMessage(Uint8Array.of(0x92, 60, 100)), { type: 'noteon', channel: 2, note: 60, velocity: 100 });
  assert.deepEqual(parseMidiMessage([0x92, 60, 0]), { type: 'noteoff', channel: 2, note: 60, velocity: 0 });
  assert.deepEqual(parseMidiMessage([0x81, 64, 32]), { type: 'noteoff', channel: 1, note: 64, velocity: 32 });
  assert.deepEqual(parseMidiMessage([0xbf, 74, 90]), { type: 'cc', channel: 15, controller: 74, value: 90 });
  for (const [status, type] of [[0xfa, 'start'], [0xfb, 'continue'], [0xfc, 'stop'], [0xf8, 'clock']]) assert.deepEqual(parseMidiMessage([status]), { type });
  for (const bytes of [[], [0x90], [0x90, 60], [0x90, 128, 2], [0x90, -1, 2], [0x90, NaN, 2], [0x190, 60, 2], [0x90, 60, 2.5], [0xf0, 1, 2]]) assert.equal(parseMidiMessage(bytes), null);
});

test('CC mapping is bounded and honors logarithmic and stepped target parameters', () => {
  const frequency = { min: 20, max: 20000, scale: 'log', step: 1 };
  assert.equal(midiValue(0, frequency), 20);
  assert.equal(midiValue(127, frequency), 20000);
  assert.ok(midiValue(64, frequency) > 630 && midiValue(64, frequency) < 660);
  assert.equal(midiValue(64, { min: 1, max: 32, step: 1 }), 17);
  for (const value of [-1, 128, 2.5, NaN]) assert.throws(() => midiValue(value, frequency));
  const mapping = [{ channel: 2, controller: 74, target: 'stage-1:frequency' }];
  assert.deepEqual(normalizeMidiMappings(mapping), mapping);
  assert.throws(() => normalizeMidiMappings([...mapping, ...mapping]));
  assert.throws(() => normalizeMidiMappings([{ channel: 16, controller: 2, target: 'xy:x' }]));
});

test('SMF format 1 resolves tempo changes into exact note timing and exports it faithfully', () => {
  const tempos = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20, ...vlq(480), 0xff, 0x51, 3, 15, 0x42, 0x40, ...end];
  const notes = [0, 0x92, 60, 105, ...vlq(480), 0x82, 60, 0, 0, 0x92, 64, 78, ...vlq(480), 0x82, 64, 0, ...end];
  const parsed = parseMidiFile(midiFixture([tempos, notes]));
  assert.equal(parsed.tempo, 120);
  assert.equal(parsed.duration, 1.5);
  assert.deepEqual(parsed.notes.map(({ track, ...note }) => note), sequence.notes);
  const roundTrip = parseMidiFile(encodeMidiFile(parsed));
  assert.deepEqual(roundTrip.notes.map(({ track, ...note }) => note), sequence.notes);
});

test('SMF running status, byte slices and corruption handling keep imports bounded', () => {
  const track = [0, 0x90, 60, 100, ...vlq(120), 64, 80, ...vlq(120), 60, 0, ...vlq(120), 64, 0, ...end];
  const bytes = midiFixture([track]);
  const wrapped = new Uint8Array(bytes.length + 12); wrapped.set(bytes, 5);
  const parsed = parseMidiFile(wrapped.subarray(5, 5 + bytes.length));
  assert.deepEqual(parsed.notes.map(n => [n.note, n.start, n.duration]), [[60, 0, .25], [64, .125, .25]]);
  assert.throws(() => parseMidiFile(bytes.subarray(0, bytes.length - 1)), /Truncated/);
  assert.throws(() => parseMidiFile(midiFixture([[0, 60, 100, ...end]])), /running status/);
  assert.throws(() => parseMidiFile(midiFixture([[0, 0x90, 60, 100, ...end]])), /unclosed/);
  assert.throws(() => parseMidiFile(midiFixture([track], { ppq: 0xe728 })), /SMPTE/);
  assert.throws(() => parseMidiFile(midiFixture([track], { format: 2 })), /format 0 or 1/);
  assert.throws(() => parseMidiFile(midiFixture([[0, 0xff, 0x51, 3, 0, 0, 0, ...end]])), /positive/);
});

test('MIDI rendering creates a finite audible signal, preserves timing and rejects oversized work', () => {
  const audio = renderMidiSequence(sequence, 16000);
  assert.equal(audio.sampleRate, 16000);
  assert.equal(audio.channels.length, 1);
  assert.equal(audio.channels[0].length, 24000);
  assert.ok(audio.channels[0].every(Number.isFinite));
  assert.ok(audio.channels[0].some(value => Math.abs(value) > .1));
  assert.equal(audio.channels[0][0], 0);
  assert.throws(() => renderMidiSequence({ version: 1, notes: [{ ...sequence.notes[0], duration: 601 }] }), /timing/);
  assert.throws(() => renderMidiSequence(sequence, 7999), /sample rate/);
  assert.throws(() => encodeMidiFile({ version: 1, notes: [{ ...sequence.notes[0], velocity: 0 }] }), /velocity/);
});

test('MIDI device permission is explicit; input routing, reconnect and disconnect release listeners', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  let requests = 0, stateChanges = 0;
  const messages = [], sent = [];
  const firstInput = { id: 'first', name: 'First keyboard', state: 'connected', close() { this.closed = true; } };
  const secondInput = { id: 'second', name: 'Second keyboard', state: 'connected', close() { this.closed = true; } };
  const output = { id: 'out', name: 'Test output', state: 'connected', send(bytes) { sent.push(bytes); } };
  const firstAccess = { inputs: new Map([[firstInput.id, firstInput]]), outputs: new Map([[output.id, output]]) };
  const secondAccess = { inputs: new Map([[secondInput.id, secondInput]]), outputs: new Map([[output.id, output]]) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { requestMIDIAccess: async options => { assert.deepEqual(options, { sysex: false }); return ++requests === 1 ? firstAccess : secondAccess; } } });
  const controller = new MidiController({ onMessage: message => messages.push(message), onState: () => stateChanges++ });
  assert.equal(requests, 0);
  assert.equal(controller.ports().connected, false);
  await controller.connect();
  firstInput.onmidimessage({ data: [0x90, 60, 70] });
  assert.equal(messages.length, 1);
  controller.selectOutput('out');
  controller.send([0xfa]);
  assert.deepEqual(sent.at(-1), [0xfa]);
  await controller.connect();
  assert.equal(firstAccess.onstatechange, null);
  assert.equal(firstInput.onmidimessage, null);
  secondInput.onmidimessage({ data: [0xb1, 74, 20] });
  assert.equal(messages.at(-1).type, 'cc');
  secondInput.state = 'disconnected'; secondAccess.onstatechange();
  assert.equal(secondInput.onmidimessage, null);
  assert.deepEqual(controller.ports().inputs, []);
  secondInput.state = 'connected'; secondAccess.onstatechange();
  controller.disconnect();
  assert.equal(secondInput.onmidimessage, null);
  assert.equal(secondAccess.onstatechange, null);
  assert.equal(controller.ports().connected, false);
  assert.ok(stateChanges >= 4);
  assert.ok(sent.some(bytes => bytes[0] === 0xb0 && bytes[1] === 123));
  assert.throws(() => controller.send([0xfa]), /Select a connected/);
});

test('MIDI reports unavailable or denied permission without inventing connected ports', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const controller = new MidiController();
  await assert.rejects(controller.connect(), /unavailable/);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { requestMIDIAccess: async () => { throw new Error('Denied'); } } });
  await assert.rejects(controller.connect(), /not granted/);
  assert.equal(controller.ports().connected, false);
});

test('disconnect while a MIDI permission request is pending cannot reconnect late', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  let resolveAccess;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { requestMIDIAccess: () => new Promise(resolve => { resolveAccess = resolve; }) } });
  const controller = new MidiController();
  const connecting = controller.connect();
  controller.disconnect();
  const input = { id: 'late', state: 'connected' };
  resolveAccess({ inputs: new Map([['late', input]]), outputs: new Map() });
  await connecting;
  assert.equal(controller.ports().connected, false);
  assert.equal(input.onmidimessage, undefined);
});

test('note-off during suspended audio resume prevents a stale or stuck sample voice', async t => {
  const oldAudioContext = globalThis.AudioContext;
  t.after(() => oldAudioContext === undefined ? delete globalThis.AudioContext : globalThis.AudioContext = oldAudioContext);
  const resumes = [], sources = [];
  class FakeContext {
    currentTime = 0;
    destination = {};
    resume() { return new Promise(resolve => resumes.push(resolve)); }
    createBuffer() { return { copyToChannel() {} }; }
    createBufferSource() { const source = { playbackRate: {}, connect() { return { connect() {} }; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
    createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  globalThis.AudioContext = FakeContext;
  const sampler = new MidiSampler(() => ({ sampleRate: 8000, channels: [new Float32Array(100)] }));
  const stale = sampler.noteOn(60, 100, 2);
  sampler.noteOff(60, 2);
  resumes.shift()();
  await stale;
  assert.equal(sources.length, 0);
  const active = sampler.noteOn(61, 100, 2);
  resumes.shift()(); await active;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  sampler.stop();
  assert.equal(sources[0].stopped, true);
  assert.equal(sampler.voices.size, 0);
  assert.equal(sampler.held.size, 0);
  await sampler.close();
});
