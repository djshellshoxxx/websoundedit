/** Native REAPER 7.86 interoperability gate: genuine open/save/reimport and full
 * native master renders for mono, stereo, 5.1 and 7.1. Run under xvfb-run on CI.
 * REAPER_BIN=/path/to/REAPER/reaper xvfb-run -a node scripts/verify-reaper.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AudioEditor } from '../src/engine.js';
import { decodeWav } from '../src/wav.js';
import { exportReaper, importReaper } from '../src/reaper.js';
import { readProjectZip } from '../src/project-archive.js';
import { nativeReaper, configureRenderLua, luaString, REAPER_VERSION, REAPER_ARCHIVE_SHA256 } from './reaper-native.mjs';

const output = path.resolve(process.argv[2] || 'test-results/reaper-native');
await mkdir(output, { recursive: true });
const sampleRate = 48000, layouts = { mono: [1, 0x4], stereo: [2, 0x3], '5.1': [6, 0x3f], '7.1': [8, 0x63f] };
const report = { version: REAPER_VERSION, archiveSha256: REAPER_ARCHIVE_SHA256, cases: [], status: 'running' };
const writeReport = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));

// Independent test media encoder. No application WAV/layout implementation is
// used to create the native-origin fixture; tones and impulses identify channels.
function independentFixture(layout, frames = 7200) {
  const [count, mask] = layouts[layout], channels = Array.from({ length: count }, (_, ch) => Float32Array.from({ length: frames }, (_, i) => .035 * Math.sin(2 * Math.PI * (271 + ch * 139) * i / sampleRate) + (i === 701 + ch * 97 ? .12 : 0)));
  const bytes = new Uint8Array(80 + frames * count * 4), view = new DataView(bytes.buffer), text = (at, value) => bytes.set(new TextEncoder().encode(value), at);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 40, true);
  view.setUint16(20, 0xfffe, true); view.setUint16(22, count, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 22, true); view.setUint16(38, 32, true); view.setUint32(40, mask, true);
  bytes.set([3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
  text(60, 'fact'); view.setUint32(64, 4, true); view.setUint32(68, frames, true); text(72, 'data'); view.setUint32(76, frames * count * 4, true);
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < count; ch++) view.setFloat32(80 + (i * count + ch) * 4, channels[ch][i], true);
  return { bytes, audio: { sampleRate, layout, channels } };
}
function compareAudio(actual, expected, tolerance, label) {
  assert.equal(actual.sampleRate, expected.sampleRate, `${label}: sample rate`); assert.equal(actual.channels.length, expected.channels.length, `${label}: channels`);
  let maximum = 0, square = 0, samples = 0;
  for (let ch = 0; ch < expected.channels.length; ch++) {
    assert.equal(actual.channels[ch].length, expected.channels[ch].length, `${label}: frame count`);
    for (let i = 0; i < expected.channels[ch].length; i++) { const difference = Math.abs(actual.channels[ch][i] - expected.channels[ch][i]); assert.ok(Number.isFinite(difference), `${label}: finite PCM`); maximum = Math.max(maximum, difference); square += difference * difference; samples++; }
  }
  assert.ok(maximum <= tolerance, `${label}: maximum PCM difference ${maximum} > ${tolerance}`);
  return { maximum, rms: Math.sqrt(square / Math.max(1, samples)), tolerance, frames: expected.channels[0].length, channels: expected.channels.length };
}
async function load(project) { const editor = new AudioEditor(); await editor.execute('project.load', { project }); return editor; }

const renderNow = `
local section = reaper.SectionFromUniqueID(0)
local render_command = nil
for index=0,100000 do
  local command, description = reaper.kbd_enumerateActions(section,index)
  if command == 0 then break end
  if description == "File: Render project, using the most recent render settings, auto-close render dialog" then render_command = command; break end
end
assert(render_command, "Native render action not found")
reaper.Main_OnCommand(render_command,0)
`;
function nativePreamble(channels) {
  return `assert(reaper.GetAppVersion():match("^7%.86"), "Unexpected native REAPER version: " .. reaper.GetAppVersion())
local master = reaper.GetMasterTrack(0)
assert(reaper.GetMediaTrackInfo_Value(master,"I_NCHAN") == ${Math.max(2, channels)}, "Master channel routing mismatch")
`;
}
function assertNativeProject(project) {
  const tracks = project.tracks;
  return `
assert(reaper.CountTracks(0) == ${tracks.length}, "Track count mismatch")
${tracks.map((track, i) => `do
local track = reaper.GetTrack(0,${i})
local _, name = reaper.GetTrackName(track)
assert(name == ${luaString(track.name)}, "Track name mismatch")
assert(reaper.CountTrackMediaItems(track) == ${track.clips.length}, "Clip count mismatch")
${track.clips.map((clip, j) => `do
local item = reaper.GetTrackMediaItem(track,${j})
local take = reaper.GetActiveTake(item)
assert(take and reaper.CountTakes(item) == 1,"Missing active take")
assert(math.abs(reaper.GetMediaItemInfo_Value(item,"D_POSITION") - ${clip.start}) < 1/${sampleRate}, "Clip position mismatch")
assert(math.abs(reaper.GetMediaItemInfo_Value(item,"D_LENGTH") - ${clip.audio.channels[0].length / sampleRate}) < 1/${sampleRate}, "Clip duration mismatch")
assert(reaper.GetMediaSourceNumChannels(reaper.GetMediaItemTake_Source(take)) == ${clip.audio.channels.length}, "Media channel count mismatch")
assert(reaper.GetMediaItemInfo_Value(item,"I_MIXFLAG") == 1,"Items must always mix")
local _, take_name = reaper.GetSetMediaItemTakeInfo_String(take,"P_NAME","",false)
assert(take_name == ${luaString(clip.name)}, "Clip name mismatch")
end`).join('\n')}
end`).join('\n')}
local _, markers, regions = reaper.CountProjectMarkers(0)
assert(markers == ${project.markers.length} and regions == 0,"Markers mismatch")
local _, title = reaper.GetSetProjectInfo_String(0,"RENDER_METADATA","ID3:TIT2",false)
assert(title == ${luaString(project.metadata.title)},"Metadata title mismatch")
`;
}

try {
  await writeReport();
  for (const layout of Object.keys(layouts)) {
    const channels = layouts[layout][0], directory = path.join(output, layout); await mkdir(directory, { recursive: true });
    const editor = new AudioEditor({ name: `Native ${layout}`, sampleRate, outputLayout: layout, bpm: 131 });
    const main = await editor.execute('track.add', { name: `Main ${layout}` });
    await editor.execute('track.update', { trackId: main.id, gainDb: -6.5, pan: -.37 });
    for (const [name, start, frames] of [['First', .025, 5760], ['Overlap', .065, 4320]]) await editor.execute('clip.add', { trackId: main.id, name, start, audio: independentFixture(layout, frames).audio });
    if (layout !== 'mono') {
      const mono = await editor.execute('track.add', { name: 'Mono panning' });
      await editor.execute('track.update', { trackId: mono.id, gainDb: -4.1, pan: .29 });
      await editor.execute('clip.add', { trackId: mono.id, name: 'Mono', start: .01, audio: independentFixture('mono', 4320).audio });
    }
    await editor.execute('markers.add', { name: 'Native check', time: .05 }); await editor.execute('metadata.update', { metadata: { title: `Interchange ${layout}`, artist: 'WebSoundEdit native verification' } });
    const expected = await editor.execute('audio.render'), portable = await editor.execute('project.save'), exported = await exportReaper(portable);
    const packageFiles = readProjectZip(exported.bytes), explicitFiles = new Map();
    for (const [relative, bytes] of packageFiles) {
      const absolute = path.join(directory, relative); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, bytes);
      // Native resave/reimport must derive tags/layout from the native RPP, not
      // accidentally reuse the original package sidecar after renaming the RPP.
      if (/\.wav$/i.test(relative)) { explicitFiles.set(relative, bytes); explicitFiles.set(absolute, bytes); }
    }
    const resaved = path.join(directory, 'native-resaved.rpp');
    await nativeReaper(path.join(directory, 'web-session'), `${nativePreamble(channels)}
${assertNativeProject(editor.getProject())}
${configureRenderLua(directory, 'web-native-render', channels, expected.channels[0].length / sampleRate)}
${renderNow}
reaper.Main_SaveProjectEx(0,${luaString(resaved)},8)
`, { project: path.join(directory, 'project.rpp') });
    const nativeWav = decodeWav(await readFile(path.join(directory, 'web-native-render.wav')), { layout });
    const renderDifference = compareAudio(nativeWav, expected, 4e-5, `${layout} Web→native full render`);
    const reopened = await importReaper(await readFile(resaved), { name: resaved, files: explicitFiles }), loaded = await load(reopened.project);
    assert.equal(reopened.project.tracks.length, portable.tracks.length, 'Resaved tracks'); assert.equal(reopened.project.markers[0].name, 'Native check'); assert.equal(reopened.project.metadata.title, portable.metadata.title);
    const reimportDifference = compareAudio(await loaded.execute('audio.render'), expected, 5e-7, `${layout} native save/reimport`);
    report.cases.push({ kind: 'web-export-native-open-render-save-reimport', layout, renderDifference, reimportDifference, warnings: [...exported.warnings, ...reopened.warnings] }); await writeReport();

    const independent = path.join(directory, 'independent'); await mkdir(independent, { recursive: true });
    const fixture = independentFixture(layout), fixturePath = path.join(independent, 'source.wav'), nativeProject = path.join(independent, 'native-created.rpp');
    await writeFile(fixturePath, fixture.bytes);
    await nativeReaper(path.join(independent, 'session'), `
assert(reaper.GetAppVersion():match("^7%.86"),"Native version mismatch")
reaper.SetCurrentBPM(0,137,false)
local master = reaper.GetMasterTrack(0)
reaper.SetMediaTrackInfo_Value(master,"I_NCHAN",${Math.max(2, channels)})
reaper.SetMediaTrackInfo_Value(master,"D_VOL",1)
reaper.SetMediaTrackInfo_Value(master,"D_PAN",0)
reaper.SetMediaTrackInfo_Value(master,"D_PANLAW",1)
reaper.SetMediaTrackInfo_Value(master,"I_PANMODE",3)
reaper.SetMediaTrackInfo_Value(master,"I_PANLAW_FLAGS",2)
reaper.InsertTrackAtIndex(0,false)
local track = reaper.GetTrack(0,0)
reaper.GetSetMediaTrackInfo_String(track,"P_NAME","Independent ${layout}",true)
reaper.SetMediaTrackInfo_Value(track,"I_NCHAN",${Math.max(2, channels)})
reaper.SetMediaTrackInfo_Value(track,"D_VOL",.625)
reaper.SetMediaTrackInfo_Value(track,"D_PAN",${layout === 'mono' ? 0 : .35})
reaper.SetMediaTrackInfo_Value(track,"D_PANLAW",1)
reaper.SetMediaTrackInfo_Value(track,"I_PANMODE",3)
reaper.SetMediaTrackInfo_Value(track,"I_PANLAW_FLAGS",2)
for index, specification in ipairs({{position=.01,length=.08,offset=.005},{position=.02,length=.06,offset=.03}}) do
  local item = reaper.AddMediaItemToTrack(track)
  reaper.SetMediaItemInfo_Value(item,"D_POSITION",specification.position)
  reaper.SetMediaItemInfo_Value(item,"D_LENGTH",specification.length)
  reaper.SetMediaItemInfo_Value(item,"B_LOOPSRC",0)
  reaper.SetMediaItemInfo_Value(item,"I_MIXFLAG",1)
  reaper.SetMediaItemInfo_Value(item,"D_FADEINLEN",0)
  reaper.SetMediaItemInfo_Value(item,"D_FADEOUTLEN",0)
  reaper.SetMediaItemInfo_Value(item,"D_FADEINLEN_AUTO",0)
  reaper.SetMediaItemInfo_Value(item,"D_FADEOUTLEN_AUTO",0)
  local take = reaper.AddTakeToMediaItem(item)
  reaper.SetMediaItemTake_Source(take,assert(reaper.PCM_Source_CreateFromFile(${luaString(fixturePath)})))
  reaper.SetMediaItemTakeInfo_Value(take,"D_STARTOFFS",specification.offset)
  reaper.GetSetMediaItemTakeInfo_String(take,"P_NAME","Native trim " .. tostring(index),true)
end
reaper.AddProjectMarker2(0,false,.035,0,"Independent marker",1,0)
reaper.GetSetProjectInfo_String(0,"RENDER_METADATA","ID3:TIT2|Independent ${layout}",true)
${configureRenderLua(independent, 'independent-native-render', channels, .09)}
${renderNow}
reaper.Main_SaveProjectEx(0,${luaString(nativeProject)},8)
`);
    const independentImport = await importReaper(await readFile(nativeProject), { name: nativeProject, files: new Map([[fixturePath, fixture.bytes], ['source.wav', fixture.bytes]]) });
    const independentEditor = await load(independentImport.project), actual = await independentEditor.execute('audio.render');
    assert.equal(independentImport.project.bpm, 137); assert.equal(independentImport.project.tracks[0].name, `Independent ${layout}`); assert.equal(independentImport.project.markers[0].name, 'Independent marker');
    assert.equal(independentImport.project.tracks[0].clips.length, 2); assert.equal(independentImport.project.metadata.title, `Independent ${layout}`);
    for (const [index, [first, frames]] of [[240, 3840], [1440, 2880]].entries()) for (let ch = 0; ch < channels; ch++) assert.deepEqual(independentEditor.getProject().tracks[0].clips[index].audio.channels[ch], fixture.audio.channels[ch].slice(first, first + frames), 'Independent trimmed PCM');
    const independentRender = decodeWav(await readFile(path.join(independent, 'independent-native-render.wav')), { layout });
    const difference = compareAudio(independentRender, actual, 4e-5, `${layout} independent native→Web full render`);
    report.cases.push({ kind: 'independently-created-native-project-import-render', layout, difference, warnings: independentImport.warnings }); await writeReport();
  }
  report.status = 'passed'; await writeReport(); console.log(JSON.stringify(report, null, 2));
} catch (error) { report.status = 'failed'; report.error = error.stack || String(error); await writeReport(); throw error; }
