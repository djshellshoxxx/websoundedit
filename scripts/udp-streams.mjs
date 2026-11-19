/** Opt-in UDP output. Only operator-pinned destinations and typed profiles exist.
 * The browser supplies bounded interleaved f32le packets; this module owns every
 * encoder/socket and never interpolates a shell command or request-supplied URL.
 */
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CHANNEL_LAYOUTS, normalizeLayout, conversionMatrix } from '../src/channel-layout.js';
import { schema as S, validateCommandParams } from '../src/command-schema.js';
import { nativeCapabilities } from './node-codecs.mjs';

const layouts=['mono','stereo','5.1','7.1'];
const rates=[8000,12000,16000,22050,24000,32000,44100,48000,88200,96000,192000];
export const STREAM_PROFILES=Object.freeze([
  {id:'s16le',label:'Raw 16-bit PCM, little endian',format:'s16le',codec:'pcm_s16le',rates,layouts,raw:true},
  {id:'f32le',label:'Raw 32-bit float PCM, little endian',format:'f32le',codec:'pcm_f32le',rates,layouts,raw:true},
  {id:'opus',label:'Opus in Ogg',format:'opus',codec:'libopus',capability:'opus',rates:[8000,12000,16000,24000,48000],layouts},
  {id:'mp3',label:'MP3 elementary stream',format:'mp3',codec:'libmp3lame',capability:'mp3',rates:[8000,16000,22050,24000,32000,44100,48000],layouts:['mono','stereo']},
  {id:'aac-ts',label:'AAC in MPEG transport stream',format:'mpegts',codec:'aac',capability:'aac',rates:[8000,12000,16000,22050,24000,32000,44100,48000,88200,96000],layouts},
  {id:'flac',label:'FLAC stream',format:'flac',codec:'flac',capability:'flac',rates,layouts},
]);
const startSchema=S.object({
  destination:S.string(64,1),profile:S.enum(...STREAM_PROFILES.map(p=>p.id)),
  inputSampleRate:S.integer(8000,192000),inputLayout:S.enum(...layouts),
  sampleRate:S.integer(8000,192000),layout:S.enum(...layouts),bitrate:S.integer(16,512),
},['destination','profile','inputSampleRate','inputLayout']);
export const STREAM_COMMANDS=[
  {method:'stream.start',description:'Start one UDP encoder for a pinned named destination and supported profile.',schema:startSchema,recordable:true,capabilities:['companion.udp']},
  {method:'stream.stop',description:'Stop and reap the owned encoder and UDP socket.',schema:S.object({id:S.string(80,1)}),recordable:true,capabilities:['companion.udp']},
  {method:'stream.status',description:'Read stream format, bounded queue and loss counters.',schema:S.object({}),recordable:false,capabilities:['companion.udp']},
];
const failure=(message,code='INVALID_ARGUMENT')=>Object.assign(new Error(message),{code});
function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(failure('Stream startup was canceled.','ABORTED'));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(failure('Stream startup was canceled.','ABORTED'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function normalizeDestinations(values=[]) {
  if(!Array.isArray(values)||values.length>16)throw new Error('Configure at most 16 named UDP destinations.');
  const seen=new Set();
  return values.map(value=>{
    if(!value||typeof value!=='object'||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.id)||seen.has(value.id))throw new Error('UDP destination IDs must be unique safe names.');
    seen.add(value.id);
    if(typeof value.address!=='string'||!isIP(value.address)||['0.0.0.0','::','255.255.255.255'].includes(value.address)||!Number.isInteger(value.port)||value.port<1||value.port>65535)throw new Error('UDP destinations require a literal IP address and port 1–65535.');
    if(value.label!==undefined&&(typeof value.label!=='string'||value.label.length>120))throw new Error('Invalid UDP destination label.');
    return Object.freeze({id:value.id,label:value.label||value.id,address:value.address,port:value.port});
  });
}
export function encoderArgs(config) {
  const profile=STREAM_PROFILES.find(p=>p.id===config.profile);
  if(!profile)throw new Error('Unknown UDP profile.');
  const count=CHANNEL_LAYOUTS[config.layout].count;
  const args=['-hide_banner','-nostdin','-loglevel','error','-f','f32le','-ar',String(config.inputSampleRate),'-ac',String(count),'-channel_layout',config.layout,'-i','pipe:0','-map','0:a:0','-vn','-c:a',profile.codec,'-ar',String(config.sampleRate),'-ac',String(count)];
  if(['opus','mp3','aac-ts'].includes(profile.id))args.push('-b:a',String(config.bitrate)+'k');
  if(profile.id==='opus')args.push('-application','lowdelay','-frame_duration','20','-page_duration','20000',...(count>2?['-mapping_family','1']:[]));
  if(profile.id==='mp3')args.push('-id3v2_version','0','-write_xing','0');
  if(profile.id==='aac-ts')args.push('-mpegts_flags','+resend_headers','-muxdelay','0','-muxpreload','0');
  args.push('-flush_packets','1','-f',profile.format,'pipe:1');return args;
}
export class UdpStreams {
  constructor({destinations=[],getCapabilities=nativeCapabilities,spawnEncoder=spawn,socketFactory=createSocket}={}){
    this.destinations=normalizeDestinations(destinations);this.getCapabilities=getCapabilities;this.spawnEncoder=spawnEncoder;this.socketFactory=socketFactory;
    this.session=null;this.last=null;this.starting=false;this.startController=null;this.closed=false;this.capabilityPromise=null;
  }
  async capabilities(){
    const native=await(this.capabilityPromise??=this.getCapabilities());
    return{enabled:this.destinations.length>0,destinations:this.destinations.map(({id,label})=>({id,label})),
      profiles:STREAM_PROFILES.filter(p=>p.raw||native.nativeFFmpeg&&native.formats.includes(p.capability)).map(({id,label,rates,layouts,raw})=>({id,label,rates,layouts,...(raw&&!native.nativeFFmpeg?{resampling:false}:{} )})),
      nativeFFmpeg:native.nativeFFmpeg,limits:{streams:1,packetBytes:256*1024,encoderQueueBytes:2*1024*1024,udpQueuePackets:128,udpPacketBytes:1316,idleSeconds:15},
      transport:'Unencrypted UDP datagrams; loss is observable but not retransmitted.',input:'Interleaved little-endian float32 PCM.'};
  }
  async execute(method,params={},context={}){
    const descriptor=STREAM_COMMANDS.find(x=>x.method===method);if(!descriptor)throw failure('Unknown stream command.','UNKNOWN_COMMAND');
    validateCommandParams(params,descriptor);
    if(method==='stream.start')return this.start(params,context);
    if(method==='stream.stop')return this.stop(params);
    return this.status();
  }
  status(){
    const session=this.session;
    if(!session)return this.last?{...this.last,active:false}:{active:false};
    return{id:session.id,active:session.ready&&!session.stopping,profile:session.config.profile,destination:session.config.destination,sampleRate:session.config.sampleRate,layout:session.config.layout,inputSampleRate:session.config.inputSampleRate,inputLayout:session.config.inputLayout,
      ...session.stats,encoderQueueBytes:session.child?.stdin.writableLength||0,udpQueuePackets:session.packets.length+(session.sending?1:0),error:session.error||null};
  }
  async start(params,context={}){
    validateCommandParams(params,STREAM_COMMANDS[0]);
    if(this.closed)throw failure('The companion is shutting down.','DISPOSED');
    if(this.session||this.starting)throw failure('A UDP stream is already active. Stop it before starting another.','STREAM_BUSY');
    const controller=new AbortController(),abort=()=>controller.abort();
    this.starting=true;this.startController=controller;let session;
    context.signal?.addEventListener('abort',abort,{once:true});if(context.signal?.aborted)abort();
    try{
      const caps=await abortable(this.capabilities(),controller.signal),destination=this.destinations.find(d=>d.id===params.destination),profile=STREAM_PROFILES.find(p=>p.id===params.profile);
      if(!destination)throw failure('Choose an operator-configured destination.');
      if(!caps.profiles.some(p=>p.id===profile.id))throw failure('The installed encoder does not support this profile.','UNSUPPORTED_CAPABILITY');
      const config={...params,sampleRate:params.sampleRate??params.inputSampleRate,layout:params.layout??params.inputLayout,bitrate:params.bitrate??192};
      if(!profile.rates.includes(config.sampleRate)||!profile.layouts.includes(config.layout))throw failure('Unsupported sample rate or speaker layout for this streaming profile.');
      if(!caps.nativeFFmpeg&&config.sampleRate!==config.inputSampleRate)throw failure('Resampling requires native FFmpeg. Use the input rate.','UNSUPPORTED_CAPABILITY');
      if(this.closed)throw failure('The companion is shutting down.','DISPOSED');
      if(controller.signal.aborted)throw failure('Stream startup was canceled.','ABORTED');
      session={id:randomUUID(),config,destination,profile,socket:this.socketFactory(isIP(destination.address)===6?'udp6':'udp4'),child:null,packets:[],sending:false,pending:Buffer.alloc(0),ready:false,stopping:false,closed:false,expectedSequence:null,expectedFrame:null,error:null,stderr:'',
        stats:{receivedFrames:0,receivedPackets:0,sentBytes:0,sentPackets:0,droppedFrames:0,reportedDroppedFrames:0,sequenceGaps:0,frameDiscontinuities:0,udpDroppedPackets:0}};
      this.session=session;
      session.socket.on('error',error=>this._fail(session,'UDP socket: '+error.message));
      await new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(timer);session.socket.off('error',onError);controller.signal.removeEventListener('abort',onAbort);error?reject(error):resolve();};
        const onError=error=>finish(error),onAbort=()=>finish(failure('Stream startup was canceled.','ABORTED'));
        const timer=setTimeout(()=>finish(new Error('UDP socket connect timed out.')),2000);
        session.socket.once('error',onError);controller.signal.addEventListener('abort',onAbort,{once:true});
        try{session.socket.connect(destination.port,destination.address,()=>finish());}catch(error){finish(error);}
        if(controller.signal.aborted)onAbort();
      });
      if(session.stopping||this.closed||controller.signal.aborted)throw failure('Stream stopped during startup.','ABORTED');
      // Same-rate raw PCM does not need a native encoder.
      if(!profile.raw||config.sampleRate!==config.inputSampleRate){
        const child=this.spawnEncoder('ffmpeg',encoderArgs(config),{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});session.child=child;
        session.childDone=new Promise(resolve=>{child.once('close',(code,signal)=>{session.childCode=code;if(!session.stopping||code!==0)this._fail(session,'Encoder stopped: '+(session.stderr.trim()||'exit '+code+(signal?' ('+signal+')':'')));resolve();});child.once('error',error=>{session.childCode=-1;this._fail(session,'Encoder: '+error.message);resolve();});});
        child.stdin.on('error',error=>this._fail(session,'Encoder input: '+error.message));
        child.stdout.on('data',bytes=>this._enqueue(session,bytes));
        child.stderr.on('data',bytes=>{if(session.stderr.length<4096)session.stderr+=bytes.toString('utf8').slice(0,4096-session.stderr.length);});
        await abortable(new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}),controller.signal);
      }
      if(session.stopping||controller.signal.aborted)throw failure('Stream stopped during startup.','ABORTED');
      session.ready=true;this._touch(session);return this.status();
    }catch(error){if(session)await this.stop({id:session.id}).catch(()=>{});throw error;}
    finally{context.signal?.removeEventListener('abort',abort);if(this.startController===controller)this.startController=null;this.starting=false;}
  }
  _touch(session){clearTimeout(session.idle);session.idle=setTimeout(()=>this._fail(session,'Input timed out after 15 seconds.'),15000);session.idle.unref?.();}
  _fail(session,message){if(session.closed)return;session.error||=String(message).slice(0,1000);if(!session.stopping)void this.stop({id:session.id}).catch(()=>{});}
  feed(id,bytes,{sequence,startFrame,frames,droppedFrames=0}={}){
    const session=this.session;if(!session||session.id!==id||session.stopping||!session.ready)throw failure('The stream is no longer active.','NOT_FOUND');
    const inputCount=CHANNEL_LAYOUTS[session.config.inputLayout].count,outputCount=CHANNEL_LAYOUTS[session.config.layout].count;
    if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(sequence)||sequence<0||sequence===Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(startFrame)||startFrame<0||!Number.isSafeInteger(frames)||frames<1||!Number.isSafeInteger(startFrame+frames)||bytes.byteLength!==frames*inputCount*4||bytes.byteLength>256*1024||!Number.isSafeInteger(droppedFrames)||droppedFrames<0||droppedFrames>192000*60)throw failure('Invalid or excessive PCM packet.');
    if(session.expectedSequence!==null&&sequence<session.expectedSequence)throw failure('PCM packets must arrive in increasing sequence order.','SEQUENCE_ERROR');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let index=0;index<frames*inputCount;index++){const value=view.getFloat32(index*4,true);if(!Number.isFinite(value)||Math.abs(value)>1e6)throw failure('PCM contains a nonfinite or unreasonable sample.');}
    const matrix=conversionMatrix(session.config.inputLayout,session.config.layout);
    const raw16=session.profile.id==='s16le'&&!session.child,encoded=Buffer.allocUnsafe(frames*outputCount*(raw16?2:4));
    for(let frame=0;frame<frames;frame++)for(let channel=0;channel<outputCount;channel++){
      let value=0;for(let source=0;source<inputCount;source++)value+=view.getFloat32((frame*inputCount+source)*4,true)*matrix[channel][source];
      if(raw16){value=Math.max(-1,Math.min(1,value));encoded.writeInt16LE(Math.round(value*(value<0?32768:32767)),(frame*outputCount+channel)*2);}
      else encoded.writeFloatLE(value,(frame*outputCount+channel)*4);
    }
    if(session.expectedSequence!==null&&sequence>session.expectedSequence)session.stats.sequenceGaps+=sequence-session.expectedSequence;
    if(session.expectedFrame!==null&&startFrame!==session.expectedFrame)session.stats.frameDiscontinuities++;
    session.expectedSequence=sequence+1;session.expectedFrame=startFrame+frames;session.stats.receivedFrames+=frames;session.stats.receivedPackets++;session.stats.reportedDroppedFrames+=droppedFrames;
    this._touch(session);
    if(session.child){
      if(session.child.stdin.destroyed||session.child.stdin.writableLength+encoded.length>2*1024*1024){session.stats.droppedFrames+=frames;return{accepted:false,...this.status()};}
      session.child.stdin.write(encoded);
    }else this._enqueue(session,encoded);
    return{accepted:true,...this.status()};
  }
  _enqueue(session,bytes){
    if(session.closed)return;
    const frameBytes=CHANNEL_LAYOUTS[session.config.layout].count*(session.profile.id==='s16le'?2:4);
    const packetBytes=session.profile.raw?Math.floor(1316/frameBytes)*frameBytes:1316;
    // Keep at most one small remainder and a fixed number of packets.
    const all=session.pending.length?Buffer.concat([session.pending,bytes]):bytes;
    let offset=0;
    for(;offset+packetBytes<=all.length;offset+=packetBytes){
      if(session.packets.length>=128){session.stats.udpDroppedPackets++;continue;}
      session.packets.push(Buffer.from(all.subarray(offset,offset+packetBytes)));
    }
    session.pending=Buffer.from(all.subarray(offset));this._send(session);
  }
  _send(session){
    if(session.closed||session.sending||!session.packets.length)return;
    session.sending=true;const bytes=session.packets.shift();
    try{session.socket.send(bytes,error=>{session.sending=false;if(error){this._fail(session,'UDP send: '+error.message);return;}session.stats.sentPackets++;session.stats.sentBytes+=bytes.length;this._send(session);});}
    catch(error){session.sending=false;this._fail(session,'UDP send: '+error.message);}
  }
  async stop({id}={}){
    const session=this.session;
    if(!id||session?.id===id)this.startController?.abort();
    if(!session)return this.status();
    if(id&&session.id!==id)throw failure('This stream ID is no longer active.','NOT_FOUND');
    if(session.stopPromise)return session.stopPromise;
    session.stopping=true;clearTimeout(session.idle);
    session.stopPromise=(async()=>{
      if(session.child){
        session.child.stdin.end();
        const timer=setTimeout(()=>session.child.kill('SIGKILL'),2000);
        await session.childDone;clearTimeout(timer);
      }
      if(session.pending.length){if(session.packets.length<128)session.packets.push(session.pending);else session.stats.udpDroppedPackets++;session.pending=Buffer.alloc(0);this._send(session);}
      const until=Date.now()+2000;
      while((session.packets.length||session.sending)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
      session.stats.udpDroppedPackets+=session.packets.length;session.packets.length=0;session.closed=true;
      try{session.socket.close();}catch{}
      this.last={...this.status(),active:false,error:session.error,encoderQueueBytes:0,udpQueuePackets:0};
      if(this.session===session)this.session=null;return this.status();
    })();return session.stopPromise;
  }
  async dispose(){this.closed=true;return this.stop();}
}
