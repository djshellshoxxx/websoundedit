import { normalizeRackChain } from './rack-config.js';
import { LIVE_LIMITS, validateLiveGraphs, normalizeAutomation, parameterDefinition } from './realtime-dsp.js';
export { LIVE_LIMITS } from './realtime-dsp.js';
const error=(message,code='RESOURCE_LIMIT')=>Object.assign(new Error(message),{code});
export class RealtimeRackManager {
  constructor(context,{channels=2,layout='stereo',nodeFactory,loadModule}={}){this.context=context;this.channels=channels;this.layout=layout;this.graphs=new Map();this.voices=new Map();this.voiceBytes=0;this.nextVoice=0;this.nodeFactory=nodeFactory;this.loadModule=loadModule;this.ready=null;this.disposed=false;this.clock={audioTime:0,timelineTime:0,rate:1,playing:false};this.bpm=120;}
  async init(){
    if(this.disposed)throw error('Live graphs have been disposed.','DISPOSED');
    if(!this.ready)this.ready=(async()=>{if(this.loadModule)return this.loadModule(this.context);if(!this.context.audioWorklet||!globalThis.AudioWorkletNode)throw error('AudioWorklet is unavailable in this browser.','UNSUPPORTED');const module=await import('./rack-worklet.js?worker&url');await this.context.audioWorklet.addModule(module.default);})();
    try{await this.ready;if(this.disposed)throw error('Live graphs have been disposed.','DISPOSED');}catch(e){this.ready=null;throw e;}
  }
  budget(candidate){return validateLiveGraphs(candidate||[...this.graphs.values()].map(g=>({id:g.id,chain:g.chain,automation:g.automation})),{sampleRate:this.context.sampleRate,channels:this.channels});}
  _send(graph,message){
    if(this.disposed)return Promise.reject(error('Live graphs have been disposed.','DISPOSED'));
    if(graph.pending.size>=64)return Promise.reject(error('Live graph control queue is full.'));
    return new Promise((resolve,reject)=>{const id=++graph.nextId,timer=setTimeout(()=>{graph.pending.delete(id);reject(error('The audio worklet did not acknowledge this change.','WORKLET_TIMEOUT'));},5000);graph.pending.set(id,{resolve,reject,timer,method:message.method});try{graph.node.port.postMessage({id,...message});}catch(e){clearTimeout(timer);graph.pending.delete(id);reject(e);}});
  }
  async setChain(id,chain){
    if(this.disposed)throw error('Live graphs have been disposed.','DISPOSED');
    const normalized=normalizeRackChain(chain),old=this.graphs.get(id),automation=old?.automation?.filter(lane=>normalized.some(stage=>stage.id===lane.slotId&&stage.effect===old.chain.find(previous=>previous.id===lane.slotId)?.effect))||[];
    this.budget([...this.graphs.values()].filter(g=>g.id!==id).map(g=>({id:g.id,chain:g.chain,automation:g.automation})).concat({id,chain:normalized,automation}));
    if(old){await this._send(old,{method:'chain',chain:normalized});old.chain=normalized;old.automation=automation;return old.node;}
    await this.init();const node=this.nodeFactory?this.nodeFactory(this.context,{channels:this.channels,chain:normalized,bpm:this.bpm}):new AudioWorkletNode(this.context,'websoundedit-rack',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[this.channels],channelCount:this.channels,channelCountMode:'explicit',channelInterpretation:'discrete',processorOptions:{channels:this.channels,chain:normalized,bpm:this.bpm}});
    const graph={id,node,chain:normalized,automation:[],pending:new Map(),nextId:0,queuedEvents:0};
    node.port.onmessage=({data})=>{if(Number.isSafeInteger(data?.queuedEvents)&&data.queuedEvents>=0)graph.queuedEvents=data.queuedEvents;const pending=graph.pending.get(data?.id);if(!pending)return;clearTimeout(pending.timer);graph.pending.delete(data.id);if(data.error)pending.reject(error(data.error.message,data.error.code));else{if(pending.method==='parameter'&&data.queuedEvents===undefined)graph.queuedEvents++;pending.resolve(true);}};
    this.graphs.set(id,graph);
    try{await this._send(graph,{method:'clock',clock:this.clock,bpm:this.bpm});return node;}catch(e){this.remove(id);throw e;}
  }
  async setAutomation(id,lanes){const graph=this.graphs.get(id);if(!graph)throw error('Create the live rack first.','NOT_FOUND');const normalized=normalizeAutomation(lanes,graph.chain);const budget=this.budget([...this.graphs.values()].map(g=>({id:g.id,chain:g.chain,automation:g.id===id?normalized:g.automation})));if(budget.automationPoints+this.queuedEventCount()>LIVE_LIMITS.automationPoints)throw error('Aggregate automation queue is full.');await this._send(graph,{method:'automation',lanes:normalized});graph.automation=normalized;}
  queuedEventCount(){return [...this.graphs.values()].reduce((sum,graph)=>sum+graph.queuedEvents+[...graph.pending.values()].filter(entry=>entry.method==='parameter').length,0);}
  async setParameter(id,event){
    const graph=this.graphs.get(id),stage=graph?.chain.find(s=>s.id===event.slotId);if(!stage)throw error('Effect stage does not exist.','NOT_FOUND');const field=parameterDefinition(stage,event.param);
    if(!Number.isFinite(event.value)||event.value<field.min||event.value>field.max||(field.integer&&!Number.isInteger(event.value)))throw new RangeError('Parameter value is outside its range.');
    const count=this.queuedEventCount()+[...this.graphs.values()].reduce((n,g)=>n+g.automation.reduce((sum,lane)=>sum+lane.points.length,0),0);if(count>=LIVE_LIMITS.automationPoints)throw error('Aggregate automation queue is full.');
    await this._send(graph,{method:'parameter',event});if(event.param==='wet')stage.wet=event.value;else stage.params[event.param]=event.value;
  }
  setClock(clock,bpm=this.bpm){this.clock={...this.clock,...clock};this.bpm=bpm;for(const graph of this.graphs.values())graph.node.port.postMessage({method:'clock',clock:this.clock,bpm,id:0});}
  reserveVoice(bytes=0){if(!Number.isSafeInteger(bytes)||bytes<0||this.voices.size>=LIVE_LIMITS.voices||this.voiceBytes+bytes>LIVE_LIMITS.voiceBytes)throw error('The shared live voice/count PCM limit has been reached.');const id=++this.nextVoice;this.voices.set(id,bytes);this.voiceBytes+=bytes;let released=false;return()=>{if(!released){released=true;this.voiceBytes-=this.voices.get(id)||0;this.voices.delete(id);}};}
  snapshot(){return [...this.graphs.values()].map(g=>({id:g.id,chain:structuredClone(g.chain),automation:structuredClone(g.automation)}));}
  remove(id){const graph=this.graphs.get(id);if(!graph)return;for(const pending of graph.pending.values()){clearTimeout(pending.timer);pending.reject(error('Live graph was removed.','DISPOSED'));}graph.pending.clear();try{graph.node.port.postMessage({method:'dispose',id:0});graph.node.port.close?.();graph.node.disconnect();}catch{}this.graphs.delete(id);}
  dispose(){if(this.disposed)return;this.disposed=true;for(const id of [...this.graphs.keys()])this.remove(id);this.voices.clear();this.voiceBytes=0;}
}
