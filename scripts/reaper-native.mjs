/** Native REAPER verification helpers. Run on a clean runner under xvfb-run.
 * Official Linux x86-64 REAPER 7.86 archive (2026-11-13):
 * https://www.reaper.fm/files/7.x/reaper786_linux_x86_64.tar.xz
 * SHA256 c2f9d8616bd1dc6175993b82451e1c6e352c6761e7ae6d72400a3f3dfb03bedb
 * REAPER's fully functional evaluation is used without changing its license state.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const REAPER_VERSION = '7.86';
export const REAPER_ARCHIVE_SHA256 = 'c2f9d8616bd1dc6175993b82451e1c6e352c6761e7ae6d72400a3f3dfb03bedb';
export const luaString = value => JSON.stringify(String(value)).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

export async function nativeReaper(directory, script, { project, timeoutMs = 90000 } = {}) {
  directory = path.resolve(directory); await mkdir(directory, { recursive: true });
  const config = path.join(directory, 'profile'); await mkdir(config, { recursive: true });
  // A dedicated dummy device does not require a physical interface or sound server.
  // No trial/license/preferences from a user's installation are read or changed.
  const ini = path.join(config, 'reaper.ini');
  await writeFile(ini, '[reaper]\naudiocfgopen=0\n[audioconfig]\nmode=0\naudiodev=dummy\n');
  const scriptPath = path.join(directory, 'verify.lua'), outcomePath = path.join(directory, 'script-outcome.txt');
  await writeFile(scriptPath, `local function run()\n${script}\nend\nlocal ok, err = xpcall(run, debug.traceback)\nlocal out = assert(io.open(${luaString(outcomePath)}, "wb"))\nout:write(ok and "OK\\n" or tostring(err))\nout:close()\nif ok then reaper.Main_OnCommand(40004, 0) end\n`);
  const args = ['-newinst', '-nosplash', '-cfgfile', ini, ...(project ? [path.resolve(project)] : []), scriptPath];
  await writeFile(path.join(directory, 'invocation.json'), JSON.stringify({ executable: process.env.REAPER_BIN || 'reaper', args }, null, 2));
  const log = createWriteStream(path.join(directory, 'reaper.log'));
  const child = spawn(process.env.REAPER_BIN || 'reaper', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const outcome = await readFile(outcomePath, 'utf8').catch(() => 'The native Lua script did not finish.');
    await writeFile(path.join(directory, 'process.json'), JSON.stringify({ ...result, timedOut, outcome }, null, 2));
    if (timedOut || result.code !== 0 || outcome !== 'OK\n') throw new Error(`Native REAPER verification failed (${timedOut ? 'timeout' : `exit ${result.code}`}): ${outcome}`);
  } finally { clearTimeout(timer); log.end(); }
}

export function configureRenderLua(directory, stem, channels, seconds, sampleRate = 48000) {
  return `
reaper.GetSetProjectInfo(0, "PROJECT_SRATE", ${sampleRate}, true)
reaper.GetSetProjectInfo(0, "PROJECT_SRATE_USE", 1, true)
reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_CHANNELS", ${channels}, true)
reaper.GetSetProjectInfo(0, "RENDER_SRATE", ${sampleRate}, true)
reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_STARTPOS", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_ENDPOS", ${seconds}, true)
reaper.GetSetProjectInfo(0, "RENDER_TAILFLAG", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_DITHER", 16, true)
reaper.GetSetProjectInfo(0, "RENDER_NORMALIZE", 0, true)
assert(reaper.GetSetProjectInfo_String(0, "RENDER_FILE", ${luaString(path.resolve(directory))}, true))
assert(reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", ${luaString(stem)}, true))
assert(reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "evaw", true))
assert(reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT2", "", true))
`;
}
