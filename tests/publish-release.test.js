import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMetadata } from '../scripts/build-metadata.mjs';
import { fileDigest, publishRelease, releasePlan, verifyReleaseAssets } from '../scripts/publish-release.mjs';
import { packageRelease } from '../scripts/package-release.mjs';

const execute = promisify(execFile);
const context = () => ({...process.env, GITHUB_REPOSITORY:'djshellshoxxx/websoundedit', GITHUB_REF:'refs/heads/main', GITHUB_SHA:'a'.repeat(40)});
const missing = () => Object.assign(new Error('missing'), {stderr:'gh: Not Found (HTTP 404)'});

async function fixture(t, version='1.0.0-beta.2') {
  const cwd = await mkdtemp(join(tmpdir(), 'websoundedit-release-test-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const env = context(), plan = releasePlan({version}, env);
  for (const directory of ['dist', 'artifacts', 'docs/releases']) await mkdir(join(cwd, directory), {recursive:true});
  await writeFile(join(cwd, 'package.json'), JSON.stringify({version}));
  await writeFile(join(cwd, 'dist/build.json'), JSON.stringify({version, commit:env.GITHUB_SHA}));
  await writeFile(join(cwd, plan.notesPath), '# Verified ' + version + '\n');
  await writeFile(join(cwd, 'artifacts/RELEASE_NOTES.md'), '# Verified ' + version + '\n');
  let checksums = '';
  for (const name of plan.archives) {
    await writeFile(join(cwd, 'artifacts', name), 'Synthetic archive for ' + name + '\n');
    checksums += (await fileDigest(join(cwd, 'artifacts', name))).sha256 + '  ' + name + '\n';
  }
  await writeFile(join(cwd, 'artifacts/SHA256SUMS.txt'), checksums);
  const assets = await verifyReleaseAssets(plan, cwd);
  const remoteAssets = () => assets.map((asset, index) => ({id:index+1, name:asset.name, size:asset.size, state:'uploaded', digest:'sha256:' + asset.sha256,
    browser_download_url:'https://github.com/' + plan.repository + '/releases/download/' + plan.tag + '/' + asset.name}));
  const release = () => ({id:101, tag_name:plan.tag, prerelease:true, draft:false, assets:remoteAssets(), html_url:'https://github.com/' + plan.repository + '/releases/tag/' + plan.tag});
  const state = {ref:null, release:null, calls:[]};
  const gh = async args => {
    state.calls.push(args);
    if (args[0] === 'api') {
      if (args[1].includes('/git/ref/tags/')) {if (!state.ref) throw missing(); return JSON.stringify(state.ref);}
      if (args[1].includes('/git/tags/')) return JSON.stringify({object:{type:'commit', sha:env.GITHUB_SHA}});
      if (args[1].includes('/releases/tags/')) {if (!state.release) throw missing(); return JSON.stringify(state.release);}
    }
    if (args[0] === 'release' && args[1] === 'create') {state.ref={object:{type:'commit', sha:env.GITHUB_SHA}}; state.release=release(); return state.release.html_url;}
    if (args[0] === 'release' && args[1] === 'upload') {state.release.assets.push(...remoteAssets().filter(asset => args.includes('artifacts/' + asset.name))); return '';}
    throw new Error('Unexpected transport call: ' + args.join(' '));
  };
  return {cwd, env, plan, assets, release, state, gh, options:{cwd, env, gh}};
}

test('release names and notes follow the package prerelease version with safe main-only context', () => {
  const plan = releasePlan({version:'1.0.0-beta.2'}, context());
  assert.equal(plan.tag, 'v1.0.0-beta.2');
  assert.equal(plan.notesPath, 'docs/releases/1.0.0-beta.2.md');
  assert.deepEqual(plan.archives, ['websoundedit-web-1.0.0-beta.2.zip', 'websoundedit-companion-1.0.0-beta.2.tar.gz']);
  for (const version of ['1.0.0', '../secret', '01.0.0-beta.2', '1.0.0-beta.02', '1.0.0-beta.2\n', null]) assert.throws(() => releasePlan({version}, context()), {code:'RELEASE_VERSION'});
  for (const patch of [{GITHUB_REPOSITORY:'other/repo'}, {GITHUB_REF:'refs/pull/1/merge'}, {GITHUB_SHA:'main'}]) assert.throws(() => releasePlan({version:'1.0.0-beta.2'}, {...context(), ...patch}), {code:'RELEASE_CONTEXT'});
});

test('a new version publishes its own archives and verifies exact remote tag and uploaded bytes', async t => {
  const f = await fixture(t), result = await publishRelease(f.options);
  assert.equal(result.status, 'verified'); assert.equal(result.version, '1.0.0-beta.2'); assert.equal(result.sourceCommit, f.env.GITHUB_SHA);
  assert.equal(result.changed, true); assert.equal(result.assets.length, 4);
  const create = f.state.calls.find(args => args[0] === 'release');
  assert.deepEqual(create.slice(0, 7), ['release', 'create', f.plan.tag, '--repo', f.plan.repository, '--target', f.env.GITHUB_SHA]);
  assert.ok(create.includes(f.plan.notesPath));
  for (const name of f.plan.assets) assert.ok(create.includes('artifacts/' + name));
  assert.equal(f.state.calls.filter(args => args[0] === 'api' && args[1].includes('/git/ref/tags/')).length, 2);
});

test('the same published commit and assets are verified without mutation, including annotated tags', async t => {
  const f = await fixture(t);
  f.state.ref = {object:{type:'tag', sha:'b'.repeat(40)}}; f.state.release = f.release();
  const result = await publishRelease(f.options);
  assert.equal(result.changed, false);
  assert.equal(f.state.calls.some(args => args[0] === 'release'), false);
});

test('another commit on the same version is never force-pushed or overwritten', async t => {
  const f = await fixture(t);
  f.state.ref = {object:{type:'commit', sha:'b'.repeat(40)}}; f.state.release = f.release();
  await assert.rejects(publishRelease(f.options), {code:'RELEASE_TAG'});
  assert.equal(f.state.calls.length, 1);
});

test('a matching tag left before release creation can be retried', async t => {
  const f = await fixture(t);
  f.state.ref = {object:{type:'commit', sha:f.env.GITHUB_SHA}};
  const result = await publishRelease(f.options);
  assert.equal(result.changed, true);
  assert.equal(f.state.calls.filter(args => args[0] === 'release' && args[1] === 'create').length, 1);
});

test('partial publication retries only absent assets after checking existing bytes', async t => {
  const f = await fixture(t);
  f.state.ref = {object:{type:'commit', sha:f.env.GITHUB_SHA}}; f.state.release = f.release();
  f.state.release.assets = f.state.release.assets.slice(0, 2);
  const result = await publishRelease(f.options);
  assert.equal(result.changed, true);
  assert.deepEqual(f.state.calls.find(args => args[0] === 'release'), ['release', 'upload', f.plan.tag, '--repo', f.plan.repository, 'artifacts/SHA256SUMS.txt', 'artifacts/RELEASE_NOTES.md']);
  assert.equal(f.state.calls.some(args => args.includes('--clobber') || args.includes('--force')), false);
});

test('tampered, ambiguous, unready or mismatched remote releases fail before any upload', async t => {
  const f = await fixture(t); f.state.ref = {object:{type:'commit', sha:f.env.GITHUB_SHA}};
  for (const modify of [
    release => {release.assets[0].digest = 'sha256:' + '0'.repeat(64);},
    release => {release.assets[0].size++;},
    release => {release.assets[0].state = 'starter';},
    release => {release.assets.push(release.assets[0]);},
    release => {release.draft = true;},
    release => {release.prerelease = false;},
    release => {release.tag_name = 'v0.0.0-beta.1';}
  ]) {
    f.state.release = f.release(); f.state.calls = []; modify(f.state.release);
    await assert.rejects(publishRelease(f.options), error => ['RELEASE_ASSET', 'RELEASE_STATE'].includes(error.code));
    assert.equal(f.state.calls.some(args => args[0] === 'release'), false);
  }
});

test('missing tag and unexpected API failures cannot authorize a release mutation', async t => {
  const f = await fixture(t); f.state.release = f.release();
  await assert.rejects(publishRelease(f.options), {code:'RELEASE_TAG'});
  let calls = 0;
  await assert.rejects(publishRelease({...f.options, gh:async () => {calls++; throw Object.assign(new Error('permission'), {stderr:'HTTP 403 Forbidden'});}}), /permission/);
  assert.equal(calls, 1);
});

test('build/source version and commit, checksums, notes and file types are checked before transport', async t => {
  const f = await fixture(t), buildPath=join(f.cwd, 'dist/build.json');
  for (const build of [{version:'1.0.0-beta.1', commit:f.env.GITHUB_SHA}, {version:f.plan.version, commit:'b'.repeat(40)}]) {
    await writeFile(buildPath, JSON.stringify(build));
    await assert.rejects(publishRelease(f.options), {code:'RELEASE_BUILD'});
  }
  await writeFile(buildPath, JSON.stringify({version:f.plan.version, commit:f.env.GITHUB_SHA}));
  const checksumPath=join(f.cwd, 'artifacts/SHA256SUMS.txt'), checksums=await readFile(checksumPath);
  await writeFile(checksumPath, 'incorrect\n'); await assert.rejects(publishRelease(f.options), {code:'RELEASE_CHECKSUMS'}); await writeFile(checksumPath, checksums);
  await writeFile(join(f.cwd, 'artifacts/RELEASE_NOTES.md'), 'old notes\n'); await assert.rejects(publishRelease(f.options), {code:'RELEASE_NOTES'});
  const archive=join(f.cwd, 'artifacts', f.plan.archives[0]); await rm(archive); await symlink(join(f.cwd, 'package.json'), archive);
  await assert.rejects(publishRelease(f.options), {code:'RELEASE_ASSET'});
  assert.equal(f.state.calls.length, 0);
});

test('publication does not report success when the new remote assets fail verification', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRelease({...f.options, gh:async args => {
    const result = await f.gh(args);
    if (args[0] === 'release' && args[1] === 'create') f.state.release.assets[0].digest = null;
    return result;
  }}), {code:'RELEASE_ASSET'});
});

test('real packaging is versioned, uses exact committed source and produces reproducible web archives', async t => {
  const f = await fixture(t), run = async args => (await execute('git', args, {cwd:f.cwd, encoding:'utf8'})).stdout.trim();
  await writeFile(join(f.cwd, '.gitignore'), 'dist/\nartifacts/\n');
  await writeFile(join(f.cwd, 'app.txt'), 'committed source\n');
  await writeFile(join(f.cwd, 'dist/index.html'), '<!doctype html><title>Fixture</title>\n');
  await run(['init', '--initial-branch=main']);
  await run(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'add', '.']);
  await run(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Versioned source']);
  f.env.GITHUB_SHA = await run(['rev-parse', 'HEAD']);
  const metadata = buildMetadata({cwd:f.cwd, env:f.env});
  assert.equal(metadata.commit, f.env.GITHUB_SHA); assert.equal(metadata.version, f.plan.version);
  assert.equal(metadata.sourceDate, new Date(Number(await run(['show', '-s', '--format=%ct', 'HEAD'])) * 1000).toISOString());
  await writeFile(join(f.cwd, 'dist/build.json'), JSON.stringify(metadata));
  const first = await packageRelease({cwd:f.cwd, env:f.env});
  assert.equal(first.version, f.plan.version);
  assert.equal(first.sourceCommit, f.env.GITHUB_SHA);
  const webFile=join(f.cwd, 'artifacts', f.plan.archives[0]);
  const names=JSON.parse((await execute('python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', webFile], {encoding:'utf8'})).stdout);
  assert.deepEqual(names, ['dist/', 'dist/build.json', 'dist/index.html']);
  const sourceNames=(await execute('tar', ['-tzf', join(f.cwd, 'artifacts', f.plan.archives[1])], {encoding:'utf8'})).stdout;
  assert.match(sourceNames, /app\.txt/); assert.ok(!sourceNames.includes('dist/')); assert.ok(!sourceNames.includes('artifacts/'));
  await utimes(join(f.cwd, 'dist/index.html'), new Date('2000-01-01'), new Date('2000-01-01'));
  await writeFile(join(f.cwd, 'dist/build.json'), JSON.stringify(buildMetadata({cwd:f.cwd, env:f.env})));
  const second = await packageRelease({cwd:f.cwd, env:f.env});
  assert.deepEqual(second.assets, first.assets, 'all package bytes remain identical when filesystem timestamps change');
  await writeFile(join(f.cwd, 'app.txt'), 'uncommitted change\n');
  await assert.rejects(packageRelease({cwd:f.cwd, env:f.env}), /uncommitted tracked changes/);
});

test('source archives build stable metadata without inventing a commit or timestamp', async t => {
  const f = await fixture(t); const env={...f.env}; delete env.GITHUB_SHA;
  assert.deepEqual(buildMetadata({cwd:f.cwd, env}), {version:f.plan.version, commit:null, sourceDate:null});
  assert.throws(() => buildMetadata({cwd:f.cwd, env:{...env, GITHUB_SHA:'--all'}}), /full lowercase commit SHA/);
});
