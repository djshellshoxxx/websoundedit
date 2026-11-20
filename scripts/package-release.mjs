/** Package the exact verified source and build using package.json as the version source. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileDigest, readReleasePlan, verifyReleaseAssets } from './publish-release.mjs';

const execute = promisify(execFile);
const zipSource = `import datetime, pathlib, stat, sys, zipfile
root = pathlib.Path('dist')
stamp = max(315532800, min(4354819198, int(sys.argv[2])))
date = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).timetuple()[:6]
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in [root, *sorted(root.rglob('*'))]:
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Release builds must contain only regular files and directories')
        directory = path.is_dir()
        info = zipfile.ZipInfo(path.as_posix() + ('/' if directory else ''), date_time=date)
        info.create_system = 3
        info.external_attr = ((stat.S_IFDIR | 0o755) if directory else (stat.S_IFREG | 0o644)) << 16
        if directory:
            info.external_attr |= 0x10
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, b'' if directory else path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
`;

export async function packageRelease({cwd=process.cwd(), env=process.env}={}) {
  const plan = await readReleasePlan({cwd, env});
  const run = async (command, args) => (await execute(command, args, {cwd, env, encoding:'utf8', timeout:120000, maxBuffer:2 * 1024 * 1024})).stdout;
  if ((await run('git', ['rev-parse', 'HEAD'])).trim() !== plan.sha) throw new Error('Release source HEAD differs from the verified commit.');
  if ((await run('git', ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Release source contains uncommitted tracked changes.');
  // Fail for missing version notes before generating either archive.
  await readFile(join(cwd, plan.notesPath));
  await mkdir(join(cwd, 'artifacts'), {recursive:true});
  const [web, companion] = plan.archives.map(name => 'artifacts/' + name);
  const timestamp = (await run('git', ['show', '-s', '--format=%ct', '--no-show-signature', plan.sha])).trim();
  await rm(join(cwd, web), {force:true});
  await run('python3', ['-c', zipSource, web, timestamp]);
  await run('git', ['archive', '--format=tar.gz', '--output=' + companion, plan.sha]);
  await copyFile(join(cwd, plan.notesPath), join(cwd, 'artifacts/RELEASE_NOTES.md'));
  let checksums = '';
  for (const name of plan.archives) checksums += (await fileDigest(join(cwd, 'artifacts', name))).sha256 + '  ' + name + '\n';
  await writeFile(join(cwd, 'artifacts/SHA256SUMS.txt'), checksums);
  const assets = await verifyReleaseAssets(plan, cwd);
  return {sourceCommit:plan.sha, version:plan.version, tag:plan.tag, assets};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {console.log(JSON.stringify(await packageRelease(), null, 2));}
  catch {console.error('Release packaging failed. Check the verified source/build commits, package version, release notes and clean checkout.'); process.exitCode = 1;}
}
