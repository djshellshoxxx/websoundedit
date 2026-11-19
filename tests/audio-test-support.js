/** Synthetic Web Audio / OPFS fixtures. These do not claim physical device QA. */
export class MemoryFile {
  constructor(name,root){this.kind='file';this.name=name;this.root=root;this.bytes=new Uint8Array();}
  async getFile(){return new Blob([this.bytes]);}
  async createWritable(){let staged=this.bytes.slice();return{write:async value=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value instanceof Uint8Array?value:new Uint8Array(value);if(bytes.length>this.root.maxBytes)throw new DOMException('Synthetic quota exhausted','QuotaExceededError');staged=bytes.slice();},close:async()=>{this.bytes=staged;},abort:async()=>{}};}
  async createSyncAccessHandle(){const file=this;return{write(bytes,{at=0}={}){if(at+bytes.length>file.root.maxBytes)throw new DOMException('Synthetic quota exhausted','QuotaExceededError');const next=new Uint8Array(Math.max(file.bytes.length,at+bytes.length));next.set(file.bytes);next.set(bytes,at);file.bytes=next;return bytes.length;},flush(){},close(){},getSize(){return file.bytes.length;}};}
}
export class MemoryDirectory {
  constructor(name='root',root){this.kind='directory';this.name=name;this.root=root||this;this.maxBytes=Infinity;this.children=new Map();}
  async getDirectoryHandle(name,{create=false}={}){let child=this.children.get(name);if(!child&&create){child=new MemoryDirectory(name,this.root);this.children.set(name,child);}if(!child||child.kind!=='directory')throw new DOMException('Missing directory','NotFoundError');return child;}
  async getFileHandle(name,{create=false}={}){let child=this.children.get(name);if(!child&&create){child=new MemoryFile(name,this.root);this.children.set(name,child);}if(!child||child.kind!=='file')throw new DOMException('Missing file','NotFoundError');return child;}
  async removeEntry(name){this.children.delete(name);}
  async *entries(){yield*this.children.entries();}
}
export class AudioParamMock {
  constructor(){this.value=0;this.events=[];}
  setValueAtTime(value,time){this.value=value;this.events.push({value,time});}
  setTargetAtTime(value,time){this.value=value;this.events.push({value,time});}
  linearRampToValueAtTime(value,time){this.events.push({value,time});}
  exponentialRampToValueAtTime(value,time){this.events.push({value,time});}
  cancelScheduledValues(){}
}
export class AudioNodeMock {
  constructor(){this.gain=new AudioParamMock();this.frequency=new AudioParamMock();this.playbackRate=new AudioParamMock();this.connections=[];this.fftSize=2048;this.stops=[];}
  connect(node,...args){this.connections.push([node,...args]);return node;}
  disconnect(node){this.connections=node?this.connections.filter(entry=>entry[0]!==node):[];}
  start(...args){this.started=args;}
  stop(...args){this.stops.push(args);}
  getFloatTimeDomainData(buffer){buffer.fill(0);}
}
export class AudioContextMock {
  constructor({sampleRate=8000}={}){this.sampleRate=sampleRate;this.currentTime=0;this.state='running';this.destination={maxChannelCount:8,channelCount:2};this.sources=[];this.buffers=[];}
  async resume(){this.state='running';}async close(){this.state='closed';}async setSinkId(id){this.sinkId=id;}
  createGain(){return new AudioNodeMock();}createChannelSplitter(){return new AudioNodeMock();}createChannelMerger(){return new AudioNodeMock();}createAnalyser(){return new AudioNodeMock();}createOscillator(){return new AudioNodeMock();}createMediaStreamSource(){return new AudioNodeMock();}
  createBuffer(count,length,sampleRate){const channels=Array.from({length:count},()=>new Float32Array(length)),buffer={length,sampleRate,duration:length/sampleRate,numberOfChannels:count,copyToChannel(data,c){channels[c].set(data);},getChannelData(c){return channels[c];}};this.buffers.push(buffer);return buffer;}
  createBufferSource(){const source=new AudioNodeMock();this.sources.push(source);return source;}
}
export const mediaTrack=(channels=1)=>({stopped:false,listeners:new Map(),stop(){this.stopped=true;},getSettings(){return{channelCount:channels,deviceId:'fixture-input',sampleRate:8000};},async applyConstraints(value){this.constraints=value;},addEventListener(type,fn){this.listeners.set(type,fn);}});
export const mediaStream=tracks=>({getTracks:()=>tracks,getAudioTracks:()=>tracks.filter(track=>!track.video)});
