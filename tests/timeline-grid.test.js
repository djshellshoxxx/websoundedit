import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual waveform and global-keyboard listeners without an audio device.
function fixture({ beatsPerBar = 3, bpm = 120, beatOffset = 0, grid = 4, snap = true } = {}) {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const clip = { id: 'clip', start: 0, duration: 20 }, pointer = {}, keyboard = {}, commands = [];
  const controls = { '#snap': { checked: snap }, '#snap-grid': { value: String(grid) } };
  const state = { sampleRate: 8000, bpm, beatsPerBar, beatOffset, duration: 20,
    tracks: [{ id: 'track', clips: [clip] }], selection: null };
  const canvas = { dataset: { trackId: 'track' }, clientWidth: 800,
    getBoundingClientRect: () => ({ left: 0, width: 800 }),
    addEventListener: (name, handler) => { pointer[name] = handler; }, focus() {}, setPointerCapture() {} };
  const context = vm.createContext({ state, canvas, view: { start: 0, duration: 20 }, cursor: 0, selectionDrag: null,
    document: { addEventListener: (name, handler) => { keyboard[name] = handler; } }, routes: null,
    $: selector => controls[selector] ||= { open: false },
    clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
    selectedClip: () => clip, selectedChannelScope: () => 'all',
    stopPlayback() {}, discardPreview() {}, updateClock() {}, drawWaveforms() {}, drawPlayhead() {}, renderSession() {},
    safe: operation => operation(), core: (method, params) => {
      commands.push({ method, params });
      if (method === 'selection.set') state.selection = params;
    },
  });
  const timeline = source.slice(source.indexOf('function quantize('), source.indexOf('\nfunction updateTabs'));
  const keys = source.slice(source.indexOf('function eventKey('), source.indexOf("\ndocument.addEventListener('click'"));
  vm.runInContext(timeline + '\nattachTimeline(canvas);\n' + keys, context);
  return { context, state, controls, commands,
    point(name, seconds) { pointer[name]({ pointerId: 1, button: 0, clientX: seconds * 40, preventDefault() {} }); },
    key(key, shiftKey = false) { keyboard.keydown({ key, shiftKey, target: { tagName: 'DIV', closest: () => null }, preventDefault() {} }); },
  };
}

test('one-bar pointer snapping follows the current meter, tempo and grid offset', () => {
  for (const [beatsPerBar, bpm, beatOffset, input, expected] of [
    [3, 120, 0, 1.6, 1.5],
    [4, 120, 0, 2.1, 2],
    [5, 120, 0, 2.7, 2.5],
    [7, 84, .125, 5.2, 5.125],
  ]) {
    const f = fixture({ beatsPerBar, bpm, beatOffset });
    f.point('pointerdown', input);
    assert.equal(f.context.cursor, expected, `${beatsPerBar} beats per bar at ${bpm} BPM`);
    assert.equal(f.controls['#snap-grid'].value, '4', 'keep the portable grid=4 representation');
  }
});

test('pointer selection endpoints use the same meter-aware bar grid', () => {
  const f = fixture();
  f.point('pointerdown', 1.6);
  f.point('pointermove', 4.4);
  assert.equal(f.context.selectionDrag.selection.start, 1.5);
  assert.equal(f.context.selectionDrag.selection.end, 4.5);
});

test('one-bar arrow steps follow meter changes without changing saved grid=4', () => {
  const f = fixture();
  f.key('ArrowRight'); assert.equal(f.context.cursor, 1.5);
  f.key('ArrowLeft'); assert.equal(f.context.cursor, 0);
  f.state.beatsPerBar = 5;
  f.key('ArrowRight'); assert.equal(f.context.cursor, 2.5);
  f.state.beatsPerBar = 4;
  f.key('ArrowRight'); assert.equal(f.context.cursor, 4.5);
  assert.equal(f.controls['#snap-grid'].value, '4');
});

test('shift-arrow selection changes use the current bar duration', () => {
  const f = fixture();
  f.context.cursor = 3;
  f.state.selection = { clipId: 'clip', start: 1.5, end: 3, channels: 'all' };
  f.key('ArrowRight', true);
  assert.equal(f.state.selection.start, 1.5);
  assert.equal(f.state.selection.end, 4.5);
  assert.equal(f.commands[0].method, 'selection.set');
  f.key('ArrowLeft', true); assert.equal(f.state.selection.end, 3);
});

test('beat subdivisions remain beat-based in non-four-beat meters', () => {
  for (const [grid, step] of [[1, .5], [.5, .25], [.25, .125], [.125, .0625]]) {
    const f = fixture({ beatsPerBar: 7, grid });
    f.key('ArrowRight'); assert.equal(f.context.cursor, step);
    f.point('pointerdown', step * 1.1); assert.equal(f.context.cursor, step);
  }
});

test('turning snap off preserves continuous pointer placement and fine arrow movement', () => {
  const f = fixture({ snap: false });
  f.point('pointerdown', 1.63); assert.ok(Math.abs(f.context.cursor - 1.63) < 1e-12);
  f.context.cursor = 0;
  f.key('ArrowRight'); assert.equal(f.context.cursor, .1);
});
