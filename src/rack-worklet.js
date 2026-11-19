import { RealtimeRackDSP } from './realtime-dsp.js';
class RackProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();const settings=options.processorOptions;this.dsp=new RealtimeRackDSP({sampleRate,channels:settings.channels,chain:settings.chain,bpm:settings.bpm});
    this.clock={audioTime:0,timelineTime:0,rate:1,loopStart:0,loopEnd:0,playing:false};this.alive=true;this.blocks=0;
    this.port.onmessage=({data})=>{try{
      if(data.method==='chain')this.dsp.updateChain(data.chain);
      else if(data.method==='parameter'){
        // Manual gestures use the advancing audio sample clock even when the
        // transport timeline is paused. Explicit timeline schedules are lanes.
        const at=Number.isFinite(data.event.audioTime)?this.dsp.frames/sampleRate+Math.max(0,data.event.audioTime-currentTime):data.event.at;
        this.dsp.schedule({...data.event,at});
      }
      else if(data.method==='automation')this.dsp.setAutomation(data.lanes);
      else if(data.method==='clock'){this.clock={...this.clock,...data.clock};this.dsp.setTempo(data.bpm??this.dsp.bpm);}
      else if(data.method==='dispose')this.alive=false;
      else throw new Error('Unknown worklet operation.');
      this.port.postMessage({id:data.id,ok:true,queuedEvents:this.dsp.pendingEventCount()});
    }catch(error){this.port.postMessage({id:data.id,error:{message:error.message,code:error.code||'INVALID_ARGUMENT'}});}};
  }
  process(inputs,outputs){
    if(!this.alive)return false;const clock=this.clock,time=clock.timelineTime+(currentTime-clock.audioTime)*(clock.playing?clock.rate:0);
    this.dsp.process(inputs[0]||[],outputs[0],{timelineStart:time,timelineRate:clock.playing?clock.rate:0,loopStart:clock.playing?clock.loopStart:0,loopEnd:clock.playing?clock.loopEnd:0});if(++this.blocks%32===0)this.port.postMessage({type:'status',queuedEvents:this.dsp.pendingEventCount()});return true;
  }
}
registerProcessor('websoundedit-rack',RackProcessor);
