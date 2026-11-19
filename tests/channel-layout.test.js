import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_LAYOUTS, conversionMatrix, convertLayout, trackMixMatrix } from '../src/channel-layout.js';
import { AudioEditor } from '../src/engine.js';
import { processAudio, trimSilence } from '../src/dsp.js';
import { encodeWav, decodeWav } from '../src/wav.js';
const fixture = (layout, frames = 80) => ({ sampleRate: 8000, layout, channels: Array.from({length: CHANNEL_LAYOUTS[layout].count}, (_, c) => new Float32Array(frames).fill((c + 1) / 16)) });
for (const layout of Object.keys(CHANNEL_LAYOUTS)) test(`${layout} PCM and extensible WAV preserve exact channel identity and portable layout`, async () => {
  const audio=fixture(layout), bytes=encodeWav(audio,{bitDepth:32,float:true}), decoded=decodeWav(bytes);
  assert.deepEqual(decoded,audio);
  const view=new DataView(bytes.buffer);assert.equal(view.getUint16(20,true),0xfffe);assert.equal(view.getUint32(40,true),CHANNEL_LAYOUTS[layout].mask);
  const engine=new AudioEditor({sampleRate:8000,outputLayout:layout});await engine.execute('clip.add',{audio});
  const portable=await engine.execute('project.save'), restored=new AudioEditor();await restored.execute('project.load',{project:portable});
  assert.deepEqual(await restored.execute('project.save'),portable);
  const raw=await restored.execute('clip.getAudio');assert.deepEqual(raw,audio);
  for(const effect of ['gain','reverse','pan','eq','compressor','limiter','tape']) {
    const result=effect==='tape'?await engine.execute('effect.preview',{effect,params:{wet:.3}}):await processAudio(audio,effect,effect==='eq'?{bands:[]}:{});
    assert.equal(result.channels.length,layout==='mono'&&effect==='pan'?2:audio.channels.length);
    assert.ok(result.channels.every(channel=>channel.every(Number.isFinite)));
  }
});
test('explicit surround selections alter only chosen indices and selected frames; undo and public copies preserve isolation',async()=>{
  const engine=new AudioEditor({sampleRate:8000,outputLayout:'7.1'}), audio=fixture('7.1');
  await engine.execute('clip.add',{audio});
  await engine.execute('selection.set',{start:.002,end:.006,channels:[2,4,7]});
  const before=await engine.execute('project.save');
  const exposed=engine.getState();exposed.selection.channels.push(0);assert.deepEqual(engine.getState().selection.channels,[2,4,7]);
  await engine.execute('effect.gain',{db:-6});const out=await engine.execute('clip.getAudio');
  for(let c=0;c<8;c++)for(let i=0;i<80;i++)assert.equal(out.channels[c][i], [2,4,7].includes(c)&&i>=16&&i<48?Math.fround(audio.channels[c][i]*10**(-6/20)):audio.channels[c][i]);
  await engine.execute('history.undo');assert.deepEqual(await engine.execute('project.save'),before);
  for(const channels of [[-1],[8],[0,0],[],[1.5]])await assert.rejects(engine.execute('selection.set',{start:0,end:.005,channels}));
});
test('surround downmix matrix excludes LFE and routes center/rear by named speakers; balance retains all nonfront channels',()=>{
  const source=fixture('7.1',1), matrix=conversionMatrix('7.1','stereo');
  assert.equal(matrix[0][3],0);assert.equal(matrix[1][3],0);assert.equal(matrix[0][2],Math.SQRT1_2);assert.equal(matrix[0][6],Math.SQRT1_2);
  const output=convertLayout(source,'stereo');assert.equal(output.channels[0][0],Math.fround(source.channels[0][0]+Math.SQRT1_2*(source.channels[2][0]+source.channels[4][0]+source.channels[6][0])));
  const balanced=trackMixMatrix('7.1','7.1',{pan:1});assert.ok(Math.abs(balanced[0][0])<1e-15);for(let i=1;i<8;i++)assert.equal(balanced[i][i],1);
});
test('stem render and saveTrack use the explicit track, preserve timing/layout and filter clip-keyed references',async()=>{
  const engine=new AudioEditor({sampleRate:8000,outputLayout:'5.1'});
  const first=await engine.execute('clip.add',{audio:fixture('5.1'),start:.01,name:'First'}),second=await engine.execute('clip.add',{audio:fixture('mono'),name:'Second'});
  await engine.execute('track.update',{trackId:first.trackId,mute:true,gainDb:-6});await engine.execute('track.update',{trackId:second.trackId,solo:true});
  await engine.execute('settings.load',{settings:{midiSequences:{[first.clipId]:{notes:[]},[second.clipId]:{notes:[]}},live:{version:1,racks:{master:{chain:[]},[first.trackId]:{chain:[]},[second.trackId]:{chain:[]}},tracks:{[first.trackId]:{},[second.trackId]:{}},loops:[{trackId:first.trackId,clipId:first.clipId},{trackId:second.trackId,clipId:second.clipId}]}}});
  const stem=await engine.execute('audio.render',{scope:'track',trackId:first.trackId,respectMute:false,respectSolo:false,end:.03});
  assert.equal(stem.layout,'5.1');assert.equal(stem.channels[0].length,240);assert.equal(stem.channels[0][0],0);assert.equal(stem.channels[5][80],Math.fround(6/16*10**(-6/20)));
  const muted=await engine.execute('audio.render',{scope:'track',trackId:first.trackId,respectMute:true});assert.ok(muted.channels.every(c=>c.every(x=>x===0)));
  const saved=await engine.execute('project.saveTrack',{trackId:first.trackId}),restored=new AudioEditor();await restored.execute('project.load',{project:saved});
  assert.equal(saved.tracks.length,1);assert.equal(saved.selectedClipId,first.clipId);assert.deepEqual(Object.keys(saved.settings.midiSequences),[first.clipId]);assert.deepEqual(Object.keys(saved.settings.live.tracks),[first.trackId]);assert.equal(saved.settings.live.loops.length,1);
  assert.deepEqual(Object.keys(saved.settings.live.racks),['master',first.trackId]);
  const raw=await engine.execute('audio.render',{scope:'track',trackId:first.trackId,raw:true,end:.03});assert.equal(raw.channels[5][80],6/16);
  const plan=await engine.execute('audio.playbackPlan',{respectMute:false,respectSolo:false,excludeTrackIds:[first.trackId]});assert.deepEqual(plan.tracks.map(t=>t.id),[second.trackId]);
});
test('surround varispeed stays within the source clock at the minimum and maximum supported sample rates',async()=>{
  for(const sampleRate of [8000,192000])for(const layout of ['5.1','7.1'])for(const rate of [.5,2]){
    const source={...fixture(layout,128),sampleRate};const out=await processAudio(source,'speed',{rate});assert.equal(out.sampleRate,sampleRate);assert.equal(out.layout,layout);assert.equal(out.channels[0].length,Math.round(128/rate));for(let c=0;c<out.channels.length;c++)assert.ok(out.channels[c].every(value=>Math.abs(value-source.channels[c][0])<1e-6));
  }
  assert.equal((await processAudio(fixture('5.1'),'stretch',{ratio:2,preservePitch:false})).channels[0].length,160);
  assert.equal((await processAudio(fixture('7.1'),'pitch',{semitones:12,preserveDuration:false})).channels[0].length,40);
});
test('raw AudioEditor recipes reject explicit nonobject params and roll back earlier steps',async()=>{
  const engine=new AudioEditor({sampleRate:8000});await engine.execute('clip.add',{audio:fixture('mono')});const before=await engine.execute('project.save');
  for(const params of [null,false,0,[],1,'']){
    await assert.rejects(engine.execute('recipe.run',{commands:[{method:'effect.gain',params:{db:-12}},{method:'effect.reverse',params}]}),/parameters must be objects/);
    assert.deepEqual(await engine.execute('project.save'),before);
  }
});
test('trimSilence trims qualifying ends, preserves an interior pause and leaves all-silent selections unchanged',async()=>{
  const audio=fixture('5.1',800);audio.channels.forEach(c=>{c.fill(0,0,100);c.fill(0,300,500);c.fill(0,700);});
  const out=trimSilence(audio,{thresholdDb:-60,minDuration:.01,padding:.001});assert.equal(out.channels[0].length,616);assert.equal(out.layout,'5.1');assert.equal(out.trimInfo.leadingFrames,92);assert.ok(out.channels[0].slice(208,408).every(x=>x===0));
  const quiet=fixture('mono');quiet.channels[0].fill(0);const editor=new AudioEditor({sampleRate:8000});await editor.execute('clip.add',{audio:quiet});
  const result=await editor.execute('effect.trimSilence',{});assert.equal(result.allSilent,true);assert.match(result.message,/left unchanged/);assert.deepEqual(await editor.execute('clip.getAudio'),quiet);
});
test('ambiguous/mismatched surround input rejects before silent routing; raw wider unsupported time-pitch rejects explicitly',async()=>{
  const audio=fixture('5.1'),bytes=encodeWav(audio,{bitDepth:32,float:true});new DataView(bytes.buffer).setUint32(40,0,true);
  assert.throws(()=>decodeWav(bytes),/explicit channel layout/);assert.equal(decodeWav(bytes,{layout:'5.1'}).layout,'5.1');
  const engine=new AudioEditor();await assert.rejects(engine.execute('clip.add',{audio:{...audio,layout:'7.1'}}));
  await assert.rejects(processAudio(audio,'pitch',{semitones:3}),/mono\/stereo/);
});
