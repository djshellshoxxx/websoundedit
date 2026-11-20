import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioEditor} from '../src/engine.js';
import {Playback} from '../src/playback.js';
import {LiveAudioRuntime,LIVE_COMMANDS} from '../src/live-audio.js';
import {RealtimeRackManager} from '../src/realtime-rack.js';
import {RealtimeRackDSP} from '../src/realtime-dsp.js';
import {RecordingStore} from '../src/recording-store.js';
import {CaptureKernel} from '../src/capture-kernel.js';
import {CaptureTap} from '../src/capture-tap.js';
import {MidiSampler} from '../src/midi.js';
import {AudioContextMock,AudioNodeMock,MemoryDirectory,mediaTrack,mediaStream} from './audio-test-support.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
class SyntheticTap {
  constructor(context,source,options){this.context=context;this.source=source;this.options=options;this.node=new AudioNodeMock();this.chunks=[];this.closed=false;this.kernel=new CaptureKernel({...options,onChunk:packet=>{const data=packet.data;this.chunks.push(Promise.resolve(options.onChunk({...packet,sampleRate:context.sampleRate})).then(buffer=>this.kernel.recycle(buffer||data.buffer)));},onEnd:result=>{this.finished=result;Promise.all(this.chunks).then(()=>{options.onEnd?.(result);this.resolveStop?.(result);});},onError:options.onError});}
  start(settings={}){this.finished=null;this.kernel.start({startFrame:Math.ceil(this.context.currentTime*this.context.sampleRate),endFrame:Number.MAX_SAFE_INTEGER,...settings});}
  stop(){if(this.finished)return Promise.resolve(this.finished);return new Promise(resolve=>{this.resolveStop=resolve;this.kernel.finish();});}
  setLoop(settings){this.loopSettings={...this.loopSettings,...settings};}
  detachSource(){}
  dispose(){this.closed=true;this.kernel.active=false;this.resolveStop?.({disposed:true});}
  async feed(frame,channels){this.kernel.process(channels,frame,channels[0].length);await Promise.all(this.chunks);await tick();}
}
async function fixture(layout='stereo'){
  const engine=new AudioEditor({sampleRate:8000,outputLayout:layout}),context=new AudioContextMock(),playback=new Playback(),taps=[];
  const archive=new RecordingStore(new MemoryDirectory()),storage={queuedBytes:0,dispose(){},async execute(method,params={},data,handle){let result;if(method==='append')result=await archive.append(data);else if(method==='start')result=await archive.start(params);else if(method==='range')result=await archive.readRange(params.recordingId,params);else if(method==='list')result=await archive.list();else if(method==='delete'||method==='recover')result=await archive[method](params.recordingId);else if(method==='export')result=await archive.export(params.recordingId,await handle.createWritable(),params);else result=await archive[method](params.status);return{result,buffer:data?.buffer};}};
  const track=mediaTrack(2),nav={mediaDevices:{enumerateDevices:async()=>[],getUserMedia:async()=>mediaStream([track])},storage:{estimate:async()=>({quota:1024**3,usage:0})}};
  const live=new LiveAudioRuntime({engine,playback,navigator:nav,contextFactory:()=>context,storage,captureFactory:async(ctx,source,options)=>{const tap=new SyntheticTap(ctx,source,options);taps.push(tap);return tap;},graphManagerFactory:(ctx,options)=>new RealtimeRackManager(ctx,{...options,loadModule:async()=>{},nodeFactory:(_,config)=>{const dsp=new RealtimeRackDSP({sampleRate:ctx.sampleRate,...config}),node=new AudioNodeMock();node.dsp=dsp;node.port={postMessage(message){try{if(message.method==='chain')dsp.updateChain(message.chain);if(message.method==='automation')dsp.setAutomation(message.lanes);if(message.method==='parameter')dsp.schedule(message.event);queueMicrotask(()=>node.port.onmessage?.({data:{id:message.id,ok:true}}));}catch(error){queueMicrotask(()=>node.port.onmessage?.({data:{id:message.id,error:{message:error.message,code:error.code}}}));}},close(){}};return node;}})});
  return{engine,context,playback,live,taps,track,archive};
}
test('live catalog has typed unique commands; constructor, list and offline render do not acquire a device',async()=>{
  const{engine,live,context}=await fixture('5.1');assert.equal(live.context,null);assert.equal(live.getState().input.active,false);assert.equal(new Set(LIVE_COMMANDS.map(c=>c.method)).size,LIVE_COMMANDS.length);assert.ok(LIVE_COMMANDS.every(c=>c.schema?.type==='object'&&c.returns&&Array.isArray(c.capabilities)));
  await live.execute('audio.capabilities');await live.execute('audio.devices.list');assert.equal(live.context,null);
  await engine.execute('audio.generate',{duration:.1,layout:'5.1'});await live.execute('live.rack.set',{chain:[{id:'d',effect:'delay',wet:1,params:{timeMs:10,feedback:.5}}]});
  const rendered=await live.execute('live.render',{scope:'mix'});assert.equal(rendered.layout,'5.1');assert.equal(rendered.channels.length,6);assert.equal(rendered.channels[0].length,800);assert.equal(live.context,null);assert.equal(context.sources.length,0);
  await live.dispose();
});
test('ordinary transport shares the live graph; knobs preserve playing sources, seek/loop/pause and track removal remain isolated',async()=>{
  const{engine,live,playback,context}=await fixture();const first=await engine.execute('audio.generate',{duration:1}),second=await engine.execute('audio.generate',{duration:1});
  await live.execute('live.rack.set',{chain:[{id:'f',effect:'filter',wet:.5}]});await live.execute('transport.play',{scope:'mix',loop:true,loopStart:0,loopEnd:1});const sources=[...context.sources];assert.equal(playback.playing,true);assert.equal(sources.length,2);
  await live.execute('live.param.set',{slotId:'f',param:'frequency',value:4000,rampMs:25});assert.equal(context.sources.length,2);assert.ok(sources.every(source=>!source.stops.length));
  await live.execute('automation.set',{lanes:[{slotId:'f',param:'wet',points:[{time:0,value:0},{time:1,value:1}]}]});await live.execute('automation.clear');await live.execute('transport.set',{rate:1.25,bpm:130,metronome:true});assert.equal(playback.rate,1.25);assert.equal(engine.getState().bpm,130);
  await live.releaseTrack(first.trackId);assert.ok(sources[0].stops.length);assert.equal(sources[1].stops.length,0);assert.equal(playback.playing,true);
  await live.execute('transport.pause');assert.equal(playback.playing,false);await live.execute('transport.seek',{position:.25});assert.equal(playback.position,.25);await live.execute('transport.stop');assert.equal(playback.position,0);await live.dispose();
});
test('a loop can be armed before first play and survives selection, stop, mix and seek transitions', async () => {
  const { engine, live, playback } = await fixture();
  try {
    await engine.execute('audio.generate', { duration: 4 });
    await engine.execute('selection.set', { start: 1, end: 2, channels: 'all' });
    const armed = await live.execute('transport.set', { loop: true, loopStart: 1, loopEnd: 2 });
    assert.deepEqual([armed.loop, armed.loopStart, armed.loopEnd], [true, 1, 2]);
    assert.equal(live.context, null, 'loop configuration must not request audio output');
    await live.execute('transport.play', { scope: 'selection' });
    assert.deepEqual([playback._timelineOffset, playback._loopStart, playback._loopEnd], [1, 0, 1]);
    await live.execute('transport.stop');
    assert.deepEqual([live.getState().transport.loopStart, live.getState().transport.loopEnd], [1, 2]);
    await live.execute('transport.play', { scope: 'mix' });
    assert.deepEqual([playback._timelineOffset, playback._loopStart, playback._loopEnd], [0, 1, 2]);
    await live.execute('transport.seek', { position: 1.25 });
    assert.deepEqual([live.getState().transport.loopStart, live.getState().transport.loopEnd], [1, 2]);
  } finally { await live.dispose(); }
});

test('paused loop changes use project time even outside the previous playback selection', async () => {
  const { engine, live, playback } = await fixture();
  try {
    await engine.execute('audio.generate', { duration: 4 });
    await engine.execute('selection.set', { start: 3, end: 4, channels: 'all' });
    await live.execute('transport.play', { scope: 'selection' });
    const playing = live.getState().transport;
    await assert.rejects(live.execute('transport.set', { loop: true, loopStart: .25, loopEnd: .75, bpm: 130 }), /playing selection/);
    assert.deepEqual(live.getState().transport, playing, 'an incompatible active loop must reject atomically');
    await live.execute('transport.pause');
    await live.execute('transport.set', { loop: true, loopStart: .25, loopEnd: .75 });
    assert.deepEqual([live.getState().transport.loopStart, live.getState().transport.loopEnd], [.25, .75]);
    await live.execute('transport.play', { scope: 'mix' });
    assert.deepEqual([playback._loopStart, playback._loopEnd], [.25, .75]);
    await live.execute('transport.pause');
    await engine.execute('selection.set', { start: 2, end: 3, channels: 'all' });
    await live.execute('transport.play', { scope: 'selection' });
    assert.deepEqual([live.getState().transport.loopStart, live.getState().transport.loopEnd], [2, 3]);
  } finally { await live.dispose(); }
});

test('invalid staged loops reject before tempo changes and empty-project arming stays silent', async () => {
  const { engine, live } = await fixture();
  try {
    await live.execute('transport.set', { loop: true });
    assert.equal(live.getState().transport.loop, true);
    assert.equal(live.context, null);
    await engine.execute('audio.generate', { duration: 4 });
    const before = live.getState().transport;
    for (const range of [{ loopStart: 1, loopEnd: 5 }, { loopStart: 2, loopEnd: 1 }]) {
      await assert.rejects(live.execute('transport.set', { loop: true, bpm: 130, ...range }), /Loop/);
      assert.deepEqual(live.getState().transport, before);
    }
    await live.execute('transport.play', { scope: 'mix' });
    assert.deepEqual([live.getState().transport.loopStart, live.getState().transport.loopEnd], [0, 4]);
  } finally { await live.dispose(); }
});
test('input settings, monitoring, bounded PCM subscriptions and device stop expose truthful active state',async()=>{
  const{live,taps,context,track}=await fixture();await live.execute('audio.input.start',{channels:[0,1],monitor:false});assert.equal(live.getState().input.sampleRate,8000);assert.equal(live.getState().input.active,true);
  await live.execute('audio.input.set',{gainDb:-3,noiseSuppression:true});await live.execute('audio.monitor.set',{enabled:true,gainDb:-6});assert.equal(live.getState().input.monitor,true);
  let release;const packets=[],held=new Promise(resolve=>{release=resolve;});const unsubscribe=live.subscribeInputPCM(async packet=>{packets.push(packet);await held;},{framesPerChunk:128,maxQueuedChunks:1});
  const tap=taps[0];await tap.feed(0,[new Float32Array(1024).fill(.2),new Float32Array(1024).fill(.4)]);assert.equal(packets.length,1);assert.equal(packets[0].channels,2);assert.equal(packets[0].layout,'stereo');assert.equal(packets[0].data.length,256);release();await tick();await tap.feed(1024,[new Float32Array(1024),new Float32Array(1024)]);assert.ok(packets[1].droppedFrames>0);unsubscribe();
  await live.execute('audio.output.set',{deviceId:'fixture-speakers',monitorLayout:'7.1'});assert.equal(context.sinkId,'fixture-speakers');assert.equal(live.getState().output.monitorLayout,'7.1');await live.execute('audio.input.stop');assert.equal(track.stopped,true);assert.equal(live.getState().input.active,false);assert.throws(()=>live.subscribeInputPCM(()=>{}),e=>e.code==='NO_INPUT');await live.dispose();
});
test('sample-clock loop capture creates a new editable track and one independently controlled layer; cancel discards partial audio',async()=>{
  const{engine,live,taps}=await fixture();await live.execute('audio.input.start',{channels:[0]});const before=engine.getState().tracks.length;const capture=await live.execute('loop.capture.start',{source:'input',beats:.25,quantize:'off',name:'Pedal layer'});const tap=taps.at(-1),frames=capture.endFrame-capture.startFrame;await tap.feed(capture.startFrame,[new Float32Array(frames).fill(.25)]);await tick();await live.pendingCapture?.committing;
  assert.equal(engine.getState().tracks.length,before+1);const layer=(await live.execute('loop.track.list'))[0];assert.equal(layer.name,'Pedal layer');assert.equal(layer.playing,true);assert.ok(Math.abs(layer.duration-frames/8000)<1e-9);
  await live.execute('loop.track.mute',{trackId:layer.trackId,muted:true});assert.equal(live.getState().loops[0].muted,true);await live.execute('loop.track.stop',{trackId:layer.trackId});assert.equal(live.getState().loops[0].playing,false);await live.execute('loop.track.play',{trackId:layer.trackId,quantize:'off'});assert.equal(live.getState().loops[0].playing,true);
  await live.execute('loop.capture.toggle',{source:'input',beats:.25,quantize:'off'});await live.execute('loop.capture.cancel');assert.equal(live.getState().capture.phase,'idle');assert.equal(engine.getState().tracks.length,before+1);
  await live.execute('loop.track.remove',{trackId:layer.trackId});assert.equal(engine.getState().tracks.length,before);assert.equal(live.getState().loops.length,0);await live.dispose();
});
test('loop arming uses the clock after worklet preparation and late audio still commits the complete loop',async()=>{
  const{engine,live,taps,context}=await fixture(),create=live.captureFactory;
  live.captureFactory=async(...args)=>{const tap=await create(...args);context.currentTime+=.5;return tap;};
  const capture=await live.execute('loop.capture.start',{source:'master',beats:.25,quantize:'off'}),tap=taps.at(-1);
  assert.ok(capture.startFrame>=Math.ceil((context.currentTime+.02)*context.sampleRate));assert.equal(capture.endFrame-capture.startFrame,1000);
  await tap.feed(capture.startFrame+64,[new Float32Array(1000).fill(.25),new Float32Array(1000).fill(.5)]);await live.pendingCapture?.committing;
  const loop=live.getState().loops[0];assert.equal(loop.duration,.125);const audio=await engine.execute('clip.getAudio',{clipId:loop.clipId});assert.equal(audio.channels[0].length,1000);assert.ok(audio.channels[0].every(sample=>sample===.25));assert.ok(audio.channels[1].every(sample=>sample===.5));await live.dispose();
});
test('actual capture-tap topology stays acyclic and master handoff preserves the scheduled phase',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'AudioWorkletNode');
  Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:class extends AudioNodeMock{constructor(){super();this.messages=[];this.port={postMessage:message=>this.messages.push(message),close(){}};}}});
  const cyclic=root=>{const active=new Set(),seen=new Set();const visit=node=>{if(active.has(node))return true;if(seen.has(node))return false;seen.add(node);active.add(node);for(const[next]of node.connections||[])if(visit(next))return true;active.delete(node);return false;};return visit(root);};
  try{
    for(const source of ['master','input']){
      const{live,context}=await fixture();let tap;
      live.captureFactory=async(ctx,node,options)=>(tap=new CaptureTap(ctx,node,{framesPerChunk:2048,...options}));
      try{
        if(source==='input')await live.execute('audio.input.start',{channels:[0]});
        const capture=await live.execute('loop.capture.start',{source,beats:.25,quantize:'off'}),pending=live.pendingCapture,node=tap.node,channels=source==='master'?2:1,frames=capture.endFrame-capture.startFrame;
        assert.equal(cyclic(live.masterOutput),false);assert.equal(node.connections.length,source==='master'?1:2);assert.ok(tap.source.connections.some(([next])=>next===node));
        context.currentTime=(capture.endFrame+80)/context.sampleRate;
        node.port.onmessage({data:{type:'chunk',sequence:0,startFrame:capture.startFrame,frames,channels,sampleRate:context.sampleRate,data:new Float32Array(frames*channels).fill(.25)}});
        node.port.onmessage({data:{type:'end',frames,startFrame:capture.startFrame,endFrame:capture.endFrame}});await tap.pending;await tick();await pending.committing;
        assert.equal(cyclic(live.masterOutput),false);assert.equal(tap.source.connections.some(([next])=>next===node),false);assert.equal(node.connections.length,2);
        const layer=live.getState().loops[0];assert.equal(layer.duration,.125);assert.equal(layer.transition,source==='master'?'main-thread':'audio-clock');assert.equal(layer.transitionDelayFrames,source==='master'?80:0);
        assert.equal(node.messages.filter(message=>message.type==='start').length,1);assert.equal(node.messages.some(message=>message.type==='loop'),false);
        assert.equal(node.messages.find(message=>message.type==='start').endFrame,capture.endFrame);
      }finally{await live.dispose();}
    }
  }finally{if(previous)Object.defineProperty(globalThis,'AudioWorkletNode',previous);else delete globalThis.AudioWorkletNode;}
});
test('long recorder archives bounded chunks; pause omits gaps; every archive action operates on its explicit recording ID',async()=>{
  const{engine,live,taps,context}=await fixture();await live.execute('recorder.start',{source:'master',name:'Synthetic long-set path'});const recordingId=live.getState().recorder.recordingId;
  await taps.at(-1).feed(0,[new Float32Array(2048).fill(.1),new Float32Array(2048).fill(.2)]);await live.execute('recorder.pause');assert.equal(live.getState().recorder.status,'paused');context.currentTime=5;await live.execute('recorder.resume');await taps.at(-1).feed(40000,[new Float32Array(2048).fill(.3),new Float32Array(2048).fill(.4)]);await live.execute('recorder.stop');const listed=await live.execute('recordings.list');assert.equal(listed.recordings[0].frames,4096);assert.equal(listed.recordings[0].seconds,.512);
  const exported=await live.execute('recordings.export',{recordingId,start:0,end:.1});assert.equal(exported.mime,'audio/wav');assert.ok(exported.bytes.length>0);await live.execute('recordings.importRange',{recordingId,start:0,end:.1,name:'Range'});assert.equal(engine.getState().tracks[0].clips[0].frames,800);
  await live.execute('recordings.auditionRange',{recordingId,start:.256,end:.512});assert.equal(live.playback.playing,true);await live.execute('recordings.recover',{recordingId});await live.execute('recordings.delete',{recordingId});assert.equal((await live.execute('recordings.list')).recordings.length,0);await live.dispose();
});
test('live settings preflight is pure, reset races cannot reactivate input, and shared MIDI disposal leaves context usable',async()=>{
  const{engine,live,context,track}=await fixture();await engine.execute('audio.generate',{duration:.1});const settings={version:1,racks:{master:{chain:[{id:'t',effect:'tremolo',wet:.5}],automation:[]}}};const normalized=live.validateSettings(settings);assert.equal(live.getSettings().racks.master.chain.length,0);await live.loadSettings(normalized);await live.execute('audio.input.start',{channels:[0]});
  const sampler=new MidiSampler(()=>({sampleRate:8000,channels:[new Float32Array(80).fill(.1)]}));sampler.setAudioRoute(live.midiRoute());live.setMidiPanic(()=>sampler.stop());await sampler.noteOn(60,100);assert.equal(sampler.context,context);assert.equal(sampler.voices.size,1);await sampler.close();assert.equal(context.state,'running');
  await Promise.all([live.resetProject(),live.resetProject()]);await live.loadSettings(normalized);assert.equal(live.getSettings().racks.master.chain.length,1);assert.equal(track.stopped,true);assert.equal(live.getState().input.active,false);await live.dispose();
});
test('all live commands reject malformed arguments before acquiring audio or mutating archive state',async()=>{
  const{live}=await fixture();for(const command of LIVE_COMMANDS)await assert.rejects(live.execute(command.method,{unexpected:true}));assert.equal(live.context,null);assert.equal(live.recordings.length,0);await assert.rejects(live.execute('missing.command'),e=>e.code==='UNKNOWN_COMMAND');const controller=new AbortController();controller.abort();await assert.rejects(live.execute('audio.capabilities',{}, {signal:controller.signal}),e=>e.code==='ABORTED');await live.dispose();
});
test('future parameter changes become persistent timeline automation and do not change earlier offline audio',async()=>{
  const{engine,live}=await fixture();await engine.execute('clip.add',{audio:{sampleRate:8000,channels:[new Float32Array(800).fill(.5)]}});
  await live.execute('live.rack.set',{chain:[{id:'t',effect:'tremolo',wet:0,params:{rate:1,depth:1}}]});await live.execute('live.param.set',{slotId:'t',param:'wet',value:1,rampMs:0,at:{seconds:.05}});
  const saved=live.getSettings();assert.equal(saved.racks.master.chain[0].wet,0);assert.equal(saved.racks.master.automation[0].points[1].time,.05);assert.equal(live.context,null);
  const dry=await engine.execute('audio.render'),out=await live.execute('live.render');assert.equal(out.channels[0][399],dry.channels[0][399]);assert.ok(out.channels[0][400]<dry.channels[0][400]);
  await live.loadSettings(saved);assert.deepEqual(await live.execute('live.render'),out);await live.execute('automation.clear');assert.deepEqual(await live.execute('live.render'),dry);await live.dispose();
});
test('settings replacement rebuilds stopped graphs; an output-layout change stops and rebuilds with rack definitions retained',async()=>{
  const{engine,live}=await fixture();await engine.execute('audio.generate',{duration:.1});await live.execute('live.rack.set',{chain:[{id:'t',effect:'tremolo',wet:.3}]});await live.execute('transport.play');await live.execute('transport.stop');
  const old=live.graphs;await live.loadSettings({version:1,racks:{master:{chain:[{id:'d',effect:'delay',wet:.7}],automation:[]}}});assert.equal(old.graphs.size,0);await live.execute('transport.play');assert.equal(live.graphs.graphs.get('master').chain[0].effect,'delay');
  await engine.execute('project.update',{outputLayout:'7.1'});live._engineChanged({method:'project.update',state:engine.getState()});if(live.resetting)await live.resetting;assert.equal(live.playback.playing,false);assert.equal(live.getSettings().racks.master.chain[0].effect,'delay');await live.execute('transport.play');assert.equal(live.graphs.channels,8);await live.dispose();
});
test('stopping input leaves a master capture valid and simultaneous archive stops finalize once',async()=>{
  const{live,taps}=await fixture();await live.execute('audio.input.start',{channels:[0]});const capture=await live.execute('loop.capture.start',{source:'master',beats:.25,quantize:'off'});const tap=taps.at(-1);await live.execute('audio.input.stop');await tap.feed(capture.startFrame,[new Float32Array(capture.endFrame-capture.startFrame).fill(.1),new Float32Array(capture.endFrame-capture.startFrame).fill(.2)]);await live.pendingCapture?.committing;assert.equal(live.getState().loops.length,1);
  await live.execute('recorder.start',{source:'master'});await taps.at(-1).feed(0,[new Float32Array(128).fill(.1),new Float32Array(128).fill(.1)]);const results=await Promise.all([live._stopRecording(),live._stopRecording()]);assert.deepEqual(results[0],results[1]);assert.equal(live.getState().recorder.status,'idle');await live.dispose();
});
test('late worklet initialization cannot revive a reset graph or dispose a newer graph',async()=>{
  const{live}=await fixture();const original=live.graphManagerFactory;let release,first=true,oldManager;const gate=new Promise(resolve=>{release=resolve;});
  live.graphManagerFactory=(...args)=>{const manager=original(...args);if(first){first=false;oldManager=manager;manager.loadModule=()=>gate;}return manager;};
  const pending=live.execute('audio.output.set',{monitorLayout:'stereo'}),rejected=assert.rejects(pending,error=>['ABORTED','DISPOSED'].includes(error.code));await tick();await live.resetProject();await live._context();const current=live.graphs;release();await rejected;
  assert.equal(oldManager.graphs.size,0);assert.equal(current.disposed,false);assert.equal(live.graphs,current);assert.ok(current.graphs.has('master'));await live.dispose();
});
test('a loop takes ownership of its track and an all-loop project still has an undoubled transport clock',async()=>{
  const{engine,live,context}=await fixture();const clip=await engine.execute('audio.generate',{duration:.1});await live.execute('transport.play');const ordinary=context.sources[0];await live.execute('loop.track.play',{trackId:clip.trackId,quantize:'off'});assert.ok(ordinary.stops.length);const voice=live.loops.get(clip.trackId).source;
  await live.execute('transport.play');assert.equal(live.playback.playing,true);assert.equal(voice.stops.length,0);assert.equal(live.playback._plan.length,1);assert.equal(live.playback._plan[0].trackId,null);await live.dispose();
});
test('permission denial remains visible and archive reads cannot starve an active recording',async()=>{
  const{live}=await fixture();live.navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Fixture permission denied');};await assert.rejects(live.execute('audio.input.start'),/permission denied/);assert.equal(live.getState().input.status,'error');assert.equal(live.getState().input.active,false);
  await live.execute('recorder.start',{source:'master'});const recordingId=live.getState().recorder.recordingId;await assert.rejects(live.execute('recordings.export',{recordingId}),error=>error.code==='BUSY');assert.equal(live.getState().recorder.status,'recording');await live.execute('recorder.stop');await live.dispose();
});
test('a recording tap resolved after project reset is disposed before it can start',async()=>{
  const{live,taps}=await fixture();await live.execute('audio.output.set',{monitorLayout:'stereo'});const factory=live.captureFactory;let release;const gate=new Promise(resolve=>{release=resolve;});live.captureFactory=async(...args)=>{const tap=await factory(...args);await gate;return tap;};
  const pending=live.execute('recorder.start',{source:'master'}),rejected=assert.rejects(pending,error=>error.code==='ABORTED');while(!taps.length)await tick();await live.resetProject();release();await rejected;assert.equal(taps[0].closed,true);assert.equal(taps[0].kernel.active,false);assert.equal(live.getState().recorder.status,'idle');assert.equal(live.graphs,null);await live.dispose();
});
