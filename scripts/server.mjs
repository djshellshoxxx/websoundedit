#!/usr/bin/env node
/** Opt-in loopback API. It never reads a request-supplied filesystem path. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { decodeAudioBytes, encodeAudioBytes, nativeCapabilities, AUDIO_FORMATS } from './node-codecs.mjs';

const MAX_JSON = 384 * 1024 * 1024;
const MAX_AUDIO = 256 * 1024 * 1024;
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value, (_, item) => item instanceof Float32Array ? Array.from(item) : item)); };
function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const size = Number(request.headers['content-length']);
    if (Number.isFinite(size) && size > limit) { const error = new Error('Request body exceeds size limit.'); error.status = 413; request.resume(); reject(error); return; }
    let bytes = 0; const chunks = [];
    request.on('data', chunk => { bytes += chunk.length; if (bytes > limit) { chunks.length = 0; const error = new Error('Request body exceeds size limit.'); error.status = 413; reject(error); request.resume(); } else if (bytes <= limit) chunks.push(chunk); });
    request.on('end', () => { if (bytes <= limit) resolveBody(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request was aborted.')));
  });
}
function equalToken(received, expected) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanOrigin(origin) { const url = new URL(origin); if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Allowed origin must be an exact http(s) origin without a path.'); return url.origin; }
function safeFileName(name, extension) { return `${String(name || 'websoundedit').replace(/[^\p{L}\p{N}_ .-]/gu, '_').slice(0, 100)}.${extension}`; }

export function createApiServer({ editor = new AudioEditor(), token = randomBytes(32).toString('hex'), allowedOrigin = null, maxJsonBytes = MAX_JSON, maxAudioBytes = MAX_AUDIO } = {}) {
  if (typeof token !== 'string' || token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('API token must contain at least 24 safe characters.');
  const origin = allowedOrigin ? cleanOrigin(allowedOrigin) : null;
  let jobs = Promise.resolve();
  const serialize = task => { const next = jobs.then(task); jobs = next.catch(() => {}); return next; };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) { json(response, 403, { error: { code: 'HOST_DENIED', message: 'This API accepts only its loopback Host.' } }); return; }
    if (request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: { code: 'ORIGIN_DENIED', message: 'Browser origin is not allowed. Use a local script or explicitly configure one allowed origin.' } }); return; }
    if (request.headers.origin && request.headers.origin === origin) {
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') { if (!request.headers.origin || request.headers.origin !== origin) json(response, 403, { error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed.' } }); else { response.writeHead(204); response.end(); } return; }
    if (!equalToken(request.headers.authorization, token)) { response.setHeader('WWW-Authenticate', 'Bearer'); json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid API Bearer token is required.' } }); return; }
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/v1/commands') { json(response, 200, { apiVersion: 1, commands: COMMANDS }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') { json(response, 200, await nativeCapabilities()); return; }
      if (request.method === 'GET' && url.pathname === '/v1/state') { json(response, 200, await serialize(() => editor.getState())); return; }
      if (request.method === 'GET' && url.pathname === '/v1/project') { json(response, 200, await serialize(() => editor.execute('project.save'))); return; }
      if (request.method === 'POST' && url.pathname === '/v1/import') {
        if (!/^audio\/|^application\/octet-stream/i.test(request.headers['content-type'] || '')) { json(response, 415, { error: { code: 'CONTENT_TYPE', message: 'Send raw audio bytes as audio/* or application/octet-stream.' } }); return; }
        const bytes = new Uint8Array(await readBody(request, maxAudioBytes));
        const result = await serialize(async () => editor.execute('clip.add', { name: url.searchParams.get('name') || 'Imported audio', trackId: url.searchParams.get('trackId') || undefined, start: url.searchParams.has('start') ? Number(url.searchParams.get('start')) : 0, audio: await decodeAudioBytes(bytes, { sampleRate: editor.getState().sampleRate }) }));
        json(response, 200, { result, state: editor.getState() }); return;
      }
      if (request.method === 'POST' && ['/v1/execute', '/v1/project', '/v1/export'].includes(url.pathname)) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { json(response, 415, { error: { code: 'CONTENT_TYPE', message: 'Use application/json for this endpoint.' } }); return; }
        const body = JSON.parse((await readBody(request, maxJsonBytes)).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The JSON body must be an object.');
        if (url.pathname === '/v1/execute') {
          if (typeof body.method !== 'string') throw new Error('Provide a method string and optional params object.');
          const result = await serialize(() => editor.execute(body.method, body.params || {})); json(response, 200, { result, state: editor.getState() }); return;
        }
        if (url.pathname === '/v1/project') { const result = await serialize(() => editor.execute('project.load', { project: body.project || body })); json(response, 200, { result, state: editor.getState() }); return; }
        const format = String(body.format || 'wav').toLowerCase(), info = AUDIO_FORMATS[format]; if (!info) throw new Error('Unsupported export format.');
        const bytes = await serialize(async () => encodeAudioBytes(await editor.execute('audio.render', body.render || { scope: body.scope || 'mix' }), { ...body, format }));
        response.writeHead(200, { 'Content-Type': info.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(body.name, info.extension))}`, 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); response.end(bytes); return;
      }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint. Use GET /v1/commands to discover editing methods.' } });
    } catch (error) { if (!response.headersSent) json(response, error.status || (error instanceof SyntaxError ? 400 : error.code === 'RESOURCE_LIMIT' ? 413 : 400), { error: { code: error.code || 'INVALID_REQUEST', message: error.message } }); else response.end(); }
  });
  server.requestTimeout = 180000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return { server, editor, token };
}
export async function startApiServer(options = {}) {
  const api = createApiServer(options); const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  await new Promise((resolveServer, reject) => { api.server.once('error', reject); api.server.listen(port, '127.0.0.1', resolveServer); });
  return { ...api, url: `http://127.0.0.1:${api.server.address().port}` };
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') options.port = Number(args[++i]);
    else if (args[i] === '--allow-origin') options.allowedOrigin = args[++i];
    else if (args[i] === '--help') { console.log('Usage: node scripts/server.mjs [--port 8787] [--allow-origin https://djshellshoxxx.github.io]\nThe server binds 127.0.0.1 only. A new Bearer token is generated per run.'); return; }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const api = await startApiServer(options);
  console.log(`WebSoundEdit local API: ${api.url}\nBearer token: ${api.token}\nDocs: docs/API.md\nPress Ctrl+C to stop.`);
  process.once('SIGINT', () => api.server.close(() => process.exit(0))); process.once('SIGTERM', () => api.server.close(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`WebSoundEdit API: ${error.message}`); process.exitCode = 1; });
