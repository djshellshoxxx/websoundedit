import test from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer } from '../scripts/server.mjs';

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
test('HTTP admission rejects excess jobs while an earlier command is blocked, then recovers', async () => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { started = resolve; });
  let count = 0;
  const editor = { getState: () => ({ tracks: [] }), execute: async () => { count++; started(); if (count === 1) await gate; return {}; } };
  const api = await startApiServer({ port: 0, editor, maxPendingJobs: 1, maxJsonBytes: 4096, maxQueuedBytes: 4096 });
  const send = () => fetch(api.url + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'test.wait' }) });
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
