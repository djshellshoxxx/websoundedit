import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryDirectory} from './audio-test-support.js';

test('actual storage worker distinguishes numeric manifest channels from transferable PCM arrays',async()=>{
  const saved=Object.fromEntries(['self','navigator'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),root=new MemoryDirectory(),pending=new Map();let id=0;
  const scope={postMessage(message,transfers=[]){
    const clone=structuredClone(message,{transfer:transfers}),entry=pending.get(clone.id);if(!entry)return;pending.delete(clone.id);clearTimeout(entry.timer);
    if(clone.error)entry.reject(Object.assign(new Error(clone.error.message),{code:clone.error.code}));else entry.resolve(clone);
  }};
  Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{getDirectory:async()=>root}}});
  const request=(method,params={},data)=>new Promise((resolve,reject)=>{
    const requestId=++id,timer=setTimeout(()=>reject(new Error('Storage worker did not reply.')),2000);pending.set(requestId,{resolve,reject,timer});
    scope.onmessage({data:structuredClone({id:requestId,method,params,data},{transfer:data?[data.buffer]:[]})});
  });
  try{
    await import('../src/recording-worker.js?recording-worker-regression');
    const started=(await request('start',{sampleRate:8000,layout:'stereo',name:'Worker roundtrip'})).result;assert.equal(started.channels,2);
    const pcm=Float32Array.from({length:256},(_,i)=>i%2?.25:.5),appended=await request('append',{},pcm);assert.equal(pcm.byteLength,0);assert.equal(appended.result.channels,2);assert.equal(appended.result.frames,128);assert.equal(appended.buffer.byteLength,1024);
    assert.equal((await request('pause')).result.channels,2);assert.equal((await request('resume')).result.channels,2);assert.equal((await request('stop')).result.frames,128);
    const range=(await request('range',{recordingId:started.id,start:0,end:.016})).result;assert.equal(range.channels.length,2);assert.equal(range.channels[0].length,128);assert.ok(range.channels[0].every(sample=>sample===.5));assert.ok(range.channels[1].every(sample=>sample===.25));
    assert.equal((await request('recover',{recordingId:started.id})).result.channels,2);assert.equal((await request('list')).result.recordings[0].id,started.id);
    await request('delete',{recordingId:started.id});assert.deepEqual((await request('list')).result.recordings,[]);
  }finally{
    for(const entry of pending.values())clearTimeout(entry.timer);
    for(const[key,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
});
