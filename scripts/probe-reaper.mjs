/** Obtain native project grammar/settings before asserting interchange support.
 * REAPER_BIN=/path/to/REAPER/reaper xvfb-run -a node scripts/probe-reaper.mjs /tmp/reaper-probe
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeReaper, luaString, configureRenderLua } from './reaper-native.mjs';

// Independent WAVEFORMATEXTENSIBLE fixture encoder: this oracle deliberately
// shares no editor PCM, layout or WAV implementation code.
const LAYOUTS = { mono: { channels: 1, mask: 0x4 }, stereo: { channels: 2, mask: 0x3 }, '5.1': { channels: 6, mask: 0x3f }, '7.1': { channels: 8, mask: 0x63f } };
function fixtureWav(channels, mask, sampleRate, frames) {
  const dataBytes = channels * frames * 4, bytes = new Uint8Array(80 + dataBytes), view = new DataView(bytes.buffer);
  const text = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 40, true); view.setUint16(20, 0xfffe, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 22, true);
  view.setUint16(38, 32, true); view.setUint32(40, mask, true);
  bytes.set([3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 44);
  text(60, 'fact'); view.setUint32(64, 4, true); view.setUint32(68, frames, true);
  text(72, 'data'); view.setUint32(76, dataBytes, true);
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < channels; ch++) view.setFloat32(80 + (i * channels + ch) * 4, .04 * Math.sin(2 * Math.PI * (300 + 107 * ch) * i / sampleRate), true);
  return bytes;
}

const directory = path.resolve(process.argv[2] || 'test-results/reaper-probe');
await mkdir(directory, { recursive: true });
const sampleRate = 48000, frames = 2400, audio = [];
for (const [layout, definition] of Object.entries(LAYOUTS)) {
  const file = path.join(directory, `${layout}.wav`);
  await writeFile(file, fixtureWav(definition.channels, definition.mask, sampleRate, frames));
  audio.push({ layout, file, channels: definition.channels });
}
const nativeFile = path.join(directory, 'native-generated.rpp');
await nativeReaper(path.join(directory, 'session'), `
assert(reaper.GetAppVersion():match("^7%.86"), "Unexpected native REAPER version: " .. reaper.GetAppVersion())
reaper.SetCurrentBPM(0,128,false)
local report = assert(io.open(${luaString(path.join(directory, 'native-settings.txt'))}, "wb"))
report:write("version=" .. reaper.GetAppVersion() .. "\\n")
local master = reaper.GetMasterTrack(0)
assert(reaper.SetMediaTrackInfo_Value(master, "I_NCHAN", 8))
for _, item in ipairs({${audio.map(item => `{layout=${luaString(item.layout)}, file=${luaString(item.file)}, channels=${item.channels}}`).join(',')}}) do
  reaper.InsertTrackAtIndex(reaper.CountTracks(0), false)
  local track = reaper.GetTrack(0, reaper.CountTracks(0)-1)
  reaper.GetSetMediaTrackInfo_String(track, "P_NAME", item.layout .. " probe", true)
  reaper.SetMediaTrackInfo_Value(track, "I_NCHAN", math.max(2,item.channels))
  reaper.SetMediaTrackInfo_Value(track, "D_VOL", 0.7)
  reaper.SetMediaTrackInfo_Value(track, "D_PAN", 0.3)
  reaper.SetMediaTrackInfo_Value(track, "I_PANMODE", 3)
  reaper.SetMediaTrackInfo_Value(track, "D_PANLAW", 1)
  reaper.SetMediaTrackInfo_Value(track, "I_PANLAW_FLAGS", 2)
  local media = reaper.AddMediaItemToTrack(track)
  reaper.SetMediaItemInfo_Value(media, "D_POSITION", 0.1)
  reaper.SetMediaItemInfo_Value(media, "D_LENGTH", 0.04)
  reaper.SetMediaItemInfo_Value(media, "D_FADEINLEN", 0)
  reaper.SetMediaItemInfo_Value(media, "D_FADEOUTLEN", 0)
  reaper.SetMediaItemInfo_Value(media, "D_FADEINLEN_AUTO", 0)
  reaper.SetMediaItemInfo_Value(media, "D_FADEOUTLEN_AUTO", 0)
  reaper.SetMediaItemInfo_Value(media, "B_LOOPSRC", 0)
  reaper.SetMediaItemInfo_Value(media, "I_MIXFLAG", 1)
  local take = reaper.AddTakeToMediaItem(media)
  reaper.SetMediaItemTake_Source(take, assert(reaper.PCM_Source_CreateFromFile(item.file)))
  reaper.SetMediaItemTakeInfo_Value(take, "D_STARTOFFS", 0.005)
  reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", item.layout .. " source", true)
  for _, key in ipairs({"D_VOL","D_PAN","I_PANMODE","D_PANLAW","I_PANLAW_FLAGS","I_NCHAN","C_MAINSEND_OFFS","C_MAINSEND_NCH"}) do report:write(item.layout .. ":" .. key .. "=" .. tostring(reaper.GetMediaTrackInfo_Value(track,key)) .. "\\n") end
end
reaper.AddProjectMarker2(0,false,0.11,0,"Native marker",1,0)
reaper.GetSetProjectInfo_String(0,"RENDER_METADATA","ID3:TIT2|Native title",true)
reaper.SetProjExtState(0,"WebSoundEdit","outputLayout","7.1")
${configureRenderLua(directory, 'native-render', 8, .15)}
reaper.Main_SaveProjectEx(0, ${luaString(nativeFile)}, 8)
report:close()
`);
console.log(`Native REAPER grammar probe saved to ${directory}`);
