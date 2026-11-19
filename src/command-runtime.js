/** One discoverable command surface for core, workbench and capability adapters. */
import { coreCommandDescriptors, validateCommandParams } from './command-schema.js';
import { ActionRecorder } from './macro-recorder.js';
const clock=()=>globalThis.performance?.now?.()??Date.now();
const methodPattern=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const fail=(message,code='INVALID_ARGUMENT')=>Object.assign(new Error(message),{code});
export class CommandRuntime {
  constructor({coreExecute,coreCommands=[],getState=()=>null,adapters=[]}={}){
    this.registry=new Map();this.listeners=new Set();this.getState=getState;this.recorder=new ActionRecorder();this.inFlight=0;this.disposed=false;
    if(coreCommands.length&&typeof coreExecute!=='function')throw new TypeError('Core commands require a coreExecute function.');
    for(const descriptor of coreCommandDescriptors(coreCommands))this.register(descriptor,(params,context)=>coreExecute(descriptor.method,params,context));
    this.register({method:'commands.list',description:'Discover commands and schemas available in this runtime.',schema:{type:'object',additionalProperties:false},recordable:false},()=>this.commands(),{replace:this.registry.has('commands.list')});
    for(const adapter of adapters){
      const commands=typeof adapter.commands==='function'?adapter.commands():adapter.commands||adapter.descriptors||[];
      for(const descriptor of commands)this.register(descriptor,(params,context)=>adapter.execute(descriptor.method||descriptor.id,params,context));
    }
  }
  register(descriptor,handler,{replace=false}={}){
    if(this.disposed)throw fail('The command runtime is disposed.','DISPOSED');
    const method=descriptor?.method||descriptor?.id;
    if(typeof method!=='string'||method.length>160||!methodPattern.test(method)||method.split('.').some(x=>['__proto__','prototype','constructor'].includes(x)))throw new TypeError('A command needs a valid method name.');
    if(typeof handler!=='function')throw new TypeError('A command needs a handler.');
    if(this.registry.has(method)&&!replace)throw new Error('Command already registered: '+method);
    const contract={
      ...descriptor,method,id:method,label:descriptor.label||method,category:descriptor.category||method.split('.')[0],
      description:descriptor.description||method,
      schema:descriptor.schema||descriptor.inputSchema||{type:'object',additionalProperties:true},
      returns:descriptor.returns||{description:'Command-specific result'},
      recordable:descriptor.recordable??true,undoable:descriptor.undoable??!!descriptor.mutates,
      capabilities:descriptor.capabilities||[],available:descriptor.available!==false,
    };
    this.registry.set(method,{descriptor:contract,handler});
    return ()=>{if(this.registry.get(method)?.handler===handler)this.registry.delete(method);};
  }
  commands(){return [...this.registry.values()].map(({descriptor})=>structuredClone(descriptor));}
  subscribe(listener){if(typeof listener!=='function')throw new TypeError('A command listener must be a function.');this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async execute(method,params={},options={}){
    if(this.disposed)throw fail('The command runtime is disposed.','DISPOSED');
    if(typeof method!=='string')throw fail('Command method must be a string.');
    const entry=this.registry.get(method);
    if(!entry)throw fail('Unknown command: '+method,'UNKNOWN_COMMAND');
    if(!entry.descriptor.available)throw fail(entry.descriptor.unavailableReason||'This capability is unavailable in this runtime: '+method,'UNSUPPORTED_CAPABILITY');
    if(options.signal?.aborted)throw fail('Command canceled before execution.','ABORTED');
    if(this.inFlight>=64)throw fail('The command runtime has 64 active operations.','RESOURCE_LIMIT');
    validateCommandParams(params,entry.descriptor);
    const origin=options.origin??'api';
    if(typeof origin!=='string'||origin.length>64)throw fail('Invalid command origin.');
    const state=this.getState?.();
    const context=state?{selectedTrackId:state.selectedTrackId,selectedClipId:state.selectedClipId,selection:state.selection?structuredClone(state.selection):null,bpm:state.bpm,sampleRate:state.sampleRate}:null;
    const startedAt=clock();this.inFlight++;
    try{
      const result=await entry.handler(params,{
        ...options,origin,runtime:this,
        execute:(nestedMethod,nestedParams,nestedOptions={})=>this.execute(nestedMethod,nestedParams,{...options,...nestedOptions,origin:'internal',record:false}),
      });
      const event={method,params,descriptor:entry.descriptor,origin,record:options.record!==false,context,result,startedAt,completedAt:clock()};
      this.recorder.capture(event);
      for(const listener of this.listeners){try{listener(event);}catch{/* Observers cannot turn a completed edit into a reported failure. */}}
      return result;
    }catch(error){
      if(error&&typeof error==='object'){if(!error.command)error.command=method;throw error;}
      throw fail(String(error),'COMMAND_FAILED');
    }finally{this.inFlight--;}
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.recorder.stop();this.listeners.clear();this.registry.clear();}
}
