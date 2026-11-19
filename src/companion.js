/** Browser-to-loopback companion bridge. Credentials and arming are memory-only. */
import { schema as S, validateCommandParams } from './command-schema.js';
export const COMPANION_COMMANDS=[
  {method:'stream.start',label:'Broadcast live input',category:'Streaming',description:'Send an already acquired live input through the explicitly connected local UDP companion.',schema:S.object({destination:S.string(64,1),profile:S.enum('s16le','f32le','opus','mp3','aac-ts','flac'),sampleRate:S.integer(8000,192000),layout:S.enum('mono','stereo','5.1','7.1'),bitrate:S.integer(16,512)},['destination','profile']),recordable:true,capabilities:['browser.live-input','companion.udp']},
  {method:'stream.stop',label:'Stop broadcast',category:'Streaming',description:'Stop this broadcast, flush bounded queued audio, and release its encoder/socket.',schema:S.object({}),recordable:true,capabilities:['companion.udp']},
  {method:'stream.status',label:'Broadcast status',category:'Streaming',description:'Read actual profile, format, packet loss and bounded queue counters.',schema:S.object({}),recordable:false,capabilities:['companion.udp']},
];
const fail=(message,code='COMPANION_ERROR')=>Object.assign(new Error(message),{code});
const inputActive=input=>Boolean(input&&(input.active??input.status==='active'));
export function companionURL(value){
  if(typeof value!=='string'||value.length>200)throw fail('Enter a loopback companion URL.','INVALID_ARGUMENT');
  let url;try{url=new URL(value);}catch{throw fail('Enter a valid companion URL.','INVALID_ARGUMENT');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw fail('Use http://127.0.0.1:PORT or http://localhost:PORT without credentials, paths or query strings.','INVALID_ARGUMENT');
  return url.origin;
}
async function boundedJSON(response){
  const reader=response.body?.getReader();let text='';
  if(reader){let size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw fail('Companion response exceeded 64 KiB.','RESOURCE_LIMIT');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
  else{ text=await response.text();if(text.length>65536)throw fail('Companion response exceeded 64 KiB.','RESOURCE_LIMIT');}
  let data;try{data=JSON.parse(text);}catch{throw fail('The companion returned an invalid JSON response.');}
  if(!response.ok)throw fail(data?.error?.message||'Companion request failed.',data?.error?.code||'COMPANION_ERROR');
  return data;
}
export class CompanionBridge extends EventTarget {
  #token='';
  constructor({live,fetchImpl=globalThis.fetch?.bind(globalThis)}={}){
    super();this.live=live;this.fetch=fetchImpl;this.url='';this.connected=false;this.connecting=false;this.capabilities={destinations:[],profiles:[]};this.stream={active:false};
    this.queue=[];this.requests=new Set();this.pumping=null;this.stopPromise=null;this.startController=null;this.unsubscribe=null;this.localDroppedFrames=0;this.error=null;this.generation=0;this.lastEmit=0;
    this.inputState=()=>{if(this.stream.active&&!inputActive(this.live.getState()?.input))void this.stop().catch(error=>{this.error=error.message;this._emit();});};
    live?.addEventListener?.('state',this.inputState);
  }
  getState(){return{connected:this.connected,url:this.url,capabilities:structuredClone(this.capabilities),stream:{...this.stream,localDroppedFrames:this.localDroppedFrames,queuedChunks:this.queue.length},error:this.error};}
  _emit(force=true){const now=Date.now();if(force||now-this.lastEmit>=250){this.lastEmit=now;this.dispatchEvent(new CustomEvent('state',{detail:this.getState()}));}}
  async _request(path,{method='GET',body,signal,timeout=5000}={}){
    if(!this.#token||!this.url)throw fail('Connect the local companion first.','PERMISSION_REQUIRED');
    const controller=new AbortController();this.requests.add(controller);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const binary=body instanceof Uint8Array;
      const response=await this.fetch(this.url+path,{method,headers:{Authorization:'Bearer '+this.#token,...(body!==undefined?{'Content-Type':binary?'application/octet-stream':'application/json'}:{})},body:body===undefined?undefined:binary?body:JSON.stringify(body),signal:controller.signal,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',targetAddressSpace:'loopback'});
      const data=await boundedJSON(response);
      if(controller.signal.aborted)throw fail('Companion request canceled or timed out.','ABORTED');
      return data;
    }catch(error){if(controller.signal.aborted)throw fail('Companion request canceled or timed out.','ABORTED');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.requests.delete(controller);}
  }
  async connect({url='http://127.0.0.1:8787',token}={}){
    if(this.connecting)throw fail('A companion connection is already in progress.','BUSY');
    const normalized=companionURL(url);
    if(typeof token!=='string'||token.length<24||token.length>512||!/^[A-Za-z0-9_-]+$/.test(token))throw fail('Paste the Bearer token printed by the local companion.','INVALID_ARGUMENT');
    this.connecting=true;
    try{
      const generation=this.generation+1;await this.disconnect();
      if(generation!==this.generation)throw fail('Connection was canceled.','ABORTED');
      this.url=normalized;this.#token=token;this.error=null;
      const result=await this._request('/v1/capabilities'),caps=result.streaming;
      if(!caps||!Array.isArray(caps.destinations)||caps.destinations.length>16||!Array.isArray(caps.profiles)||caps.profiles.length>16)throw fail('This companion does not advertise the 1.0 streaming API.');
      if(generation!==this.generation)throw fail('Connection was canceled.','ABORTED');
      this.capabilities=caps;this.connected=true;this._emit();return this.getState();
    }catch(error){this.#token='';this.connected=false;this.capabilities={destinations:[],profiles:[]};this.error=error.message;this._emit();throw error;}
    finally{this.connecting=false;}
  }
  async disconnect(){
    this.generation++;
    try{if(this.stream.active||this.starting||this.stopPromise)await this.stop();}catch{}
    this.unsubscribe?.();this.unsubscribe=null;this.queue.length=0;
    for(const controller of this.requests)controller.abort();
    this.#token='';this.connected=false;this.capabilities={destinations:[],profiles:[]};this.stream={active:false};this.error=null;this._emit();return this.getState();
  }
  async execute(method,params={},context={}){
    const descriptor=COMPANION_COMMANDS.find(item=>item.method===method);if(!descriptor)throw fail('Unknown streaming command.','UNKNOWN_COMMAND');
    validateCommandParams(params,descriptor);
    if(method==='stream.start')return this.start(params,context);
    if(method==='stream.stop')return this.stop();
    if(this.connected){const generation=this.generation,result=await this._request('/v1/execute',{method:'POST',body:{method:'stream.status',params:{}},signal:context.signal});if(generation===this.generation&&this.connected){this.stream=result.result;this._emit();}}
    return this.getState();
  }
  async start(params,context={}){
    validateCommandParams(params,COMPANION_COMMANDS[0]);
    if(!this.connected)throw fail('Connect the local companion in Options → Streaming first.','PERMISSION_REQUIRED');
    if(this.stream.active||this.starting||this.stopPromise)throw fail('A broadcast is already active or changing state.','BUSY');
    const input=this.live?.getState()?.input;
    if(!inputActive(input)||!Number.isInteger(input.sampleRate)||!input.layout)throw fail('Start a microphone, instrument or system input first.','PERMISSION_REQUIRED');
    const generation=this.generation,controller=new AbortController(),abort=()=>controller.abort();
    this.starting=true;this.startController=controller;
    context.signal?.addEventListener('abort',abort,{once:true});if(context.signal?.aborted)abort();
    try{
      const result=await this._request('/v1/execute',{method:'POST',body:{method:'stream.start',params:{...params,inputSampleRate:input.sampleRate,inputLayout:input.layout}},signal:controller.signal});
      if(generation!==this.generation||!this.connected||controller.signal.aborted)throw fail('Broadcast startup was canceled.','ABORTED');
      if(!result.result?.active||typeof result.result.id!=='string')throw fail('The companion did not create an active stream.');
      this.stream=result.result;this.error=null;this.localDroppedFrames=0;
      if(!inputActive(this.live?.getState()?.input)){await this.stop();throw fail('The input stopped during broadcast startup.','ABORTED');}
      try{this.unsubscribe=this.live.subscribeInputPCM(chunk=>this._chunk(chunk),{framesPerChunk:1024,maxQueuedChunks:4});}
      catch(error){await this.stop().catch(()=>{});throw error;}
      this._emit();return this.getState();
    }finally{context.signal?.removeEventListener('abort',abort);if(this.startController===controller)this.startController=null;this.starting=false;}
  }
  _chunk(chunk){
    if(!this.stream.active)return;
    if(chunk.sampleRate!==this.stream.inputSampleRate||chunk.layout!==this.stream.inputLayout){this.error='Input format changed. Start a new broadcast for the new format.';void this.stop().catch(()=>{});return;}
    if(!(chunk.data instanceof Float32Array)||chunk.frames<1||chunk.frames>1024||chunk.data.length!==chunk.frames*chunk.channels){this.error='Live input supplied an invalid PCM chunk.';void this.stop().catch(()=>{});return;}
    if(this.queue.length>=4){this.localDroppedFrames+=chunk.frames;this._emit(false);return;}
    const bytes=new Uint8Array(chunk.data.length*4),view=new DataView(bytes.buffer);
    for(let i=0;i<chunk.data.length;i++)view.setFloat32(i*4,chunk.data[i],true);
    this.queue.push({bytes,sequence:chunk.sequence,startFrame:chunk.startFrame,frames:chunk.frames,droppedFrames:chunk.droppedFrames||0,id:this.stream.id});
    if(!this.pumping)this.pumping=this._pump().finally(()=>{this.pumping=null;});
  }
  async _pump(){
    while(this.queue.length&&this.connected){
      const chunk=this.queue.shift(),query=new URLSearchParams({sequence:String(chunk.sequence),startFrame:String(chunk.startFrame),frames:String(chunk.frames),droppedFrames:String(chunk.droppedFrames)});
      try{const generation=this.generation,result=await this._request('/v1/stream/'+encodeURIComponent(chunk.id)+'/pcm?'+query,{method:'POST',body:chunk.bytes});if(generation===this.generation&&this.stream.id===chunk.id)this.stream=result;this._emit(false);}
      catch(error){this.error=error.message;this.localDroppedFrames+=chunk.frames+this.queue.reduce((sum,item)=>sum+item.frames,0);this.queue.length=0;this.unsubscribe?.();this.unsubscribe=null;this.stream={...this.stream,active:false};this._emit();try{await this._request('/v1/execute',{method:'POST',body:{method:'stream.stop',params:{id:chunk.id}},timeout:2000});}catch{}break;}
    }
  }
  async stop(){
    if(this.stopPromise)return this.stopPromise;
    const id=this.stream.id,pendingStart=this.starting;this.startController?.abort();
    this.unsubscribe?.();this.unsubscribe=null;
    this.stopPromise=(async()=>{
      if(this.pumping)await this.pumping;
      this.queue.length=0;
      if((id||pendingStart)&&this.connected){const result=await this._request('/v1/execute',{method:'POST',body:{method:'stream.stop',params:id?{id}:{}}});this.stream={...result.result,active:false};}
      else this.stream={...this.stream,active:false};
      this._emit();return this.getState();
    })();
    try{return await this.stopPromise;}finally{this.stopPromise=null;}
  }
  async dispose(){await this.disconnect();this.live?.removeEventListener?.('state',this.inputState);}
}
