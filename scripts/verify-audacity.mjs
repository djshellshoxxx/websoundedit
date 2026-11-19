#!/usr/bin/env node
/** Native interoperability gate. Run on a Linux runner with audacity, xvfb,
 * and xauth installed: xvfb-run -a node scripts/verify-audacity.mjs
 * Reference commands: https://manual.audacityteam.org/man/scripting_reference.html
 * No existing Audacity configuration is edited. All XDG paths are private fixtures.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, constants, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, open, stat, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { AudioEditor } from '../src/engine.js';
import { exportAudacity, importAudacity } from '../src/audacity.js';
import { encodeWav, decodeWav } from '../src/wav.js';

const output = path.resolve(process.env.AUDACITY_TEST_OUTPUT || 'test-results/native-audacity');
const executable = process.env.AUDACITY_EXECUTABLE || 'audacity';
const sampleRate = 48000;
const uid = process.getuid();
const toPipe = `/tmp/audacity_script_pipe.to.${uid}`, fromPipe = `/tmp/audacity_script_pipe.from.${uid}`;
const report = { passed: false, cases: [], sampleRate, notes: ['Native hardware audio I/O is not used. Audio is exported to disk and compared numerically.'] };
const quoted = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
await mkdir(output, { recursive: true });

function pcm(frequencies, seconds = 1) {
  return { sampleRate, channels: frequencies.map((frequency, channel) => Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => (.15 - channel * .03) * Math.sin(2 * Math.PI * frequency * i / sampleRate))) };
}

async function fixture() {
  const editor = new AudioEditor({ name: 'Native interchange', sampleRate });
  const mono = await editor.execute('clip.add', { name: 'Mono clip', trackName: 'Mono track', start: .25, audio: pcm([440]) });
  await editor.execute('clip.add', { trackId: mono.trackId, name: 'Mono overlap', start: .75, audio: pcm([220], .5) });
  await editor.execute('track.update', { trackId: mono.trackId, gainDb: -2, pan: -.4 });
  const stereo = await editor.execute('clip.add', { name: 'Stereo clip', trackName: 'Stereo track', start: .5, audio: pcm([660, 880]) });
  await editor.execute('track.update', { trackId: stereo.trackId, gainDb: -1, pan: .3 });
  await editor.execute('markers.add', { name: 'Verification label', time: .75 });
  await editor.execute('metadata.update', { metadata: { title: 'Native round trip', artist: 'WebSoundEdit', album: 'Interoperability', comment: 'Generated mono and stereo PCM' } });
  return editor;
}

function comparePCM(actual, expected, tolerance, label) {
  assert.equal(actual.sampleRate, expected.sampleRate, `${label}: sample rate`);
  assert.equal(actual.channels.length, expected.channels.length, `${label}: channel count`);
  let maximum = 0, squared = 0, samples = 0;
  for (let channel = 0; channel < expected.channels.length; channel++) {
    assert.equal(actual.channels[channel].length, expected.channels[channel].length, `${label}: frame count`);
    for (let i = 0; i < expected.channels[channel].length; i++) {
      const difference = Math.abs(actual.channels[channel][i] - expected.channels[channel][i]);
      assert.ok(Number.isFinite(difference), `${label}: finite PCM`);
      maximum = Math.max(maximum, difference); squared += difference * difference; samples++;
    }
  }
  assert.ok(maximum <= tolerance, `${label}: max PCM difference ${maximum} exceeds ${tolerance}`);
  return { maximumDifference: maximum, rmsDifference: Math.sqrt(squared / Math.max(samples, 1)), tolerance, frames: expected.channels[0].length, channels: expected.channels.length };
}

function parseInfo(response) {
  const json = response.replace(/BatchCommand finished:[\s\S]*$/, '').trim();
  return JSON.parse(json);
}

/** One native process per fixture keeps project selection and save paths isolated. */
async function nativeSession(label, action) {
  if (existsSync(toPipe) || existsSync(fromPipe)) throw new Error('An existing Audacity scripting pipe is present. Run this gate on a clean, dedicated runner.');
  // Audacity 3.4.2 prefers an existing legacy data directory over XDG paths.
  // Refuse that situation instead of touching the runner user's preferences.
  assert.ok(!existsSync(path.join(homedir(), '.audacity-data')), 'Native gate needs a clean runner without legacy Audacity preferences');
  const base = path.join(output, label), config = path.join(base, 'config', 'audacity');
  await mkdir(config, { recursive: true });
  const temp = path.join(base, 'temporary'); await mkdir(temp, { recursive: true });
  // ModuleSettings::GetModuleStatus requires matching path AND modification
  // time, otherwise an enabled module is reset to New and silently skipped.
  // https://github.com/audacity/audacity/blob/Audacity-3.4.2/libraries/lib-module-manager/ModuleSettings.cpp
  const modules = process.env.AUDACITY_SCRIPT_MODULE ? [process.env.AUDACITY_SCRIPT_MODULE] :
    execFileSync('dpkg-query', ['-L', 'audacity'], { encoding: 'utf8' }).split('\n').filter(file => file.endsWith('/mod-script-pipe.so'));
  assert.equal(modules.length, 1, 'Locate exactly one installed Audacity scripting module');
  const moduleFile = modules[0], moduleTime = (await stat(moduleFile)).mtime.toISOString().slice(0, 19);
  // The typed WAV exporter introduced in 3.4 reads a subtype (6 = float),
  // not the older combined header/subtype preference (65542).
  // https://github.com/audacity/audacity/blob/Audacity-3.4.2/modules/mod-pcm/ExportPCM.cpp
  const configText = `[Version]\nMajor=3\nMinor=4\nMicro=2\n[GUI]\nShowSplashScreen=0\n` +
    `[Module]\nmod-script-pipe=1\n[ModulePath]\nmod-script-pipe=${moduleFile}\n[ModuleDateTime]\nmod-script-pipe=${moduleTime}\n` +
    `[Directories]\nTempDir=${temp}\n[AudioIO]\nPlaybackDevice=\nRecordingDevice=\n[Warnings]\nFirstProjectSave=0\n` +
    `[Update]\nUpdateNoticeShown=1\nDefaultUpdatesChecking=0\n[Export]\nFormat=WAV\n` +
    `[FileFormats]\nExportFormat_SF1=65542\n[FileFormats/ExportFormat_SF1_Type]\nWAV_10000=6\n`;
  await writeFile(path.join(config, 'audacity.cfg'), configText, 'utf8');
  const transcript = [], pipeEvents = [];
  const log = createWriteStream(path.join(base, 'audacity.log'));
  const launchedAt = Date.now();
  const child = spawn(executable, [], {
    env: { ...process.env, TZ: 'UTC', XDG_CONFIG_HOME: path.join(base, 'config'), XDG_DATA_HOME: path.join(base, 'data'), XDG_CACHE_HOME: path.join(base, 'cache'), XDG_STATE_HOME: path.join(base, 'state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let spawnError; child.once('error', error => { spawnError = error; });
  // 'exit' identifies the native process ending. 'close' additionally waits for
  // inherited stdout/stderr handles, which a desktop helper can keep open.
  const childDone = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      pipeEvents.push({ at: new Date().toISOString(), nativeExit: { code, signal } });
      resolve({ code, signal });
    });
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
  });
  let writer, reader, pending = null, buffer = '';
  const failPending = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
  try {
    for (let i = 0; i < 300 && !(existsSync(toPipe) && existsSync(fromPipe)); i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Audacity exited before creating its scripting pipe (${child.exitCode}).`);
      await pause(100);
    }
    if (!existsSync(toPipe) || !existsSync(fromPipe)) throw new Error('Audacity scripting pipe was not ready within 30 seconds. Inspect the native log and first-run configuration.');
    writer = await open(toPipe, constants.O_WRONLY);
    reader = createReadStream(fromPipe, { encoding: 'utf8' });
    reader.on('data', chunk => {
      pipeEvents.push({ at: new Date().toISOString(), received: chunk });
      buffer += chunk;
      // ModuleInitialize starts the pipe before an active project exists.
      // ScriptCommandRelay returns an empty response in that state and
      // ScripterCallback sends exactly one newline. Only the readiness probe
      // accepts it; normal commands still require an explicit successful result.
      if (pending?.allowEmpty && buffer === '\n') {
        const request = pending; pending = null; buffer = ''; clearTimeout(request.timer);
        transcript.push({ command: request.command, response: '', startupNotReady: true });
        request.resolve(''); return;
      }
      const match = /BatchCommand finished: (OK|Failed!?)\s*\r?\n/.exec(buffer);
      if (!match || !pending) return;
      const response = buffer.slice(0, match.index + match[0].length).trim();
      buffer = buffer.slice(match.index + match[0].length);
      const request = pending; pending = null; clearTimeout(request.timer);
      transcript.push({ command: request.command, response });
      if (match[1] !== 'OK') request.reject(new Error(`Audacity rejected ${request.command}: ${response}`));
      else request.resolve(response);
    });
    reader.on('error', failPending);
    reader.on('end', () => failPending(new Error('Audacity closed the scripting pipe before replying.')));
    const command = (text, timeout = 30000, allowEmpty = false) => new Promise((resolve, reject) => {
      if (pending) { reject(new Error('Native commands must be serialized.')); return; }
      if (!buffer.trim()) buffer = '';
      pipeEvents.push({ at: new Date().toISOString(), sent: text });
      const timer = setTimeout(() => {
        pipeEvents.push({ at: new Date().toISOString(), timedOut: text, unparsedResponse: buffer });
        pending = null; reject(new Error(`Audacity command timed out: ${text}`));
      }, timeout);
      pending = { command: text, resolve, reject, timer, allowEmpty };
      writer.write(`${text}\n`).catch(error => failPending(error));
    });
    const readyUntil = Date.now() + 30000;
    let ready = false;
    while (Date.now() < readyUntil) {
      const response = await command('Message: Text="WebSoundEdit native interoperability"', Math.max(1, readyUntil - Date.now()), true);
      if (response) { assert.match(response, /WebSoundEdit native interoperability/); ready = true; break; }
      await pause(100);
    }
    assert.ok(ready, 'Audacity created an active project and completed the readiness command');
    const result = await action(command, base);
    // Closing a saved project checkpoints its SQLite WAL before the JS reader opens it.
    await command('Close:');
    // Native shutdown may close the scripting FIFO before the child-process
    // exit event arrives. Accept that order only when Audacity then exits 0.
    let exitError;
    try { await command('Exit:', 5000); } catch (error) { exitError = error; }
    // The final command is complete. Release the scripting transport before
    // waiting, so no server read is held open by this test client at shutdown.
    reader?.destroy(); await writer?.close().catch(() => {}); writer = null;
    const nativeExit = await Promise.race([childDone, pause(5000).then(() => null)]);
    if (!nativeExit) throw exitError || new Error(`Audacity did not exit after the Exit command (exitCode=${child.exitCode}, signal=${child.signalCode}).`);
    assert.equal(nativeExit.code, 0, `Audacity exited unsuccessfully (${nativeExit.signal || nativeExit.code})`);
    return result;
  } finally {
    failPending(new Error('Native session ended.'));
    reader?.destroy(); await writer?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const stopped = await Promise.race([childDone, pause(5000).then(() => null)]);
    if (!stopped) { child.kill('SIGKILL'); await childDone; }
    child.stdout.unpipe(log); child.stderr.unpipe(log);
    child.stdout.destroy(); child.stderr.destroy();
    log.end();
    await writeFile(path.join(base, 'transcript.json'), JSON.stringify(transcript, null, 2));
    await writeFile(path.join(base, 'pipe-events.json'), JSON.stringify(pipeEvents, null, 2));
    // Audacity's detached pipe server unlinks on client EOF, then can recreate
    // its FIFOs before process exit. These exact paths were absent at launch on
    // this dedicated runner. Clean up only our UID's newly created FIFOs after
    // the process is confirmed stopped; never remove a preexisting or other file.
    for (const file of [toPipe, fromPipe]) {
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      assert.ok(info.isFIFO() && info.uid === uid && info.ctimeMs >= launchedAt, `Refuse cleanup of a scripting pipe not created by this native session: ${file}`);
      await unlink(file);
    }
  }
}

async function nativeExport(command, destination, duration) {
  await command('SelectAll:');
  // Select also resets track selection to its default first track. SelectTime
  // changes only the range and keeps every track/lane in the exported mix.
  await command(`SelectTime: Start=0 End=${duration}`);
  await command(`Export2: Filename=${quoted(destination)} NumChannels=2`);
  assert.ok((await stat(destination)).size > 44, 'Native WAV export exists');
}

async function reimportNative(file) {
  const imported = await importAudacity(new Uint8Array(await readFile(file)), { name: path.basename(file) });
  const editor = new AudioEditor(); await editor.execute('project.load', { project: imported.project });
  return { editor, warnings: imported.warnings };
}

try {
  assert.equal(process.platform, 'linux', 'Native gate requires Linux');
  assert.ok(process.env.DISPLAY, 'Run with xvfb-run -a');
  try { report.nativeVersion = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'audacity'], { encoding: 'utf8' }).trim(); }
  catch { report.nativeVersion = executable; }
  const source = await fixture(), portable = await source.execute('project.save'), expected = await source.execute('audio.render');
  await writeFile(path.join(output, 'expected-mix.wav'), encodeWav(expected, { bitDepth: 32, float: true }));
  for (const format of ['aup3', 'aup']) {
    const encoded = await exportAudacity(portable, { format });
    const folder = path.join(output, `input-${format}`); await mkdir(folder, { recursive: true });
    let input;
    if (format === 'aup3') { input = path.join(folder, 'source.aup3'); await writeFile(input, encoded.bytes); }
    else {
      for (const [relative, bytes] of Object.entries(unzipSync(encoded.bytes))) {
        const destination = path.join(folder, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
      }
      input = path.join(folder, 'project.aup');
    }
    const artifacts = await nativeSession(`native-${format}`, async (command, folder) => {
      // AUP is an import into a temporary project in Audacity 3.x.
      // OpenProject2 guesses success from a changed database filename, so it
      // reports failure even after a successful legacy import. Import2 returns
      // the actual importer result and is the appropriate scripting entry point.
      // Audacity 3.4.2's legacy importer creates clips at the current project
      // rate before applying the XML rate. Set the documented prerequisite so
      // its deferred SetRate does not scale clip offsets from 44100 to 48000.
      if (format === 'aup') await command(`SetProject: Rate=${sampleRate}`);
      await command(format === 'aup' ? `Import2: Filename=${quoted(input)}` : `OpenProject2: Filename=${quoted(input)} AddToHistory=0`);
      const tracks = parseInfo(await command('GetInfo: Type=Tracks Format=JSON'));
      const clips = parseInfo(await command('GetInfo: Type=Clips Format=JSON'));
      const labels = parseInfo(await command('GetInfo: Type=Labels Format=JSON'));
      assert.ok(tracks.some(track => track.name === 'Mono track'), 'Native mono track name');
      assert.ok(tracks.some(track => track.name === 'Mono track — lane 2'), 'Native overlap has a separate audible lane');
      assert.ok(tracks.some(track => track.name === 'Stereo track'), 'Native stereo track name');
      assert.ok(clips.some(clip => Math.abs(clip.start - .25) < 1e-7), 'Native mono clip placement');
      assert.ok(clips.some(clip => Math.abs(clip.start - .5) < 1e-7), 'Native stereo clip placement');
      assert.ok(clips.some(clip => Math.abs(clip.start - .75) < 1e-7), 'Native overlapping clip placement');
      assert.ok(JSON.stringify(labels).includes('Verification label'), 'Native label text');
      const wav = path.join(folder, 'native-mix.wav'), saved = path.join(folder, 'saved-by-audacity.aup3');
      await nativeExport(command, wav, source.getState().duration);
      await command(`SaveProject2: Filename=${quoted(saved)} AddToHistory=0`);
      assert.ok(existsSync(saved), 'Native save created the requested project');
      return { wav, saved, tracks, clips, labels };
    });
    const nativePCM = decodeWav(new Uint8Array(await readFile(artifacts.wav)));
    const nativeMix = comparePCM(nativePCM, expected, .0002, `${format} native mix`);
    const roundtrip = await reimportNative(artifacts.saved), actual = await roundtrip.editor.execute('audio.render');
    const returnedMix = comparePCM(actual, expected, 2e-6, `${format} native save/reimport`);
    assert.equal(roundtrip.editor.getProject().tracks.length, source.getProject().tracks.length + 1, `${format} one extra overlap lane`);
    for (const [key, value] of Object.entries(source.getState().metadata)) assert.equal(roundtrip.editor.getState().metadata[key], value, `${format} metadata ${key}`);
    for (const sourceTrack of source.getProject().tracks) {
      const actualTracks = roundtrip.editor.getProject().tracks.filter(track => track.name === sourceTrack.name || track.name.startsWith(`${sourceTrack.name} — lane `));
      assert.ok(actualTracks.some(track => track.name === sourceTrack.name), `${format} returned track ${sourceTrack.name}`);
      const actualClips = actualTracks.flatMap(track => track.clips);
      assert.equal(actualClips.length, sourceTrack.clips.length);
      for (const sourceClip of sourceTrack.clips) {
        const matches = actualClips.filter(clip => clip.name === sourceClip.name);
        assert.equal(matches.length, 1, `${format} returned exactly one ${sourceClip.name}`);
        const actualClip = matches[0];
        assert.equal(actualClip.start, sourceClip.start);
        comparePCM(actualClip.audio, sourceClip.audio, 1e-7, `${format} stored clip PCM`);
      }
    }
    report.cases.push({ format, nativeMix, returnedMix, warnings: roundtrip.warnings });
    console.log(`PASS ${format}: native open, track/clip/label inspection, WAV export, save and import; max difference ${nativeMix.maximumDifference}`);
  }
  // This project starts from a native WAV import, independent of our project writer.
  const wavSource = path.join(output, 'independent-native-source.wav');
  await writeFile(wavSource, encodeWav(pcm([523.25, 783.99]), { bitDepth: 32, float: true }));
  const nativeOnly = await nativeSession('independent-native', async (command, folder) => {
    await command(`Import2: Filename=${quoted(wavSource)}`);
    await command('SetProject: Rate=48000');
    await command('SelectAll:');
    // Pan is stable across 3.x; the gain parameter was renamed Gain -> Volume.
    // Nonzero gain is already covered by both project-export fixtures above.
    await command('SetTrack: Name="Native generated" Pan=25');
    const wav = path.join(folder, 'native-mix.wav'), saved = path.join(folder, 'independent-native.aup3');
    await nativeExport(command, wav, 1);
    await command(`SaveProject2: Filename=${quoted(saved)} AddToHistory=0`);
    return { wav, saved };
  });
  const independent = await reimportNative(nativeOnly.saved);
  const reference = decodeWav(new Uint8Array(await readFile(nativeOnly.wav)));
  const independentMix = comparePCM(await independent.editor.execute('audio.render'), reference, .0002, 'Independent native project');
  report.cases.push({ format: 'independent-native-aup3', returnedMix: independentMix, warnings: independent.warnings });
  report.passed = true;
  console.log('PASS independent Audacity-generated AUP3 import and audible mix');
} catch (error) {
  report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
