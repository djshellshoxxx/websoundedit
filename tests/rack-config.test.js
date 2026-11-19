import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RACK_EFFECTS, RACK_EFFECTS, createRackEffect, normalizeRackChain,
  normalizeRackSettings, rackTargets, valueFromPosition, positionFromValue,
} from '../src/rack-config.js';

test('the effects catalogue contains the requested processors and validates every default', () => {
  const expected = ['echo', 'delay', 'reverb', 'chorus', 'flanger', 'phaser', 'distortion', 'tremolo', 'filter', 'tape', 'stutter', 'bitcrusher'];
  assert.deepEqual(Object.keys(RACK_EFFECTS), expected);
  const chain = expected.map((effect, index) => createRackEffect(effect, { id: `stage-${index}` }));
  assert.deepEqual(normalizeRackChain(chain), chain);
  for (const stage of chain) {
    assert.equal(typeof stage.wet, 'number');
    assert.equal(stage.enabled, true);
    assert.deepEqual(Object.keys(stage.params).sort(), RACK_EFFECTS[stage.effect].fields.map(field => field.key).sort());
  }
});

test('settings preserve duplicate effects, processing order, wet/dry and stable XY bindings', () => {
  const first = createRackEffect('delay', { id: 'first' });
  const second = createRackEffect('delay', { id: 'second' });
  first.wet = 0;
  second.enabled = false;
  second.params.timeMs = 124;
  const settings = { version: 1, chain: [second, first], xy: { x: { id: 'first', key: 'wet' }, y: { id: 'second', key: 'timeMs' } } };
  const normalized = normalizeRackSettings(settings);
  assert.deepEqual(normalized, settings);
  normalized.chain[0].params.timeMs = 777;
  assert.equal(settings.chain[0].params.timeMs, 124, 'normalization must not alias caller-owned data');
  assert.equal(rackTargets(settings.chain).find(target => target.id === 'second' && target.key === 'timeMs').label, '1. Delay · Time');
});

test('rack validation rejects unbounded or malformed settings without modifying the input', () => {
  const valid = createRackEffect('delay', { id: 'valid' });
  const invalid = [
    null, {}, Array.from({ length: MAX_RACK_EFFECTS + 1 }, (_, index) => ({ ...valid, id: `stage-${index}` })),
    [{ ...valid, effect: '__proto__' }], [{ ...valid, id: '"><img src=x>' }], [valid, valid],
    [{ ...valid, wet: NaN }], [{ ...valid, wet: Infinity }], [{ ...valid, wet: -0.1 }], [{ ...valid, wet: '0.5' }],
    [{ ...valid, wet: null }], [{ ...valid, enabled: null }], [{ ...valid, id: null }],
    [{ ...valid, enabled: 1 }], [{ ...valid, params: [] }], [{ ...valid, params: { timeMs: 3000 } }],
    [{ ...valid, params: { feedback: '<script>' } }], [{ ...valid, params: { unrecognized: 2 } }],
    [{ ...createRackEffect('stutter'), params: { division: 3.5 } }],
    [{ ...createRackEffect('filter'), params: { type: 'allpass' } }],
  ];
  for (const chain of invalid) assert.throws(() => normalizeRackChain(chain));
  assert.equal(valid.params.timeMs, 350);
  assert.equal(valid.wet, 0.5);
});

test('XY validates numeric targets, rejects stale bindings, and allows two parameters on one stage', () => {
  const stage = createRackEffect('filter', { id: 'filter' });
  const base = { version: 1, chain: [stage] };
  const binding = { id: 'filter', key: 'frequency' };
  assert.throws(() => normalizeRackSettings({ ...base, xy: { x: { id: 'removed', key: 'wet' } } }));
  assert.throws(() => normalizeRackSettings({ ...base, xy: { x: { id: 'filter', key: 'type' } } }));
  assert.throws(() => normalizeRackSettings({ ...base, xy: { x: binding, y: binding } }));
  assert.deepEqual(normalizeRackSettings({ ...base, xy: { x: binding, y: { id: 'filter', key: 'q' } } }).xy.x, binding);
  assert.deepEqual(normalizeRackSettings(), { version: 1, chain: [], xy: { x: null, y: null } });
});

test('continuous and logarithmic XY mappings are bounded, reversible and integer-aware', () => {
  const linear = { min: -0.9, max: 0.9 };
  const log = { min: 20, max: 20000, scale: 'log' };
  for (const setting of [linear, log]) {
    assert.equal(valueFromPosition(setting, -2), setting.min);
    assert.equal(valueFromPosition(setting, 3), setting.max);
    for (const position of [0, 0.1, 0.25, 0.5, 0.9, 1]) assert.ok(Math.abs(positionFromValue(setting, valueFromPosition(setting, position)) - position) < 1e-12);
  }
  assert.ok(Math.abs(valueFromPosition(log, 0.5) - Math.sqrt(20 * 20000)) < 1e-9);
  assert.equal(valueFromPosition({ min: 1, max: 32, integer: true }, 0.5), 17);
  assert.throws(() => valueFromPosition(linear, NaN));
  assert.throws(() => valueFromPosition(linear, Infinity));
});
