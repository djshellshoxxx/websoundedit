/** Fixed-pool capture, driven by AudioContext frame numbers. */
export class CaptureKernel {
  constructor({channels,framesPerChunk=2048,poolSize=8,onChunk=()=>{},onEnd=()=>{},onError=()=>{}}){
    if(![1,2,6,8].includes(channels)||!Number.isInteger(framesPerChunk)||framesPerChunk<128||framesPerChunk>16384||!Number.isInteger(poolSize)||poolSize<2||poolSize>16)throw new RangeError('Invalid capture pool dimensions.');
    this.channels=channels;this.framesPerChunk=framesPerChunk;this.onChunk=onChunk;this.onEnd=onEnd;this.onError=onError;this.byteLength=channels*framesPerChunk*4;this.pool=Array.from({length:poolSize},()=>new Float32Array(channels*framesPerChunk));this.poolSize=poolSize;this.active=false;this.current=null;this.offset=0;this.sequence=0;this.frames=0;
  }
  start({startFrame,endFrame=Number.MAX_SAFE_INTEGER}){if(!Number.isSafeInteger(startFrame)||startFrame<0||!Number.isSafeInteger(endFrame)||endFrame<=startFrame)throw new RangeError('Invalid capture boundaries.');if(this.active)throw new Error('Capture is already active.');this.startFrame=startFrame;this.endFrame=endFrame;this.active=true;this.frames=0;this.sequence=0;this.offset=0;}
  recycle(buffer){if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==this.byteLength||this.pool.length>=this.poolSize)throw new RangeError('Invalid recycled capture buffer.');this.pool.push(new Float32Array(buffer));}
  _flush(){if(!this.current||!this.offset)return;const data=this.current;this.current=null;this.onChunk({sequence:this.sequence++,startFrame:this.packetStart,frames:this.offset,channels:this.channels,data});this.offset=0;}
  finish(){if(!this.active)return;this.active=false;this._flush();this.onEnd({frames:this.frames,startFrame:this.startFrame,endFrame:this.startFrame+this.frames});}
  stop(endFrame){if(!Number.isSafeInteger(endFrame)||endFrame<0)throw new RangeError('Invalid capture stop boundary.');this.endFrame=Math.min(this.endFrame,Math.max(endFrame,this.startFrame+this.frames));if(this.endFrame<=this.startFrame+this.frames)this.finish();return this.endFrame;}
  process(input,frame,length=128){
    if(!this.active)return;
    for(let i=0;i<length;i++){
      const at=frame+i;if(at>=this.endFrame){this.finish();return;}if(at<this.startFrame)continue;
      if(!this.current){this.current=this.pool.pop();if(!this.current){this.active=false;this.onError({code:'BACKPRESSURE',message:'Capture stopped because its bounded storage/consumer queue is full.',frames:this.frames});return;}this.packetStart=at;}
      for(let c=0;c<this.channels;c++){const value=input[c]?.[i]??0;if(!Number.isFinite(value)||Math.abs(value)>1e6){this.active=false;this.onError({code:'INVALID_PCM',message:'Capture stopped because its source produced invalid samples.',frames:this.frames});return;}this.current[this.offset*this.channels+c]=value;}
      this.offset++;this.frames++;if(this.offset===this.framesPerChunk)this._flush();
    }
    if(frame+length>=this.endFrame)this.finish();
  }
}
