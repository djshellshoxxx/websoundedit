import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureTap } from '../src/capture-tap.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(run){
  const saved={AudioWorkletNode:globalThis.AudioWorkletNode,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout},timers=new Map(),taps=[];let timerId=0;
  class NodeMock {connect(){} disconnect(){}}
  globalThis.AudioWorkletNode=class extends NodeMock {constructor(context,name,options){super();this.options=options;this.messages=[];this.port={postMessage:(message)=>this.messages.push(message),close(){}};}};
  globalThis.setTimeout=(callback,ms)=>{const id=++timerId;timers.set(id,{callback,ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  const context={currentTime:1,sampleRate:48000,destination:new NodeMock(),createGain(){const node=new NodeMock();node.gain={value:1};return node;}};
  const create=(options={})=>{const errors=[],ends=[],tap=new CaptureTap(context,new NodeMock(),{channels:2,framesPerChunk:2048,loopFrames:0,onStart(){},onChunk:packet=>packet.data.buffer,onEnd:result=>ends.push(result),onError:error=>errors.push(error),...options});taps.push(tap);return{tap,errors,ends,receive:message=>tap.node.port.onmessage?.({data:message})};};
  try{await run({create,timers,context});}finally{for(const tap of taps)tap.dispose();timers.clear();globalThis.setTimeout=saved.setTimeout;globalThis.clearTimeout=saved.clearTimeout;if(saved.AudioWorkletNode===undefined)delete globalThis.AudioWorkletNode;else globalThis.AudioWorkletNode=saved.AudioWorkletNode;}
}

test('capture pool override preserves the existing loop and input defaults',()=>fixture(async({create})=>{
  const loop=create({loopFrames:6000}),input=create({framesPerChunk:1024}),recording=create({framesPerChunk:6016,poolSize:16});
  assert.deepEqual(loop.tap.node.options.processorOptions,{channels:2,framesPerChunk:2048,loopFrames:6000,poolSize:8});
  assert.equal(input.tap.node.options.processorOptions.framesPerChunk,1024);assert.equal(input.tap.node.options.processorOptions.poolSize,8);
  assert.equal(recording.tap.node.options.processorOptions.framesPerChunk,6016);assert.equal(recording.tap.node.options.processorOptions.poolSize,16);
}));

test('overlapping stops share the error result without orphaning the first timeout',()=>fixture(async({create,timers})=>{
  let second;const errors=[];const current=create({onError:error=>{errors.push(error);second=current.tap.stop();}});
  const first=current.tap.stop();current.receive({type:'error',code:'BACKPRESSURE',message:'bounded pool full',frames:16384});
  assert.equal(second,first);const result=await first;
  assert.equal(result.error,'bounded pool full');assert.equal(result.code,'BACKPRESSURE');assert.equal(result.frames,16384);
  assert.equal(errors.length,1);assert.equal(timers.size,0);assert.equal(current.tap.node.messages.filter(message=>message.type==='stop').length,1);
}));

test('an error stop drains every accepted PCM chunk and retains the first visible error',()=>fixture(async({create,timers})=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),written=[];const current=create({onChunk:async packet=>{await held;written.push(Array.from(packet.data));return packet.data.buffer;}});
  const data=new Float32Array(4096);data.set([.125,-.125,.25,-.25,.5,-.5,.75,-.75]);
  const tail=new Float32Array(4096);tail.set([1,-1]);
  current.receive({type:'chunk',data,frames:4,channels:2});current.receive({type:'chunk',data:tail,frames:1,channels:2});await tick();
  let settled=false;const stopping=current.tap.stop().then(result=>{settled=true;return result;});
  current.receive({type:'error',code:'BACKPRESSURE',message:'bounded pool full',frames:5});
  current.receive({type:'error',code:'CAPTURE_ERROR',message:'later cleanup failure',frames:5});
  await tick();assert.equal(settled,false);assert.deepEqual(written,[]);
  release();const result=await stopping;
  assert.deepEqual(written,[[.125,-.125,.25,-.25,.5,-.5,.75,-.75],[1,-1]]);assert.equal(result.frames,5);assert.equal(result.error,'bounded pool full');assert.equal(result.code,'BACKPRESSURE');
  assert.equal(current.errors.length,1);assert.equal(current.ends.length,0);assert.equal(timers.size,0);
}));

test('normal capture completion also drains PCM and calls onEnd exactly once',()=>fixture(async({create})=>{
  let release;const held=new Promise(resolve=>{release=resolve;});let written=false;
  const current=create({onChunk:async packet=>{await held;written=true;return packet.data.buffer;}});
  current.receive({type:'chunk',data:new Float32Array(4096),frames:9,channels:2});await tick();
  const stopping=current.tap.stop();let settled=false;stopping.then(()=>{settled=true;});
  current.receive({type:'end',frames:9,startFrame:48000,endFrame:48009});current.receive({type:'end',frames:9,startFrame:48000,endFrame:48009});
  await tick();assert.equal(settled,false);assert.equal(current.ends.length,0);
  release();const result=await stopping;assert.equal(written,true);assert.equal(result.frames,9);assert.equal(result.error,undefined);assert.equal(current.ends.length,1);assert.equal(current.errors.length,0);
}));

test('a consumer failure cannot become successful completion when the worklet later ends',()=>fixture(async({create})=>{
  let stop;const seen=[];const failure=Object.assign(new Error('storage write failed'),{code:'STORAGE_ERROR'});
  const current=create({onChunk:async packet=>{seen.push(packet.frames);if(seen.length===1)throw failure;return packet.data.buffer;},onError:error=>{current.errors.push(error);stop=current.tap.stop();}});
  current.receive({type:'chunk',data:new Float32Array(4096),frames:4,channels:2});current.receive({type:'chunk',data:new Float32Array(4096),frames:7,channels:2});
  current.receive({type:'end',frames:11,startFrame:48000,endFrame:48011});await tick();
  const result=await stop;assert.deepEqual(seen,[4,7]);assert.equal(result.error,'storage write failed');assert.equal(result.code,'STORAGE_ERROR');assert.equal(current.errors.length,1);assert.equal(current.ends.length,0);
}));

test('disposed taps ignore late messages and pending consumer errors',()=>fixture(async({create,timers})=>{
  let reject;const held=new Promise((resolve,fail)=>{reject=fail;});let chunks=0;
  const current=create({onChunk:async()=>{chunks++;await held;}}),receive=current.tap.node.port.onmessage;
  current.receive({type:'chunk',data:new Float32Array(4096),frames:4,channels:2});await tick();
  const stopping=current.tap.stop();current.tap.dispose();assert.equal((await stopping).disposed,true);
  receive({data:{type:'error',code:'BACKPRESSURE',message:'old tap error'}});receive({data:{type:'chunk',data:new Float32Array(4096),frames:4,channels:2}});receive({data:{type:'end',frames:4}});
  reject(new Error('old consumer failed'));await current.tap.pending;await tick();
  assert.equal(chunks,1);assert.equal(current.errors.length,0);assert.equal(current.ends.length,0);assert.equal(timers.size,0);assert.equal((await current.tap.stop()).disposed,true);
}));

test('capture stop retains its finite five-second deadline',()=>fixture(async({create,timers})=>{
  const current=create(),first=current.tap.stop();const rejected=assert.rejects(first,error=>error.code==='CAPTURE_TIMEOUT');
  assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.ms,5000);timer.callback();await rejected;
  assert.equal(current.tap.stop(),first);assert.equal(current.tap.node.messages.filter(message=>message.type==='stop').length,1);
}));

test('a completion callback error is retained by a reentrant stop caller',()=>fixture(async({create,timers})=>{
  let stopping;const failure=Object.assign(new Error('completion callback failed'),{code:'CALLBACK_ERROR'});
  const current=create({onEnd:()=>{throw failure;},onError:error=>{current.errors.push(error);stopping=current.tap.stop();}});
  current.receive({type:'end',frames:32,startFrame:48000,endFrame:48032});await tick();
  const result=await stopping;assert.equal(result.frames,32);assert.equal(result.error,failure.message);assert.equal(result.code,failure.code);
  assert.equal(current.errors.length,1);assert.equal(timers.size,0);assert.equal((await current.tap.stop()).error,failure.message);
}));
