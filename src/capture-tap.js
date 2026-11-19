const modules=new WeakMap();
export class CaptureTap {
  static async create(context,source,{channels,framesPerChunk=2048,loopFrames=0,onChunk,onEnd=()=>{},onError=()=>{}}={}){
    if(!modules.has(context))modules.set(context,(async()=>{const module=await import('./capture-worklet.js?worker&url');await context.audioWorklet.addModule(module.default);})());
    await modules.get(context);return new CaptureTap(context,source,{channels,framesPerChunk,loopFrames,onChunk,onEnd,onError});
  }
  constructor(context,source,{channels,framesPerChunk,loopFrames,onChunk,onEnd,onError}){
    this.context=context;this.source=source;this.onChunk=onChunk;this.onEnd=onEnd;this.onError=onError;this.pending=Promise.resolve();this.closed=false;
    this.node=new AudioWorkletNode(context,'websoundedit-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[channels],channelCount:channels,channelCountMode:'explicit',channelInterpretation:'discrete',processorOptions:{channels,framesPerChunk,loopFrames,poolSize:8}});
    this.silent=context.createGain();this.silent.gain.value=0;this.node.connect(this.silent);this.silent.connect(context.destination);source.connect(this.node);
    this.node.port.onmessage=({data})=>{
      if(data.type==='chunk'){
        this.pending=this.pending.then(async()=>{let buffer=data.data.buffer;try{const returned=await this.onChunk({...data,data:new Float32Array(buffer,0,data.frames*data.channels)});if(returned instanceof ArrayBuffer)buffer=returned;}catch(error){if(error.buffer instanceof ArrayBuffer)buffer=error.buffer;this.onError(error);this.node.port.postMessage({type:'stop',endFrame:Math.round(context.currentTime*context.sampleRate)});}finally{if(buffer.byteLength&&!this.closed)this.node.port.postMessage({type:'recycle',buffer},[buffer]);}}).catch(error=>this.onError(error));
      }else if(data.type==='end'){this.pending.then(()=>{this.finished=data;this.onEnd(data);this.ended?.(data);this.ended=null;});}
      else if(data.type==='error'){this.onError(Object.assign(new Error(data.message),{code:data.code}));this.ended?.({frames:data.frames||0,error:data.message});this.ended=null;}
    };
  }
  start({startFrame=Math.ceil(this.context.currentTime*this.context.sampleRate),endFrame=Number.MAX_SAFE_INTEGER}={}){this.finished=null;this.node.port.postMessage({type:'start',startFrame,endFrame});}
  stop(endFrame=Math.ceil(this.context.currentTime*this.context.sampleRate)){
    if(this.finished)return Promise.resolve(this.finished);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.ended=null;reject(Object.assign(new Error('Capture stop timed out; written audio remains recoverable.'),{code:'CAPTURE_TIMEOUT'}));},5000);this.ended=value=>{clearTimeout(timer);resolve(value);};this.node.port.postMessage({type:'stop',endFrame});});
  }
  setLoop(settings){this.node.port.postMessage({type:'loop',settings});}
  detachSource(){try{this.source.disconnect(this.node);}catch{}}
  dispose(){if(this.closed)return;this.closed=true;try{this.source.disconnect(this.node);}catch{}try{this.node.port.postMessage({type:'dispose'});this.node.port.close();this.node.disconnect();this.silent.disconnect();}catch{}this.ended?.({disposed:true});this.ended=null;}
}
