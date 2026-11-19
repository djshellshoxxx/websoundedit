import test from 'node:test';
import assert from 'node:assert/strict';
import { messageCost } from '../src/message-budget.js';

test('preflight rejects a huge sparse array before worker structured cloning', () => {
  const sparse = new Array(1_000_001);
  assert.throws(() => messageCost({ clips: sparse }), error => error.code === 'RESOURCE_LIMIT');
  const shortSparse = [1, , 3];
  assert.throws(() => messageCost({ clips: shortSparse }), /must be dense/);
});

test('preflight does not invoke getters on objects or array indices', () => {
  let invoked = 0;
  const object = {};
  Object.defineProperty(object, 'audio', { enumerable: true, get() { invoked++; return new Float32Array(1); } });
  assert.throws(() => messageCost({ content: object }), /accessors/);
  const array = [0];
  Object.defineProperty(array, '0', { get() { invoked++; return 0; } });
  assert.throws(() => messageCost({ content: array }), /accessors/);
  assert.equal(invoked, 0);
});

test('preflight rejects extra array properties, symbols and executable values', () => {
  const array = [1]; array.extra = 2;
  assert.throws(() => messageCost(array), /dense/);
  assert.throws(() => messageCost({ [Symbol('hidden')]: true }), /unsupported property/);
  assert.throws(() => messageCost({ execute() {} }), /executable or unsupported/);
});

test('preflight counts shared PCM backing buffers once and applies byte budget', () => {
  const buffer = new ArrayBuffer(128);
  const pcm = { left: new Float32Array(buffer, 0, 16), right: new Float32Array(buffer, 64, 16) };
  const first = messageCost(pcm);
  assert.ok(first >= 128 && first < 256);
  assert.equal(first, messageCost(pcm));
  assert.throws(() => messageCost(pcm, first - 1), error => error.code === 'RESOURCE_LIMIT');
  assert.deepEqual(messageCost({ channels: [new Float32Array([0.2, 0.4])] }) > 0, true);
});
