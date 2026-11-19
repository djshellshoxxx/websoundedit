import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { UdpStreams, normalizeDestinations, encoderArgs } from '../scripts/udp-streams.mjs';
import { startApiServer } from '../scripts/server.mjs';
import { NodeWorkbench } from '../scripts/node-runtime.mjs';
import { CompanionBridge, companionURL } from '../src/companion.js';
import { encodeWav, decodeWav } from '../src/wav.js';
import { decodeAudioBytes, nativeCapabilities } from '../scripts/node-codecs.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('macro validation honors explicitly supplied variable names without executing commands',async()=>{
  const workbench=new NodeWorkbench();
  try{
    assert.equal((await workbench.execute('macro.validate',{text:'let value=custom; track.add({});',variables:{custom:1}})).valid,true);
    assert.equal((await workbench.execute('macro.validate',{text:'let value=missing; track.add({});',variables:{custom:1}})).valid,false);
    assert.equal(workbench.getState().tracks.length,0);
  }finally{await workbench.dispose();}
});
const pcm=(frames=1024,channels=1)=>{const bytes=Buffer.alloc(frames*channels*4);for(let i=0;i<frames;i++)for(let c=0;c<channels;c++)bytes.writeFloatLE(.25*Math.sin(2*Math.PI*(440+c*101)*i/48000),(i*channels+c)*4);return bytes;};
async function receiver(){const socket=createSocket('udp4'),packets=[];socket.on('message',message=>packets.push(Buffer.from(message)));await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'127.0.0.1',resolve);});return{socket,packets,destination:{id:'test',label:'Synthetic local receiver',address:'127.0.0.1',port:socket.address().port}};}
async function withApi(fn,options={}){const api=await startApiServer({port:0,...options});try{return await fn(api);}finally{await api.workbench.dispose();api.server.closeAllConnections();await new Promise(resolve=>api.server.close(resolve));}}
async function command(api,method,params={},expect=200){const response=await fetch(api.url+'/v1/execute',{method:'POST',headers:{Authorization:'Bearer '+api.token,'Content-Type':'application/json'},body:JSON.stringify({method,params})});const result=await response.json();assert.equal(response.status,expect,JSON.stringify(result));return result;}
test('HTTP PCM counters require one canonical integer query value and reject ambiguity atomically',async()=>{
  const r=await receiver();
  try{await withApi(async api=>{
    const {result:stream}=await command(api,'stream.start',{destination:'test',profile:'f32le',inputSampleRate:48000,inputLayout:'mono'});
    for(const sequence of ['','%20','0x0','1e0','0&sequence=1','-0']){
      const response=await fetch(api.url+'/v1/stream/'+stream.id+'/pcm?sequence='+sequence+'&startFrame=0&frames=1',{method:'POST',headers:{Authorization:'Bearer '+api.token,'Content-Type':'application/octet-stream'},body:pcm(1)});
      assert.equal(response.status,400);await response.arrayBuffer();assert.equal(api.workbench.streams.status().receivedPackets,0);
    }
    await command(api,'stream.stop');assert.equal(r.packets.length,0);
  },{destinations:[r.destination]});}finally{r.socket.close();}
});
test('destinations and encoder profiles cannot select arbitrary hosts, URLs or shell options',()=>{
  for(const destination of [{id:'x',address:'example.com',port:12},{id:'../x',address:'127.0.0.1',port:12},{id:'x',address:'127.0.0.1',port:0},{id:'x',address:'0.0.0.0',port:12}])assert.throws(()=>normalizeDestinations([destination]));
  const args=encoderArgs({profile:'opus',inputSampleRate:48000,sampleRate:48000,layout:'stereo',bitrate:128});assert.ok(args.includes('pipe:1'));assert.equal(args.some(arg=>arg.includes('udp://')),false);
  assert.throws(()=>encoderArgs({profile:'opus;echo pwn'}));
  for(const url of ['https://evil.example','http://127.0.0.1@evil.example','http://localhost.evil.example','http://127.0.0.1:8787/path','http://127.0.0.1:8787/?token=secret'])assert.throws(()=>companionURL(url));
  assert.equal(companionURL('http://localhost:8787'),'http://localhost:8787');
});
test('raw UDP carries exact mono PCM, reports sequence gaps and rejects malformed packets atomically',async()=>{
  const r=await receiver(),streams=new UdpStreams({destinations:[r.destination]});
  try{
    const state=await streams.start({destination:'test',profile:'f32le',inputSampleRate:48000,inputLayout:'mono'}),bytes=pcm(1024);
    assert.throws(()=>streams.feed(state.id,Buffer.alloc(3),{sequence:0,startFrame:0,frames:1}));assert.equal(streams.status().receivedPackets,0);
    const invalid=Buffer.from(bytes);invalid.writeFloatLE(NaN,0);assert.throws(()=>streams.feed(state.id,invalid,{sequence:0,startFrame:0,frames:1024}));assert.equal(streams.status().receivedPackets,0);
    streams.feed(state.id,bytes,{sequence:0,startFrame:0,frames:1024});assert.throws(()=>streams.feed(state.id,bytes,{sequence:0,startFrame:0,frames:1024}),{code:'SEQUENCE_ERROR'});
    streams.feed(state.id,bytes,{sequence:2,startFrame:2048,frames:1024,droppedFrames:1024});
    const stopped=await streams.stop();await pause(10);assert.deepEqual(Buffer.concat(r.packets),Buffer.concat([bytes,bytes]));
    assert.equal(stopped.active,false);assert.equal(stopped.sequenceGaps,1);assert.equal(stopped.reportedDroppedFrames,1024);assert.equal(stopped.frameDiscontinuities,1);assert.ok(r.packets.every(packet=>packet.length<=1316&&packet.length%4===0));
  }finally{await streams.dispose();r.socket.close();}
});
test('UDP float-to-s16 conversion clips correctly and explicit surround downmix excludes LFE',async()=>{
  const r=await receiver(),streams=new UdpStreams({destinations:[r.destination]});
  try{
    const state=await streams.start({destination:'test',profile:'s16le',inputSampleRate:48000,inputLayout:'5.1',layout:'mono'}),bytes=Buffer.alloc(3*6*4);
    bytes.writeFloatLE(1,3*4); // LFE-only first frame.
    for(let c=0;c<6;c++){bytes.writeFloatLE(10,(6+c)*4);bytes.writeFloatLE(-10,(12+c)*4);}
    streams.feed(state.id,bytes,{sequence:0,startFrame:0,frames:3});await streams.stop();await pause(10);
    const output=Buffer.concat(r.packets);assert.equal(output.length,6);assert.equal(output.readInt16LE(0),0);assert.equal(output.readInt16LE(2),32767);assert.equal(output.readInt16LE(4),-32768);
  }finally{await streams.dispose();r.socket.close();}
});
test('native streaming profiles produce decodable Opus, MP3, AAC/TS and FLAC datagrams',async t=>{
  const native=await nativeCapabilities();if(!native.nativeFFmpeg){t.skip('Native FFmpeg is optional outside CI.');return;}
  for(const [profile,format]of [['opus','opus'],['mp3','mp3'],['aac-ts','aac'],['flac','flac']]){
    if(!native.formats.includes(format))continue;
    const r=await receiver(),streams=new UdpStreams({destinations:[r.destination]});
    try{
      const state=await streams.start({destination:'test',profile,inputSampleRate:48000,inputLayout:'mono'});
      streams.feed(state.id,pcm(4800),{sequence:0,startFrame:0,frames:4800});const stopped=await streams.stop();await pause(10);
      assert.equal(stopped.error,null,profile);assert.ok(stopped.sentBytes>100,profile);assert.equal(stopped.udpDroppedPackets,0,profile);
      const bytes=new Uint8Array(Buffer.concat(r.packets));
      // Node's file decoder deliberately excludes MPEG-TS. Use a dedicated
      // bounded subprocess oracle in the companion profile test for TS.
      if(profile!=='aac-ts'){const decoded=await decodeAudioBytes(bytes);assert.equal(decoded.channels.length,1,profile);assert.ok(decoded.channels[0].some(value=>Math.abs(value)>.1),profile);assert.ok(decoded.channels[0].length/decoded.sampleRate>=.09,profile);}
      else{
        assert.equal(bytes[0],0x47);
        const decoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-f','mpegts','-i','pipe:0','-map','0:a:0','-ac','1','-ar','48000','-c:a','pcm_f32le','-f','f32le','pipe:1'],{input:bytes,maxBuffer:2*1024*1024,timeout:5000});
        assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length%4,0);assert.ok(decoded.stdout.length>=4000*4);let peak=0;for(let i=0;i<decoded.stdout.length;i+=4){const value=decoded.stdout.readFloatLE(i);assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));}assert.ok(peak>.1);
      }
    }finally{await streams.dispose();r.socket.close();}
  }
});
test('HTTP alias import, recorded script, macro export artifact and isolated batch use shared commands',async()=>{
  await withApi(async api=>{
    const bytes=encodeWav({sampleRate:8000,channels:[Float32Array.from({length:800},(_,i)=>i<100||i>699?0:.2)]});
    const response=await fetch(api.url+'/v1/inputs?name=take.wav',{method:'POST',headers:{Authorization:'Bearer '+api.token,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(response.status,200);const alias=(await response.json()).result;
    await command(api,'macro.record.start');await command(api,'file.import',{input:alias.id});await command(api,'effect.normalize',{targetDb:-3});const recording=(await command(api,'macro.record.stop')).result;assert.match(recording.text,/file.import/);assert.match(recording.text,/"input": input/);
    const before=await api.editor.execute('project.save');
    const result=(await command(api,'macro.batch',{text:'effect.trimSilence({thresholdDb:-40,minDuration:.01,padding:0});effect.normalize({targetDb:-1});file.export({scope:"track",format:"wav",name:input.stem});',inputIds:[alias.id]})).result;
    assert.equal(result.results[0].success,true);assert.deepEqual(await api.editor.execute('project.save'),before);
    const artifact=result.results[0].outputs[0],download=await fetch(api.url+artifact.url,{headers:{Authorization:'Bearer '+api.token}});
    assert.equal(download.status,200);const audio=decodeWav(new Uint8Array(await download.arrayBuffer()));assert.ok(audio.channels[0].length<4800);assert.ok(Math.abs(Math.max(...audio.channels[0])-10**(-1/20)/Math.SQRT2)<.003);
    const unavailable=(await command(api,'audio.input.start',{},400)).error;assert.equal(unavailable.code,'UNSUPPORTED_CAPABILITY');
  });
});
test('HTTP cancel remains responsive with an occupied admission queue',async()=>{
  await withApi(async api=>{
    const request=command(api,'macro.run',{text:'track.add({name:"kept"});wait({seconds:60});track.remove({});'},400);
    for(let i=0;i<100&&!api.workbench.runner.controller;i++)await pause(5);
    const response=await fetch(api.url+'/v1/cancel',{method:'POST',headers:{Authorization:'Bearer '+api.token}});assert.equal(response.status,200);
    const error=(await request).error;assert.equal(error.code,'ABORTED');assert.equal(error.completedSteps,1);assert.equal(error.partial,true);assert.equal(api.editor.getState().tracks.length,1);
  },{maxPendingJobs:1});
});
test('browser bridge sends only acquired input, keeps token private, and releases the subscription',async()=>{
  const r=await receiver();
  try{await withApi(async api=>{
    class Input extends EventTarget{getState(){return{input:{active:true,sampleRate:48000,layout:'mono'}};}subscribeInputPCM(fn){this.callback=fn;return()=>{this.callback=null;};}}
    const live=new Input(),bridge=new CompanionBridge({live});await bridge.connect({url:api.url,token:api.token});
    assert.doesNotMatch(JSON.stringify(bridge.getState()),new RegExp(api.token));await bridge.execute('stream.start',{destination:'test',profile:'f32le'});
    const bytes=pcm(),data=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length));live.callback({sequence:0,startFrame:0,sampleRate:48000,layout:'mono',channels:1,frames:1024,data,droppedFrames:0});
    await bridge.stop();await pause(10);assert.deepEqual(Buffer.concat(r.packets),bytes);assert.equal(live.callback,null);await bridge.disconnect();assert.equal(bridge.getState().connected,false);
  },{destinations:[r.destination]});}finally{r.socket.close();}
});
test('bad replacement imports preserve editor state and output filenames cannot escape',async()=>{
  const workbench=new NodeWorkbench();
  try{
    await workbench.execute('audio.generate',{duration:.01});const before=await workbench.editor.execute('project.save'),input=workbench.supply(new Uint8Array([0,1,2]),{name:'bad.wav'});
    await assert.rejects(workbench.execute('file.import',{input:input.id,replace:true}));assert.deepEqual(await workbench.editor.execute('project.save'),before);
    const output=await workbench.execute('file.export',{format:'wav',name:'../../outside'});assert.doesNotMatch(output.name,/[\\/]/);assert.equal(workbench.artifacts.get(output.id).bytes.length>0,true);
  }finally{await workbench.dispose();}
});
