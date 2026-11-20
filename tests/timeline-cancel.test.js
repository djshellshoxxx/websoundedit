import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real UI listeners and their temporary clip geometry.
function fixture() {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function attachTimeline('), end = source.indexOf('\nfunction updateTabs', start);
  const handlers = {}, clip = { id: 'clip', start: 0, duration: 8 }, fields = {};
  const state = { sampleRate: 8000, tracks: [{ id: 'track', clips: [clip] }], selection: { clipId: 'clip', start: 1, end: 2 } };
  const canvas = { dataset: { trackId: 'track' }, clientWidth: 800, getBoundingClientRect: () => ({ left: 0, width: 800 }), addEventListener: (name, fn) => handlers[name] = fn, setPointerCapture() {}, focus() {} };
  let renders = 0;
  const context = vm.createContext({ state, canvas, view: { start: 0, duration: 8 }, cursor: .5, selectionDrag: null,
    clamp: (n, a, b) => Math.max(a, Math.min(b, n)), quantize: n => n,
    stopPlayback() {}, discardPreview() {}, updateClock() {}, drawWaveforms() {},
    selectedChannelScope: () => 'all', $: selector => fields[selector] ||= {},
    renderSession: () => renders++, safe: () => assert.fail('A cancelled drag must not commit'),
  });
  vm.runInContext(source.slice(start, end) + '\nattachTimeline(canvas);', context);
  const send = (name, values = {}) => handlers[name]?.({ pointerId: 1, button: 0, clientX: 100, preventDefault() {}, ...values });
  return { clip, state, context, send, renders: () => renders };
}

for (const reason of ['pointercancel', 'lostpointercapture']) {
  test(`${reason} rolls back an unfinished clip move and restores the cursor`, () => {
    const f = fixture();
    f.send('pointerdown', { altKey: true });
    f.send('pointermove', { clientX: 300 });
    assert.equal(f.clip.start, 2);
    f.send(reason);
    assert.equal(f.clip.start, 0);
    assert.equal(f.context.cursor, .5);
    assert.equal(f.context.selectionDrag, null);
    assert.equal(f.renders(), 1);
    f.send('pointerup');
  });
}

test('a second touch cannot take over or finish the active waveform gesture', () => {
  const f = fixture();
  f.send('pointerdown', { altKey: true });
  f.send('pointerdown', { pointerId: 2, clientX: 200 });
  f.send('pointermove', { pointerId: 2, clientX: 400 });
  assert.equal(f.clip.start, 0);
  f.send('pointerup', { pointerId: 2 });
  f.send('pointermove', { clientX: 300 });
  assert.equal(f.clip.start, 2);
  f.send('pointercancel');
  assert.equal(f.clip.start, 0);
});
