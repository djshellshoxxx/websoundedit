/** SDK composition with shared resource ownership and no automatic permissions. */
import { AudioEditor, COMMANDS } from './engine.js';
import { CommandRuntime } from './command-runtime.js';
import { LiveAudioRuntime, LIVE_COMMANDS } from './live-audio.js';
import { CompanionBridge, COMPANION_COMMANDS } from './companion.js';
export function createCoreRuntime({engine=new AudioEditor()}={}){
  const runtime=new CommandRuntime({coreExecute:engine.execute.bind(engine),coreCommands:COMMANDS,getState:engine.getState.bind(engine)});
  runtime.engine=engine;return runtime;
}
export function createBrowserRuntime({engine=new AudioEditor(),playback,...liveOptions}={}){
  // Forward state from direct in-process editors as well as worker clients.
  const facade=new EventTarget();facade.getState=()=>engine.getState();
  facade.execute=async(method,params)=>{
    const result=await engine.execute(method,params);
    facade.dispatchEvent(new CustomEvent('state',{detail:{method,state:engine.getState()}}));return result;
  };
  const live=new LiveAudioRuntime({...liveOptions,engine:facade,...(playback?{playback}:{})}),companion=new CompanionBridge({live});
  const coreExecute=async(method,params)=>{
    const steps=method==='recipe.run'?(params.commands||params.steps||params.recipe?.commands||params.recipe?.steps||params.recipe):null;
    const replacement=['project.new','project.load'].includes(method)||Array.isArray(steps)&&steps.some(step=>['project.new','project.load'].includes(step.method));
    let settings;
    const preflight=project=>{const parsed=typeof project==='string'?JSON.parse(project):project;return live.validateSettings(parsed?.settings?.live||{version:1,racks:{}},{project:parsed});};
    if(method==='project.load')settings=preflight(params.project);
    if(Array.isArray(steps))for(const step of steps)if(step.method==='project.load')preflight(step.params?.project);
    if(replacement){await companion.disconnect();await live.resetProject();}
    const result=await facade.execute(method,params);
    if(settings)await live.loadSettings(settings);
    else if(replacement&&method==='recipe.run')await live.loadSettings(facade.getState().settings?.live||{version:1,racks:{}});
    if(['project.save','project.saveTrack'].includes(method)){
      const saved=live.getSettings();
      if(method==='project.saveTrack')saved.racks=Object.fromEntries(Object.entries(saved.racks).filter(([id])=>id==='master'||id===result.selectedTrackId));
      result.settings={...result.settings,live:saved};
    }
    return result;
  };
  const runtime=new CommandRuntime({coreExecute,coreCommands:COMMANDS,getState:facade.getState});
  const capabilities=live.capabilities();
  for(const descriptor of LIVE_COMMANDS)runtime.register({...descriptor,available:descriptor.capabilities.every(key=>capabilities[key]!==false)},(params,context)=>live.execute(descriptor.method,params,context));
  for(const descriptor of COMPANION_COMMANDS)runtime.register(descriptor,(params,context)=>companion.execute(descriptor.method,params,context));
  runtime.engine=facade;runtime.live=live;runtime.companion=companion;
  const dispose=runtime.dispose.bind(runtime);
  runtime.dispose=async()=>{dispose();try{await companion.dispose();}finally{await live.dispose();}};
  return runtime;
}
