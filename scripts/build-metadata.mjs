import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic metadata keeps retried builds of one source commit byte-identical. */
export function buildMetadata({cwd=process.cwd(), env=process.env}={}) {
  const version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  let commit = env.GITHUB_SHA || null, sourceDate = null;
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('GITHUB_SHA must be a full lowercase commit SHA.');
  const git = args => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
  const hasGit = existsSync(join(cwd, '.git'));
  if (!commit && hasGit) try {commit = git(['rev-parse', 'HEAD']);} catch { /* A source archive may have no Git metadata. */ }
  if (commit && hasGit) try {sourceDate = new Date(Number(git(['show', '-s', '--format=%ct', '--no-show-signature', commit])) * 1000).toISOString();} catch { /* Archives can identify a commit without its local Git object. */ }
  return {version, commit, sourceDate};
}
