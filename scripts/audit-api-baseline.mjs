/** Reproducible post-publication 0.2 API audit; never uses real user media. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { startApiServer } from './server.mjs';
import { EngineClient } from '../src/client.js';

const seed = 0x51ec2026;
let randomState = seed;
const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 4294967296; };
const pick = values => values[Math.floor(random() * values.length)];
const findings = [], report = { baseline: '5906ba639d5c56e6d64a6c0eb64a8f469fc09d72', seed, node: process.version, startedAt: new Date().toISOString(), cases: 0, findings };
const api = await startApiServer({ port: 0, maxJsonBytes: 4096, maxAudioBytes: 4096 });
const headers = { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' };
try {
  const before = JSON.stringify(api.editor.getState());
  for (let index = 0; index < 1200; index++) {
    const variant = index % 6;
    let body;
    if (variant === 0) body = JSON.stringify({ method: pick(['constructor', '__proto__', 'process.exit', 'filesystem.read', 'effect.__proto__', '', 'unknown.' + index]), params: {} });
    else if (variant === 1) body = JSON.stringify(pick([null, [], true, 12, 'string', { method: null }, { method: {} }]));
    else if (variant === 2) body = JSON.stringify({ method: 'project.update', params: { bpm: pick([-1, 0, 401, '120', {}, []]) } });
    else if (variant === 3) body = JSON.stringify({ method: 'project.update', params: { name: pick(['', ' '.repeat(index % 50), 'x'.repeat(201), {}, 0]) } });
    else if (variant === 4) body = pick(['{', '{"a":', '{"method":"track.add",}', 'NaN', '\u0000']);
    else body = JSON.stringify({ method: 'track.update', params: { trackId: 'missing-' + index, gainDb: pick([-1000, 999, null, 'x']) } });
    const response = await fetch(api.url + '/v1/execute', { method: 'POST', headers, body });
    assert.equal(response.status, 400, `case ${index}`);
    const result = await response.json();
    assert.equal(typeof result.error.message, 'string');
    assert.equal(JSON.stringify(api.editor.getState()), before, `state changed at ${index}`);
    report.cases++;
  }
  for (const origin of ['null', 'https://untrusted.example', 'http://localhost', 'https://djshellshoxxx.github.io.attacker.example']) {
    const response = await fetch(api.url + '/v1/state', { headers: { ...headers, Origin: origin } });
    assert.equal(response.status, 403); report.cases++;
  }
  for (const host of ['attacker.example', '127.0.0.1', 'localhost.evil.example', '[::1]:1']) {
    const status = await new Promise((resolve, reject) => { const req = request(api.url + '/v1/state', { headers: { ...headers, Host: host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(status, 403); report.cases++;
  }
  for (const body of ['x'.repeat(4097), JSON.stringify({ method: 'track.add', params: { name: 'x'.repeat(5000) } })]) {
    const response = await fetch(api.url + '/v1/execute', { method: 'POST', headers, body });
    assert.equal(response.status, 413); await response.arrayBuffer(); report.cases++;
  }
  const falseParams = await fetch(api.url + '/v1/execute', { method: 'POST', headers, body: JSON.stringify({ method: 'track.add', params: false }) });
  await falseParams.arrayBuffer();
  if (falseParams.status === 200 && api.editor.getState().tracks.length === 1) findings.push({ id: 'API-04', severity: 'low', title: 'False parameters become an empty object at the HTTP boundary', evidence: { status: falseParams.status, tracksAdded: 1 } });
} finally { api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }

// Hold a tiny first job and observe whether all 24 additional authenticated
// requests are retained. This demonstrates admission behavior without pressure.
let release;
const gate = new Promise(resolve => { release = resolve; });
let calls = 0;
const editor = { execute: async () => { calls++; if (calls === 1) await gate; return {}; }, getState: () => ({ tracks: [] }) };
const queuedApi = await startApiServer({ port: 0, editor, maxJsonBytes: 4096, maxAudioBytes: 4096 });
try {
  const requests = Array.from({ length: 25 }, () => fetch(queuedApi.url + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${queuedApi.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'test.wait', params: { padding: 'x'.repeat(1024) } }) }));
  await new Promise(resolve => setTimeout(resolve, 100));
  release(); const statuses = await Promise.all(requests.map(async result => { const r = await result; await r.arrayBuffer(); return r.status; }));
  report.queueProbe = { concurrentRequests: requests.length, accepted: statuses.filter(x => x === 200).length, rejected: statuses.filter(x => x !== 200).length, maxProbeBodyBytes: 27000 };
  if (statuses.every(x => x === 200)) findings.push({ id: 'API-01', severity: 'medium', title: 'No aggregate HTTP job/body admission budget', evidence: report.queueProbe });
} finally { release(); queuedApi.server.closeAllConnections(); await new Promise(resolve => queuedApi.server.close(resolve)); }

const previousWorker = globalThis.Worker;
try {
  globalThis.Worker = class { postMessage() { throw new DOMException('not cloneable', 'DataCloneError'); } };
  const client = new EngineClient();
  await assert.rejects(client.execute('project.state', { bad: () => {} }));
  report.workerPendingAfterCloneFailure = client.pending.size;
  if (client.pending.size) findings.push({ id: 'API-02', severity: 'medium', title: 'Failed worker postMessage leaves pending entry', evidence: { pending: client.pending.size } });
  globalThis.Worker = class { postMessage() {} };
  const deadClient = new EngineClient();
  deadClient.worker.onerror({ message: 'Simulated worker failure' });
  const result = await Promise.race([deadClient.execute('project.state').then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);
  report.commandAfterWorkerFailure = result;
  if (result === 'pending') findings.push({ id: 'API-03', severity: 'medium', title: 'Commands after terminal worker failure remain pending', evidence: { result } });
} finally { if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; }
report.finishedAt = new Date().toISOString();
await mkdir('test-results/audits', { recursive: true });
await writeFile('test-results/audits/api-baseline.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
