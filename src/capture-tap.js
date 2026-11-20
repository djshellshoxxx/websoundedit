const modules=new WeakMap();
export class CaptureTap {
  static async create(context,source,{channels,framesPerChunk=2048,loopFrames=0,poolSize=8,onStart=()=>{},onChunk,onEnd=()=>{},onError=()=>{}}={}){
    if(!modules.has(context))modules.set(context,(async()=>{const module=await import('./capture-worklet.js?worker&url');await context.audioWorklet.addModule(module.default);})());
    await modules.get(context);return new CaptureTap(context,source,{channels,framesPerChunk,loopFrames,poolSize,onStart,onChunk,onEnd,onError});
  }
  constructor(context,source,{channels,framesPerChunk=2048,loopFrames=0,poolSize=8,onStart=()=>{},onChunk,onEnd=()=>{},onError=()=>{}}){
    this.context=context;this.source=source;this.onChunk=onChunk;this.onEnd=onEnd;this.onError=onError;this.pending=Promise.resolve();this.closed=false;this.failure=null;this.completion=null;this.stopPromise=null;
    this.node=new AudioWorkletNode(context,'websoundedit-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[channels],channelCount:channels,channelCountMode:'explicit',channelInterpretation:'discrete',processorOptions:{channels,framesPerChunk,loopFrames,poolSize}});
    this.silent=context.createGain();this.silent.gain.value=0;this.node.connect(this.silent);this.silent.connect(context.destination);source.connect(this.node);
    this.node.port.onmessage=({data})=>{
      if(this.closed||this.finished)return;
      if(data.type==='start'){if(!this.completion)onStart(data);}
      else if(data.type==='chunk'){
        if(this.completion)return;
        this.pending=this.pending.then(async()=>{
          if(this.closed)return;
          let buffer=data.data.buffer;
          try{const returned=await this.onChunk({...data,data:new Float32Array(buffer,0,data.frames*data.channels)});if(returned instanceof ArrayBuffer)buffer=returned;}
          catch(error){if(error?.buffer instanceof ArrayBuffer)buffer=error.buffer;this._stopWithError(error);}
          finally{if(buffer.byteLength&&!this.closed)this.node.port.postMessage({type:'recycle',buffer},[buffer]);}
        }).catch(error=>this._stopWithError(error));
      }else if(data.type==='end')this._complete(data);
      else if(data.type==='error'){
        try{this._recordError(Object.assign(new Error(data.message),{code:data.code}));}
        finally{this._complete({frames:data.frames||0});}
      }
    };
  }
  _recordError(error){if(this.closed||this.failure)return;this.failure=error instanceof Error?error:new Error(String(error));this.onError(this.failure);}
  _stopWithError(error){if(this.closed)return;try{this._recordError(error);}finally{this.stop().catch(error=>this._recordError(error));}}
  _result(data){return this.failure?{...data,error:this.failure.message,code:this.failure.code}:data;}
  _settleStop(result){clearTimeout(this.stopTimer);this.stopTimer=null;const resolve=this.ended;this.ended=null;resolve?.(result);}
  _complete(data){
    if(this.closed||this.finished||this.completion)return;
    // Port messages are ordered: all PCM accepted before this terminal message
    // is already in pending. Storage must consume it before callers finalize.
    this.completion=this.pending.then(()=>{
      if(this.closed||this.finished)return;
      this.finished=this._result(data);
      try{if(!this.failure)this.onEnd(this.finished);}
      catch(error){this._recordError(error);this.finished=this._result(data);}
      finally{this._settleStop(this.finished);}
    });
  }
  start({startFrame=Math.ceil(this.context.currentTime*this.context.sampleRate),endFrame=Number.MAX_SAFE_INTEGER,quantumFrames=0}={}){
    if(this.closed)throw new Error('Capture is disposed.');
    if(this.ended)throw new Error('Capture is still stopping.');
    this.finished=null;this.failure=null;this.completion=null;this.stopPromise=null;this.node.port.postMessage({type:'start',startFrame,endFrame,quantumFrames});
  }
  stop(endFrame=Math.ceil(this.context.currentTime*this.context.sampleRate)){
    if(this.stopPromise)return this.stopPromise;
    if(this.finished||this.closed)return this.stopPromise=Promise.resolve(this._result(this.finished||{disposed:true}));
    let rejectStop;
    this.stopPromise=new Promise((resolve,reject)=>{this.ended=resolve;rejectStop=reject;});
    this.stopTimer=setTimeout(()=>{this.ended=null;this.stopTimer=null;rejectStop(Object.assign(new Error('Capture stop timed out; written audio remains recoverable.'),{code:'CAPTURE_TIMEOUT'}));},5000);
    // Install the shared promise before posting: an error callback may itself
    // request stop while a user pause/stop is already waiting for these writes.
    try{if(!this.completion)this.node.port.postMessage({type:'stop',endFrame});}
    catch(error){clearTimeout(this.stopTimer);this.stopTimer=null;this.ended=null;rejectStop(error);}
    return this.stopPromise;
  }
  setLoop(settings){this.node.port.postMessage({type:'loop',settings});}
  detachSource(){try{this.source.disconnect(this.node);}catch{}}
  dispose(){if(this.closed)return;this.closed=true;this.finished=this.finished||this._result({disposed:true});try{this.source.disconnect(this.node);}catch{}try{this.node.port.postMessage({type:'dispose'});this.node.port.onmessage=null;this.node.port.close();this.node.disconnect();this.silent.disconnect();}catch{}this._settleStop(this.finished);}
}
