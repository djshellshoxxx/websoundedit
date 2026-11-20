import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryScheduler } from '../src/recovery.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const timers = new Map(), states = [];
  let serial = 0, stored = { name: 'Earlier recovery' }, snapshots = 0;
  const writer = new RecoveryScheduler({
    snapshot: async () => ({ name: `Snapshot ${++snapshots}` }),
    save: async project => { stored = project; },
    clear: async () => { stored = null; },
    onState: (state, error) => states.push({ state, error }),
    setTimer: callback => { const id = ++serial; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
    ...overrides,
  });
  return { writer, timers, states, stored: () => stored, snapshots: () => snapshots,
    fire() { assert.equal(timers.size, 1); const [id, callback] = [...timers][0]; timers.delete(id); return callback(); } };
}

test('clear invalidates a snapshot still being serialized and future edits can save again', async () => {
  const pending = deferred(), state = fixture({ snapshot: () => pending.promise });
  state.writer.schedule(); const saving = state.fire();
  assert.deepEqual(await state.writer.clear(), { cleared: true });
  assert.equal(state.stored(), null);
  pending.resolve({ name: 'The recovery copy the user removed' }); await saving;
  assert.equal(state.stored(), null);
  assert.deepEqual(state.states.map(event => event.state), ['pending', 'cleared']);
  state.writer.snapshot = async () => ({ name: 'A later edit' });
  state.writer.schedule(); await state.fire();
  assert.equal(state.stored().name, 'A later edit');
  assert.equal(state.states.at(-1).state, 'saved');
});

test('clear waits behind an in-progress write and cannot be undone by that write', async () => {
  const entered = deferred(), release = deferred();
  let stored, clears = 0;
  const state = fixture({
    save: async project => { entered.resolve(); await release.promise; stored = project; },
    clear: async () => { clears++; stored = null; },
  });
  state.writer.schedule(); const saving = state.fire(); await entered.promise;
  const clearing = state.writer.clear();
  await Promise.resolve(); assert.equal(clears, 0);
  release.resolve(); await Promise.all([saving, clearing]);
  assert.equal(clears, 1); assert.equal(stored, null);
  assert.deepEqual(state.states.map(event => event.state), ['pending', 'cleared']);
});

test('repeated edits coalesce before serialization and clear cancels the pending timer', async () => {
  const state = fixture();
  for (let i = 0; i < 1000; i++) state.writer.schedule();
  assert.equal(state.timers.size, 1); assert.equal(state.snapshots(), 0);
  await state.fire(); assert.equal(state.snapshots(), 1);
  for (let i = 0; i < 1000; i++) state.writer.schedule();
  await state.writer.clear();
  assert.equal(state.timers.size, 0); assert.equal(state.snapshots(), 1); assert.equal(state.stored(), null);
});

test('superseded snapshots cannot overwrite a newer recovery copy or report stale success', async () => {
  const old = deferred(), current = deferred(); let calls = 0;
  const state = fixture({ snapshot: () => (++calls === 1 ? old.promise : current.promise) });
  state.writer.schedule(); const first = state.fire();
  state.writer.schedule(); const second = state.fire();
  current.resolve({ name: 'Current edit' }); await second;
  old.resolve({ name: 'Previous edit' }); await first;
  assert.equal(state.stored().name, 'Current edit');
  assert.equal(state.states.filter(event => event.state === 'saved').length, 1);
});

test('batch cancellation invalidates an in-flight snapshot and ignores its late error', async () => {
  const pending = deferred(), state = fixture({ snapshot: () => pending.promise });
  state.writer.schedule(); const saving = state.fire(); state.writer.cancel();
  pending.reject(new Error('Previous project was disposed')); await saving;
  assert.equal(state.stored().name, 'Earlier recovery');
  assert.deepEqual(state.states.map(event => event.state), ['pending']);
});

test('failed writes do not poison later clears or saves, and clear errors reach the caller', async () => {
  const state = fixture();
  state.writer.save = async () => { throw new Error('Synthetic quota exhaustion'); };
  state.writer.schedule(); await state.fire();
  assert.equal(state.states.at(-1).state, 'error');
  assert.match(state.states.at(-1).error.message, /quota/);
  await state.writer.clear(); assert.equal(state.stored(), null);
  state.writer.remove = async () => { throw new Error('Synthetic blocked storage'); };
  await assert.rejects(state.writer.clear(), /blocked storage/);
  let saved;
  state.writer.save = async project => { saved = project; };
  state.writer.schedule(); await state.fire();
  assert.equal(saved.name, 'Snapshot 2'); assert.equal(state.states.at(-1).state, 'saved');
});

test('saves queued behind an older write are discarded if a newer edit replaces them', async () => {
  const entered = deferred(), release = deferred(), saved = []; let writes = 0;
  const state = fixture({ save: async project => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    saved.push(project.name);
  } });
  state.writer.schedule(); const first = state.fire(); await entered.promise;
  state.writer.schedule(); const second = state.fire(); await Promise.resolve();
  state.writer.schedule(); const third = state.fire(); await Promise.resolve();
  release.resolve(); await Promise.all([first, second, third]);
  assert.deepEqual(saved, ['Snapshot 1', 'Snapshot 3']);
  assert.equal(state.states.filter(event => event.state === 'saved').length, 1);
});
