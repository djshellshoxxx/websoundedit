import test from 'node:test';
import assert from 'node:assert/strict';
import {RecordingStore,validateRecordingManifest} from '../src/recording-store.js';
import {MemoryDirectory} from './audio-test-support.js';
import {decodeWav} from '../src/wav.js';
import {createStreamWavHeader,writeStreamWav} from '../src/wav-stream.js';
import {CaptureKernel} from '../src/capture-kernel.js';
import {RecordingClient} from '../src/recording-client.js';
test('OPFS protocol preserves interleaved surround, pause gaps, bounded ranges and streamed WAV',async()=>{
  const root=new MemoryDirectory(),store=new RecordingStore(root),record=await store.start({sampleRate:8000,layout:'5.1',name:'DJ fixture'});
  const packet=Float32Array.from({length:128*6},(_,i)=>(i%6+1)/16);for(let i=0;i<200;i++)await store.append(packet);
  await store.pause();await assert.rejects(store.append(packet),e=>e.code==='NOT_RECORDING');await store.resume();await store.append(packet);const done=await store.stop();assert.equal(done.frames,201*128);assert.equal(done.seconds,201*128/8000);
  const range=await store.readRange(record.id,{start:.125,end:.25});assert.equal(range.layout,'5.1');assert.equal(range.channels[0].length,1000);for(let c=0;c<6;c++)assert.ok(range.channels[c].every(value=>value===(c+1)/16));
  const chunks=[];let closed=false;await store.export(record.id,{write:async bytes=>chunks.push(bytes.slice()),close:async()=>{closed=true;},abort:async()=>{}},{start:.125,end:.25});assert.equal(closed,true);const total=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const chunk of chunks){total.set(chunk,offset);offset+=chunk.length;}assert.deepEqual(decodeWav(total),range);
  assert.equal((await store.list()).recordings.length,1);await store.delete(record.id);assert.equal((await store.list()).recordings.length,0);
});
test('interrupted manifests recover the last valid committed range and ignore unrelated files',async()=>{
  const root=new MemoryDirectory(),store=new RecordingStore(root),record=await store.start({sampleRate:8000,layout:'stereo'});await store.append(new Float32Array(512).fill(.25));await store.stop();
  const own=await root.getDirectoryHandle('websoundedit-recordings-v1'),dir=await own.getDirectoryHandle(record.id);const manifest=await store._manifest(dir,record.id);const latest=await dir.getFileHandle(`manifest-${manifest.generation%2}.json`);latest.bytes=new TextEncoder().encode('{ interrupted write');
  await own.getFileHandle('unrelated.json',{create:true});const replacement=new RecordingStore(root),recovered=await replacement.recover(record.id);assert.equal(recovered.frames,256);assert.equal(recovered.status,'interrupted');assert.equal((await replacement.list()).recordings.length,1);
  const raw=await dir.getFileHandle('audio.f32');raw.bytes=raw.bytes.slice(0,400);const truncated=await replacement.recover(record.id);assert.equal(truncated.frames,50);assert.equal(truncated.bytes,400);
  assert.throws(()=>validateRecordingManifest({...recovered,frames:Infinity}));await assert.rejects(replacement.delete('../outside'));
});
test('quota, capacity and output failure stop safely without discarding confirmed bytes',async()=>{
  const root=new MemoryDirectory(),store=new RecordingStore(root),record=await store.start({sampleRate:8000,layout:'mono',maxBytes:1024});await store.append(new Float32Array(128).fill(.1));await assert.rejects(store.append(new Float32Array(256)),e=>e.code==='RECORDING_LIMIT');assert.equal(store.active,null);assert.equal((await store.recover(record.id)).bytes,512);
  const next=await store.start({sampleRate:8000,layout:'mono'});await store.append(new Float32Array(128));root.maxBytes=800;await assert.rejects(store.append(new Float32Array(128)),e=>e.code==='STORAGE_ERROR');root.maxBytes=Infinity;assert.equal((await store.recover(next.id)).bytes,512);
  let aborted=false;await assert.rejects(store.export(record.id,{write:async()=>{throw new Error('Synthetic output error');},abort:async()=>{aborted=true;}}),/Synthetic output/);assert.equal(aborted,true);assert.equal((await store.list()).recordings.length,2);
});
test('RF64 headers represent multi-hour sizes without allocating a multi-hour buffer; cancellation aborts streaming output',async()=>{
  const frames=48000*60*60*8,header=createStreamWavHeader({sampleRate:48000,layout:'7.1',frames}),view=new DataView(header.bytes.buffer);assert.equal(new TextDecoder().decode(header.bytes.slice(0,4)),'RF64');assert.equal(header.rf64,true);assert.equal(view.getBigUint64(28,true),BigInt(frames)*32n);assert.equal(view.getBigUint64(36,true),BigInt(frames));assert.equal(header.bytes.length,116);
  const controller=new AbortController();let writes=0,aborted=false;await assert.rejects(writeStreamWav({sampleRate:8000,layout:'mono',frames:256,read:async(_,count)=>new Uint8Array(count*4)},{write:async()=>{if(++writes===2)controller.abort();},abort:async()=>{aborted=true;}},{chunkFrames:128,signal:controller.signal}),e=>e.code==='ABORTED');assert.equal(aborted,true);
});
test('sample-clock capture honors exact boundaries and its fixed pool stops rather than silently dropping',()=>{
  const packets=[],ends=[];let kernel;kernel=new CaptureKernel({channels:2,framesPerChunk:128,poolSize:2,onChunk:packet=>{packets.push({...packet,data:packet.data.slice(0,packet.frames*2)});kernel.recycle(packet.data.buffer);},onEnd:value=>ends.push(value)});kernel.start({startFrame:64,endFrame:320});for(let frame=0;frame<384;frame+=128)kernel.process([Float32Array.from({length:128},(_,i)=>(frame+i)/1000),new Float32Array(128).fill(.5)],frame);assert.equal(ends[0].frames,256);assert.equal(packets[0].startFrame,64);assert.equal(packets[0].data[0],Math.fround(.064));assert.equal(packets.at(-1).data.at(-2),Math.fround(.319));
  const errors=[];const blocked=new CaptureKernel({channels:1,framesPerChunk:128,poolSize:2,onError:error=>errors.push(error)});blocked.start({startFrame:0,endFrame:1024});for(let frame=0;frame<512;frame+=128)blocked.process([new Float32Array(128)],frame);assert.equal(errors.length,1);assert.equal(errors[0].code,'BACKPRESSURE');assert.equal(blocked.frames,256);assert.equal(blocked.active,false);
});
test('storage worker client rejects excess queued PCM and terminal errors release every pending request',async()=>{
  let worker;const client=new RecordingClient({workerFactory:()=>worker={postMessage(){},terminate(){this.terminated=true;}}});const first=client.execute('append',{},new Float32Array(2*1024*1024)).catch(e=>e.code);await assert.rejects(client.execute('append',{},new Float32Array(1)),e=>e.code==='BACKPRESSURE');assert.equal(client.queuedBytes,8*1024*1024);worker.onerror({message:'Synthetic storage interruption'});assert.equal(await first,'STORAGE_ERROR');assert.equal(client.queuedBytes,0);await assert.rejects(client.execute('list'),/Synthetic storage interruption/);assert.equal(worker.terminated,true);
});
test('archive preflight rejects active and subframe reads and releases a failed export destination',async()=>{
  const store=new RecordingStore(new MemoryDirectory()),record=await store.start({sampleRate:8000,layout:'mono'});await store.append(new Float32Array(128));await assert.rejects(store.readRange(record.id),error=>error.code==='BUSY');await store.stop();await assert.rejects(store.readRange(record.id,{start:0,end:.00001}),/sample frame/);
  let aborted=0,written=0;await assert.rejects(store.export(record.id,{write:async()=>{written++;},abort:async()=>{aborted++;}},{start:0,end:5}));assert.equal(aborted,1);assert.equal(written,0);
  let ended;const kernel=new CaptureKernel({channels:1,framesPerChunk:128,onChunk:packet=>kernel.recycle(packet.data.buffer),onEnd:value=>{ended=value;}});kernel.start({startFrame:0,endFrame:1000});kernel.process([new Float32Array(128)],0);assert.equal(kernel.stop(64),128);assert.equal(ended.endFrame,128);assert.equal(ended.frames,128);
});
test('storage cancellation uses a bounded control message and settles after the worker abort acknowledgement',async()=>{
  const messages=[];let worker;const client=new RecordingClient({workerFactory:()=>worker={postMessage:message=>messages.push(message),terminate(){}}}),controller=new AbortController();const pending=client.execute('export',{},undefined,undefined,{signal:controller.signal}),rejected=assert.rejects(pending,error=>error.code==='ABORTED');controller.abort();assert.equal(messages[1].method,'cancel');assert.equal(messages[1].requestId,messages[0].id);worker.onmessage({data:{id:messages[0].id,error:{code:'ABORTED',message:'Synthetic cooperative cancellation'}}});await rejected;assert.equal(client.pending.size,0);assert.equal(client.queuedBytes,0);client.dispose();
});
