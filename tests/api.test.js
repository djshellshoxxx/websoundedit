import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startApiServer } from '../scripts/server.mjs';
import { encodeAudioBytes, decodeAudioBytes, nativeCapabilities } from '../scripts/node-codecs.mjs';
import { encodeWav, decodeWav } from '../src/wav.js';
const execute = promisify(execFile);
const audio = { sampleRate: 8000, channels: [new Float32Array(8000).fill(.2), new Float32Array(8000).fill(.2)] };
async function withApi(fn, options = {}) {
  const api = await startApiServer({ port: 0, ...options });
  try { await fn(api); } finally { api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
}
const auth = api => ({ Authorization: `Bearer ${api.token}` });
async function call(api, method, params = {}) {
  const response = await fetch(`${api.url}/v1/execute`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json.result;
}

test('HTTP API imports audio, edits selected samples, exports audio and round trips JSON', async () => {
  await withApi(async api => {
    let response = await fetch(`${api.url}/v1/import?name=take.wav`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'audio/wav' }, body: encodeWav(audio) });
    assert.equal(response.status, 200); const imported = await response.json(); assert.ok(imported.result.clipId);
    await call(api, 'selection.set', { start: .25, end: .5 });
    await call(api, 'effect.reverse'); await call(api, 'effect.normalize', { targetDb: -6 });
    response = await fetch(`${api.url}/v1/export`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'wav', bitDepth: 24, render: { scope: 'selection' } }) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /audio\/wav/);
    const exported = decodeWav(new Uint8Array(await response.arrayBuffer()));
    assert.equal(exported.channels[0].length, 12000); // Imported/resampled into the default 48 kHz project.
    assert.ok(Math.abs(exported.channels[0][100] - 10 ** (-6 / 20)) < 1e-5);
    const project = await (await fetch(`${api.url}/v1/project`, { headers: auth(api) })).json();
    await call(api, 'project.new');
    response = await fetch(`${api.url}/v1/project`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
    assert.equal(response.status, 200); const restored = await response.json(); assert.equal(restored.state.tracks.length, 1); assert.equal(restored.state.selection.end, .5);
  });
});

test('HTTP API denies unauthenticated, cross-origin and non-loopback Host requests', async () => {
  await withApi(async api => {
    assert.equal((await fetch(`${api.url}/v1/state`)).status, 401);
    assert.equal((await fetch(`${api.url}/v1/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${api.url}/v1/state`, { headers: { ...auth(api), Origin: 'https://untrusted.example' } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      const req = request(`${api.url}/v1/state`, { headers: { ...auth(api), Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(`${api.url}/v1/commands`, { headers: auth(api) })).status, 200);
  });
});

test('HTTP rejects oversized, invalid JSON and unknown operations without changing state', async () => {
  await withApi(async api => {
    let response = await fetch(`${api.url}/v1/execute`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    response = await fetch(`${api.url}/v1/execute`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'filesystem.read', params: { path: '/etc/passwd' } }) }); assert.equal(response.status, 400);
    response = await fetch(`${api.url}/v1/execute`, { method: 'POST', headers: { ...auth(api), 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) }); assert.equal(response.status, 413);
    assert.equal(api.editor.getState().tracks.length, 0);
  }, { maxJsonBytes: 1024 });
});

test('optional browser origin has preflight support but still requires a token', async () => {
  await withApi(async api => {
    let response = await fetch(`${api.url}/v1/execute`, { method: 'OPTIONS', headers: { Origin: 'https://djshellshoxxx.github.io' } });
    assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'https://djshellshoxxx.github.io');
    response = await fetch(`${api.url}/v1/state`, { headers: { Origin: 'https://djshellshoxxx.github.io' } }); assert.equal(response.status, 401);
  }, { allowedOrigin: 'https://djshellshoxxx.github.io' });
});

test('native codecs produce real FLAC, MP3, Opus and M4A files when ffmpeg is installed', async t => {
  const capabilities = await nativeCapabilities();
  if (!capabilities.nativeFFmpeg) { t.skip('Native FFmpeg is optional.'); return; }
  const tone = { sampleRate: 48000, channels: [Float32Array.from({ length: 48000 }, (_, i) => .2 * Math.sin(2 * Math.PI * 440 * i / 48000))] };
  for (const format of ['flac', 'mp3', 'opus', 'm4a']) {
    if (!capabilities.formats.includes(format)) continue;
    const bytes = await encodeAudioBytes(tone, { format }); assert.ok(bytes.length > 100);
    const decoded = await decodeAudioBytes(bytes); assert.equal(decoded.sampleRate, 48000);
    assert.ok(Math.abs(decoded.channels[0].length / decoded.sampleRate - 1) < .1);
    assert.ok(decoded.channels[0].some(v => Math.abs(v) > .1));
  }
});

test('CLI runs a JSON recipe over a local file and writes a portable project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'websoundedit-cli-test-'));
  try {
    const input = join(directory, 'input.wav'), recipe = join(directory, 'recipe.json'), output = join(directory, 'edited.wav'), project = join(directory, 'session.json');
    await writeFile(input, encodeWav(audio)); await writeFile(recipe, JSON.stringify({ commands: [{ method: 'effect.normalize', params: { targetDb: -3 } }] }));
    const result = await execute(process.execPath, ['scripts/cli.mjs', '--input', input, '--recipe', recipe, '--output', output, '--save-project', project]);
    assert.match(result.stdout, /Saved/);
    const decoded = decodeWav(new Uint8Array(await readFile(output))); assert.ok(Math.abs(decoded.channels[0][200] - 10 ** (-3 / 20)) < .0001);
    const saved = JSON.parse(await readFile(project, 'utf8')); assert.equal(saved.format, 'websoundedit'); assert.equal(saved.tracks.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI format-only conversion preserves mono channels, native sample rate and amplitude', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'websoundedit-convert-test-'));
  try {
    const input = join(directory, 'input.wav'), output = join(directory, 'output.wav');
    const source = { sampleRate: 44100, channels: [new Float32Array(4410).fill(.5)] };
    await writeFile(input, encodeWav(source, { bitDepth: 24 }));
    await execute(process.execPath, ['scripts/cli.mjs', '--input', input, '--output', output, '--bit-depth', '24']);
    const decoded = decodeWav(new Uint8Array(await readFile(output)));
    assert.equal(decoded.channels.length, 1); assert.equal(decoded.sampleRate, 44100); assert.equal(decoded.channels[0].length, 4410); assert.ok(Math.abs(decoded.channels[0][20] - .5) < 1e-6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
