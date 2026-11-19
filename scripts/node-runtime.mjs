/** Headless adapters: explicit byte aliases and bounded artifacts, never paths from scripts. */
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { CommandRuntime } from '../src/command-runtime.js';
import { MacroRunner, parseMacro, validateMacro } from '../src/macro.js';
import { FILE_COMMANDS } from '../src/file-commands.js';
import { LIVE_COMMANDS } from '../src/live-commands.js';
import { schema as S } from '../src/command-schema.js';
import { decodeAudioBytes, encodeAudioBytes, AUDIO_FORMATS } from './node-codecs.mjs';
import { UdpStreams, STREAM_COMMANDS } from './udp-streams.mjs';

const MAX_INPUT=256*1024*1024,MAX_OUTPUT=128*1024*1024;
const fail=(message,code='INVALID_ARGUMENT')=>Object.assign(new Error(message),{code});
export function safeArtifactStem(value){
  const text=String(value||'audio').normalize('NFKC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'-').replace(/^\.+|[. ]+$/g,'').trim().slice(0,100).replace(/[\uD800-\uDBFF]$/,'');
  return !text||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)?'audio':text;
}
function hasImport(ast){if(!ast||typeof ast!=='object')return false;if(ast.type==='CallExpression'&&ast.method==='file.import')return true;return Object.values(ast).some(value=>Array.isArray(value)?value.some(hasImport):value&&typeof value==='object'&&hasImport(value));}
export const NODE_MACRO_COMMANDS=[
  {method:'macro.validate',description:'Parse and preflight a text macro against this runtime.',schema:S.object({text:S.string(131072),variables:{type:'object'}},['text']),recordable:false},
  {method:'macro.run',description:'Run a bounded text macro in this editor. Completed operations remain applied if canceled.',schema:S.object({text:S.string(131072),variables:{type:'object'},limits:{type:'object'}},['text']),recordable:false},
  {method:'macro.cancel',description:'Cancel the active macro or batch between atomic commands.',schema:S.object({}),recordable:false},
  {method:'macro.status',description:'Read macro/batch progress without waiting for editing to finish.',schema:S.object({}),recordable:false},
  {method:'macro.batch',description:'Run supplied input aliases sequentially in separate editors, preserving this editor.',schema:S.object({text:S.string(131072),inputIds:S.array(S.string(80,1),128,1),continueOnError:S.boolean,variables:{type:'object'}},['text','inputIds']),recordable:false},
  {method:'macro.record.start',description:'Record successful semantic API operations as macro text.',schema:S.object({timing:S.boolean,portable:S.boolean}),recordable:false},
  {method:'macro.record.stop',description:'Finish and return the recorded macro text.',schema:S.object({}),recordable:false},
];
export class NodeWorkbench {
  constructor({editor=new AudioEditor(),destinations=[],outputSink=null,streams=null,getCapabilities}={}){
    this.editor=editor;this.inputs=new Map();this.inputBytes=0;this.artifacts=new Map();this.artifactBytes=0;this.outputSink=outputSink;this.usedNames=new Set();this.outputs=[];this.batchController=null;this.batchChild=null;this.batchResults=[];this.macroState={running:false,completedSteps:0};
    this.streams=streams||new UdpStreams({destinations,...(getCapabilities?{getCapabilities}:{})});
    this.runtime=new CommandRuntime({coreExecute:editor.execute.bind(editor),coreCommands:COMMANDS,getState:editor.getState.bind(editor)});
    for(const descriptor of LIVE_COMMANDS)this.runtime.register({...descriptor,available:false,unavailableReason:'This method needs the browser audio runtime. Use the published browser SDK/workbench.'},()=>{throw fail('Browser audio runtime required.','UNSUPPORTED_CAPABILITY');});
    for(const descriptor of FILE_COMMANDS)this.runtime.register({...descriptor,capabilities:['supplied.files'],requires:undefined},(params,context)=>descriptor.method==='file.import'?this.importFile(params,context):descriptor.method==='file.export'?this.exportFile(params,context):this.exportStems(params,context));
    for(const descriptor of STREAM_COMMANDS)this.runtime.register(descriptor,(params,context)=>this.streams.execute(descriptor.method,params,context));
    this.runner=new MacroRunner({execute:(method,params,context)=>this.runtime.execute(method,params,context),getCommands:()=>this.runtime.commands(),getContext:()=>({project:this.editor.getState(),inputs:this.aliases()})});
    for(const descriptor of NODE_MACRO_COMMANDS)this.runtime.register(descriptor,(params,context)=>this.macro(descriptor.method,params,context));
    this.runtime.register({method:'file.inputs',description:'List explicitly supplied input aliases.',schema:S.object({}),recordable:false},()=>this.aliases());
    this.runtime.register({method:'file.input.remove',description:'Forget one supplied input alias.',schema:S.object({input:S.string(80,1)},['input']),recordable:false},({input})=>{const entry=this.inputs.get(input);if(!entry)throw fail('Input alias not found.','NOT_FOUND');this.inputBytes-=entry.bytes.length;this.inputs.delete(input);return true;});
    this.runtime.register({method:'file.artifacts',description:'List retained export artifacts.',schema:S.object({}),recordable:false},()=>[...this.artifacts.values()].map(value=>this.artifactInfo(value)));
    this.runtime.register({method:'file.artifact.remove',description:'Release one retained export artifact.',schema:S.object({id:S.string(80,1)},['id']),recordable:false},({id})=>{const artifact=this.artifacts.get(id);if(!artifact)throw fail('Artifact not found.','NOT_FOUND');this.artifacts.delete(id);this.artifactBytes-=artifact.bytes.length;return true;});
  }
  execute(method,params,context){return this.runtime.execute(method,params,context);}
  commands(){return this.runtime.commands();}
  getState(){return this.editor.getState();}
  aliases(){return [...this.inputs.values()].map(entry=>({...entry.alias}));}
  supply(bytes,{name='input.wav',id=randomUUID(),copy=true}={}){
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_INPUT||this.inputBytes+bytes.length>MAX_INPUT||this.inputs.size>=128)throw fail('Supplied input aliases exceed 128 files or 256 MiB.','RESOURCE_LIMIT');
    if(typeof name!=='string'||!name.length||name.length>1024||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id)||this.inputs.has(id))throw fail('Input aliases need unique safe IDs and a filename.');
    const alias={id,name,stem:safeArtifactStem(name.replace(/\.[^.]+$/,'')),size:bytes.length};
    this.inputs.set(id,{alias,bytes:copy?bytes.slice():bytes});this.inputBytes+=bytes.length;return{...alias};
  }
  async importFile(params,context={}){
    context.signal?.throwIfAborted();const id=typeof params.input==='string'?params.input:params.input?.id,entry=this.inputs.get(id);
    if(!entry)throw fail('Supply the local file bytes as an explicit input alias first.','NOT_FOUND');
    const {bytes,alias}=entry,name=alias.name;
    let project,warnings=[],format;
    if(/\.json$/i.test(name))project=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    else {
      if(bytes[0]===0x50&&bytes[1]===0x4b){const {readProjectZip}=await import('../src/project-archive.js');const files=readProjectZip(bytes,{accept:path=>/\.(rpp|aup)$/i.test(path)});format=[...files.keys()].some(path=>/\.rpp$/i.test(path))?'reaper':'audacity';}
      else if(/\.rpp$/i.test(name))format='reaper';else if(/\.aup3?$/i.test(name))format='audacity';
      if(format){
        const files=new Map();for(const item of this.inputs.values()){if(files.has(item.alias.name))throw fail('Companion media filenames are ambiguous. Supply distinct aliases.');files.set(item.alias.name,item.bytes);}
        const imported=format==='reaper'?await(await import('../src/reaper.js')).importReaper(bytes,{name,files,decodeMedia:decodeAudioBytes}):await(await import('../src/audacity.js')).importAudacity(bytes,{name,files});
        project=imported.project;warnings=imported.warnings||[];
      }
    }
    context.signal?.throwIfAborted();
    if(project){await this.editor.execute('project.load',{project});return{input:id,name,project:true,warnings};}
    const audio=await decodeAudioBytes(bytes,{sampleRate:this.editor.getState().sampleRate});
    context.signal?.throwIfAborted();
    const clip={audio,name:params.name||name,trackId:params.trackId,start:params.start};let result;
    if(params.replace){
      const results=await this.editor.execute('recipe.run',{commands:[{method:'project.new',params:{name:alias.stem,sampleRate:this.editor.getState().sampleRate,outputLayout:this.editor.getState().outputLayout}},{method:'clip.add',params:{...clip,trackId:undefined}}]});result=results.at(-1);
    }else result=await this.editor.execute('clip.add',clip);
    return{input:id,name,clipId:result.clipId,clipIds:[result.clipId],trackId:result.trackId,warnings};
  }
  artifactInfo(value){return{id:value.id,name:value.name,mime:value.mime,ext:value.ext,bytes:value.bytes.length,warnings:value.warnings||[],url:'/v1/artifacts/'+value.id};}
  uniqueName(stem,ext){const base=safeArtifactStem(stem);let name=base+'.'+ext,index=2;while(this.usedNames.has(name.toLowerCase()))name=base.slice(0,90)+' ('+(index++)+').'+ext;this.usedNames.add(name.toLowerCase());return name;}
  async emit(result,name,context={}){
    context.signal?.throwIfAborted();if(!(result.bytes instanceof Uint8Array)||!result.bytes.length)throw fail('Encoder returned no file.','ENCODER_FAILED');
    if(this.usedNames.size>=4096)throw fail('This workbench reached its 4096-export limit. Start a new job.','RESOURCE_LIMIT');
    const filename=this.uniqueName(name,result.ext),artifact={...result,id:randomUUID(),name:filename};
    if(this.outputSink){await this.outputSink(artifact,context);const info=this.artifactInfo(artifact);delete info.url;this.outputs.push(info);return info;}
    if(this.artifacts.size>=128||this.artifactBytes+artifact.bytes.length>MAX_OUTPUT)throw fail('Retained outputs exceed 128 files or 128 MiB. Download/remove artifacts or use a CLI output sink.','RESOURCE_LIMIT');
    this.artifacts.set(artifact.id,artifact);this.artifactBytes+=artifact.bytes.length;const info=this.artifactInfo(artifact);this.outputs.push(info);return info;
  }
  async renderFile(params={},context={}){
    context.signal?.throwIfAborted();const state=this.editor.getState(),scope=params.scope||'mix',format=params.format||'wav';
    if(params.live)throw fail('Live-rack render requires the browser live runtime.','UNSUPPORTED_CAPABILITY');
    let result;
    if(['session','aup3','aup','reaper'].includes(format)){
      if(!['mix','track'].includes(scope))throw fail('Editable projects support full-session or one-track scope.');
      const project=await this.editor.execute(scope==='track'?'project.saveTrack':'project.save',scope==='track'?{trackId:params.trackId||state.selectedTrackId}:{});
      if(format==='session')result={bytes:new TextEncoder().encode(JSON.stringify(project)),mime:'application/json',ext:'websoundedit.json'};
      else if(format==='reaper')result=await(await import('../src/reaper.js')).exportReaper(project,{format:'zip'});
      else result=await(await import('../src/audacity.js')).exportAudacity(project,{format,multichannel:params.multichannel||'reject'});
    }else{
      const info=AUDIO_FORMATS[format];if(!info)throw fail('Unsupported native export format.');
      const render={scope};for(const key of ['trackId','clipId','start','end','raw','respectMute','respectSolo','outputLayout'])if(params[key]!==undefined)render[key]=params[key];
      const audio=await this.editor.execute('audio.render',render);context.signal?.throwIfAborted();
      result={bytes:await encodeAudioBytes(audio,{...params,float:params.bitDepth===32,format,metadata:state.metadata||{}}),mime:info.mime,ext:info.extension,warnings:[]};
    }
    context.signal?.throwIfAborted();return result;
  }
  async exportFile(params={},context={}){
    const state=this.editor.getState(),track=state.tracks.find(item=>item.id===(params.trackId||state.selectedTrackId));
    return this.emit(await this.renderFile(params,context),params.name||(params.scope==='track'?track?.name:state.name),context);
  }
  async exportStems(params={},context={}){
    if(['session','aup','aup3','reaper'].includes(params.format))throw fail('Choose an audio format for stems.');
    const state=this.editor.getState(),ids=params.trackIds||state.tracks.filter(track=>track.clips.length).map(track=>track.id);
    if(!ids.length||ids.length>64||new Set(ids).size!==ids.length||ids.some(id=>!state.tracks.some(track=>track.id===id)))throw fail('Choose one to 64 existing distinct tracks.');
    const files=Object.create(null),used=new Set();let total=0;
    for(const trackId of ids){
      const track=state.tracks.find(item=>item.id===trackId),result=await this.renderFile({...params,scope:'track',trackId,start:0,...(params.align===false?{}:{end:state.duration}),respectMute:params.respectMute===true,respectSolo:params.respectSolo===true},context);
      if((total+=result.bytes.length)>MAX_OUTPUT)throw fail('Stem files exceed 128 MiB. Export fewer tracks.','RESOURCE_LIMIT');
      let name=safeArtifactStem(track.name)+'.'+result.ext,number=2;while(used.has(name.toLowerCase()))name=safeArtifactStem(track.name)+' ('+(number++)+').'+result.ext;used.add(name.toLowerCase());files[name]=result.bytes;
    }
    const bytes=zipSync(files,{level:0});if(bytes.length>MAX_OUTPUT)throw fail('Stem ZIP exceeds 128 MiB.','RESOURCE_LIMIT');
    return this.emit({bytes,mime:'application/zip',ext:'zip'},params.name||state.name+'-stems',context);
  }
  async macro(method,params,context={}){
    if(method==='macro.cancel'){this.runner.cancel();this.batchController?.abort();this.batchChild?.runner.cancel();return{cancelRequested:true};}
    if(method==='macro.status')return{...this.macroState,batch:!!this.batchController,results:this.batchResults,recorder:this.runtime.recorder.getState()};
    if(method==='macro.record.start')return this.runtime.recorder.start(params);
    if(method==='macro.record.stop')return this.runtime.recorder.stop();
    if(method==='macro.validate')return validateMacro(parseMacro(params.text),this.commands());
    if(method==='macro.batch')return this.batch(params,context);
    if(this.batchController||this.runner.controller)throw fail('A macro or batch is already running.','MACRO_BUSY');
    this.macroState={running:true,completedSteps:0};
    try{return await this.runner.run(params.text,{variables:params.variables||{},limits:params.limits||{},signal:context.signal,onEvent:event=>{this.macroState={...this.macroState,...event,running:!['complete','error'].includes(event.type)};}});}
    finally{this.macroState.running=false;}
  }
  async batch({text,inputIds,continueOnError=false,variables={}},context={}){
    if(this.batchController||this.runner.controller)throw fail('A macro or batch is already running.','MACRO_BUSY');
    const ast=parseMacro(text),validation=validateMacro(ast,this.commands());
    if(!validation.valid)throw fail(validation.errors[0].message,'MACRO_INVALID');
    if(new Set(inputIds).size!==inputIds.length||inputIds.some(id=>!this.inputs.has(id)))throw fail('Batch input aliases must exist and be distinct.');
    const controller=new AbortController();this.batchController=controller;this.batchResults=[];const abort=()=>controller.abort();context.signal?.addEventListener('abort',abort,{once:true});if(context.signal?.aborted)abort();
    const automaticallyImport=!hasImport(ast),original=this.editor.getState();let outputs=0;
    try{
      for(const id of inputIds){
        controller.signal.throwIfAborted();const entry=this.inputs.get(id),beforeOutputs=this.outputs.length;
        const child=new NodeWorkbench({editor:new AudioEditor({sampleRate:original.sampleRate,outputLayout:original.outputLayout}),outputSink:async artifact=>{const suffix='.'+artifact.ext,stem=artifact.name.endsWith(suffix)?artifact.name.slice(0,-suffix.length):artifact.name;await this.emit(artifact,stem,{signal:controller.signal});}});
        this.batchChild=child;
        try{
          // Immutable bytes are shared with the isolated editor, not multiplied.
          for(const input of this.inputs.values())child.supply(input.bytes,{name:input.alias.name,id:input.alias.id,copy:false});
          if(automaticallyImport)await child.runtime.execute('file.import',{input:id},{origin:'batch',record:false,signal:controller.signal});
          await child.runner.run(text,{variables:{...variables,input:entry.alias,file:entry.alias,inputs:[entry.alias]},signal:controller.signal,onEvent:event=>{this.macroState={...event,running:true,input:id};}});
          this.batchResults.push({id,name:entry.alias.name,success:true,outputs:this.outputs.slice(beforeOutputs)});
        }catch(error){this.batchResults.push({id,name:entry.alias.name,success:false,error:{message:error.message,code:error.code||'COMMAND_FAILED',completedSteps:error.completedSteps||0},outputs:this.outputs.slice(beforeOutputs)});if(!continueOnError||controller.signal.aborted)throw error;}
        finally{await child.dispose();this.batchChild=null;outputs+=this.outputs.length-beforeOutputs;}
      }
      return{results:this.batchResults,outputCount:outputs};
    }finally{context.signal?.removeEventListener('abort',abort);this.batchController=null;this.macroState.running=false;}
  }
  async dispose(){this.runner.cancel();this.batchController?.abort();await this.batchChild?.dispose();await this.streams.dispose();this.runtime.dispose();this.inputs.clear();this.artifacts.clear();this.inputBytes=0;this.artifactBytes=0;}
}
