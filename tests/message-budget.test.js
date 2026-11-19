import test from 'node:test';
import assert from 'node:assert/strict';
import { messageCost } from '../src/message-budget.js';
import { EngineClient } from '../src/client.js';

const resourceLimit = error => error.code === 'RESOURCE_LIMIT';

test('preflight rejects huge and short sparse arrays before cloning', () => {
  assert.throws(() => messageCost({ clips: new Array(1_000_001) }), resourceLimit);
  assert.throws(() => messageCost({ clips: [1, , 3] }), /must be dense/);
});

test('preflight rejects object and array accessors without invoking them', () => {
  let invoked = 0;
  const object = {}, array = [0];
  Object.defineProperty(object, 'audio', { enumerable: true, get() { invoked++; return new Float32Array(1); } });
  Object.defineProperty(array, '0', { get() { invoked++; return 0; } });
  assert.throws(() => messageCost({ content: object }), /accessors/);
  assert.throws(() => messageCost({ content: array }), /accessors/);
  assert.equal(invoked, 0);
});

test('preflight accepts only dense enumerable array indices and data properties', () => {
  const extra = [1]; extra.extra = 2;
  const hidden = [1]; Object.defineProperty(hidden, '0', { enumerable: false });
  const invalidIndex = []; invalidIndex['01'] = 2;
  assert.throws(() => messageCost(extra), /dense|indexed/);
  assert.throws(() => messageCost(hidden), /enumerable/);
  assert.throws(() => messageCost(invalidIndex), /dense|indexed/);
  assert.throws(() => messageCost({ [Symbol('hidden')]: true }), /unsupported property/);
  assert.throws(() => messageCost({ execute() {} }), /executable or unsupported/);
  assert.throws(() => messageCost(new (class extends Array {})(1)), /plain objects/);
});

test('preflight counts complete shared backing buffers once and enforces exact byte budget', () => {
  const buffer = new ArrayBuffer(128);
  const pcm = { left: new Float32Array(buffer, 0, 16), right: new Float32Array(buffer, 64, 16) };
  const cost = messageCost(pcm);
  assert.ok(cost >= 128 && cost < 256);
  assert.equal(messageCost(pcm, cost), cost);
  assert.throws(() => messageCost(pcm, cost - 1), resourceLimit);
  // A one-sample view still clones its complete backing store.
  assert.equal(messageCost(new Float32Array(buffer, 0, 1)), 32 + 128);
  assert.equal(messageCost({ channels: [new Float32Array([0.2, 0.4])] }) > 0, true);
});

test('binary accounting bypasses shadowed view and buffer accessors', () => {
  let invoked = 0;
  const buffer = new ArrayBuffer(128), typed = new Float32Array(buffer), data = new DataView(buffer);
  const getter = { get() { invoked++; return 0; } };
  Object.defineProperty(buffer, 'byteLength', getter);
  Object.defineProperty(typed, 'buffer', getter);
  Object.defineProperty(typed, 'byteLength', getter);
  Object.defineProperty(data, 'buffer', getter);
  Object.defineProperty(data, 'byteLength', getter);
  for (const value of [buffer, typed, data]) {
    assert.equal(messageCost(value), 160);
    assert.throws(() => messageCost(value, 159), resourceLimit);
  }
  assert.equal(invoked, 0);
});

test('genuine ArrayBuffers retain intrinsic accounting after prototype changes', () => {
  for (const prototype of [null, Object.prototype]) {
    const buffer = new ArrayBuffer(128);
    Object.setPrototypeOf(buffer, prototype);
    assert.equal(messageCost(buffer), 160);
    assert.throws(() => messageCost(buffer, 159), resourceLimit);
    const clone = structuredClone(buffer);
    assert.equal(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(clone), 128);
  }
});

test('prototype changes cannot hide cloneable Map or Set contents as plain records', () => {
  for (const value of [new Map([['pcm', new Uint8Array(128)]]), new Set([new Uint8Array(128)])]) {
    Object.setPrototypeOf(value, null);
    assert.throws(() => messageCost(value), /plain objects/);
  }
});

test('pending values reserve the node budget before nested array enumeration', () => {
  let enumerated = 0;
  const nested = new Proxy(new Array(600_000), {
    ownKeys() { enumerated++; throw new Error('Nested array should be rejected before enumeration.'); },
  });
  const outer = new Array(600_000).fill(null);
  outer[outer.length - 1] = nested;
  assert.throws(() => messageCost(outer), resourceLimit);
  assert.equal(enumerated, 0);
});

test('byte overflow rejects during enumeration before visiting additional properties', () => {
  const value = { ['a'.repeat(10)]: 0 };
  Object.defineProperty(value, 'later', { enumerable: true, get() { throw new Error('Should never run.'); } });
  assert.throws(() => messageCost(value, 51), resourceLimit);
});

test('repeated references and cycles stay bounded without recounting PCM storage', () => {
  const buffer = new ArrayBuffer(128), shared = { audio: new Float32Array(buffer) };
  const value = { first: shared, second: shared }; value.self = value;
  assert.ok(messageCost(value) >= 128 && messageCost(value) < 300);
  assert.equal(messageCost(structuredClone(value)), messageCost(value));
});

test('shared-buffer views use intrinsic byte lengths when available', { skip: typeof SharedArrayBuffer === 'undefined' }, () => {
  let invoked = 0;
  const buffer = new SharedArrayBuffer(128);
  Object.defineProperty(buffer, 'byteLength', { get() { invoked++; return 0; } });
  assert.equal(messageCost(new Float32Array(buffer)), 160);
  assert.equal(invoked, 0);
});

test('worker admission rejects malformed messages without posting or retaining queue entries', async () => {
  const previous = globalThis.Worker;
  let posted = 0, invoked = 0;
  globalThis.Worker = class {
    postMessage(message) {
      posted++;
      const cloned = structuredClone(message);
      queueMicrotask(() => this.onmessage({ data: { id: cloned.id, result: { ok: true } } }));
    }
    terminate() {}
  };
  const client = new EngineClient({ maxPendingBytes: 256 });
  try {
    const accessor = {};
    Object.defineProperty(accessor, 'audio', { enumerable: true, get() { invoked++; return 0; } });
    await assert.rejects(client.execute('project.state', accessor), /accessors/);
    await assert.rejects(client.execute('project.state', { clips: new Array(1_000_001) }), resourceLimit);
    const oversized = new Float32Array(128);
    Object.defineProperty(oversized, 'buffer', { get() { invoked++; return new ArrayBuffer(0); } });
    await assert.rejects(client.execute('project.state', { audio: oversized }), resourceLimit);
    assert.equal(posted, 0); assert.equal(invoked, 0);
    assert.equal(client.pending.size, 0); assert.equal(client.queuedBytes, 0);
    assert.deepEqual(await client.execute('project.state', { audio: new Float32Array(8) }), { ok: true });
    assert.equal(posted, 1); assert.equal(client.pending.size, 0); assert.equal(client.queuedBytes, 0);
  } finally {
    client.dispose();
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
  }
});
