import { Playback } from './playback.js';
import { AudioDevices } from './audio-devices.js';
import { CHANNEL_LAYOUTS, audioLayout, normalizeLayout, layoutForChannels, convertLayout } from './channel-layout.js';
import { connectMatrix } from './audio-routing.js';
import { normalizeRackChain } from './rack-config.js';
import { RealtimeRackManager } from './realtime-rack.js';
import { RealtimeRackDSP, LIVE_LIMITS, validateLiveGraphs, normalizeAutomation, parameterDefinition, automationValue } from './realtime-dsp.js';
import { CaptureTap } from './capture-tap.js';
import { RecordingClient } from './recording-client.js';
import { encodeWav } from './wav.js';
import { validateCommandParams } from './command-schema.js';
import { LIVE_COMMANDS } from './live-commands.js';
import { ENCODING_LIMITS } from './codec-budget.js';
export { LIVE_COMMANDS, LIVE_LIMITS };
const contracts=new Map(LIVE_COMMANDS.map(command=>[command.method,command]));
const fail=(message,code='INVALID_ARGUMENT')=>{throw Object.assign(new Error(message),{code});};
const abort=signal=>{if(signal?.aborted)fail('Audio operation cancelled.','ABORTED');};
const copy=value=>structuredClone(value),disconnect=node=>{try{node?.disconnect();}catch{}},gain=db=>10**(db/20);
const id=()=>globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const task=()=>new Promise(resolve=>setTimeout(resolve,0));
const emptyCapture=()=>({phase:'idle',captureId:null,source:null,beats:null,startFrame:null,endFrame:null,frames:0,transition:null});
const emptyRecorder=()=>({status:'idle',recordingId:null,name:null,source:null,frames:0,seconds:0,bytesWritten:0,queuedBytes:0,maxBytes:null,error:null});

/** Browser facade. Constructing it neither unlocks audio nor requests a device. */
export class LiveAudioRuntime extends EventTarget {
  constructor({engine,playback=new Playback(),navigator:nav=globalThis.navigator,contextFactory,devices,storage,captureFactory=CaptureTap.create,graphManagerFactory=(context,options)=>new RealtimeRackManager(context,options)}={}){
    super();if(!engine?.execute)throw new TypeError('A live runtime requires the shared editor.');
    this.engine=engine;this.playback=playback;this.navigator=nav;this.contextFactory=contextFactory||((options)=>{const Constructor=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Constructor)fail('Web Audio is unavailable.','UNSUPPORTED');return new Constructor(options);});
    this.context=null;this.contextReady=null;this.graphManagerFactory=graphManagerFactory;this.captureFactory=captureFactory;this.graphs=null;this.layout='stereo';this.listeners=new Set();this.disposed=false;this.generation=0;this.inputGeneration=0;this.queue=Promise.resolve();this.pending=0;
    this.racks=new Map([['master',{chain:[],automation:[]}]]);this.loops=new Map();this.capture=emptyCapture();this.recorder=emptyRecorder();this.recordings=[];this.storageState={available:!!(storage||nav?.storage?.getDirectory),usage:null,quota:null,remainingBytes:null,error:null};
    this.storage=storage||new RecordingClient({onProgress:progress=>this._emit('progress',progress)});this.devices=devices||new AudioDevices({navigator:nav,onChange:()=>this._inputChanged()});this.subscribers=new Set();
    this.output={deviceId:'default',monitorLayout:'stereo',maxChannels:null,fallback:false,message:null};this.monitor={enabled:false,gainDb:0};this.lastPlay={scope:'mix'};this.exportDestination=null;this.midiPanic=()=>{};
    this.playback.setAudioRoute({contextProvider:()=>this._context(),outputNode:trackId=>this.graphs?.graphs.get(trackId)?.node||this.masterInput,monitorNode:()=>this.monitorOutput,meterNode:()=>this.masterOutput,layout:()=>this.layout,reserveVoice:bytes=>this.graphs?.reserveVoice(bytes)||(()=>{}),onClock:(clock,bpm)=>{this.clock=clock;this.graphs?.setClock(clock,bpm);}});
    this.engineListener=event=>this._engineChanged(event.detail||{});this.engine.addEventListener?.('state',this.engineListener);this.knownTracks=new Set(this._project().tracks.map(track=>track.id));
  }
  _project(){return this.engine.getState?.()||{sampleRate:48000,outputLayout:'stereo',bpm:120,beatsPerBar:4,beatOffset:0,tracks:[],duration:0,settings:{}};}
  capabilities(){return{audioWorklet:!!(globalThis.AudioWorkletNode||this.contextFactory&&this.captureFactory!==CaptureTap.create),...this.devices.capabilities(),outputSelection:!!(this.context?.setSinkId||(globalThis.AudioContext||globalThis.webkitAudioContext)?.prototype?.setSinkId),opfs:this.storageState.available,streamingFileExport:!!globalThis.showSaveFilePicker,layouts:Object.keys(CHANNEL_LAYOUTS),limits:LIVE_LIMITS,editor:{maxSeconds:600,maxBytes:256*1024*1024},recording:{maxSeconds:86400,maxBytes:512*1024**3},exportLimits:{...ENCODING_LIMITS},timePitchSurround:false};}
  commands(){return LIVE_COMMANDS.map(command=>copy(command));}
  subscribe(listener){if(typeof listener!=='function')throw new TypeError('Provide a live state listener.');this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  _emit(type,detail={}){const event={type,...detail};for(const listener of this.listeners)try{listener(event);}catch{}this.dispatchEvent(new CustomEvent(type,{detail:event}));}
  _state(method){this._emit('state',{method,state:this.getState()});}
  _error(error){this._emit('error',{code:error.code||'AUDIO_ERROR',message:error.message||String(error),recordingId:this.recorder.recordingId,recoverable:!!this.recorder.recordingId});}
  getState(){
    const input=this.devices.getState();input.active=input.status==='active';input.sampleRate=this.context?.sampleRate||null;
    return{capabilities:this.capabilities(),context:{state:this.context?.state||'not-started',sampleRate:this.context?.sampleRate||null,baseLatency:Number.isFinite(this.context?.baseLatency)?this.context.baseLatency:null,outputLatency:Number.isFinite(this.context?.outputLatency)?this.context.outputLatency:null,projectLayout:this._project().outputLayout||'stereo'},input:{...input,monitor:this.monitor.enabled},output:copy(this.output),transport:{playing:this.playback.playing,position:this.playback.position,rate:this.playback.rate,loop:this.playback.loop,loopStart:this.playback._timelineOffset+this.playback._loopStart,loopEnd:this.playback._timelineOffset+this.playback._loopEnd,bpm:this._project().bpm,metronome:this.playback.metronome},racks:[...this.racks].map(([key,value])=>({target:key==='master'?'master':{trackId:key},...copy(value)})),capture:copy(this.capture),loops:[...this.loops.values()].map(loop=>({trackId:loop.trackId,clipId:loop.clipId,name:loop.name,playing:loop.playing,muted:loop.muted,duration:loop.duration,transition:loop.transition||'audio-clock',transitionDelayFrames:loop.transitionDelayFrames||0,transitionDelaySeconds:loop.transitionDelaySeconds||0})),recorder:{...copy(this.recorder),queuedBytes:this.storage.queuedBytes||0},recordings:copy(this.recordings),storage:copy(this.storageState)};
  }
  execute(method,params={},options={}){
    if(this.disposed)return Promise.reject(Object.assign(new Error('Live audio has been disposed.'),{code:'DISPOSED'}));
    const descriptor=contracts.get(method);if(!descriptor)return Promise.reject(Object.assign(new Error(`Unknown live command: ${method}`),{code:'UNKNOWN_COMMAND'}));
    try{validateCommandParams(params,descriptor);abort(options.signal);if(this.pending>=64)fail('Live command queue is full.','RESOURCE_LIMIT');}catch(error){return Promise.reject(error);}
    // Stop/cancel must invalidate late permission grants immediately, including
    // while a previous command is awaiting a device picker or file operation.
    if(method==='audio.input.stop'){this.inputGeneration++;this.devices.stop();}
    if(method==='loop.capture.cancel')this.captureCancelled=true;
    this.pending++;const generation=this.generation;
    const run=async()=>{try{abort(options.signal);if(this.resetting)await this.resetting;if(this.disposed)fail('Live audio has been disposed.','DISPOSED');if(generation!==this.generation)fail('Audio operation belongs to the previous project.','ABORTED');const result=await this._execute(method,params,{...options,generation});this._state(method);return result;}catch(error){this._error(error);throw error;}finally{this.pending--;}};
    const result=this.queue.then(run,run);this.queue=result.catch(()=>{});return result;
  }
  async _context(){
    if(this.disposed)fail('Live audio has been disposed.','DISPOSED');
    if(this.resetting)await this.resetting;
    if(this.contextReady){await this.contextReady;if(this.context.state!=='running')await this.context.resume();return this.context;}
    const generation=this.generation,project=this._project();this.layout=normalizeLayout(project.outputLayout||'stereo');this.context=this.context&&this.context.state!=='closed'?this.context:this.playback.context||this.contextFactory({latencyHint:'interactive',sampleRate:project.sampleRate});
    const context=this.context;const resumed=context.state==='running'?Promise.resolve():context.resume();let manager,masterInput,masterOutput,monitorOutput;
    const check=()=>{if(generation!==this.generation||this.disposed)fail('Audio start was cancelled.','ABORTED');};
    const ready=(async()=>{
      await resumed;if(generation!==this.generation||this.disposed)fail('Audio start was cancelled.','ABORTED');
      manager=this.graphManagerFactory(context,{channels:CHANNEL_LAYOUTS[this.layout].count,layout:this.layout});this.graphs=manager;
      masterInput=await manager.setChain('master',this.racks.get('master').chain);check();
      masterOutput=context.createGain();masterOutput.channelCount=CHANNEL_LAYOUTS[this.layout].count;masterOutput.channelCountMode='explicit';masterOutput.channelInterpretation='discrete';masterInput.connect(masterOutput);
      await manager.setAutomation('master',this.racks.get('master').automation);check();monitorOutput=context.createGain();monitorOutput.gain.value=1;monitorOutput.connect(context.destination);
      this.masterInput=masterInput;this.masterOutput=masterOutput;this.monitorOutput=monitorOutput;this._monitorRouting(this.output.monitorLayout);
      this.epoch=context.currentTime;manager.setClock({audioTime:context.currentTime,timelineTime:0,rate:1,playing:false},project.bpm);context.onstatechange=()=>this._state('audio.context');return context;
    })().catch(error=>{manager?.dispose();disconnect(masterOutput);disconnect(monitorOutput);if(this.graphs===manager)this.graphs=null;if(this.contextReady===ready)this.contextReady=null;throw error;});
    this.contextReady=ready;return ready;
  }
  _monitorRouting(requested){
    const max=this.context.destination.maxChannelCount||2,layout=normalizeLayout(requested||this.layout),count=CHANNEL_LAYOUTS[layout].count,actual=count<=max?layout:max>=2?'stereo':'mono';
    this.monitorRoute?.dispose();try{this.context.destination.channelCount=CHANNEL_LAYOUTS[actual].count;this.context.destination.channelInterpretation='discrete';}catch{}
    this.monitorRoute=connectMatrix(this.context,this.masterOutput,this.layout,actual,this.monitorOutput);
    this.output={...this.output,monitorLayout:actual,maxChannels:max,fallback:actual!==layout,message:actual!==layout?`${layout} monitoring needs more output channels; using an explicit ${actual} downmix with LFE excluded.`:null};
  }
  _target(target='master'){if(target==='master')return'master';const trackId=target?.trackId;if(typeof trackId!=='string'||!this._project().tracks.some(track=>track.id===trackId))fail('Choose an existing track for the live rack.','NOT_FOUND');return trackId;}
  _candidate(key,value){const all=new Map(this.racks);all.set(key,value);validateLiveGraphs([...all].map(([id,rack])=>({id,...rack})),{sampleRate:this.context?.sampleRate||this._project().sampleRate,channels:CHANNEL_LAYOUTS[this.context?this.layout:this._project().outputLayout||'stereo'].count});return all;}
  async _ensureTrack(trackId){if(!this.graphs.graphs.has(trackId)){const config=this.racks.get(trackId)||{chain:[],automation:[]};const node=await this.graphs.setChain(trackId,config.chain);node.connect(this.masterInput);await this.graphs.setAutomation(trackId,config.automation);}return this.graphs.graphs.get(trackId).node;}
  async _rackSet(params){const key=this._target(params.target),chain=normalizeRackChain(params.chain),previous=this.racks.get(key)||{automation:[]};const value={chain,automation:previous.automation.filter(lane=>chain.some(stage=>stage.id===lane.slotId&&stage.effect===(this.racks.get(key)?.chain.find(s=>s.id===lane.slotId)?.effect)))};const candidate=this._candidate(key,value);if(this.contextReady){await this.contextReady;const existed=this.graphs.graphs.has(key),node=await this.graphs.setChain(key,chain);if(key!=='master'&&!existed)node.connect(this.masterInput);await this.graphs.setAutomation(key,value.automation);}this.racks=candidate;return copy(value);}
  async _paramSet(params){
    const key=this._target(params.target),rack=this.racks.get(key),stage=rack?.chain.find(stage=>stage.id===params.slotId);if(!stage)fail('Choose an existing effect stage.','NOT_FOUND');
    const field=parameterDefinition(stage,params.param);if(params.value<field.min||params.value>field.max||(field.integer&&!Number.isInteger(params.value)))fail('Parameter value is outside its supported range.');
    const project=this._project(),now=this.playback.playing?this.playback.position:this.clock?.timelineTime||0,at=params.at?.seconds??(params.at?.beat!==undefined?project.beatOffset+params.at.beat*60/project.bpm:now),rampSeconds=(params.rampMs??10)/1000;
    if(at<0||at+rampSeconds>86400)fail('Parameter schedule is outside the supported timeline.');
    const event={slotId:stage.id,param:params.param,value:params.value,at,rampSeconds};
    if(params.at){
      // Explicit timeline schedules are stored as automation, so they survive
      // save/load and are evaluated identically after seek, loop and offline render.
      const prior=rack.automation.find(lane=>lane.slotId===stage.id&&lane.param===params.param),base=params.param==='wet'?stage.wet:stage.params[params.param];
      let from=prior?automationValue(prior,at,base):base;if(field.integer)from=Math.round(from);
      const end=at+rampSeconds,points=(prior?.points||[{time:0,value:base,curve:'step'}]).filter(point=>point.time<at||point.time>end);
      if(rampSeconds)points.push({time:at,value:from,curve:'linear'},{time:end,value:params.value,curve:'step'});else points.push({time:at,value:params.value,curve:'step'});
      points.sort((a,b)=>a.time-b.time);const lanes=rack.automation.filter(lane=>lane!==prior).concat({slotId:stage.id,param:params.param,points});
      await this._automationSet({target:params.target,lanes});return{target:params.target||'master',...event,scheduled:true};
    }
    if(this.contextReady){await this.contextReady;await this._ensureTrackIfNeeded(key);await this.graphs.setParameter(key,{...event,audioTime:this.context.currentTime});}
    if(params.param==='wet')stage.wet=params.value;else stage.params[params.param]=params.value;return{target:params.target||'master',...event};
  }
  async _ensureTrackIfNeeded(key){if(key!=='master')await this._ensureTrack(key);}
  async _automationSet(params){const key=this._target(params.target),rack=this.racks.get(key);if(!rack)fail('Create this rack first.','NOT_FOUND');const lanes=params.enabled===false?[]:normalizeAutomation(params.lanes,rack.chain),candidate=this._candidate(key,{...rack,automation:lanes});if(this.contextReady){await this.contextReady;await this._ensureTrackIfNeeded(key);await this.graphs.setAutomation(key,lanes);}this.racks=candidate;return{target:params.target||'master',lanes:copy(lanes)};}
  async _play(params,{signal,generation=this.generation}={}){
    abort(signal);
    const context=await this._context(),project=this._project(),scope=params.scope||this.lastPlay.scope||'mix';
    const plan=await this.engine.execute('audio.playbackPlan',{scope,...(params.trackId?{trackId:params.trackId}:{}),...(params.clipId?{clipId:params.clipId}:{}),...(params.start!==undefined?{start:params.start}:{}),...(params.end!==undefined?{end:params.end}:{}),excludeTrackIds:[...this.loops.keys()]});
    const proposed=[...this.graphs.graphs.values()].map(graph=>({id:graph.id,chain:graph.chain,automation:graph.automation}));for(const track of plan.tracks)if(!proposed.some(graph=>graph.id===track.id))proposed.push({id:track.id,...(this.racks.get(track.id)||{chain:[],automation:[]})});this.graphs.budget(proposed);
    for(const track of plan.tracks)await this._ensureTrack(track.id);abort(signal);if(generation!==this.generation)fail('Playback start was cancelled.','ABORTED');
    const position=params.position??(params.offset!==undefined?plan.start+params.offset:this.playback.position>=plan.start&&this.playback.position<plan.end?this.playback.position:plan.start),loop=params.loop??this.playback.loop;
    const stagedStart=this.playback._timelineOffset+this.playback._loopStart,stagedEnd=this.playback._timelineOffset+this.playback._loopEnd;
    const stagedFits=stagedEnd>stagedStart&&stagedStart>=plan.start&&stagedEnd<=plan.end;
    const loopStart=(params.loopStart??(stagedFits?stagedStart:plan.start))-plan.start,loopEnd=(params.loopEnd??(stagedFits?stagedEnd:plan.end))-plan.start;
    const options={offset:position-plan.start,loop,loopStart,loopEnd,rate:params.rate??this.playback.rate,bpm:params.bpm??project.bpm,beatsPerBar:params.beatsPerBar??project.beatsPerBar,beatOffset:params.beatOffset??project.beatOffset,metronome:params.metronome??this.playback.metronome};
    const onAbort=()=>this.playback.stop();signal?.addEventListener('abort',onAbort,{once:true});try{await this.playback.playPlan(plan,options);abort(signal);}finally{signal?.removeEventListener('abort',onAbort);}this.lastPlay={scope,...(params.trackId?{trackId:params.trackId}:{}),...(params.clipId?{clipId:params.clipId}:{})};this.graphs.setClock({audioTime:context.currentTime,timelineTime:this.playback.position,rate:this.playback.rate,playing:true,loopStart:loop?plan.start+loopStart:0,loopEnd:loop?plan.start+loopEnd:0},options.bpm);return this.getState().transport;
  }
  async _transportSet(params){
    const project=this._project();let nextLoop;
    if(params.loop!==undefined||params.loopStart!==undefined||params.loopEnd!==undefined){
      const offset=this.playback._timelineOffset,previousStart=offset+this.playback._loopStart,previousEnd=offset+this.playback._loopEnd;
      const previousFits=previousEnd>previousStart&&previousStart>=0&&previousEnd<=project.duration;
      const start=params.loopStart??(previousFits?previousStart:0),end=params.loopEnd??(previousFits?previousEnd:project.duration),enabled=params.loop??this.playback.loop;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<0||start>project.duration||end>project.duration)fail('Loop bounds must fit the project duration.');
      const pendingEmpty=project.duration===0&&params.loopStart===undefined&&params.loopEnd===undefined;
      if(enabled&&end<=start&&!pendingEmpty)fail('Loop end must follow loop start.');
      if(this.playback.playing&&(start<offset||end>offset+this.playback._duration))fail('Loop bounds must fit the playing selection. Stop playback or play the mix before changing its range.');
      nextLoop={enabled,start:start-offset,end:end-offset};
    }
    // Preflight loop bounds before changing tempo or restarting an active source.
    if(params.bpm!==undefined||params.beatsPerBar!==undefined||params.beatOffset!==undefined)await this.engine.execute('project.update',Object.fromEntries(['bpm','beatsPerBar','beatOffset'].filter(key=>params[key]!==undefined).map(key=>[key,params[key]])));
    this.playback.setTempo(params.bpm??project.bpm,params.beatOffset??project.beatOffset,params.beatsPerBar??project.beatsPerBar);
    if(params.rate!==undefined)this.playback.setRate(params.rate);
    if(params.metronome!==undefined)this.playback.setMetronome(params.metronome);
    if(nextLoop)this.playback.setLoop(nextLoop.enabled,nextLoop);
    return this.getState().transport;
  }
  async _inputStart(params,options){
    if(this.capture.phase!=='idle'||['recording','paused'].includes(this.recorder.status))fail('Stop capture/recording before changing the input device or channels.','BUSY');
    const generation=this.generation,inputGeneration=this.inputGeneration;const contextPromise=this._context(),streamPromise=this.devices.start(params,options);let stream;
    try{[ ,stream]=await Promise.all([contextPromise,streamPromise]);abort(options.signal);if(generation!==this.generation||inputGeneration!==this.inputGeneration)fail('Input request was cancelled.','ABORTED');this._disconnectInput();
      const state=this.devices.getState(),context=this.context,source=context.createMediaStreamSource(stream),split=context.createChannelSplitter(state.availableChannels),merge=context.createChannelMerger(state.channels.length),level=context.createGain();level.gain.value=gain(state.gainDb);level.channelCount=state.channels.length;level.channelCountMode='explicit';level.channelInterpretation='discrete';source.connect(split);state.channels.forEach((index,c)=>split.connect(merge,index,c));merge.connect(level);this.inputNodes=[source,split,merge,level];this.inputNode=level;
      this.inputMonitor=context.createGain();this.inputMonitor.gain.value=params.monitor?gain(this.monitor.gainDb):0;level.connect(this.inputMonitor);this.inputRoute=connectMatrix(context,this.inputMonitor,state.layout,this.layout,this.masterInput);this.monitor.enabled=!!params.monitor;
      this.inputTap=await this.captureFactory(context,level,{channels:state.channels.length,framesPerChunk:1024,onChunk:packet=>{this._inputPacket(packet);return packet.data.buffer;},onError:error=>this._error(error)});abort(options.signal);if(generation!==this.generation||inputGeneration!==this.inputGeneration)fail('Input request was cancelled.','ABORTED');this.inputTap.start();return this.getState().input;
    }catch(error){this.devices.stop({error});this._disconnectInput();throw error;}
  }
  _disconnectInput(){this.inputTap?.dispose();this.inputTap=null;this.inputRoute?.dispose();this.inputRoute=null;disconnect(this.inputMonitor);this.inputMonitor=null;for(const node of this.inputNodes||[])disconnect(node);this.inputNodes=[];this.inputNode=null;this.monitor.enabled=false;for(const subscription of this.subscribers)subscription.active=false;this.subscribers.clear();}
  _inputChanged(){if(this.devices?.state.status!=='active'&&this.inputNode){this._disconnectInput();if(this.capture.source==='input'&&this.capture.phase!=='idle')this._cancelCapture().catch(error=>this._error(error));if(this.recorder.source==='input'&&['recording','paused'].includes(this.recorder.status))this._stopRecording('error').catch(error=>this._error(error));}if(this.devices)this._state('audio.input.state');}
  subscribeInputPCM(onChunk,{framesPerChunk=1024,maxQueuedChunks=4}={}){
    if(this.devices.state.status!=='active'||!this.inputNode)fail('Start input before subscribing to its PCM.','NO_INPUT');if(typeof onChunk!=='function'||!Number.isInteger(framesPerChunk)||framesPerChunk<128||framesPerChunk>16384||!Number.isInteger(maxQueuedChunks)||maxQueuedChunks<1||maxQueuedChunks>16||this.subscribers.size>=8)fail('Invalid or excessive input subscription.','RESOURCE_LIMIT');
    const channels=this.devices.state.channels.length,subscription={active:true,onChunk,framesPerChunk,maxQueuedChunks,queued:0,offset:0,sequence:0,droppedFrames:0,buffer:new Float32Array(framesPerChunk*channels),startFrame:0};this.subscribers.add(subscription);return()=>{subscription.active=false;this.subscribers.delete(subscription);};
  }
  _inputPacket(packet){
    const layout=this.devices.state.layout;for(const sub of this.subscribers){let inputOffset=0;while(inputOffset<packet.frames){const take=Math.min(sub.framesPerChunk-sub.offset,packet.frames-inputOffset);if(!sub.offset)sub.startFrame=packet.startFrame+inputOffset;sub.buffer.set(packet.data.subarray(inputOffset*packet.channels,(inputOffset+take)*packet.channels),sub.offset*packet.channels);sub.offset+=take;inputOffset+=take;if(sub.offset===sub.framesPerChunk){sub.offset=0;if(sub.queued>=sub.maxQueuedChunks){sub.droppedFrames+=sub.framesPerChunk;continue;}const data=sub.buffer.slice(),chunk={sequence:sub.sequence++,startFrame:sub.startFrame,sampleRate:packet.sampleRate,layout,channels:packet.channels,frames:sub.framesPerChunk,data,droppedFrames:sub.droppedFrames};sub.droppedFrames=0;sub.queued++;Promise.resolve().then(()=>{if(sub.active)return sub.onChunk(chunk);}).catch(error=>{sub.active=false;this.subscribers.delete(sub);this._error(error);}).finally(()=>sub.queued--);}}}
    const peaks=Array.from({length:packet.channels},()=>0);for(let i=0;i<packet.data.length;i++)peaks[i%packet.channels]=Math.max(peaks[i%packet.channels],Math.abs(packet.data[i]));this._emit('meter',{source:'input',peaks});
  }
  async _source(source='input'){await this._context();if(source==='input'){if(this.devices.state.status!=='active'||!this.inputNode)fail('Start an input device first.','NO_INPUT');return{node:this.inputNode,layout:this.devices.state.layout,channels:this.devices.state.channels.length};}if(source==='master')return{node:this.masterOutput,layout:this.layout,channels:CHANNEL_LAYOUTS[this.layout].count};const trackId=this._target(source);return{node:await this._ensureTrack(trackId),layout:this.layout,channels:CHANNEL_LAYOUTS[this.layout].count};}
  _boundary(quantize='beat'){
    const context=this.context,project=this._project(),rate=this.playback.playing?this.playback.rate:1,lead=.02,now=context.currentTime+lead;
    if(quantize==='off')return Math.ceil(now*context.sampleRate);
    const step=60/project.bpm*(quantize==='bar'?project.beatsPerBar:1),position=this.playback.playing?this.playback.position+lead*rate:now-this.epoch,beat=Math.ceil((position-project.beatOffset)/step-1e-9)*step+project.beatOffset;
    return Math.ceil((now+(beat-position)/rate)*context.sampleRate);
  }
  async _captureStart(params,options){
    if(this.capture.phase!=='idle')fail('A loop capture is already active.','BUSY');this.captureCancelled=false;const source=params.source||'input',route=await this._source(source);abort(options.signal);if(options.generation!==undefined&&options.generation!==this.generation)fail('Loop capture start was cancelled.','ABORTED');
    const context=this.context,beats=params.beats??4,frames=Math.max(1,Math.round(beats*60/this._project().bpm/(this.playback.playing?this.playback.rate:1)*context.sampleRate));
    if(frames*route.channels*4*2>LIVE_LIMITS.captureBytes)fail('This loop exceeds the bounded capture memory; choose fewer beats or channels.','RESOURCE_LIMIT');
    const captureId=id(),generation=this.generation,release=this.graphs.reserveVoice(frames*route.channels*4),audio={sampleRate:context.sampleRate,layout:route.layout,channels:Array.from({length:route.channels},()=>new Float32Array(frames))};
    const transition=source==='master'?'main-thread':'audio-clock';this.capture={phase:'armed',captureId,source,beats,startFrame:null,endFrame:null,frames:0,transition};const pending={captureId,generation,audio,release,offset:0,name:params.name||`Loop ${this.loops.size+1}`,graphId:`capture-${captureId}`,route:null,tap:null,committing:null,transition,transitionDelayFrames:0};this.pendingCapture=pending;
    try{
      const node=await this.graphs.setChain(pending.graphId,[]);node.connect(this.masterInput);
      abort(options.signal);if(this.captureCancelled||generation!==this.generation)fail('Loop capture cancelled.','ABORTED');
      pending.tap=await this.captureFactory(context,route.node,{channels:route.channels,loopFrames:frames,onStart:bounds=>{if(this.pendingCapture!==pending||generation!==this.generation)return;this.capture.startFrame=bounds.startFrame;this.capture.endFrame=bounds.endFrame;this._emit('capture',copy(this.capture));},onChunk:packet=>{if(this.pendingCapture!==pending||generation!==this.generation)return packet.data.buffer;const available=Math.min(packet.frames,frames-pending.offset);for(let i=0;i<available;i++)for(let c=0;c<route.channels;c++)audio.channels[c][pending.offset+i]=packet.data[i*route.channels+c];pending.offset+=available;this.capture.frames=pending.offset;this.capture.phase='recording';this._emit('progress',{captureId,frames:pending.offset,totalFrames:frames});return packet.data.buffer;},onEnd:result=>{if(this.pendingCapture===pending&&!this.captureCancelled&&generation===this.generation){pending.endFrame=result.endFrame;this._commitCapture(pending).catch(error=>{this._error(error);this._cancelCapture().catch(()=>{});});}},onError:error=>{this._error(error);this._cancelCapture().catch(()=>{});}});
      // A master tap cannot feed its captured loop back into the same master
      // while its input is attached: Web Audio would mute that graph cycle.
      if(transition==='audio-clock')pending.route=connectMatrix(context,pending.tap.node,route.layout,this.layout,node);
      abort(options.signal);if(this.captureCancelled||generation!==this.generation)fail('Loop capture cancelled.','ABORTED');
      // Loading a graph/worklet can outlast the scheduling lead. Choose the
      // boundary only once preparation is complete, and let the processor move
      // a late start to the next grid boundary while retaining every loop frame.
      const quantize=params.quantize||'beat',project=this._project(),startFrame=this._boundary(quantize),endFrame=startFrame+frames,quantumFrames=quantize==='off'?0:60/project.bpm*(quantize==='bar'?project.beatsPerBar:1)/(this.playback.playing?this.playback.rate:1)*context.sampleRate;
      this.capture.startFrame=startFrame;this.capture.endFrame=endFrame;pending.tap.start({startFrame,endFrame,quantumFrames});this._emit('capture',copy(this.capture));return copy(this.capture);
    }catch(error){pending.tap?.dispose();pending.route?.dispose();pending.release();this.graphs?.remove(pending.graphId);if(this.pendingCapture===pending)await this._cancelCapture();throw error;}
  }
  _commitCapture(pending){
    if(pending.committing)return pending.committing;
    pending.committing=(async()=>{if(this.captureCancelled||pending.generation!==this.generation)return null;if(!pending.offset)fail('Capture did not contain audio.','EMPTY_AUDIO');this.capture.phase='committing';this._state('loop.capture.commit');
      pending.tap.detachSource?.();
      if(!pending.route){
        const graph=this.graphs?.graphs.get(pending.graphId);if(!graph)fail('Capture graph is no longer available.','ABORTED');
        pending.route=connectMatrix(this.context,pending.tap.node,pending.audio.layout,this.layout,graph.node);
        pending.transitionDelayFrames=Math.max(0,Math.ceil(this.context.currentTime*pending.audio.sampleRate)-(pending.endFrame??this.capture.endFrame));
      }
      const audio={...pending.audio,channels:pending.audio.channels.map(channel=>channel.slice(0,pending.offset))};
      if(this.captureCancelled||pending.generation!==this.generation)return null;const clip=await this.engine.execute('clip.add',{name:pending.name,audio,start:0});
      if(pending.generation!==this.generation||this.captureCancelled||this.pendingCapture!==pending){pending.tap.dispose();pending.route.dispose();pending.release();if(this._project().tracks.some(track=>track.id===clip.trackId&&track.clips.some(item=>item.id===clip.clipId)))await this.engine.execute('track.remove',{trackId:clip.trackId});return null;}
      const graph=this.graphs.graphs.get(pending.graphId);if(graph){this.graphs.graphs.delete(pending.graphId);graph.id=clip.trackId;this.graphs.graphs.set(clip.trackId,graph);}
      this.loops.set(clip.trackId,{trackId:clip.trackId,clipId:clip.clipId,name:clip.name,duration:pending.offset/audio.sampleRate,playing:true,muted:false,tap:pending.tap,route:pending.route,release:pending.release,layout:audio.layout,transition:pending.transition,transitionDelayFrames:pending.transitionDelayFrames,transitionDelaySeconds:pending.transitionDelayFrames/audio.sampleRate});
      this.pendingCapture=null;this.capture=emptyCapture();this._emit('capture',{phase:'playing',trackId:clip.trackId,clipId:clip.clipId});this._state('loop.capture.complete');return clip;
    })();return pending.committing;
  }
  async _captureStop(commit=true){const pending=this.pendingCapture;if(!pending)return null;if(!commit)return this._cancelCapture();await pending.tap.stop();return this._commitCapture(pending);}
  async _cancelCapture(){this.captureCancelled=true;const pending=this.pendingCapture;this.pendingCapture=null;if(pending){pending.tap?.dispose();pending.route?.dispose();pending.release();this.graphs?.remove(pending.graphId);}this.capture=emptyCapture();this._emit('capture',copy(this.capture));return true;}
  async _loopPlay(params){
    this.playback.removeTrack?.(params.trackId);
    let loop=this.loops.get(params.trackId);const whenFrame=this.context?this._boundary(params.quantize||'beat'):0;
    if(loop?.tap){loop.tap.setLoop({playing:true,anchor:whenFrame,offset:0,muted:loop.muted});loop.playing=true;return this.getState().loops.find(item=>item.trackId===params.trackId);}
    await this._context();const track=this._project().tracks.find(track=>track.id===params.trackId);if(!track)fail('Loop track does not exist.','NOT_FOUND');const clip=track.clips.find(clip=>clip.id===(params.clipId||loop?.clipId))||track.clips[0];if(!clip)fail('The loop track contains no clip.','EMPTY_AUDIO');
    if(loop?.source)this._stopLoop(loop);
    const audio=await this.engine.execute('clip.getAudio',{clipId:clip.id}),context=this.context,node=await this._ensureTrack(track.id),buffer=context.createBuffer(audio.channels.length,audio.channels[0].length,audio.sampleRate);audio.channels.forEach((channel,c)=>buffer.copyToChannel(channel,c));const release=this.graphs.reserveVoice(audio.channels.length*audio.channels[0].length*4),source=context.createBufferSource();source.buffer=buffer;source.loop=true;
    const level=context.createGain();level.gain.value=loop?.muted?0:1;source.connect(level);const route=connectMatrix(context,level,audioLayout(audio),this.layout,node,track);const when=this._boundary(params.quantize||'beat')/context.sampleRate;source.start(when);
    loop={trackId:track.id,clipId:clip.id,name:clip.name,duration:clip.duration,playing:true,muted:!!loop?.muted,source,level,route,release};this.loops.set(track.id,loop);return this.getState().loops.find(item=>item.trackId===track.id);
  }
  _stopLoop(loop){if(loop.tap)loop.tap.setLoop({playing:false});if(loop.source){try{loop.source.stop();}catch{}disconnect(loop.source);disconnect(loop.level);loop.route?.dispose();loop.release();loop.source=null;}loop.playing=false;}
  async releaseTrack(trackId){this.playback.removeTrack?.(trackId);const loop=this.loops.get(trackId);if(loop){this._stopLoop(loop);loop.tap?.dispose();loop.route?.dispose();loop.release();this.loops.delete(trackId);}this.graphs?.remove(trackId);this.racks.delete(trackId);this._state('track.release');}
  async _quota(){if(!this.storageState.available)fail('Disk-backed recording storage is unavailable.','UNSUPPORTED');try{const estimate=await this.navigator?.storage?.estimate?.();if(estimate)this.storageState={...this.storageState,usage:estimate.usage??null,quota:estimate.quota??null,remainingBytes:estimate.quota!==undefined&&estimate.usage!==undefined?Math.max(0,estimate.quota-estimate.usage):null};}catch(error){this.storageState.error=error.message;}return this.storageState;}
  async _recorderTap(route){
    const generation=this.generation,tap=await this.captureFactory(this.context,route.node,{channels:route.channels,onChunk:async packet=>{if(this.recorder.status!=='recording')return packet.data.buffer;const response=await this.storage.execute('append',{},packet.data);this._recordInfo(response.result);this._emit('progress',{recordingId:this.recorder.recordingId,frames:this.recorder.frames,bytesWritten:this.recorder.bytesWritten,queuedBytes:this.storage.queuedBytes||0,remainingBytes:this.storageState.remainingBytes});return response.buffer;},onError:error=>{this._error(error);this._stopRecording('error').catch(e=>this._error(e));}});
    if(generation!==this.generation||this.recorder.status!=='recording'){tap.dispose();fail('Recording start was cancelled.','ABORTED');}this.recordTap=tap;tap.start();
  }
  _recordInfo(result){if(!result)return;this.recorder={...this.recorder,recordingId:result.id,name:result.name,frames:result.frames,seconds:result.seconds,bytesWritten:result.bytes,maxBytes:result.maxBytes};}
  async _recordStart(params,options){if(['recording','paused','stopping'].includes(this.recorder.status))fail('A recording is already active.','BUSY');await this._quota();const source=params.source||'master',route=await this._source(source);abort(options.signal);if(options.generation!==undefined&&options.generation!==this.generation)fail('Recording start was cancelled.','ABORTED');const remaining=this.storageState.remainingBytes;if(remaining!==null&&remaining<1024*1024)fail('Insufficient storage quota for recording.','STORAGE_QUOTA');const maxBytes=Math.floor(Math.min(params.maxBytes??512*1024**3,remaining===null?Infinity:remaining*.9));const response=await this.storage.execute('start',{name:params.name||'DJ recording',sampleRate:this.context.sampleRate,layout:route.layout,maxBytes,maxSeconds:params.maxSeconds??86400});this.recorder={...emptyRecorder(),status:'recording',source};this.recordRoute=route;this._recordInfo(response.result);try{abort(options.signal);if(options.generation!==undefined&&options.generation!==this.generation)fail('Recording start was cancelled.','ABORTED');await this._recorderTap(route);abort(options.signal);if(options.generation!==undefined&&options.generation!==this.generation)fail('Recording start was cancelled.','ABORTED');return copy(this.recorder);}catch(error){await this._stopRecording('error');throw error;}}
  _stopRecording(status='complete'){
    if(this.stoppingRecording)return this.stoppingRecording;
    if(!this.recorder.recordingId||this.recorder.status==='idle')return Promise.resolve(null);
    this.stoppingRecording=(async()=>{
      const tap=this.recordTap;this.recordTap=null;try{if(tap)await tap.stop();}catch(error){status='error';this.recorder.error=error.message;}finally{tap?.dispose();}
      this.recorder.status='stopping';let result;try{result=(await this.storage.execute('stop',{status})).result;this._recordInfo(result);this.recorder.status=status==='error'?'error':'idle';await this._refreshRecordings();}catch(error){this.recorder.status='error';this.recorder.error=error.message;throw error;}this._state('recorder.stop');return result;
    })().finally(()=>{this.stoppingRecording=null;});return this.stoppingRecording;
  }
  async _refreshRecordings(){if(!this.storageState.available)return{recordings:[],warnings:['OPFS storage is unavailable.']};const result=(await this.storage.execute('list')).result;this.recordings=result.recordings;await this._quota();return result;}
  setExportDestination(handle){if(!handle?.createWritable)throw new TypeError('Choose a writable file handle.');this.exportDestination=handle;}
  setMidiPanic(callback){this.midiPanic=typeof callback==='function'?callback:()=>{};}
  midiRoute(){return{contextProvider:()=>this._context(),outputNode:()=>this.masterInput,layout:()=>this.layout,reserveVoice:bytes=>this.graphs.reserveVoice(bytes)};}
  getSettings(){return{version:1,racks:Object.fromEntries([...this.racks].map(([key,value])=>[key,copy(value)]))};}
  validateSettings(settings,{project=this._project()}={}){
    if(!settings||settings.version!==1||!settings.racks||typeof settings.racks!=='object'||Array.isArray(settings.racks))fail('Invalid live settings.');
    const candidate=new Map();for(const[key,value]of Object.entries(settings.racks)){if(key!=='master'&&!project.tracks.some(track=>track.id===key))continue;const chain=normalizeRackChain(value.chain),automation=normalizeAutomation(value.automation||[],chain);candidate.set(key,{chain,automation});}
    if(!candidate.has('master'))candidate.set('master',{chain:[],automation:[]});validateLiveGraphs([...candidate].map(([id,value])=>({id,...value})),{sampleRate:project.sampleRate,channels:CHANNEL_LAYOUTS[project.outputLayout||'stereo'].count});return{version:1,racks:Object.fromEntries(candidate)};
  }
  async loadSettings(settings){if(this.resetting)await this.resetting;const normalized=this.validateSettings(settings);if(this.playback.playing||this.devices.state.status==='active'||this.pendingCapture||[...this.loops.values()].some(loop=>loop.playing)||['recording','paused','stopping'].includes(this.recorder.status))fail('Stop live audio before loading live settings.','BUSY');if(this.contextReady)await this.resetProject();this.racks=new Map(Object.entries(normalized.racks));return this.getSettings();}
  async _offline(audio,rack,start,bpm,signal){if(!rack)return audio;const dsp=new RealtimeRackDSP({sampleRate:audio.sampleRate,channels:audio.channels.length,chain:rack.chain,bpm});dsp.setAutomation(rack.automation);for(let at=0;at<audio.channels[0].length;at+=128){const end=Math.min(audio.channels[0].length,at+128),block=audio.channels.map(channel=>channel.subarray(at,end));dsp.process(block,block,{timelineStart:start+at/audio.sampleRate});if(at%8192===0){abort(signal);await task();}}return audio;}
  async _liveRender(params,{signal}={}){
    const project=this._project(),snapshot=new Map([...this.racks].map(([key,value])=>[key,copy(value)])),scope=params.scope||'mix',outputLayout=normalizeLayout(params.outputLayout||project.outputLayout||'stereo');
    const master=snapshot.get('master');let audio,start=params.start||0;
    if(scope==='clip'||scope==='selection'){
      const clipId=params.clipId||project.selectedClipId,track=project.tracks.find(track=>track.clips.some(clip=>clip.id===clipId));if(!track)fail('Select an existing clip.','NOT_FOUND');const clip=track.clips.find(clip=>clip.id===clipId);start=clip.start+(params.start??(scope==='selection'?project.selection?.start||0:0));audio=await this.engine.execute('audio.render',{...params,outputLayout});await this._offline(audio,snapshot.get(track.id),start,project.bpm,signal);
    }else{
      const tracks=scope==='track'?[project.tracks.find(track=>track.id===params.trackId)]:project.tracks;if(tracks.some(track=>!track)||!['track','mix'].includes(scope))fail('Choose an existing render track.','NOT_FOUND');const end=params.end??tracks.reduce((max,track)=>track.clips.reduce((n,clip)=>Math.max(n,clip.start+clip.duration),max),0),frames=Math.round((end-start)*project.sampleRate),channels=CHANNEL_LAYOUTS[outputLayout].count;if(frames<=0||frames*channels*4>256*1024*1024)fail('Live render exceeds the resident editing range.','RESOURCE_LIMIT');audio={sampleRate:project.sampleRate,layout:outputLayout,channels:Array.from({length:channels},()=>new Float32Array(frames))};const solo=(params.respectSolo??scope==='mix')&&project.tracks.some(track=>track.solo);
      for(const track of tracks){if(solo&&!track.solo||params.respectMute!==false&&track.mute)continue;abort(signal);const part=await this.engine.execute('audio.render',{scope:'track',trackId:track.id,start,end,outputLayout,respectMute:false,respectSolo:false});await this._offline(part,snapshot.get(track.id),start,project.bpm,signal);for(let c=0;c<channels;c++)for(let i=0;i<frames;i++)audio.channels[c][i]+=part.channels[c][i];}
    }
    await this._offline(audio,master,start,project.bpm,signal);return audio;
  }
  async _execute(method,params,options){
    if(['recordings.export','recordings.importRange','recordings.auditionRange'].includes(method)&&['recording','stopping'].includes(this.recorder.status))fail('Pause or stop capture before reading an archive so disk work cannot starve the recording queue.','BUSY');
    switch(method){
      case'audio.capabilities':return this.capabilities();case'audio.devices.list':return this.devices.list();
      case'audio.input.start':return this._inputStart(params,options);case'audio.input.stop':this.devices.stop();this._disconnectInput();return this.getState().input;
      case'audio.input.set':{const result=await this.devices.set(params);if(this.inputNode)this.inputNode.gain.setTargetAtTime(gain(result.gainDb),this.context.currentTime,.005);return result;}
      case'audio.output.set':{await this._context();if(params.deviceId!==undefined&&params.deviceId!==this.output.deviceId){if(!this.context.setSinkId)fail('This browser does not support output device selection.','UNSUPPORTED');await this.context.setSinkId(params.deviceId);this.output.deviceId=params.deviceId;}this._monitorRouting(params.monitorLayout||this.output.monitorLayout);return copy(this.output);}
      case'audio.monitor.set':{if(params.enabled&&!this.inputNode)fail('Start an input before enabling monitoring.','NO_INPUT');if(params.gainDb!==undefined)this.monitor.gainDb=params.gainDb;if(params.enabled!==undefined)this.monitor.enabled=params.enabled;if(this.inputMonitor)this.inputMonitor.gain.setTargetAtTime(this.monitor.enabled?gain(this.monitor.gainDb):0,this.context.currentTime,.005);return copy(this.monitor);}
      case'transport.play':return this._play(params,options);case'transport.pause':this.playback.pause();return this.getState().transport;
      case'transport.stop':this.playback.stop();for(const loop of this.loops.values())this._stopLoop(loop);this.midiPanic();if(this.pendingCapture)await this._cancelCapture();return this.getState().transport;
      case'transport.seek':{const playing=this.playback.playing;if(playing)return this._play({...this.lastPlay,position:params.position});this.playback._position=params.position;this.playback.onTime?.(params.position);return this.getState().transport;}
      case'transport.set':return this._transportSet(params);case'live.rack.set':return this._rackSet(params);case'live.param.set':return this._paramSet(params);case'automation.set':return this._automationSet(params);case'automation.clear':return this._automationSet({target:params.target,lanes:[]});case'live.render':return this._liveRender(params,options);
      case'loop.capture.start':return this._captureStart(params,options);case'loop.capture.toggle':return this.pendingCapture?this._captureStop(true):this._captureStart(params,options);case'loop.capture.stop':return this._captureStop(params.commit!==false);case'loop.capture.cancel':return this._cancelCapture();
      case'loop.track.list':return this.getState().loops;case'loop.track.play':return this._loopPlay(params);
      case'loop.track.stop':{const loop=this.loops.get(params.trackId);if(!loop)fail('Loop layer was not found.','NOT_FOUND');this._stopLoop(loop);return this.getState().loops;}
      case'loop.track.mute':{const loop=this.loops.get(params.trackId);if(!loop)fail('Loop layer was not found.','NOT_FOUND');loop.muted=params.muted;loop.tap?.setLoop({muted:params.muted});if(loop.level)loop.level.gain.setTargetAtTime(params.muted?0:1,this.context.currentTime,.005);return this.getState().loops;}
      case'loop.track.remove':await this.releaseTrack(params.trackId);return this.engine.execute('track.remove',{trackId:params.trackId});
      case'recorder.start':return this._recordStart(params,options);case'recorder.stop':return this._stopRecording();
      case'recorder.pause':if(this.recorder.status!=='recording')fail('No recording is running.','NOT_RECORDING');await this.recordTap.stop();this.recordTap.dispose();this.recordTap=null;this._recordInfo((await this.storage.execute('pause')).result);this.recorder.status='paused';return copy(this.recorder);
      case'recorder.resume':if(this.recorder.status!=='paused')fail('Recording is not paused.','NOT_RECORDING');this._recordInfo((await this.storage.execute('resume')).result);this.recorder.status='recording';await this._recorderTap(this.recordRoute);return copy(this.recorder);
      case'recordings.list':return this._refreshRecordings();case'recordings.recover':{const result=(await this.storage.execute('recover',params)).result;await this._refreshRecordings();return result;}
      case'recordings.delete':{const result=(await this.storage.execute('delete',params)).result;await this._refreshRecordings();return result;}
      case'recordings.importRange':{const audio=(await this.storage.execute('range',params,undefined,undefined,{signal:options.signal})).result;abort(options.signal);return this.engine.execute('clip.add',{audio,name:params.name||'Recorded range'});}
      case'recordings.auditionRange':{const audio=(await this.storage.execute('range',params,undefined,undefined,{signal:options.signal})).result;abort(options.signal);await this.playback.play(audio);return{duration:audio.channels[0].length/audio.sampleRate};}
      case'recordings.export':{const handle=this.exportDestination;this.exportDestination=null;if(handle){abort(options.signal);const result=(await this.storage.execute('export',params,undefined,handle,{signal:options.signal})).result;return{...result,recordingId:params.recordingId,mime:'audio/wav'};}const listing=await this._refreshRecordings(),record=listing.recordings.find(item=>item.id===params.recordingId);if(!record)fail('Recording not found.','NOT_FOUND');const frames=Math.round(((params.end??record.seconds)-(params.start??0))*record.sampleRate);if(frames*record.channels*4>64*1024*1024)fail('Choose a streaming file destination or export a range below 64 MiB.','STREAM_DESTINATION_REQUIRED');const audio=(await this.storage.execute('range',params,undefined,undefined,{signal:options.signal})).result;return{bytes:encodeWav(audio,{float:true,bitDepth:32}),mime:'audio/wav',ext:'wav',recordingId:params.recordingId};}
      default:fail(`Unhandled live command ${method}.`,'UNKNOWN_COMMAND');
    }
  }
  _engineChanged({method,state}){
    if(!state)return;const ids=new Set(state.tracks.map(track=>track.id));for(const id of this.knownTracks)if(!ids.has(id))this.releaseTrack(id).catch(error=>this._error(error));this.knownTracks=ids;
    if(['project.new','project.load'].includes(method))this.resetProject().catch(error=>this._error(error));
    else if(this.contextReady&&(state.outputLayout||'stereo')!==this.layout)this.resetProject({preserveSettings:true}).catch(error=>this._error(error));
  }
  resetProject({preserveSettings=false}={}){
    if(this.resetting)return this.resetting;
    const retained=preserveSettings?new Map([...this.racks].map(([key,value])=>[key,copy(value)])):new Map([['master',{chain:[],automation:[]}]]);
    this.generation++;this.devices.stop();this._disconnectInput();this.playback.stop();this.midiPanic();
    this.resetting=(async()=>{await this._cancelCapture();await this._stopRecording();for(const trackId of [...this.loops.keys()])await this.releaseTrack(trackId);this.graphs?.dispose();this.graphs=null;this.monitorRoute?.dispose();disconnect(this.masterOutput);disconnect(this.monitorOutput);this.masterInput=null;this.masterOutput=null;this.monitorOutput=null;this.contextReady=null;this.racks=retained;this._state('project.reset');return true;})().finally(()=>{this.resetting=null;});return this.resetting;
  }
  async dispose(){if(this.disposed)return;await this.resetProject();this.disposed=true;this.devices.dispose();this.storage.dispose();this.engine.removeEventListener?.('state',this.engineListener);this.listeners.clear();await this.playback.dispose();if(this.context&&this.context.state!=='closed')await this.context.close();this.context=null;}
}
