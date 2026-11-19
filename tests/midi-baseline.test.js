import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidiFile, parseMidiFile, normalizeMidiMappings } from '../src/midi.js';
import { createRackEffect, normalizeRackSettings } from '../src/rack-config.js';

// Published 0.2 audit: keep this assertion active while the defect is repaired.
test('MIDI export preserves overlapping same-pitch notes on independent source tracks', () => {
  const notes = [
    { note: 60, velocity: 100, channel: 0, track: 0, start: 0, duration: 2 },
    { note: 60, velocity: 80, channel: 0, track: 1, start: 1, duration: .5 },
  ];
  const actual = parseMidiFile(encodeMidiFile({ version: 1, notes })).notes;
  const order = entries => [...entries].sort((a, b) => a.start - b.start || b.velocity - a.velocity);
  assert.deepEqual(order(actual), order(notes));
});

function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

test('seeded SMF structural mutations return bounded notes or controlled parse errors', t => {
  const seed = 0x20b37a11, rng = random(seed), integer = max => Math.floor(rng() * max);
  let accepted = 0, rejected = 0;
  for (let iteration = 0; iteration < 4096; iteration++) {
    const notes = Array.from({ length: 1 + integer(12) }, (_, index) => ({
      note: 48 + index, channel: integer(16), velocity: 1 + integer(127),
      start: integer(40) / 8, duration: (1 + integer(16)) / 8,
    }));
    let bytes = encodeMidiFile({ version: 1, notes });
    if (iteration % 4 === 1) bytes = bytes.subarray(0, integer(bytes.length));
    if (iteration % 4 === 2) {
      bytes = bytes.slice();
      for (let edit = 0; edit < 1 + integer(4); edit++) bytes[integer(bytes.length)] = integer(256);
    }
    if (iteration % 4 === 3) {
      bytes = bytes.slice();
      const view = new DataView(bytes.buffer);
      view.setUint32(iteration % 2 ? 18 : 4, integer(0x100000000));
    }
    try {
      const result = parseMidiFile(bytes);
      assert.ok(result.notes.length > 0 && result.notes.length <= 10000);
      assert.ok(Number.isFinite(result.duration) && result.duration > 0 && result.duration <= 600);
      for (const note of result.notes) {
        assert.ok(Number.isInteger(note.note) && note.note >= 0 && note.note <= 127);
        assert.ok(Number.isInteger(note.channel) && note.channel >= 0 && note.channel <= 15);
        assert.ok(Number.isInteger(note.track) && note.track >= 0 && note.track < 64);
        assert.ok(Number.isFinite(note.start) && note.start >= 0);
        assert.ok(Number.isFinite(note.duration) && note.duration > 0 && note.start + note.duration <= 600);
      }
      accepted++;
    } catch (error) {
      assert.equal(error.name, 'Error', `seed ${seed}, iteration ${iteration}: ${error.stack}`);
      assert.ok(error.message.length > 0 && error.message.length < 500);
      rejected++;
    }
  }
  assert.equal(accepted + rejected, 4096);
  assert.ok(accepted >= 1024 && rejected >= 2048);
  t.diagnostic(`seed=0x${seed.toString(16)} cases=4096 accepted=${accepted} rejected=${rejected}`);
});

test('seeded mapping and rack validation rejects invalid values without mutating caller data', t => {
  const seed = 0x20b37a12, rng = random(seed), integer = max => Math.floor(rng() * max);
  for (let iteration = 0; iteration < 2048; iteration++) {
    const mappings = [{ channel: integer(16), controller: integer(128), target: `stage-${iteration}:wet` }];
    const rack = { version: 1, chain: [createRackEffect('filter', { id: `stage-${iteration}` })], xy: { x: null, y: null } };
    if (iteration % 2) {
      mappings[0].channel = iteration % 3 ? 16 + integer(1000) : -1;
      rack.chain[0].params.frequency = iteration % 3 ? 20001 + integer(100000) : '<img src=x onerror=alert(1)>';
    }
    const beforeMappings = JSON.stringify(mappings), beforeRack = JSON.stringify(rack);
    if (iteration % 2) {
      assert.throws(() => normalizeMidiMappings(mappings));
      assert.throws(() => normalizeRackSettings(rack));
    } else {
      assert.deepEqual(normalizeMidiMappings(mappings), mappings);
      assert.deepEqual(normalizeRackSettings(rack), rack);
    }
    assert.equal(JSON.stringify(mappings), beforeMappings);
    assert.equal(JSON.stringify(rack), beforeRack);
  }
  assert.equal({}.polluted, undefined);
  t.diagnostic(`seed=0x${seed.toString(16)} cases=2048 mappings + 2048 rack settings; half valid, half invalid`);
});
