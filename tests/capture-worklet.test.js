import test from 'node:test';
import assert from 'node:assert/strict';
import {CaptureKernel} from '../src/capture-kernel.js';

test('a late quantized capture moves to the next grid point without shortening the requested period',()=>{
  const starts=[],ends=[],packets=[];let kernel;
  kernel=new CaptureKernel({channels:1,framesPerChunk:128,onStart:value=>starts.push(value),onChunk:packet=>{packets.push(packet.data.slice(0,packet.frames));kernel.recycle(packet.data.buffer);},onEnd:value=>ends.push(value)});
  kernel.start({startFrame:64,endFrame:320,quantumFrames:256});
  for(let frame=128;frame<640;frame+=128)kernel.process([Float32Array.from({length:128},(_,i)=>(frame+i)/1000)],frame);
  assert.deepEqual(starts,[{startFrame:320,endFrame:576}]);assert.deepEqual(ends,[{frames:256,startFrame:320,endFrame:576}]);assert.equal(packets[0][0],Math.fround(.320));assert.equal(packets.at(-1).at(-1),Math.fround(.575));
});

test('actual capture processor preserves 6000 frames and loop phase when arming is 64 samples late',async()=>{
  const keys=['AudioWorkletProcessor','registerProcessor','currentFrame','sampleRate'],saved=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),messages=[];let Processor;
  const globals={AudioWorkletProcessor:class{constructor(){this.port={postMessage:(message,transfers=[])=>messages.push(structuredClone(message,{transfer:transfers}))};}},registerProcessor:(_,value)=>{Processor=value;},currentFrame:128,sampleRate:48000};
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  try{
    await import('../src/capture-worklet.js?capture-worklet-regression');
    const processor=new Processor({processorOptions:{channels:1,framesPerChunk:2048,poolSize:8,loopFrames:6000}});processor.port.onmessage({data:{type:'start',startFrame:64,endFrame:6064,quantumFrames:0}});
    const output=new Map();
    for(let frame=128;frame<12300;frame+=128){globalThis.currentFrame=frame;const block=new Float32Array(128);processor.process([[Float32Array.from({length:128},(_,i)=>(frame+i)/48000)]],[[block]]);for(let i=0;i<128;i++)if(frame+i>=6128)output.set(frame+i,block[i]);}
    assert.deepEqual(messages.find(message=>message.type==='start'),{type:'start',startFrame:128,endFrame:6128});assert.deepEqual(messages.find(message=>message.type==='end'),{type:'end',frames:6000,startFrame:128,endFrame:6128});
    const chunks=messages.filter(message=>message.type==='chunk'),captured=chunks.flatMap(message=>Array.from(message.data.subarray(0,message.frames)));
    assert.equal(captured.length,6000);for(let i=0;i<captured.length;i++)assert.equal(captured[i],Math.fround((128+i)/48000));
    assert.equal(output.get(6128),captured[0]);assert.equal(output.get(12127),captured[5999]);assert.equal(output.get(12128),captured[0]);
    assert.equal(messages.some(message=>message.type==='error'),false);
  }finally{for(const[key,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});
