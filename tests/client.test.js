import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient } from '../src/client.js';

async function withWorker(WorkerClass, task) {
  const old = globalThis.Worker; globalThis.Worker = WorkerClass;
  try { await task(); } finally { if (old === undefined) delete globalThis.Worker; else globalThis.Worker = old; }
}
test('worker send failure releases pending entry and future valid sends still resolve', async () => {
  class WorkerMock {
    postMessage(data) {
      if (data.params.uncloneable) throw new DOMException('Cannot clone input', 'DataCloneError');
      queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { ok: true }, state: { revision: 1 } } }));
    }
    terminate() {}
  }
  await withWorker(WorkerMock, async () => {
    const client = new EngineClient();
    await assert.rejects(client.execute('project.state', { uncloneable: true }));
    assert.equal(client.pending.size, 0);
    assert.deepEqual(await client.execute('project.state'), { ok: true });
    assert.equal(client.pending.size, 0);
    client.dispose?.();
  });
});
test('terminal worker failure rejects queued and future commands promptly', async () => {
  await withWorker(class { postMessage() {} terminate() {} }, async () => {
    const client = new EngineClient();
    const first = client.execute('project.state');
    client.worker.onerror({ message: 'Synthetic terminal failure' });
    await assert.rejects(first, /Synthetic terminal failure/);
    const result = await Promise.race([client.execute('project.state').then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);
    assert.equal(result, 'rejected');
    assert.equal(client.pending.size, 0);
    client.dispose?.();
  });
});
test('worker client bounds queued jobs and releases all on disposal', async () => {
  await withWorker(class { postMessage() {} terminate() { this.stopped = true; } }, async () => {
    const client = new EngineClient({ maxPending: 2 });
    const a = client.execute('project.state').catch(error => error.code);
    const b = client.execute('project.state').catch(error => error.code);
    const third = await Promise.race([client.execute('project.state').then(() => 'resolved', e => e.code), new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);
    assert.equal(third, 'RESOURCE_LIMIT');
    client.dispose();
    assert.equal(await a, 'DISPOSED'); assert.equal(await b, 'DISPOSED');
    assert.equal(client.pending.size, 0); assert.equal(client.worker.stopped, true);
  });
});
