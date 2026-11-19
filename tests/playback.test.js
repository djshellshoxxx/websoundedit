import test from 'node:test';
import assert from 'node:assert/strict';
import { Playback, playbackPosition } from '../src/playback.js';

class Param {
 constructor(){this.value=0;this.events=[];}
 setValueAtTime(value,time){this.value=value;this.events.push({value,time});}
 linearRampToValueAtTime(value,time){this.events.push({value,time});}
 exponentialRampToValueAtTime(value,time){this.events.push({value,time});}
 cancelScheduledValues(time){this.events=this.events.filter(x=>x.time<time);}
}
class Node {
 constructor(){this.gain=new Param();this.frequency=new Param();this.playbackRate=new Param();this.connections=[];this.stops=[];this.fftSize=2048;}
 connect(...args){this.connections.push(args);}
 disconnect(){this.connections=[];this.disconnected=true;}
 start(time,offset){this.startTime=time;this.offset=offset;}
 stop(time=0){this.stops.push(time);}
 getFloatTimeDomainData(array){array.fill(this.level||0);}
}
class Context {
 static count=0;
 constructor(){Context.count++;this.currentTime=0;this.state='suspended';this.destination={};this.sources=[];this.oscillators=[];}
 async resume(){this.state='running';}
 async close(){this.state='closed';}
 createBuffer(channels,length,sampleRate){return {duration:length/sampleRate,copyToChannel(){}};}
 createBufferSource(){const node=new Node();this.sources.push(node);return node;}
 createOscillator(){const node=new Node();this.oscillators.push(node);return node;}
 createGain(){return new Node();}
 createChannelSplitter(){return new Node();}
 createAnalyser(){return new Node();}
}
const audio = (duration=2, channels=1) => ({sampleRate:8000,channels:Array.from({length:channels},()=>new Float32Array(8000*duration))});

test('pure clock maps initial offsets, rate, loop wraps and natural end without timer drift',()=>{
 const config={offset:1,elapsed:0,rate:1,duration:10,loop:false,loopStart:2,loopEnd:4};
 assert.equal(playbackPosition({...config,elapsed:3}),4);
 assert.equal(playbackPosition({...config,elapsed:3,rate:2}),7);
 assert.equal(playbackPosition({...config,elapsed:100}),10);
 assert.equal(playbackPosition({...config,elapsed:5,loop:true}),2);
 assert.equal(playbackPosition({...config,elapsed:100.5,loop:true}),3.5);
});

test('construction is silent; pause/rate/stop preserve clock semantics and dispose closes context',async()=>{
 const previous=globalThis.AudioContext;globalThis.AudioContext=Context;
 const updates=[],meters=[];const before=Context.count;
 const playback=new Playback({onTime:x=>updates.push(x),onMeter:x=>meters.push(x)});
 try{
  assert.equal(Context.count,before);assert.equal(playback.context,null);assert.equal(playback.playing,false);
  await playback.play(audio(4),{timelineOffset:10,offset:1});
  const context=playback.context;context.currentTime=.515;assert.equal(playback.position,11.5);
  playback.setRate(2);assert.equal(playback.position,11.5);
  context.currentTime=.765;assert.equal(playback.position,12);
  assert.equal(playback.pause(),12);assert.equal(playback.position,12);assert.equal(playback.playing,false);
  assert.ok(context.sources[0].stops.length);assert.ok(context.sources[0].disconnected);
  assert.deepEqual(meters.at(-1),{left:0,right:0,clipped:false});
  playback.stop();assert.equal(playback.position,0);assert.equal(updates.at(-1),0);
  await playback.dispose();assert.equal(context.state,'closed');assert.equal(playback.context,null);
 }finally{playback.stop();globalThis.AudioContext=previous;}
});

test('metronome schedules actual audio-clock beats including repeated loop boundaries and cancels all future clicks',async()=>{
 const previous=globalThis.AudioContext;globalThis.AudioContext=Context;
 const playback=new Playback();
 try{
  await playback.play(audio(2),{loop:true,loopStart:0,loopEnd:.2,metronome:true,bpm:120});
  const context=playback.context;
  assert.ok(context.oscillators.some(x=>Math.abs(x.startTime-.015)<1e-8));
  assert.ok(context.oscillators.some(x=>Math.abs(x.startTime-.215)<1e-8));
  context.currentTime=.25;playback._tick();
  assert.ok(context.oscillators.some(x=>Math.abs(x.startTime-.415)<1e-8),JSON.stringify(context.oscillators.map(x=>x.startTime)));
  context.currentTime=.5;playback._tick();
  assert.ok(context.oscillators.some(x=>Math.abs(x.startTime-.615)<1e-8),JSON.stringify(context.oscillators.map(x=>x.startTime)));
  playback.setMetronome(false);assert.ok(context.oscillators.every(x=>x.disconnected&&x.stops.includes(0)));
  const count=context.oscillators.length;context.currentTime=100.5;playback._tick();assert.equal(context.oscillators.length,count);
  assert.ok(Math.abs(playback.position-.085)<1e-8);
 }finally{playback.stop();globalThis.AudioContext=previous;}
});

test('metronome beat offset, rate and timeline offset use the same grid; natural end cleans nodes',async()=>{
 const previous=globalThis.AudioContext;globalThis.AudioContext=Context;let ended;
 const playback=new Playback({onEnded:x=>{ended=x;}});
 try{
  await playback.play(audio(1),{timelineOffset:2,offset:.1,rate:2,bpm:120,beatOffset:.25,metronome:true});
  const context=playback.context;
  // Timeline starts 2.1; the next absolute beat is 2.25, .075 wall-clock s later.
  assert.ok(context.oscillators.some(x=>Math.abs(x.startTime-.09)<1e-8));
  context.sources[0].onended();
  assert.equal(playback.playing,false);assert.equal(ended,3);assert.equal(playback.position,3);assert.equal(playback._timer,null);
  assert.ok(context.oscillators.every(x=>x.disconnected));
 }finally{playback.stop();globalThis.AudioContext=previous;}
});

test('stop cancels a pending async resume before any source can become audible',async()=>{
 const previous=globalThis.AudioContext;let resume;
 class SlowContext extends Context {resume(){return new Promise(resolve=>{resume=()=>{this.state='running';resolve();};});}}
 globalThis.AudioContext=SlowContext;const playback=new Playback();
 try{const pending=playback.play(audio());playback.stop();resume();assert.equal(await pending,false);assert.equal(playback.context.sources.length,0);assert.equal(playback.playing,false);}
 finally{playback.stop();globalThis.AudioContext=previous;}
});

test('invalid audio or loop ranges reject before creating an AudioContext',async()=>{
 const previous=globalThis.AudioContext;globalThis.AudioContext=Context;const before=Context.count;const playback=new Playback();
 try{
  await assert.rejects(playback.play({sampleRate:8000,channels:[new Float32Array(0)]}),/nonempty/);
  await assert.rejects(playback.play(audio(),{loop:true,loopStart:1,loopEnd:.5}),/follow/);
  await assert.rejects(playback.play(audio(),{rate:0}),/rate/);
  assert.equal(Context.count,before);
 }finally{playback.stop();globalThis.AudioContext=previous;}
});


test('custom beats-per-bar accents follow the project meter and validate integer1–16',async()=>{
 const previous=globalThis.AudioContext;globalThis.AudioContext=Context;const playback=new Playback();
 try{
  await playback.play(audio(4),{bpm:120,beatsPerBar:3,metronome:true});
  const context=playback.context;
  for(const time of [.4,.9,1.4]){context.currentTime=time;playback._tick();}
  const accents=context.oscillators.map(node=>node.frequency.events[0].value);
  assert.deepEqual(accents.slice(0,4),[1400,950,950,1400]);
  playback.setTempo(120,0,2);assert.equal(playback._beatsPerBar,2);
  assert.throws(()=>playback.setTempo(120,0,3.5),/integer/);
  assert.equal(playback._beatsPerBar,2);
  await assert.rejects(playback.play(audio(),{beatsPerBar:0}),/Beats per bar/);
  await assert.rejects(playback.play(audio(),{beatsPerBar:17}),/Beats per bar/);
 }finally{playback.stop();globalThis.AudioContext=previous;}
});
