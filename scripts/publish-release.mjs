/** Publish the version in the verified main checkout without moving an existing tag. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export const RELEASE_REPOSITORY = 'djshellshoxxx/websoundedit';
const fail = (code, message) => Object.assign(new Error(message), {code});

export function releasePlan(packageInfo, env) {
  if (env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    throw fail('RELEASE_CONTEXT', 'Release publication requires the verified main job and its full commit SHA.');
  }
  const version = packageInfo?.version;
  const match = typeof version === 'string' && version.length <= 80 && version.match(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/);
  if (!match || match[1].split('.').some(part => /^0\d+$/.test(part))) {
    throw fail('RELEASE_VERSION', 'The prerelease publisher requires a safe semantic prerelease version in package.json.');
  }
  const archives = ['websoundedit-web-' + version + '.zip', 'websoundedit-companion-' + version + '.tar.gz'];
  return {repository:RELEASE_REPOSITORY, sha:env.GITHUB_SHA, version, tag:'v' + version, title:'WebSoundEdit ' + version,
    notesPath:'docs/releases/' + version + '.md', archives, assets:[...archives, 'SHA256SUMS.txt', 'RELEASE_NOTES.md']};
}

export async function fileDigest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 512 * 1024 * 1024) throw fail('RELEASE_ASSET', 'Release assets must be nonempty regular files up to 512 MiB.');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return {size:stat.size, sha256:digest.digest('hex')};
}

export async function readReleasePlan({cwd=process.cwd(), env=process.env}={}) {
  const plan = releasePlan(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')), env);
  const build = JSON.parse(await readFile(join(cwd, 'dist/build.json'), 'utf8'));
  if (build.version !== plan.version || build.commit !== plan.sha) throw fail('RELEASE_BUILD', 'The built application version and commit must match the verified source.');
  return plan;
}

export async function verifyReleaseAssets(plan, cwd=process.cwd()) {
  const assets = [];
  for (const name of plan.assets) assets.push({name, ...await fileDigest(join(cwd, 'artifacts', name))});
  const checksums = await readFile(join(cwd, 'artifacts/SHA256SUMS.txt'), 'utf8');
  const expected = plan.archives.map(name => assets.find(asset => asset.name === name).sha256 + '  ' + name + '\n').join('');
  if (checksums !== expected) throw fail('RELEASE_CHECKSUMS', 'The packaged archive checksums differ from the local release assets.');
  const notes = await readFile(join(cwd, plan.notesPath));
  if (!notes.equals(await readFile(join(cwd, 'artifacts/RELEASE_NOTES.md')))) throw fail('RELEASE_NOTES', 'The packaged release notes differ from this version\'s source notes.');
  return assets;
}

async function runGh(args, options) {
  return (await execute('gh', args, {...options, encoding:'utf8', timeout:120000, maxBuffer:2 * 1024 * 1024})).stdout;
}

/** Injected transport supports local regression tests; the CLI has no repository override. */
export async function publishRelease({cwd=process.cwd(), env=process.env, gh=runGh}={}) {
  const plan = await readReleasePlan({cwd, env});
  const assets = await verifyReleaseAssets(plan, cwd);
  const call = args => gh(args, {cwd, env});
  const api = async path => JSON.parse(await call(['api', path]));
  const refPath = 'repos/' + plan.repository + '/git/ref/tags/' + plan.tag;
  const releasePath = 'repos/' + plan.repository + '/releases/tags/' + plan.tag;
  const optional = async path => {
    try {return await api(path);}
    catch (error) {if (/\bHTTP 404\b|\bNot Found\b/.test(error.stderr || '')) return null; throw error;}
  };
  const verifyRef = async ref => {
    let object = ref?.object;
    for (let depth=0; object?.type === 'tag' && depth<4; depth++) object = (await api('repos/' + plan.repository + '/git/tags/' + object.sha)).object;
    if (object?.type !== 'commit' || object.sha !== plan.sha) throw fail('RELEASE_TAG', 'The existing prerelease tag points to another commit; publish a new package version instead of replacing it.');
  };
  const verifyRelease = (release, allowMissing=false) => {
    if (release.tag_name !== plan.tag || !release.prerelease || release.draft || !Array.isArray(release.assets)) throw fail('RELEASE_STATE', 'Existing release is not the expected published prerelease.');
    const missing = [];
    for (const expected of assets) {
      const matches = release.assets.filter(asset => asset.name === expected.name);
      if (!matches.length && allowMissing) {missing.push(expected.name); continue;}
      if (matches.length !== 1) throw fail('RELEASE_ASSET', 'Release assets are missing or ambiguous: ' + expected.name);
      const actual = matches[0];
      if (actual.state !== 'uploaded' || actual.size !== expected.size || actual.digest !== 'sha256:' + expected.sha256) {
        throw fail('RELEASE_ASSET', 'Published asset bytes do not match the verified package: ' + expected.name);
      }
    }
    return missing;
  };
  const ref = await optional(refPath);
  if (ref) await verifyRef(ref);
  let release = await optional(releasePath), changed=false;
  if (release) {
    if (!ref) throw fail('RELEASE_TAG', 'A published prerelease has no readable tag; refusing to modify it.');
    const missing = verifyRelease(release, true);
    if (missing.length) {
      // Retry an interrupted upload only after all existing assets match. Never overwrite an asset.
      await call(['release', 'upload', plan.tag, '--repo', plan.repository, ...missing.map(name => 'artifacts/' + name)]);
      changed = true;
    }
  } else {
    await call(['release', 'create', plan.tag, '--repo', plan.repository, '--target', plan.sha, '--prerelease',
      '--title', plan.title, '--notes-file', plan.notesPath, ...plan.assets.map(name => 'artifacts/' + name)]);
    changed = true;
  }
  await verifyRef(await api(refPath));
  release = await api(releasePath);
  verifyRelease(release);
  return {status:'verified', repository:plan.repository, sourceCommit:plan.sha, version:plan.version, tag:plan.tag, changed,
    url:release.html_url, releaseId:release.id, assets:assets.map(asset => ({...asset, url:release.assets.find(item => item.name === asset.name).browser_download_url}))};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {console.log(JSON.stringify(await publishRelease(), null, 2));}
  catch (error) {
    const code = error.code?.startsWith('RELEASE_') ? error.code : 'RELEASE_FAILED';
    const message = code === 'RELEASE_FAILED' ? 'Release publication failed; no success was recorded. Check the GitHub release and rerun the verified main job.' : error.message;
    console.log(JSON.stringify({status:'failed', code, message}, null, 2));
    console.error(code + ': ' + message);
    process.exitCode = 1;
  }
}
