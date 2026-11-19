/** Deterministic small-buffer beta fuzz. No audio hardware, network or large files. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {AudioEditor} from '../src/engine.js';
import {CHANNEL_LAYOUTS} from '../src/channel-layout.js';
import {RACK_EFFECTS} from '../src/rack-config.js';
import {RealtimeRackDSP,renderLiveDSP} from '../src/realtime-dsp.js';
import {encodeWav,decodeWav} from '../src/wav.js';
const seeds=[0x10be7a26,0x51ec7100,0x0071a11e],casesPerSeed=120;
const report={version:1,seeds:seeds.map(seed=>`0x${seed.toString(16).padStart(8,'0')}`),kind:'synthetic bounded PCM/state/control fuzz; no hardware claim',limits:{casesPerSeed,maxFrames:767,maxStages:4,sampleRate:8000},counts:{statefulDsp:0,blockComparisons:0,wetZero:0,atomicRejectedGraphs:0,multichannelEdits:0,undoRoundTrips:0,saveTrackRoundTrips:0,wavRoundTrips:0,wavMutations:0},failures:[]};
const random=seed=>{let n=seed>>>0;return()=>{n^=n<<13;n^=n>>>17;n^=n<<5;return(n>>>0)/4294967296;};},pick=(rng,array)=>array[Math.floor(rng()*array.length)];
function stage(rng,id){const effect=pick(rng,Object.keys(RACK_EFFECTS)),definition=RACK_EFFECTS[effect],params={};for(const field of definition.fields)params[field.key]=field.type==='select'?pick(rng,field.options):field.integer?Math.floor(field.min+rng()*(field.max-field.min+1)):field.min+rng()*(field.max-field.min);return{id,effect,wet:rng(),enabled:rng()>.1,params};}
for(const seed of seeds){const rng=random(seed);for(let index=0;index<casesPerSeed;index++){
  const layout=pick(rng,['mono','stereo','5.1','7.1']),count=CHANNEL_LAYOUTS[layout].count,frames=256+Math.floor(rng()*512),audio={sampleRate:8000,layout,channels:Array.from({length:count},(_,c)=>Float32Array.from({length:frames},(_,i)=>Math.sin(i*(.08+c*.011))*.15+(rng()-.5)*.01))};
  try{
    const chain=Array.from({length:1+Math.floor(rng()*4)},(_,i)=>stage(rng,`s${i}`)),start=Math.floor(rng()*8000)/8000,automation=[{slotId:'s0',param:'wet',points:[{time:start,value:0,curve:pick(rng,['step','linear'])},{time:start+.02,value:.8,curve:'step'}]}];
    const a=renderLiveDSP(audio,{chain,automation,start,blockFrames:128}),b=renderLiveDSP(audio,{chain,automation,start,blockFrames:1+Math.floor(rng()*193)});assert.deepEqual(a,b);assert.ok(a.channels.every(channel=>channel.every(Number.isFinite)));report.counts.statefulDsp++;report.counts.blockComparisons++;
    assert.deepEqual(renderLiveDSP(audio,{chain:chain.map(effect=>({...effect,wet:0}))}),audio);report.counts.wetZero++;
    const dsp=new RealtimeRackDSP({sampleRate:8000,channels:count,chain}),before=dsp.snapshot(),history=dsp.stages[0];assert.throws(()=>dsp.updateChain([{...chain[0],wet:NaN}]));assert.deepEqual(dsp.snapshot(),before);assert.equal(dsp.stages[0],history);report.counts.atomicRejectedGraphs++;
    const engine=new AudioEditor({sampleRate:8000,outputLayout:layout}),first=await engine.execute('clip.add',{audio,name:'Fuzz source'});await engine.execute('clip.add',{audio,name:'Other track'});
    const selected=Array.from({length:count},(_,c)=>c).filter(()=>rng()<.5);if(!selected.length)selected.push(Math.floor(rng()*count));const from=1+Math.floor(rng()*64),to=frames-1;
    await engine.execute('selection.set',{clipId:first.clipId,start:from/8000,end:to/8000,channels:selected});const portable=await engine.execute('project.save');await engine.execute('effect.gain',{db:-6});const altered=await engine.execute('clip.getAudio',{clipId:first.clipId});
    for(let c=0;c<count;c++)for(let i=0;i<frames;i++)assert.equal(altered.channels[c][i],selected.includes(c)&&i>=from&&i<to?Math.fround(audio.channels[c][i]*10**(-6/20)):audio.channels[c][i]);report.counts.multichannelEdits++;
    await engine.execute('history.undo');assert.deepEqual(await engine.execute('project.save'),portable);report.counts.undoRoundTrips++;
    const one=await engine.execute('project.saveTrack',{trackId:first.trackId}),loaded=new AudioEditor();await loaded.execute('project.load',{project:one});assert.deepEqual(await loaded.execute('clip.getAudio'),audio);assert.equal(loaded.getState().tracks.length,1);report.counts.saveTrackRoundTrips++;
    const wav=encodeWav(audio,{float:true,bitDepth:32});assert.deepEqual(decodeWav(wav),audio);report.counts.wavRoundTrips++;
    for(const mutation of ['mask','size']){const bytes=wav.slice(),view=new DataView(bytes.buffer);if(mutation==='mask')view.setUint32(40,0x80000000,true);else view.setUint32(4,0xffffffff,true);assert.throws(()=>decodeWav(bytes));report.counts.wavMutations++;}
  }catch(error){report.failures.push({seed:`0x${seed.toString(16)}`,index,layout,frames,message:error.message,code:error.code||error.name});}
}}
const json=JSON.stringify(report,null,2)+'\n',out=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6);if(out)await writeFile(out,json);console.log(JSON.stringify({...report,failures:report.failures.slice(0,8),failureCount:report.failures.length},null,2));if(report.failures.length)process.exitCode=1;
