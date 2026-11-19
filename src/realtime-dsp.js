/** Stateful block DSP shared by AudioWorklet and live-settings offline export.
 * No buffer allocations occur in process(). Configuration allocates only after
 * validation and admission; stable stage IDs retain their ring/filter history.
 */
import { normalizeRackChain, RACK_EFFECTS } from './rack-config.js';
export const LIVE_LIMITS = Object.freeze({ stateBytes: 64 * 1024 * 1024, graphs: 65, stages: 128, stagesPerRack: 12, voices: 128, voiceBytes: 256 * 1024 * 1024, automationPoints: 8192, blockFrames: 2048, captureBytes: 64 * 1024 * 1024, queuedRecordingBytes: 8 * 1024 * 1024 });
const TAU=2*Math.PI, REVERB_TIMES=[29.7,37.1,41.1,43.7], finite=x=>Math.max(-1e6,Math.min(1e6,Number.isFinite(x)?x:0));
const resource=message=>Object.assign(new RangeError(message),{code:'RESOURCE_LIMIT'});
const bounded=(n,min,max,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw new RangeError(`Invalid ${label}.`);return n;};
function dimensions(sampleRate,channels){bounded(sampleRate,8000,192000,'sample rate');if(!Number.isInteger(sampleRate)||![1,2,6,8].includes(channels))throw new RangeError('Invalid live audio dimensions.');}
const ring=(seconds,sr)=>new Float32Array(Math.ceil(seconds*sr)+4);
const msFrames=(ms,sr)=>Math.max(1,Math.round(ms*sr/1000));
const capacities={echo:12,delay:2,reverb:1,chorus:.081,flanger:.022,tape:.012,stutter:3};
export function estimateRackBytes(chain,sampleRate,channels){
  dimensions(sampleRate,channels);const normalized=normalizeRackChain(chain);
  return channels*LIVE_LIMITS.blockFrames*4*2+normalized.reduce((sum,stage)=>sum+channels*(Math.ceil((capacities[stage.effect]||0)*sampleRate)+256)*4+2048,0);
}
export function validateLiveGraphs(graphs,{sampleRate,channels}={}){
  if(!Array.isArray(graphs)||graphs.length>LIVE_LIMITS.graphs)throw resource('Too many live rack graphs.');
  let bytes=0,stages=0,points=0;const ids=new Set();
  for(const graph of graphs){if(typeof graph.id!=='string'||ids.has(graph.id))throw new TypeError('Live graph IDs must be unique.');ids.add(graph.id);stages+=graph.chain.length;bytes+=estimateRackBytes(graph.chain,sampleRate,channels);points+=(graph.automation||[]).reduce((sum,lane)=>sum+lane.points.length,0);}
  if(bytes>LIVE_LIMITS.stateBytes||stages>LIVE_LIMITS.stages||points>LIVE_LIMITS.automationPoints)throw resource('Live racks exceed the shared DSP memory, stage or automation budget.');
  return {bytes,stages,graphs:graphs.length,automationPoints:points};
}
export function parameterDefinition(stage,param){
  const field=param==='wet'?{key:'wet',min:0,max:1}:RACK_EFFECTS[stage.effect]?.fields.find(field=>field.key===param&&field.type!=='select');
  if(!field)throw new RangeError('Choose a numeric parameter of an existing effect.');return field;
}
function parameterValue(stage,param,value){const field=parameterDefinition(stage,param);bounded(value,field.min,field.max,param);if(field.integer&&!Number.isInteger(value))throw new RangeError(`${param} requires an integer.`);return value;}
export function normalizeAutomation(lanes,chain){
  if(!Array.isArray(lanes)||lanes.length>128)throw resource('Too many automation lanes.');
  let count=0;const keys=new Set();
  return lanes.map(lane=>{
    const stage=chain.find(stage=>stage.id===lane?.slotId),key=`${lane?.slotId}:${lane?.param}`;
    if(!stage||keys.has(key))throw new RangeError('Automation requires unique existing effect parameters.');keys.add(key);parameterDefinition(stage,lane.param);
    if(!Array.isArray(lane.points)||!lane.points.length||(count+=lane.points.length)>LIVE_LIMITS.automationPoints)throw resource('Automation requires 1–8192 total points.');
    let previous=-1;
    const points=lane.points.map(point=>{bounded(point.time,0,86400,'automation time');if(point.time<=previous)throw new RangeError('Automation times must increase.');previous=point.time;parameterValue(stage,lane.param,point.value);const curve=point.curve??'linear';if(!['step','linear'].includes(curve))throw new RangeError('Choose step or linear automation.');return{time:point.time,value:point.value,curve};});
    return{slotId:stage.id,param:lane.param,points};
  });
}
export function automationValue(lane,time,fallback){
  const points=lane.points;if(time<points[0].time)return fallback;
  let lo=0,hi=points.length-1;while(lo<hi){const middle=Math.ceil((lo+hi)/2);if(points[middle].time<=time)lo=middle;else hi=middle-1;}
  const point=points[lo],next=points[lo+1];return next&&point.curve==='linear'?point.value+(next.value-point.value)*(time-point.time)/(next.time-point.time):point.value;
}
function read(memory,frame,delay){const at=((frame-delay)%memory.length+memory.length)%memory.length,i=Math.floor(at),f=at-i;return memory[i]*(1-f)+memory[(i+1)%memory.length]*f;}
function makeStage(config,sr,count){
  const state={...config,params:{...config.params},frame:0,phase:0,channels:[],filter:null,filterKey:''};
  for(let c=0;c<count;c++){
    const channel={ring:capacities[config.effect]?ring(config.effect==='reverb'?.201:capacities[config.effect],sr):null,lp:0,z1:0,z2:0,last:0,held:0,x:new Float64Array(6),y:new Float64Array(6)};
    if(config.effect==='reverb'){channel.combs=[29.7,37.1,41.1,43.7].map((ms,i)=>ring((ms*1.45+c*(i+1)*.31)/1000+.001,sr));channel.combLow=new Float64Array(4);channel.allpass=[ring(.0051,sr),ring(.0017,sr)];}
    state.channels.push(channel);
  }
  return state;
}
function setValue(stage,param,value){if(param==='wet'){if(stage.effect==='stutter'&&stage.wet===0&&value>0)stage.frame=0;stage.wet=value;}else{if(stage.effect==='stutter'&&param==='division'&&stage.params.division!==value)stage.frame=0;stage.params[param]=value;}}
function updateFilter(stage,sr){
  const p=stage.params;if(stage.filterType===p.type&&stage.filterFrequency===p.frequency&&stage.filterQ===p.q)return;
  const w=TAU*Math.min(p.frequency,sr*.499)/sr,cos=Math.cos(w),alpha=Math.sin(w)/(2*p.q),a0=1+alpha;
  let b0,b1,b2;if(p.type==='lowpass'){b0=(1-cos)/2;b1=1-cos;b2=b0;}else if(p.type==='highpass'){b0=(1+cos)/2;b1=-(1+cos);b2=b0;}else if(p.type==='bandpass'){b0=alpha;b1=0;b2=-alpha;}else{b0=1;b1=-2*cos;b2=1;}
  // Reuse coefficient storage; initial allocation is part of configuration.
  const f=stage.filter;f[0]=b0/a0;f[1]=b1/a0;f[2]=b2/a0;f[3]=-2*cos/a0;f[4]=(1-alpha)/a0;stage.filterType=p.type;stage.filterFrequency=p.frequency;stage.filterQ=p.q;
}
function wetSample(stage,input,c,sr,bpm){
  const p=stage.params,s=stage.channels[c],frame=stage.frame;let output=input;
  switch(stage.effect){
    case'echo':{s.ring[frame%s.ring.length]=input;output=0;let gain=1;for(let repeat=1;repeat<=p.repeats;repeat++){output+=read(s.ring,frame,p.timeMs*sr/1000*repeat)*gain;gain*=p.decay;}break;}
    case'delay':{output=read(s.ring,frame,Math.max(1,p.timeMs*sr/1000));s.ring[frame%s.ring.length]=finite(input+output*p.feedback);break;}
    case'reverb':{
      s.ring[frame%s.ring.length]=input;const pre=p.predelayMs===0?input:read(s.ring,frame,p.predelayMs*sr/1000);output=0;
      for(let k=0;k<4;k++){const memory=s.combs[k],delay=msFrames(REVERB_TIMES[k]*(.55+p.room*.9)+c*(k+1)*.31,sr),value=read(memory,frame,delay);s.combLow[k]=value*(.95-p.damping*.9)+s.combLow[k]*(.05+p.damping*.9);memory[frame%memory.length]=finite(pre+s.combLow[k]*(.35+p.room*.59));output+=value*.25;}
      for(let k=0;k<2;k++){const memory=s.allpass[k],previous=read(memory,frame,msFrames(k?1.7:5.1,sr)),next=previous-.5*output;memory[frame%memory.length]=finite(output+.5*next);output=next;}break;
    }
    case'chorus':case'flanger':{const delay=((stage.effect==='flanger'?1:p.delayMs)+p.depthMs*(1+Math.sin(stage.phase)))*sr/1000;output=read(s.ring,frame,delay);s.ring[frame%s.ring.length]=finite(input+output*(p.feedback||0));break;}
    case'phaser':{const frequency=Math.min(sr*.4,700*2**((.5+.5*Math.sin(stage.phase)-.5)*4*p.depth)),t=Math.tan(Math.PI*frequency/sr),a=(t-1)/(t+1);output=input+s.last*p.feedback;for(let k=0;k<6;k++){const next=a*output+s.x[k]-a*s.y[k];s.x[k]=output;s.y[k]=next;output=next;}s.last=finite(output);break;}
    case'distortion':{const shaped=Math.tanh(input*p.drive)/Math.tanh(p.drive),coefficient=1-Math.exp(-TAU*Math.min(p.tone,sr*.45)/sr);s.lp+=coefficient*(shaped-s.lp);output=s.lp;break;}
    case'tremolo':output=input*(1-p.depth*(.5+.5*Math.sin(stage.phase)));break;
    case'filter':{const f=stage.filter;output=f[0]*input+s.z1;s.z1=f[1]*input-f[3]*output+s.z2;s.z2=f[2]*input-f[4]*output;break;}
    case'tape':{s.ring[frame%s.ring.length]=input;const seconds=frame/sr,delay=sr*(.006+.005*p.wow*Math.sin(TAU*.63*seconds)+.0004*p.flutter*Math.sin(TAU*7.1*seconds)),shaped=Math.tanh(read(s.ring,frame,delay)*p.drive)/Math.tanh(p.drive),coef=1-Math.exp(-TAU*Math.min(20000-p.warmth*17000,sr*.45)/sr);s.lp+=coef*(shaped-s.lp);output=s.lp;break;}
    case'stutter':{const length=Math.max(1,Math.round(sr*60/bpm/p.division)),at=frame%length,open=Math.max(1,Math.round(length*p.gate)),fade=Math.min(Math.floor(open/2),Math.round(p.fadeMs*sr/1000));if(frame<length)s.ring[at]=input;const envelope=at>=open?0:fade?Math.max(0,Math.min(1,at/fade,(open-1-at)/fade)):1;output=s.ring[at]*envelope;break;}
    case'bitcrusher':{if(frame%p.hold===0){const levels=2**(p.bits-1)-1;s.held=Math.round(input*levels)/levels;}output=s.held;break;}
  }
  return finite(output);
}
export class RealtimeRackDSP {
  constructor({sampleRate,channels,chain=[],bpm=120,maxBytes=LIVE_LIMITS.stateBytes}={}){
    dimensions(sampleRate,channels);this.sampleRate=sampleRate;this.channels=channels;this.bpm=bounded(bpm,20,400,'tempo');this.maxBytes=maxBytes;this.stages=[];this.lanes=[];this.events=[];this.eventIndex=0;this.ramps=[];this.frames=0;
    this.updateChain(chain);
  }
  updateChain(chain){
    const next=normalizeRackChain(chain),bytes=estimateRackBytes(next,this.sampleRate,this.channels);if(bytes>this.maxBytes)throw resource('Live rack exceeds its DSP memory allowance.');
    const old=new Map(this.stages.map(stage=>[stage.id,stage]));
    const stages=next.map(config=>{let stage=old.get(config.id);if(!stage||stage.effect!==config.effect){stage=makeStage(config,this.sampleRate,this.channels);stage.filter=new Float64Array(5);}return {stage,config};});
    for(const {stage,config} of stages){stage.enabled=config.enabled;setValue(stage,'wet',config.wet);if(stage.effect==='stutter'&&stage.params.division!==config.params.division)stage.frame=0;stage.params={...config.params};stage.baseWet=config.wet;stage.baseParams={...config.params};}
    this.stages=stages.map(x=>x.stage);this.bytes=bytes;
    const retained=slotId=>this.stages.some(stage=>stage.id===slotId&&old.get(slotId)===stage);
    this.lanes=this.lanes.filter(lane=>retained(lane.slotId));this.events=this.events.slice(this.eventIndex).filter(event=>retained(event.slotId));this.eventIndex=0;this.ramps=this.ramps.filter(event=>retained(event.slotId));return this.snapshot();
  }
  snapshot(){return this.stages.map(s=>({id:s.id,effect:s.effect,enabled:s.enabled,wet:s.wet,params:{...s.params}}));}
  pendingEventCount(){return this.events.length-this.eventIndex+this.ramps.length;}
  setTempo(bpm){bounded(bpm,20,400,'tempo');if(bpm!==this.bpm)for(const stage of this.stages)if(stage.effect==='stutter')stage.frame=0;this.bpm=bpm;}
  setAutomation(lanes){const next=normalizeAutomation(lanes,this.snapshot());this.lanes=next;}
  schedule({slotId,param,value,at=0,rampSeconds=0}){
    const stage=this.stages.find(s=>s.id===slotId);if(!stage)throw new RangeError('Effect stage does not exist.');parameterValue(stage,param,value);bounded(at,0,86400,'parameter time');bounded(rampSeconds,0,60,'parameter ramp');
    if(this.pendingEventCount()+this.lanes.reduce((count,lane)=>count+lane.points.length,0)>=LIVE_LIMITS.automationPoints)throw resource('Live parameter queue is full.');
    this.events=this.events.slice(this.eventIndex);this.eventIndex=0;this.events.push({slotId,param,value,at,rampSeconds});this.events.sort((a,b)=>a.at-b.at);
  }
  _automate(time){
    time=Math.round(time*this.sampleRate)/this.sampleRate;
    for(const lane of this.lanes){const stage=this.stages.find(s=>s.id===lane.slotId);if(!stage)continue;let value=automationValue(lane,time,lane.param==='wet'?stage.baseWet:stage.baseParams[lane.param]);if(parameterDefinition(stage,lane.param).integer)value=Math.round(value);setValue(stage,lane.param,value);}
    while(this.eventIndex<this.events.length&&this.events[this.eventIndex].at<=time){const event=this.events[this.eventIndex++],stage=this.stages.find(s=>s.id===event.slotId);if(!stage)continue;for(let index=this.ramps.length-1;index>=0;index--)if(this.ramps[index].slotId===event.slotId&&this.ramps[index].param===event.param)this.ramps.splice(index,1);if(event.rampSeconds){event.from=event.param==='wet'?stage.wet:stage.params[event.param];this.ramps.push(event);}else setValue(stage,event.param,event.value);}
    for(let i=this.ramps.length-1;i>=0;i--){const ramp=this.ramps[i],stage=this.stages.find(s=>s.id===ramp.slotId);if(!stage){this.ramps.splice(i,1);continue;}const f=Math.max(0,Math.min(1,(time-ramp.at)/ramp.rampSeconds));let value=ramp.from+(ramp.value-ramp.from)*f;if(parameterDefinition(stage,ramp.param).integer)value=Math.round(value);setValue(stage,ramp.param,value);if(f===1)this.ramps.splice(i,1);}
  }
  process(input,output,{timelineStart=this.frames/this.sampleRate,timelineRate=1,loopStart=0,loopEnd=0}={}){
    const length=output[0]?.length||0;if(length>LIVE_LIMITS.blockFrames||output.length!==this.channels)throw new RangeError('Invalid DSP block dimensions.');
    for(let i=0;i<length;i++){
      let time=timelineStart+i*timelineRate/this.sampleRate;if(loopEnd>loopStart&&time>=loopEnd)time=loopStart+(time-loopStart)%(loopEnd-loopStart);this._automate(time);
      for(let c=0;c<this.channels;c++)output[c][i]=input[c]?.[i]||0;
      for(const stage of this.stages){if(stage.effect==='filter')updateFilter(stage,this.sampleRate);for(let c=0;c<this.channels;c++){const dry=output[c][i],wet=wetSample(stage,dry,c,this.sampleRate,this.bpm);output[c][i]=stage.enabled?finite(dry*(1-stage.wet)+wet*stage.wet):dry;}stage.frame++;stage.phase=(stage.phase+TAU*(stage.params.rate||0)/this.sampleRate)%TAU;}
    }
    this.frames+=length;return output;
  }
}
export function renderLiveDSP(audio,{chain=[],automation=[],bpm=120,start=0,blockFrames=128}={}){
  if(!Number.isInteger(blockFrames)||blockFrames<1||blockFrames>LIVE_LIMITS.blockFrames)throw new RangeError('Invalid offline block size.');
  dimensions(audio?.sampleRate,audio?.channels?.length);const frames=audio.channels[0]?.length;if(!Number.isSafeInteger(frames)||frames<1||frames/audio.sampleRate>600||frames*audio.channels.length*4>256*1024*1024)throw resource('Offline live render exceeds the resident audio limit.');for(const channel of audio.channels){if(!(channel instanceof Float32Array)||channel.length!==frames)throw new TypeError('Offline live render needs equal-length Float32Array channels.');for(const sample of channel)if(!Number.isFinite(sample)||Math.abs(sample)>1e6)throw new RangeError('Offline live PCM contains invalid samples.');}
  const dsp=new RealtimeRackDSP({sampleRate:audio.sampleRate,channels:audio.channels.length,chain,bpm});dsp.setAutomation(automation);
  const channels=audio.channels.map(c=>new Float32Array(c.length));
  for(let offset=0;offset<channels[0].length;offset+=blockFrames){const end=Math.min(channels[0].length,offset+blockFrames);dsp.process(audio.channels.map(c=>c.subarray(offset,end)),channels.map(c=>c.subarray(offset,end)),{timelineStart:start+offset/audio.sampleRate});}
  return{sampleRate:audio.sampleRate,...(audio.layout?{layout:audio.layout}:{}),channels};
}
