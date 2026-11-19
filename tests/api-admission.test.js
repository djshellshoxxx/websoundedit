import test from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer } from '../scripts/server.mjs';
import { ApiAdmission, boundedJson } from '../scripts/api-admission.mjs';

test('HTTP rejects provided non-object params rather than silently mutating', async () => {
  const api = await startApiServer({ port: 0 });
  try {
    for (const params of [false, 0, '', null, [], 'x']) {
      const response = await fetch(api.url + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'track.add', params }) });
      assert.equal(response.status, 400); await response.arrayBuffer();
      assert.equal(api.editor.getState().tracks.length, 0);
    }
  } finally { api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
});

test('aggregate body leases reject excess bytes and release exactly once', () => {
  const budget = new ApiAdmission({ maxJobs: 2, maxBytes: 1024 });
  const a = budget.acquire(), b = budget.acquire(); a.reserve(700); b.reserve(300);
  assert.throws(() => b.reserve(25), error => error.code === 'QUEUE_LIMIT');
  assert.deepEqual(budget.state(), { jobs: 2, bytes: 1000, maxJobs: 2, maxBytes: 1024 });
  a.release(); a.release(); b.release(); assert.equal(budget.state().bytes, 0); assert.equal(budget.state().jobs, 0);
});

test('JSON bounds reject expansion and cycles before materializing large results', () => {
  assert.throws(() => boundedJson({ pcm: new Float32Array(1000) }, 1024), /binary export/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => boundedJson(cyclic), /limit/);
  const text = 'a'.repeat(2000) + '🎵"\\\n';
  assert.equal(JSON.parse(boundedJson({ text }, 4096)).text, text);
});

test('an abandoned queued HTTP command is not executed and capacity is restored', async () => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { started = resolve; });
  const calls = [];
  const editor = { getState: () => ({}), execute: async (method, params) => { calls.push(params.name); started(); if (params.name === 'first') await gate; return {}; } };
  const api = await startApiServer({ port: 0, editor });
  const send = (method, signal) => fetch(api.url + '/v1/execute', { method: 'POST', signal, headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'track.add', params: { name: method } }) });
  let first;
  try {
    first = send('first'); await running;
    const controller = new AbortController(); const second = send('abandoned', controller.signal).catch(error => error);
    for (let i = 0; i < 100 && api.diagnostics().jobs < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(api.diagnostics().jobs, 2);
    controller.abort(); await second; await new Promise(resolve => setTimeout(resolve, 20));
    release(); await (await first).arrayBuffer();
    const next = await send('next'); assert.equal(next.status, 200); await next.arrayBuffer();
    assert.deepEqual(calls, ['first', 'next']);
    assert.equal(api.diagnostics().jobs, 0); assert.equal(api.diagnostics().bytes, 0);
  } finally { release(); await first; api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
});
test('HTTP admission rejects excess jobs while an earlier command is blocked, then recovers', async () => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { started = resolve; });
  let count = 0;
  const editor = { getState: () => ({ tracks: [] }), execute: async () => { count++; started(); if (count === 1) await gate; return {}; } };
  const api = await startApiServer({ port: 0, editor, maxPendingJobs: 1, maxJsonBytes: 4096, maxQueuedBytes: 4096 });
  const send = () => fetch(api.url + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'project.state' }) });
  let first, second;
  try {
    first = send(); await running;
    second = send();
    const result = await Promise.race([second.then(async response => { const body = await response.json(); return { status: response.status, code: body.error?.code }; }), new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), 200))]);
    assert.equal(result.status, 429); assert.equal(result.code, 'QUEUE_LIMIT');
    release(); assert.equal((await first).status, 200);
    const next = await send(); assert.equal(next.status, 200); await next.arrayBuffer();
    assert.equal(count, 2);
  } finally { release(); await Promise.allSettled([first, second].filter(Boolean)); api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
});
