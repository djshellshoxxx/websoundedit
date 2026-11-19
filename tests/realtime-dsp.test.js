import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeRackDSP,renderLiveDSP,validateLiveGraphs,LIVE_LIMITS} from '../src/realtime-dsp.js';
import {RealtimeRackManager} from '../src/realtime-rack.js';
import {RACK_EFFECTS} from '../src/rack-config.js';
const audio=(channels=2,frames=4096)=>({sampleRate:8000,layout:channels===8?'7.1':channels===6?'5.1':channels===1?'mono':'stereo',channels:Array.from({length:channels},(_,c)=>Float32Array.from({length:frames},(_,i)=>i===0?.7:Math.sin(i*.14+c*.1)*.15))});
for(const effect of Object.keys(RACK_EFFECTS))test(`live ${effect} retains state across arbitrary blocks, differs audibly, preserves surround channels and zero wet`,()=>{
  const input=audio(6),chain=[{id:'stage',effect,wet:1,params:{}}];
  const block=renderLiveDSP(input,{chain,blockFrames:128}),odd=renderLiveDSP(input,{chain,blockFrames:137});
  assert.deepEqual(block,odd);assert.equal(block.channels.length,6);assert.ok(block.channels.every(c=>c.every(Number.isFinite)));
  assert.ok(block.channels.some((c,k)=>c.some((x,i)=>Math.abs(x-input.channels[k][i])>1e-5)));
  const bypass=renderLiveDSP(input,{chain:[{...chain[0],wet:0}]});assert.deepEqual(bypass,input);
});
test('feedback delay and reverb continue into later blocks after their input stops',()=>{
  const input={sampleRate:8000,channels:[new Float32Array(4000)]};input.channels[0][0]=1;
  const delay=renderLiveDSP(input,{chain:[{id:'d',effect:'delay',wet:1,params:{timeMs:10,feedback:.5}}]});assert.equal(delay.channels[0][80],1);assert.equal(delay.channels[0][160],.5);assert.equal(delay.channels[0][240],.25);
  const reverb=renderLiveDSP(input,{chain:[{id:'r',effect:'reverb',wet:1,params:{predelayMs:20}}]});assert.ok(reverb.channels[0].slice(1000).some(x=>Math.abs(x)>1e-5));assert.ok(reverb.channels[0].slice(0,160).every(x=>x===0));
});
test('stable stage IDs preserve delay history across a reorder and rejected changes preserve active output',()=>{
  const chain=[{id:'d',effect:'delay',wet:1,params:{timeMs:10,feedback:.5}},{id:'t',effect:'tremolo',wet:0}];
  const dsp=new RealtimeRackDSP({sampleRate:8000,channels:1,chain}),input=[new Float32Array(64)],out=[new Float32Array(64)];input[0][0]=1;dsp.process(input,out);
  const original=dsp.stages[0];dsp.updateChain([...chain].reverse());assert.equal(dsp.stages[1],original);
  assert.throws(()=>dsp.updateChain([{id:'d',effect:'delay',params:{feedback:4}}]));input[0].fill(0);dsp.process(input,out);assert.equal(out[0][16],1);
});
test('automation evaluates exact sample time, respects timeline offsets and linear/step curves',()=>{
  const input={sampleRate:8000,channels:[new Float32Array(800).fill(1)]},chain=[{id:'t',effect:'tremolo',wet:1,params:{rate:1,depth:1}}];
  const automation=[{slotId:'t',param:'wet',points:[{time:10,value:0,curve:'linear'},{time:10.1,value:1,curve:'step'}]}];
  const output=renderLiveDSP(input,{chain,automation,start:10});assert.equal(output.channels[0][0],1);
  const half=1-.5*(.5+.5*Math.sin(2*Math.PI*.05));assert.ok(Math.abs(output.channels[0][400]-half)<1e-6);
  const full=renderLiveDSP(input,{chain,automation,start:0});assert.ok(full.channels[0][0]<1);
  const dsp=new RealtimeRackDSP({sampleRate:8000,channels:1,chain});dsp.schedule({slotId:'t',param:'wet',value:0,at:.01});const out=[new Float32Array(128)];dsp.process([input.channels[0].subarray(0,128)],out);assert.equal(out[0][80],1);
});
test('aggregate graph limits validate channel/sample-rate memory, total stages and automation before allocation',()=>{
  assert.throws(()=>validateLiveGraphs([{id:'master',chain:[{id:'e',effect:'echo'}]}],{sampleRate:192000,channels:8}),e=>e.code==='RESOURCE_LIMIT');
  const graphs=Array.from({length:11},(_,g)=>({id:`track${g}`,chain:Array.from({length:12},(_,i)=>({id:`stage${i}`,effect:'tremolo'}))}));assert.throws(()=>validateLiveGraphs(graphs,{sampleRate:48000,channels:2}),e=>e.code==='RESOURCE_LIMIT');
});
test('automation restores its initial value after seek and replacing an effect clears incompatible queued controls',()=>{
  const dsp=new RealtimeRackDSP({sampleRate:8000,channels:1,chain:[{id:'stage',effect:'delay',wet:0}]});
  dsp.setAutomation([{slotId:'stage',param:'wet',points:[{time:1,value:1}]}]);dsp.process([new Float32Array(1).fill(.5)],[new Float32Array(1)],{timelineStart:1});
  const out=[new Float32Array(1)];dsp.process([new Float32Array(1).fill(.5)],out,{timelineStart:0});assert.equal(out[0][0],.5);
  dsp.schedule({slotId:'stage',param:'feedback',value:.8,at:2,rampSeconds:1});dsp.updateChain([{id:'stage',effect:'tremolo',wet:0}]);assert.equal(dsp.pendingEventCount(),0);assert.equal(dsp.lanes.length,0);dsp.process([new Float32Array(1).fill(.5)],out,{timelineStart:3});assert.equal(out[0][0],.5);
});
test('live stutter recaptures a complete new slice when division or tempo changes',()=>{
  const dsp=new RealtimeRackDSP({sampleRate:8000,channels:1,chain:[{id:'s',effect:'stutter',wet:1,params:{division:32,gate:1,fadeMs:0}}]}),out=[new Float32Array(128)];dsp.process([new Float32Array(128).fill(.25)],out);
  dsp.schedule({slotId:'s',param:'division',value:2,at:128/8000});dsp.process([new Float32Array(128).fill(.75)],out);assert.ok(out[0].every(value=>value===.75));dsp.setTempo(100);assert.equal(dsp.stages[0].frame,0);dsp.process([new Float32Array(128).fill(.5)],out);assert.ok(out[0].every(value=>value===.5));
});
test('manual effect ramps advance while the transport is frozen, and timeline automation stays on transport time',()=>{
  const dsp=new RealtimeRackDSP({sampleRate:8000,channels:1,chain:[{id:'t',effect:'tremolo',wet:0,params:{rate:.05,depth:1}}]}),out=[new Float32Array(128)];
  dsp.schedule({slotId:'t',param:'wet',value:1,at:0,rampSeconds:.01});for(let i=0;i<16;i++)dsp.process([new Float32Array(128).fill(.5)],out,{timelineStart:0,timelineRate:0});assert.equal(dsp.stages[0].wet,1);assert.equal(dsp.pendingEventCount(),0);assert.ok(out[0].every(value=>value<.3));
  dsp.setAutomation([{slotId:'t',param:'wet',points:[{time:0,value:0,curve:'step'},{time:1,value:1,curve:'step'}]}]);for(let i=0;i<16;i++)dsp.process([new Float32Array(128).fill(.5)],out,{timelineStart:0,timelineRate:0});assert.ok(out[0].every(value=>value===.5));dsp.process([new Float32Array(128).fill(.5)],out,{timelineStart:1,timelineRate:0});assert.ok(out[0].every(value=>value<.3));
});
test('shared scheduled-event, lane and voice PCM budgets reject before sending a graph mutation',async()=>{
  let sent=0;const manager=new RealtimeRackManager({sampleRate:8000},{channels:1,loadModule:async()=>{},nodeFactory:()=>{let queued=0;const node={port:{postMessage(message){sent++;if(message.method==='parameter')queued++;queueMicrotask(()=>node.port.onmessage?.({data:{id:message.id,ok:true,queuedEvents:queued}}));},close(){}},disconnect(){}};return node;}});
  for(const id of ['one','two']){await manager.setChain(id,[{id:'t',effect:'tremolo'}]);await manager.setAutomation(id,[{slotId:'t',param:'wet',points:Array.from({length:4095},(_,i)=>({time:i/10,value:0,curve:'step'}))}]);}
  await manager.setParameter('one',{slotId:'t',param:'wet',value:.5,at:800});await manager.setParameter('two',{slotId:'t',param:'wet',value:.6,at:800});const before=sent;
  await assert.rejects(manager.setParameter('one',{slotId:'t',param:'wet',value:.8,at:801}),error=>error.code==='RESOURCE_LIMIT');assert.equal(sent,before);assert.equal(manager.graphs.get('one').chain[0].wet,.5);
  const release=manager.reserveVoice(LIVE_LIMITS.voiceBytes);assert.throws(()=>manager.reserveVoice(4),error=>error.code==='RESOURCE_LIMIT');release();assert.equal(manager.voiceBytes,0);manager.dispose();
});
test('excessive aggregate graph requests fail atomically without replacing a playing graph or exceeding voices',async()=>{
  let created=0;const context={sampleRate:192000};
  const manager=new RealtimeRackManager(context,{channels:8,layout:'7.1',loadModule:async()=>{},nodeFactory:(_,config)=>{
    created++;const dsp=new RealtimeRackDSP({sampleRate:192000,...config});const node={dsp,port:{postMessage(message){if(message.method==='chain')dsp.updateChain(message.chain);queueMicrotask(()=>node.port.onmessage?.({data:{id:message.id,ok:true}}));},close(){}},disconnect(){}};return node;
  }});
  const active=await manager.setChain('master',[{id:'t',effect:'tremolo',wet:0}]);
  await assert.rejects(manager.setChain('too-big',[{id:'e',effect:'echo'}]),e=>e.code==='RESOURCE_LIMIT');assert.equal(created,1);assert.equal(manager.graphs.get('master').node,active);
  const input=audio(8,128).channels,out=input.map(c=>new Float32Array(c.length));active.dsp.process(input,out);assert.deepEqual(out,input);
  const releases=Array.from({length:LIVE_LIMITS.voices},()=>manager.reserveVoice());assert.throws(()=>manager.reserveVoice(),e=>e.code==='RESOURCE_LIMIT');releases[0]();const release=manager.reserveVoice();release();releases.forEach(fn=>fn());assert.equal(manager.voices.size,0);manager.dispose();
});
