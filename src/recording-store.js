import { CHANNEL_LAYOUTS, normalizeLayout } from './channel-layout.js';
import { writeStreamWav } from './wav-stream.js';
const ROOT='websoundedit-recordings-v1',MAX_RECORDS=1000,MAX_RANGE_BYTES=256*1024*1024;
const fail=(message,code='INVALID_ARGUMENT')=>{throw Object.assign(new Error(message),{code});};
const validId=id=>typeof id==='string'&&/^rec-[A-Za-z0-9-]{1,80}$/.test(id);
export function validateRecordingManifest(value,id=value?.id){
  if(!value||value.format!=='websoundedit-recording'||value.version!==1||!validId(id)||value.id!==id)fail('Invalid recording manifest.');
  normalizeLayout(value.layout);const channels=CHANNEL_LAYOUTS[value.layout].count;
  if(value.channels!==channels||!Number.isInteger(value.sampleRate)||value.sampleRate<8000||value.sampleRate>192000||!Number.isSafeInteger(value.frames)||value.frames<0||value.bytes!==value.frames*channels*4||!Number.isSafeInteger(value.bytes)||value.bytes>512*1024**3)fail('Invalid recording dimensions.');
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>200||!Number.isSafeInteger(value.generation)||value.generation<0||!['recording','paused','complete','interrupted','error'].includes(value.status)||typeof value.createdAt!=='string'||value.createdAt.length>40||!Number.isFinite(Date.parse(value.createdAt)))fail('Invalid recording metadata.');
  return structuredClone(value);
}
const info=manifest=>({...manifest,seconds:manifest.frames/manifest.sampleRate});
export class RecordingStore {
  constructor(root){this.root=root;this.active=null;this.directory=null;}
  async init(){return this.directory ||= await this.root.getDirectoryHandle(ROOT,{create:true});}
  async _directory(id,create=false){if(!validId(id))fail('Invalid recording ID.');return(await this.init()).getDirectoryHandle(id,{create});}
  async _manifest(directory,id){
    const candidates=[];
    for(const slot of [0,1])try{const file=await(await directory.getFileHandle(`manifest-${slot}.json`)).getFile();if(file.size>65536)continue;candidates.push(validateRecordingManifest(JSON.parse(await file.text()),id));}catch{}
    if(!candidates.length)fail('No valid recovery manifest was found.','CORRUPT_RECORDING');return candidates.sort((a,b)=>b.generation-a.generation)[0];
  }
  async _commit(active){active.manifest.generation++;const file=await active.directory.getFileHandle(`manifest-${active.manifest.generation%2}.json`,{create:true});const stream=await file.createWritable();try{await stream.write(JSON.stringify(active.manifest));await stream.close();}catch(error){await stream.abort?.();throw error;}}
  async start({name='Recording',sampleRate,layout='stereo',maxBytes=512*1024**3,maxSeconds=86400}={}){
    if(this.active)fail('A recording is already active.','BUSY');normalizeLayout(layout);
    if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000||typeof name!=='string'||!name.trim()||name.length>200||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>512*1024**3||!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>86400)fail('Invalid recording settings.');
    const existing=await this.list();if(existing.recordings.length>=MAX_RECORDS)fail('Recording archive is full.','RESOURCE_LIMIT');
    const id=`rec-${globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}`,directory=await this._directory(id,true),file=await directory.getFileHandle('audio.f32',{create:true});
    if(!file.createSyncAccessHandle){await(await this.init()).removeEntry(id,{recursive:true});fail('Disk-backed capture requires OPFS synchronous access in a storage worker.','UNSUPPORTED');}
    let handle;
    try{handle=await file.createSyncAccessHandle();const manifest={format:'websoundedit-recording',version:1,id,name:name.trim(),sampleRate,layout,channels:CHANNEL_LAYOUTS[layout].count,frames:0,bytes:0,status:'recording',generation:0,createdAt:new Date().toISOString(),maxBytes,maxSeconds};const active={directory,handle,manifest};await this._commit(active);this.active=active;return info(manifest);}catch(error){handle?.close();await(await this.init()).removeEntry(id,{recursive:true});throw error;}
  }
  async append(data){
    const active=this.active;if(!active||active.manifest.status!=='recording')fail('Recording is not accepting audio.','NOT_RECORDING');
    const manifest=active.manifest;if(!(data instanceof Float32Array)||data.length%manifest.channels||data.byteLength>8*1024*1024)fail('Invalid recording chunk.');
    for(const sample of data)if(!Number.isFinite(sample)||Math.abs(sample)>1e6)fail('Recording contains invalid PCM.');
    if(manifest.bytes+data.byteLength>manifest.maxBytes||manifest.frames+data.length/manifest.channels>manifest.maxSeconds*manifest.sampleRate){await this.stop('error');fail('Recording reached its configured capacity; the completed range is recoverable.','RECORDING_LIMIT');}
    try{
      const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength),written=active.handle.write(bytes,{at:manifest.bytes});if(written!==bytes.byteLength)throw new Error('Storage wrote only part of an audio chunk.');active.handle.flush();
      manifest.frames+=data.length/manifest.channels;manifest.bytes+=bytes.byteLength;await this._commit(active);return info(manifest);
    }catch(error){try{await this.stop('error');}catch{active.handle.close();this.active=null;}throw Object.assign(new Error(`Recording stopped after a storage failure: ${error.message}`),{code:'STORAGE_ERROR',recordingId:manifest.id});}
  }
  async pause(){if(!this.active)fail('No active recording.','NOT_RECORDING');this.active.manifest.status='paused';await this._commit(this.active);return info(this.active.manifest);}
  async resume(){if(!this.active)fail('No active recording.','NOT_RECORDING');this.active.manifest.status='recording';await this._commit(this.active);return info(this.active.manifest);}
  async stop(status='complete'){
    const active=this.active;if(!active)return null;this.active=null;active.manifest.status=status;
    try{active.handle.flush();await this._commit(active);}finally{active.handle.close();}return info(active.manifest);
  }
  async list(){const recordings=[],warnings=[];let count=0;for await(const[name,handle]of(await this.init()).entries()){if(++count>MAX_RECORDS*2){warnings.push('Archive listing limit reached.');break;}if(handle.kind!=='directory'||!validId(name))continue;try{recordings.push(info(await this._manifest(handle,name)));}catch(error){warnings.push(`${name}: ${error.message}`);}}return{recordings:recordings.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),warnings};}
  async recover(id){
    if(this.active?.manifest.id===id)fail('Stop the active recording before recovery.','BUSY');const directory=await this._directory(id),manifest=await this._manifest(directory,id),file=await(await directory.getFileHandle('audio.f32')).getFile();
    manifest.frames=Math.min(manifest.frames,Math.floor(file.size/(manifest.channels*4)));manifest.bytes=manifest.frames*manifest.channels*4;manifest.status='interrupted';await this._commit({directory,manifest});return info(manifest);
  }
  async _range(id,{start=0,end}={},bounded=true){
    if(this.active?.manifest.id===id)fail('Stop this recording before reading its committed archive.','BUSY');
    const directory=await this._directory(id),manifest=await this._manifest(directory,id);end??=manifest.frames/manifest.sampleRate;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>manifest.frames/manifest.sampleRate)fail('Choose a nonempty range within the recorded audio.');
    const first=Math.round(start*manifest.sampleRate),last=Math.round(end*manifest.sampleRate),frames=last-first;
    if(frames<1)fail('The recorded range must contain at least one complete sample frame.');
    if(bounded&&(frames/manifest.sampleRate>600||frames*manifest.channels*4>MAX_RANGE_BYTES))fail('Import or audition at most ten minutes and 256 MiB at once.','RESOURCE_LIMIT');
    const file=await(await directory.getFileHandle('audio.f32')).getFile();if(last*manifest.channels*4>file.size)fail('Recording payload is truncated. Recover it first.','CORRUPT_RECORDING');return{manifest,file,first,frames};
  }
  async readRange(id,range={}){const{manifest,file,first,frames}=await this._range(id,range),bytes=await file.slice(first*manifest.channels*4,(first+frames)*manifest.channels*4).arrayBuffer(),view=new DataView(bytes),channels=Array.from({length:manifest.channels},()=>new Float32Array(frames));for(let i=0;i<frames;i++)for(let c=0;c<channels.length;c++){const value=view.getFloat32((i*channels.length+c)*4,true);if(!Number.isFinite(value)||Math.abs(value)>1e6)fail('Recording contains invalid PCM.','CORRUPT_RECORDING');channels[c][i]=value;}return{sampleRate:manifest.sampleRate,layout:manifest.layout,channels};}
  async export(id,writable,range={},options={}){try{const{manifest,file,first,frames}=await this._range(id,range,false),block=manifest.channels*4;return await writeStreamWav({sampleRate:manifest.sampleRate,layout:manifest.layout,frames,read:async(at,count)=>new Uint8Array(await file.slice((first+at)*block,(first+at+count)*block).arrayBuffer())},writable,options);}catch(error){try{await writable.abort?.(error);}catch{}throw error;}}
  async delete(id){if(!validId(id))fail('Invalid recording ID.');if(this.active?.manifest.id===id)fail('Stop the active recording before deleting it.','BUSY');await(await this.init()).removeEntry(id,{recursive:true});return true;}
}
