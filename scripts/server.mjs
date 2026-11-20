#!/usr/bin/env node
/** Opt-in loopback API. It never reads a request-supplied filesystem path. */
import { createServer } from 'node:http';
import packageInfo from '../package.json' with { type: 'json' };
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { decodeAudioBytes, encodeAudioBytes, nativeCapabilities, AUDIO_FORMATS } from './node-codecs.mjs';
import { ApiAdmission, boundedJson } from './api-admission.mjs';
import { NodeWorkbench } from './node-runtime.mjs';
import { readFile } from 'node:fs/promises';

const MAX_JSON = 384 * 1024 * 1024;
const MAX_AUDIO = 256 * 1024 * 1024;
function readBody(request, limit, lease) {
  return new Promise((resolveBody, reject) => {
    const size = Number(request.headers['content-length']);
    if (Number.isFinite(size) && size > limit) { const error = new Error('Request body exceeds size limit.'); error.status = 413; request.resume(); reject(error); return; }
    let bytes = 0, reserved = 0, settled = false; const chunks = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = failure => { if (settled) return; settled = true; cleanup(); chunks.length = 0; request.resume(); reject(failure); };
    const aborted = () => error(Object.assign(new Error('Request was aborted.'), { code: 'ABORTED' }));
    const data = chunk => {
      try {
        bytes += chunk.length;
        if (bytes > limit) throw Object.assign(new Error('Request body exceeds size limit.'), { status: 413 });
        if (bytes > reserved) { lease.reserve(bytes - reserved); reserved = bytes; }
        chunks.push(chunk);
      } catch (failure) { error(failure); }
    };
    const end = () => { if (!settled) { settled = true; cleanup(); resolveBody(Buffer.concat(chunks, bytes)); } };
    try { if (Number.isFinite(size) && size > 0) { lease.reserve(size); reserved = size; } }
    catch (failure) { error(failure); return; }
    request.on('data', data); request.on('end', end); request.on('error', error); request.on('aborted', aborted);
  });
}
function equalToken(received, expected) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanOrigin(origin) { const url = new URL(origin); if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Allowed origin must be an exact http(s) origin without a path.'); return url.origin; }
function safeFileName(name, extension) { return `${String(name || 'websoundedit').replace(/[^\p{L}\p{N}_ .-]/gu, '_').slice(0, 100)}.${extension}`; }

export function createApiServer({ editor = new AudioEditor(), workbench: suppliedWorkbench = null, destinations = [], token = randomBytes(32).toString('hex'), allowedOrigin = null, maxJsonBytes = MAX_JSON, maxAudioBytes = MAX_AUDIO, maxPendingJobs = 8, maxQueuedBytes = 512 * 1024 * 1024, maxResponseBytes = MAX_JSON } = {}) {
  if (typeof token !== 'string' || token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('API token must contain at least 24 safe characters.');
  const origin = allowedOrigin ? cleanOrigin(allowedOrigin) : null;
  for (const limit of [maxJsonBytes, maxAudioBytes, maxResponseBytes]) if (!Number.isSafeInteger(limit) || limit < 1024 || limit > MAX_JSON) throw new RangeError('API byte limits must be integers from 1 KiB to 384 MiB.');
  const admission = new ApiAdmission({ maxJobs: maxPendingJobs, maxBytes: maxQueuedBytes });
  let capabilitiesPromise;
  const native = () => capabilitiesPromise ??= nativeCapabilities().catch(error => { capabilitiesPromise = null; throw error; });
  const workbench = suppliedWorkbench || new NodeWorkbench({ editor, destinations, getCapabilities: native });
  editor = workbench.editor;
  const capabilities = async () => ({ ...await native(), apiVersion: 1, applicationVersion: packageInfo.version, streaming: await workbench.streams.capabilities(), macros: { language:'WebSoundEdit Macro 1', supported:true }, files: { suppliedInputs:128,inputBytes:256*1024*1024,retainedArtifacts:128,artifactBytes:128*1024*1024 } });
  let jobs = Promise.resolve();
  const serialize = task => { const next = jobs.then(task); jobs = next.catch(() => {}); return next; };
  const server = createServer(async (request, response) => {
    let lease, workDone = false, responseDone = false, abandoned = false, operationCompleted = false;
    const controller = new AbortController();
    const release = () => { if (workDone && responseDone) lease?.release(); };
    response.once('finish', () => { responseDone = true; release(); });
    response.once('close', () => { responseDone = true; if (!response.writableEnded) { abandoned = true; controller.abort(); } release(); });
    request.once('aborted', () => { abandoned = true; controller.abort(); });
    request.on('error', () => { abandoned = true; controller.abort(); });
    const json = (response, status, value) => {
      if (response.destroyed) return;
      const body = boundedJson(value, status >= 400 ? 65536 : maxResponseBytes);
      if (status < 400) lease?.reserve(Buffer.byteLength(body));
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(body);
    };
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) { json(response, 403, { error: { code: 'HOST_DENIED', message: 'This API accepts only its loopback Host.' } }); return; }
    if (request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: { code: 'ORIGIN_DENIED', message: 'Browser origin is not allowed. Use a local script or explicitly configure one allowed origin.' } }); return; }
    if (request.headers.origin && request.headers.origin === origin) {
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (request.method === 'OPTIONS') { if (!request.headers.origin || request.headers.origin !== origin) json(response, 403, { error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed.' } }); else { response.writeHead(204); response.end(); } return; }
    if (!equalToken(request.headers.authorization, token)) { response.setHeader('WWW-Authenticate', 'Bearer'); json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid API Bearer token is required.' } }); return; }
    try {
      // An authenticated, body-free cancel remains responsive with a full queue.
      if (request.method === 'POST' && request.url === '/v1/cancel') { json(response,200,{result:await workbench.macro('macro.cancel',{})});return; }
      lease = admission.acquire();
      const serial = task => serialize(() => { if (abandoned) throw Object.assign(new Error('Request was aborted before execution.'), { code: 'ABORTED', status: 499 }); return task(); });
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/v1/commands') { json(response, 200, { apiVersion: 1, commands: workbench.commands() }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') { json(response, 200, await serial(capabilities)); return; }
      if (request.method === 'GET' && url.pathname === '/v1/macro/status') { json(response,200,await workbench.macro('macro.status',{}));return; }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/artifacts/')) {
        const artifact=workbench.artifacts.get(url.pathname.slice('/v1/artifacts/'.length));
        if(!artifact){json(response,404,{error:{code:'NOT_FOUND',message:'Artifact not found.'}});return;}
        lease.reserve(artifact.bytes.length);
        response.writeHead(200,{'Content-Type':artifact.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(artifact.name),'Cache-Control':'no-store','Content-Length':artifact.bytes.length});response.end(artifact.bytes);return;
      }
      const pcmPath=/^\/v1\/stream\/([A-Za-z0-9_-]{1,80})\/pcm$/.exec(url.pathname);
      if(request.method==='POST'&&pcmPath){
        if(!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type']||'')){json(response,415,{error:{code:'CONTENT_TYPE',message:'PCM packets require application/octet-stream.'}});return;}
        const bytes=new Uint8Array(await readBody(request,256*1024,lease)),packet={};
        for(const key of ['sequence','startFrame','frames','droppedFrames']){
          const values=url.searchParams.getAll(key);
          packet[key]=key==='droppedFrames'&&!values.length?0:values.length===1&&/^(0|[1-9][0-9]{0,15})$/.test(values[0])?Number(values[0]):NaN;
        }
        const result=workbench.streams.feed(pcmPath[1],bytes,packet);operationCompleted=true;json(response,200,result);return;
      }
      if(request.method==='POST'&&url.pathname==='/v1/inputs'){
        if(!/^audio\/|^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type']||'')){json(response,415,{error:{code:'CONTENT_TYPE',message:'Supply file bytes as audio/* or application/octet-stream.'}});return;}
        const bytes=new Uint8Array(await readBody(request,maxAudioBytes,lease));
        const result=workbench.supply(bytes,{name:url.searchParams.get('name')||'input.wav',copy:false});operationCompleted=true;json(response,200,{result});return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') { json(response, 200, await serial(() => editor.getState())); return; }
      if (request.method === 'GET' && url.pathname === '/v1/project') { json(response, 200, await serial(() => editor.execute('project.save'))); return; }
      if (request.method === 'POST' && url.pathname === '/v1/import') {
        if (!/^audio\/|^application\/octet-stream/i.test(request.headers['content-type'] || '')) { json(response, 415, { error: { code: 'CONTENT_TYPE', message: 'Send raw audio bytes as audio/* or application/octet-stream.' } }); return; }
        const bytes = new Uint8Array(await readBody(request, maxAudioBytes, lease));
        const result = await serial(async () => editor.execute('clip.add', { name: url.searchParams.get('name') || 'Imported audio', trackId: url.searchParams.get('trackId') || undefined, start: url.searchParams.has('start') ? Number(url.searchParams.get('start')) : 0, audio: await decodeAudioBytes(bytes, { sampleRate: editor.getState().sampleRate }) }));
        operationCompleted = true;
        json(response, 200, { result, state: editor.getState() }); return;
      }
      if (request.method === 'POST' && ['/v1/execute', '/v1/project', '/v1/export'].includes(url.pathname)) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { json(response, 415, { error: { code: 'CONTENT_TYPE', message: 'Use application/json for this endpoint.' } }); return; }
        const body = JSON.parse((await readBody(request, maxJsonBytes, lease)).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The JSON body must be an object.');
        if (url.pathname === '/v1/execute') {
          if (typeof body.method !== 'string') throw new Error('Provide a method string and optional params object.');
          const params = body.params === undefined ? {} : body.params;
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Command parameters must be an object.');
          const execute=()=>workbench.execute(body.method,params,{origin:'api',signal:controller.signal});
          const result = await (['macro.cancel','macro.status','stream.start','stream.stop','stream.status'].includes(body.method)?execute():serial(execute));
          operationCompleted = true; json(response, 200, { result, ...(!body.method.startsWith('stream.')?{state:editor.getState()}:{}) }); return;
        }
        if (url.pathname === '/v1/project') { const result = await serial(() => editor.execute('project.load', { project: body.project || body })); operationCompleted = true; json(response, 200, { result, state: editor.getState() }); return; }
        const format = String(body.format || 'wav').toLowerCase(), info = AUDIO_FORMATS[format]; if (!info) throw new Error('Unsupported export format.');
        const bytes = await serial(async () => encodeAudioBytes(await editor.execute('audio.render', body.render || { scope: body.scope || 'mix' }), { ...body, format }));
        lease.reserve(bytes.byteLength);
        response.writeHead(200, { 'Content-Type': info.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(body.name, info.extension))}`, 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); response.end(bytes); return;
      }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint. Use GET /v1/commands to discover editing methods.' } });
    } catch (error) { if (!response.headersSent) json(response, error.status || (error instanceof SyntaxError ? 400 : error.code === 'RESOURCE_LIMIT' ? 413 : 400), { error: { code: error.code || 'INVALID_REQUEST', message: String(error.message).slice(0, 1000), operationCompleted, ...(error.completedSteps!==undefined?{completedSteps:error.completedSteps,partial:error.completedSteps>0}:{}), ...(error.command?{command:error.command}:{}), ...(error.line?{line:error.line,column:error.column}:{}) } }); else response.end(); }
    finally { workDone = true; responseDone ||= response.writableFinished || response.destroyed; release(); request.resume(); }
  });
  server.requestTimeout = 180000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxConnections = 32; server.maxRequestsPerSocket = 1000;
  server.once('close',()=>{void workbench.dispose().catch(()=>{});});
  return { server, editor, token, workbench, runtime:workbench.runtime, diagnostics: () => admission.state() };
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
    else if (args[i] === '--destinations') { const bytes=await readFile(args[++i]);if(bytes.length>16384)throw new Error('Destination configuration exceeds 16 KiB.');options.destinations=JSON.parse(bytes.toString('utf8')); }
    else if (args[i] === '--help') { console.log('Usage: node scripts/server.mjs [--port 8787] [--allow-origin https://djshellshoxxx.github.io] [--destinations udp-destinations.json]\nThe server binds 127.0.0.1 only. A new Bearer token is generated per run.\nDestination JSON: [{"id":"studio","address":"127.0.0.1","port":5004,"label":"Studio receiver"}]\nOnly pinned literal IP destinations are available to scripts. UDP stays disabled without configuration.'); return; }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const api = await startApiServer(options);
  console.log(`WebSoundEdit local API: ${api.url}\nBearer token: ${api.token}\nDocs: docs/API.md\nPress Ctrl+C to stop.`);
  const shutdown=async()=>{await api.workbench.macro('macro.cancel',{});await api.workbench.streams.dispose();api.server.closeAllConnections();api.server.close(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`WebSoundEdit API: ${error.message}`); process.exitCode = 1; });
