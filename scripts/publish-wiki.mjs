/** Publish only the verified main checkout to this repository's existing wiki. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WIKI_REPOSITORY = 'djshellshoxxx/websoundedit';
export const WIKI_REMOTE = 'https://github.com/' + WIKI_REPOSITORY + '.wiki.git';
export const WIKI_LIMITS = Object.freeze({pages:32, pageBytes:128 * 1024, totalBytes:1024 * 1024, htmlBytes:2 * 1024 * 1024});
const PUBLIC_BASE = 'https://github.com/' + WIKI_REPOSITORY + '/wiki';
const RAW_BASE = 'https://raw.githubusercontent.com/wiki/' + WIKI_REPOSITORY;
const DEFAULT_SOURCE = fileURLToPath(new URL('../docs/wiki/', import.meta.url));
const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = (code, message) => Object.assign(new Error(message), {code});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateWikiContext(env) {
  if (env.GITHUB_REPOSITORY !== WIKI_REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    throw fail('WIKI_CONTEXT', 'Wiki publication requires djshellshoxxx/websoundedit, refs/heads/main and a full lowercase GITHUB_SHA.');
  }
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN || env.GITHUB_TOKEN.length > 4096 || /[\s\0]/.test(env.GITHUB_TOKEN)) {
    throw fail('WIKI_TOKEN', 'Wiki publication requires the existing repository-scoped GITHUB_TOKEN.');
  }
  return {sha:env.GITHUB_SHA, token:env.GITHUB_TOKEN};
}

export async function readWikiSources(sourceDir) {
  const directory = resolve(sourceDir);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw fail('WIKI_SOURCE', 'Wiki sources must be a real, nonsymlinked directory.');
  const entries = (await readdir(directory, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  if (!entries.length || entries.length > WIKI_LIMITS.pages) throw fail('WIKI_SOURCE', 'Wiki sources must contain 1–32 flat Markdown files.');
  const files = [], folded = new Set(); let total = 0;
  for (const entry of entries) {
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9-]{0,95}|_Sidebar|_Footer)\.md$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw fail('WIKI_SOURCE', 'Wiki sources accept only flat, regular Markdown files with safe page names.');
    if (folded.has(entry.name.toLowerCase())) throw fail('WIKI_SOURCE', 'Wiki source names must be distinct without case differences.');
    folded.add(entry.name.toLowerCase());
    const handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > WIKI_LIMITS.pageBytes || total + info.size > WIKI_LIMITS.totalBytes) throw fail('WIKI_SOURCE', 'Wiki sources exceed the 128 KiB per-page or 1 MiB total limit, or contain an empty page.');
      const buffer = Buffer.alloc(info.size + 1); let size = 0;
      while (size < buffer.length) {const read = await handle.read(buffer, size, buffer.length-size, size); if (!read.bytesRead) break; size += read.bytesRead;}
      if (size !== info.size) throw fail('WIKI_SOURCE', 'A wiki source changed size while being read; retry from an immutable checkout.');
      const bytes = buffer.subarray(0, size);
      try {if (new TextDecoder('utf-8', {fatal:true}).decode(bytes).includes('\0')) throw new Error('NUL');}
      catch {throw fail('WIKI_SOURCE', 'Wiki Markdown must be valid UTF-8 without NUL bytes.');}
      total += size; files.push({name:entry.name, bytes, sha256:hash(bytes)});
    } finally {await handle.close();}
  }
  const required = ['Home.md', 'User-Guide.md', 'Developer-Guide.md', '_Sidebar.md'];
  if (required.some(name=>!files.some(file=>file.name === name))) throw fail('WIKI_SOURCE', 'Wiki sources must include Home.md, User-Guide.md, Developer-Guide.md and _Sidebar.md.');
  return files;
}

async function runGit(args, options) {
  const {stdout} = await execute('git', ['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','core.autocrlf=false','-c','commit.gpgsign=false',...args], {...options, encoding:'utf8', timeout:60000, maxBuffer:2 * 1024 * 1024});
  return stdout;
}

function gitEnvironment(env, askpass, token) {
  const result = {...env};
  for (const key of Object.keys(result)) if (key.startsWith('GIT_') || key === 'GITHUB_TOKEN' || key === 'WIKI_PUBLISH_TOKEN') delete result[key];
  return {...result, LC_ALL:'C', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_ALLOW_PROTOCOL:'https', GIT_TERMINAL_PROMPT:'0', GIT_ASKPASS:askpass, WIKI_PUBLISH_TOKEN:token};
}

async function responseBytes(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw fail('WIKI_VERIFY', 'Public wiki response has no body.');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) throw fail('WIKI_VERIFY', 'Public wiki response exceeds its expected byte limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {try {await reader.cancel();} finally {reader.releaseLock();}}
  return Buffer.concat(chunks, total);
}

async function fetchPublic(fetcher, url, limit, html=false) {
  const response = await fetcher(url, {redirect:'manual', headers:{Accept:html?'text/html':'text/plain'}, signal:AbortSignal.timeout(15000)});
  if (response.status !== 200 || response.redirected || response.url && response.url !== url) {
    try {await response.body?.cancel();} catch {}
    throw fail('WIKI_VERIFY', 'Public wiki URL did not return HTTP 200 without a redirect: ' + url + ' (HTTP ' + response.status + ').');
  }
  if (html && !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    try {await response.body?.cancel();} catch {}
    throw fail('WIKI_VERIFY', 'Public wiki page did not return HTML: ' + url);
  }
  const bytes = await responseBytes(response, limit);
  if (html && !/<(?:!doctype\s+html|html)(?:\s|>)/i.test(bytes.toString('utf8'))) throw fail('WIKI_VERIFY', 'Public wiki page is not an HTML document: ' + url);
  return bytes;
}

export async function verifyWikiPublic(files, {commit, fetcher=globalThis.fetch, wait=pause, attempts=6}={}) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw fail('WIKI_VERIFY', 'Invalid wiki verification bounds.');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const verified = [];
      for (const file of files) {
        const suffix = '?websoundedit_publish=' + commit;
        const rawUrl = RAW_BASE + '/' + encodeURIComponent(file.name);
        const bytes = await fetchPublic(fetcher, rawUrl + suffix, file.bytes.length + 1);
        if (!bytes.equals(file.bytes)) throw fail('WIKI_VERIFY', 'Public raw wiki bytes differ from the verified source: ' + file.name);
        const stem = file.name.slice(0, -3);
        const pageUrl = stem.startsWith('_') ? null : PUBLIC_BASE + (stem === 'Home' ? '' : '/' + encodeURIComponent(stem));
        if (pageUrl) await fetchPublic(fetcher, pageUrl + suffix, WIKI_LIMITS.htmlBytes, true);
        verified.push({name:file.name, pageUrl, rawUrl, sha256:file.sha256});
      }
      return verified;
    } catch (error) {lastError = error; if (attempt + 1 < attempts) await wait(5000);}
  }
  throw fail('WIKI_VERIFY', 'Wiki Git publication was not confirmed by public page and raw-byte verification. ' + (lastError?.code === 'WIKI_VERIFY' ? lastError.message : 'Public fetch failed.'));
}

/** Injected git/fetch functions are for local tests; the CLI accepts no destination override. */
export async function publishWiki({env=process.env, sourceDir=DEFAULT_SOURCE, temporaryDirectory=tmpdir(), git=runGit, fetcher=globalThis.fetch, wait=pause, verificationAttempts=6}={}) {
  const {sha, token} = validateWikiContext(env);
  const files = await readWikiSources(sourceDir);
  const working = await mkdtemp(join(temporaryDirectory, 'websoundedit-wiki-'));
  const checkout = join(working, 'checkout'), askpass = join(working, 'askpass.sh');
  try {
    await chmod(working, 0o700);
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' \'x-access-token\' ;;\n  *Password*) printf \'%s\\n\' "$WIKI_PUBLISH_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', {mode:0o700, flag:'wx'});
    const childEnv = gitEnvironment(env, askpass, token);
    const call = async args => {
      try {return await git(args, {cwd:checkout, env:childEnv});}
      catch {throw fail('WIKI_GIT', 'Wiki Git operation failed: ' + args[0] + '. No command output or credentials were logged.');}
    };
    try {await git(['clone','--no-tags','--depth=1','--single-branch','--',WIKI_REMOTE,checkout], {cwd:working, env:childEnv});}
    catch {throw fail('WIKI_UNAVAILABLE', 'Cannot clone ' + WIKI_REMOTE + '. If this wiki has no initial page, create and save Home through the repository Wiki tab, then rerun the verified main publication. Otherwise check wiki availability and the existing repository-scoped token access. No credentials or repository settings were changed.');}
    if ((await call(['remote','get-url','origin'])).trim() !== WIKI_REMOTE) throw fail('WIKI_REMOTE', 'Wiki origin differs from the fixed repository; refusing publication.');
    let ref, defaultRef;
    try {
      ref = (await call(['symbolic-ref','--quiet','HEAD'])).trim();
      defaultRef = (await call(['symbolic-ref','--quiet','refs/remotes/origin/HEAD'])).trim();
      await call(['rev-parse','--verify','HEAD']);
    } catch {throw fail('WIKI_UNINITIALIZED', 'The wiki has no readable initialized default branch. Create and save its initial Home page through the repository Wiki tab, then rerun the verified main publication.');}
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || defaultRef !== 'refs/remotes/origin/' + ref.slice(11)) throw fail('WIKI_BRANCH', 'The wiki must have an initialized default branch.');
    await call(['check-ref-format', ref]);
    if ((await call(['status','--porcelain'])).trim()) throw fail('WIKI_DIRTY', 'The freshly cloned wiki is not clean.');
    for (const file of files) {
      let target;
      try {target = await lstat(join(checkout, file.name));} catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (target && (!target.isFile() || target.isSymbolicLink())) throw fail('WIKI_TARGET', 'Refusing to replace a wiki target that is not a regular file: ' + file.name);
    }
    for (let index = 0; index < files.length; index++) {
      const file = files[index], staged = join(working, 'page-' + index);
      await writeFile(staged, file.bytes, {flag:'wx', mode:0o644});
      await rename(staged, join(checkout, file.name));
    }
    await call(['add','--',...files.map(file=>file.name)]);
    const staged = (await call(['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
    if (staged.some(name=>!files.some(file=>file.name === name))) throw fail('WIKI_STAGING', 'Wiki staging contains an unrelated path.');
    if (staged.length) await call(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m','Publish WebSoundEdit wiki from ' + sha]);
    const commit = (await call(['rev-parse','HEAD'])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw fail('WIKI_COMMIT', 'The wiki did not produce a valid commit.');
    for (const file of files) if (!Buffer.from(await call(['show','HEAD:' + file.name]), 'utf8').equals(file.bytes)) throw fail('WIKI_CONTENT', 'Committed wiki bytes differ from the source: ' + file.name);
    if (staged.length) {
      try {await call(['push','--porcelain','origin','HEAD:' + ref]);}
      catch {throw fail('WIKI_PUSH', 'Wiki push failed, possibly because another writer updated it. No force push or rebase was attempted; review the wiki and rerun publication.');}
    }
    const remote = (await call(['ls-remote','--exit-code','origin',ref])).trim();
    if (remote !== commit + '\t' + ref) throw fail('WIKI_REMOTE_HEAD', 'The public wiki Git ref does not match the publication commit.');
    const pages = await verifyWikiPublic(files, {commit, fetcher, wait, attempts:verificationAttempts});
    return {repository:WIKI_REPOSITORY, sourceCommit:sha, wikiCommit:commit, changed:staged.length > 0, pages};
  } finally {await rm(working, {recursive:true, force:true});}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {console.log(JSON.stringify(await publishWiki(), null, 2));}
  catch (error) {console.error((error.code || 'WIKI_FAILED') + ': ' + (error.code?.startsWith('WIKI_') ? error.message : 'Wiki publication failed; no success was recorded.')); process.exitCode = 1;}
}
