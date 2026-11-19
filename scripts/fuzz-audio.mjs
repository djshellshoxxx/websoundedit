/** Deterministic, bounded audio baseline/feature regression fuzzing.
 * Runs small synthetic buffers only; no devices, network or large fixtures.
 * Exit 1 means an invariant failed. A report includes exact seeds and indices.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { AudioEditor, COMMANDS, LIMITS } from '../src/engine.js';
import { processAudio, validateAudio } from '../src/dsp.js';
import { processRack, RACK_EFFECT_NAMES } from '../src/rack-dsp.js';
import { encodeWav, decodeWav } from '../src/wav.js';

const seeds = [0x57455345, 0x00c0ffee, 0x51ec7100];
const report = { version: 1, seeds: seeds.map(x => `0x${x.toString(16).padStart(8,'0')}`),
  limits: { sequencesPerSeed: 8, stepsPerSequence: 100, maxClipFrames: 319, maxTracks: 6, maxClips: 12 },
  counts: { engineCases: 0, accepted: 0, expectedRejections: 0, unexpectedRejections: 0, atomicChecks: 0, stateChecks: 0, historyRoundTrips: 0, projectRoundTrips: 0, dspCases: 0, wavRoundTrips: 0, wavMutations: 0, wavAcceptedMutations: 0, wavRejectedMutations: 0 }, failures: [] };
const mutable = new Set(COMMANDS.filter(c => c.mutates).map(c => c.method));
function random(seed) { let x=seed>>>0; return () => { x^=x<<13;x^=x>>>17;x^=x<<5; return (x>>>0)/4294967296; }; }
const pick = (rng, array) => array[Math.floor(rng()*array.length)];
const integer = (rng, n) => Math.floor(rng()*n);
function failure(area, at, error) {
  report.failures.push({area,...at,message:error.message,code:error.code||error.name});
}
function signal(rng, channels=2, frames=128) {
  return {sampleRate:8000,channels:Array.from({length:channels},(_,c)=>Float32Array.from({length:frames},(_,i)=>
    Math.sin(i*(.09+c*.017))*.25+(rng()-.5)*.03))};
}
function assertState(editor) {
  const state=editor.getState(), ids=new Set();
  assert.ok(state.tracks.length<=LIMITS.tracks);
  let clips=0;
  for(const track of state.tracks) {
    assert.ok(!ids.has(track.id));ids.add(track.id);
    assert.ok(track.name.length>0&&track.name.length<=200,'track name within portable limit');
    for(const clip of track.clips) {
      clips++;assert.ok(!ids.has(clip.id));ids.add(clip.id);
      assert.ok(clip.name.length>0&&clip.name.length<=200,'generated clip name exceeds portable limit');
      assert.ok(clip.frames>0&&clip.channels>=1&&clip.channels<=2);
      assert.ok(clip.start>=0&&clip.start+clip.duration<=LIMITS.timelineSeconds+1e-9);
    }
  }
  assert.ok(clips<=LIMITS.clips);
  const selected=state.tracks.find(t=>t.id===state.selectedTrackId);
  assert.ok(state.selectedTrackId===null||selected,'selected track exists');
  assert.ok(state.selectedClipId===null||selected?.clips.some(c=>c.id===state.selectedClipId),'selected clip belongs to selected track');
  if(state.selection) {
    assert.equal(state.selection.trackId,state.selectedTrackId,'selection track and selected track differ');
    assert.equal(state.selection.clipId,state.selectedClipId,'selection clip and selected clip differ');
    const clip=selected.clips.find(c=>c.id===state.selection.clipId);
    assert.ok(state.selection.start>=0&&state.selection.end>state.selection.start&&state.selection.end<=clip.duration+1e-9);
  }
  assert.ok(state.history.undo<=LIMITS.historyEntries&&state.history.bytes<=LIMITS.historyBytes);
  for(const track of editor.getProject().tracks)for(const clip of track.clips)validateAudio(clip.audio,{allowEmpty:false});
}
function command(rng, editor, step) {
  const state=editor.getState(), all=state.tracks.flatMap(t=>t.clips.map(c=>({...c,trackId:t.id}))), clip=all.length?pick(rng,all):null;
  const add=()=>({method:'clip.add',params:{audio:signal(rng,1+integer(rng,2),64+integer(rng,256)),name:step%37===0?'n'.repeat(200):`Clip ${step}`,
    ...(state.tracks.length>=6?{trackId:pick(rng,state.tracks).id}:{}),start:integer(rng,8)/100},valid:true});
  if(!clip)return add();
  if(rng()<.28) {
    const bad=integer(rng,6), target={clipId:clip.id,start:0,end:clip.duration};
    if(bad===0)return{method:'clip.update',params:{clipId:clip.id,start:600},valid:false};
    if(bad===1)return{method:'track.update',params:{trackId:clip.trackId,gainDb:1,pan:2},valid:false};
    if(bad===2)return{method:'selection.set',params:{clipId:clip.id,start:clip.duration,end:0},valid:false};
    if(bad===3)return{method:'recipe.run',params:{commands:[{method:'track.update',params:{trackId:clip.trackId,gainDb:2}},{method:'effect.gain',params:{target,db:99}}]},valid:false};
    if(bad===4)return{method:'clip.add',params:{audio:{sampleRate:8000,channels:[Float32Array.of(NaN)]}},valid:false};
    return{method:'effect.rack',params:{target,chain:[{id:'a',effect:'tape',wet:.5,params:{}},{id:'b',effect:'filter',params:{frequency:Infinity}}]},valid:false};
  }
  const first=integer(rng,Math.max(1,clip.frames-1)), last=first+1+integer(rng,clip.frames-first);
  const target={clipId:clip.id,start:first/8000,end:last/8000,channels:clip.channels===2&&rng()<.35?pick(rng,['left','right']):'all'};
  switch(integer(rng,14)) {
    case 0: return all.length<12?add():{method:'clip.remove',params:{clipId:clip.id},valid:true};
    case 1: return{method:'selection.set',params:target,valid:true};
    case 2: return{method:'effect.gain',params:{target,db:integer(rng,13)-6},valid:true};
    case 3: return{method:'effect.reverse',params:{target},valid:true};
    case 4: return{method:'effect.normalize',params:{target,targetDb:-3},valid:true};
    case 5: return{method:'effect.preview',params:{target,effect:'invert'},valid:true};
    case 6: return all.length<12?{method:'clip.duplicate',params:{clipId:clip.id,start:integer(rng,10)/100},valid:true}:{method:'clip.remove',params:{clipId:clip.id},valid:true};
    case 7: return clip.frames>1&&all.length<12?{method:'clip.split',params:{clipId:clip.id,at:(1+integer(rng,clip.frames-1))/8000},valid:true}:{method:'project.select',params:{clipId:clip.id},valid:true};
    case 8: return{method:'edit.trim',params:{target:{...target,channels:'all'}},valid:true};
    case 9: return{method:'track.update',params:{trackId:clip.trackId,pan:rng()*2-1,gainDb:integer(rng,19)-12,mute:rng()<.2,solo:rng()<.1},valid:true};
    case 10: return{method:'clip.update',params:{clipId:clip.id,start:integer(rng,20)/100,destinationTrackId:pick(rng,state.tracks).id},valid:true};
    case 11: return{method:'effect.rack',params:{target,chain:[{id:'s',effect:pick(rng,RACK_EFFECT_NAMES),wet:rng(),params:{}}]},valid:true};
    case 12: return{method:'audio.render',params:{scope:'track',trackId:clip.trackId},valid:true};
    default: return{method:'clip.key',params:{clipId:clip.id,tonic:integer(rng,12),mode:pick(rng,['major','minor'])},valid:true};
  }
}

for(const seed of seeds) {
  const rng=random(seed);
  for(let sequence=0;sequence<report.limits.sequencesPerSeed;sequence++) {
    let editor=new AudioEditor({sampleRate:8000,name:'Seeded audio audit'});
    for(let step=0;step<report.limits.stepsPerSequence;step++) {
      const action=command(rng,editor,step),at={seed:`0x${seed.toString(16)}`,sequence,step,method:action.method};
      report.counts.engineCases++;
      const before=await editor.execute('project.save'), beforeState=editor.getState();
      let result,error;
      try{result=await editor.execute(action.method,action.params);}catch(e){error=e;}
      try {
        if(error) {
          report.counts.atomicChecks++;
          assert.deepEqual(await editor.execute('project.save'),before,'failed command mutated project');
          assert.deepEqual(editor.getState(),beforeState,'failed command mutated history/state');
          if(action.valid){report.counts.unexpectedRejections++;throw error;} else report.counts.expectedRejections++;
        } else {
          report.counts.accepted++;
          assert.ok(action.valid,'invalid command unexpectedly accepted');
          report.counts.stateChecks++;assertState(editor);
          if(action.method==='effect.preview')assert.deepEqual(await editor.execute('project.save'),before,'preview mutated PCM/state');
          if(action.method==='audio.render')validateAudio(result,{allowEmpty:false});
          if(mutable.has(action.method)&&step%11===0) {
            const after=await editor.execute('project.save');
            assert.equal(await editor.execute('history.undo'),true);assert.deepEqual(await editor.execute('project.save'),before,'undo failed to restore project');
            assert.equal(await editor.execute('history.redo'),true);assert.deepEqual(await editor.execute('project.save'),after,'redo failed to restore project');
            report.counts.historyRoundTrips++;
          }
          if(step%17===0) {
            const portable=await editor.execute('project.save'), restored=new AudioEditor();
            await restored.execute('project.load',{project:portable});
            assert.deepEqual(await restored.execute('project.save'),portable,'portable roundtrip changed project');
            report.counts.projectRoundTrips++;
          }
        }
      }catch(e){failure('engine',at,e);editor=new AudioEditor({sampleRate:8000,name:'Seeded audio audit'});}
    }
  }
  for(let iteration=0;iteration<200;iteration++) {
    const audio=signal(rng,1+integer(rng,2),1+integer(rng,256)),original=audio.channels.map(c=>c.slice());
    const effect=pick(rng,RACK_EFFECT_NAMES),wet=iteration%3===0?0:rng();
    try {
      const out=await processRack(audio,{chain:[{id:'effect',effect,wet,params:{}}]});validateAudio(out,{allowEmpty:false});
      assert.equal(out.channels.length,audio.channels.length);assert.equal(out.channels[0].length,audio.channels[0].length);
      assert.deepEqual(audio.channels,original,'DSP mutated input');
      if(!wet)assert.deepEqual(out.channels,original,'zero wet changed samples');
      for(let c=0;c<audio.channels.length;c++)assert.notEqual(out.channels[c].buffer,audio.channels[c].buffer,'DSP leaked input ownership');
      const reversed=await processAudio(await processAudio(audio,'reverse'),'reverse');assert.deepEqual(reversed.channels,original);
      report.counts.dspCases++;
    }catch(e){failure('dsp',{seed:`0x${seed.toString(16)}`,iteration,effect,wet},e);}
    for(const bitDepth of [16,24,32]) {
      const float=bitDepth===32,bytes=encodeWav(audio,{bitDepth,float}),decoded=decodeWav(bytes);
      try {
        assert.equal(decoded.channels.length,audio.channels.length);assert.equal(decoded.channels[0].length,audio.channels[0].length);
        for(let c=0;c<audio.channels.length;c++)for(let i=0;i<audio.channels[c].length;i++)assert.ok(Math.abs(decoded.channels[c][i]-audio.channels[c][i])<=(float?0:1/2**(bitDepth-1)),'WAV sample mismatch');
        report.counts.wavRoundTrips++;
      }catch(e){failure('wav-roundtrip',{seed:`0x${seed.toString(16)}`,iteration,bitDepth},e);}
      const changed=bytes.slice();
      if(iteration%4===0)changed[0]^=1;
      else if(iteration%4===1)new DataView(changed.buffer).setUint16(22,3,true);
      else if(iteration%4===2)new DataView(changed.buffer).setUint32(4,changed.length+2048,true);
      else {const at=integer(rng,changed.length);changed[at]^=1<<integer(rng,8);}
      report.counts.wavMutations++;
      try {
        const output=decodeWav(changed);report.counts.wavAcceptedMutations++;
        try {assert.ok(iteration%4===3,'invalid header mutation accepted');validateAudio(output);}
        catch(e){failure('wav-mutation',{seed:`0x${seed.toString(16)}`,iteration,bitDepth},e);}
      }catch {report.counts.wavRejectedMutations++;}
    }
  }
}
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
const json=JSON.stringify(report,null,2)+'\n';if(out)await writeFile(out,json);
console.log(JSON.stringify({seeds:report.seeds,counts:report.counts,failures:report.failures.length,firstFailures:report.failures.slice(0,8)},null,2));
process.exitCode=report.failures.length?1:0;
