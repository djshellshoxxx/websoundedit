import { RecordingStore } from './recording-store.js';
let storePromise,queue=Promise.resolve(),pending=0,queuedBytes=0;const controllers=new Map();
const store=()=>storePromise||=(async()=>new RecordingStore(await navigator.storage.getDirectory()))();
self.onmessage=({data})=>{
  if(data.method==='cancel'){controllers.get(data.requestId)?.abort();return;}
  const bytes=data.data?.byteLength||0;
  if(pending>=32||queuedBytes+bytes>8*1024*1024){self.postMessage({id:data.id,error:{code:'BACKPRESSURE',message:'Storage queue reached its bounded capacity.'},buffer:data.data?.buffer},data.data?[data.data.buffer]:[]);return;}
  pending++;queuedBytes+=bytes;const controller=new AbortController();controllers.set(data.id,controller);
  const run=async()=>{let result;try{
    if(controller.signal.aborted)throw Object.assign(new Error('Storage operation cancelled.'),{code:'ABORTED'});const archive=await store();
    switch(data.method){
      case'start':result=await archive.start(data.params);break;
      case'append':result=await archive.append(data.data);break;
      case'pause':result=await archive.pause();break;case'resume':result=await archive.resume();break;case'stop':result=await archive.stop(data.params?.status);break;
      case'list':result=await archive.list();break;case'recover':result=await archive.recover(data.params.recordingId);break;case'delete':result=await archive.delete(data.params.recordingId);break;
      case'range':result=await archive.readRange(data.params.recordingId,data.params);break;
      case'export':{const writable=await data.handle.createWritable();result=await archive.export(data.params.recordingId,writable,data.params,{signal:controller.signal,onProgress:progress=>self.postMessage({type:'progress',...progress})});break;}
      default:throw new Error('Unknown recording operation.');
    }
    const transfer=data.data?[data.data.buffer]:Array.isArray(result?.channels)?result.channels.map(channel=>channel.buffer):[];self.postMessage({id:data.id,result,...(data.data?{buffer:data.data.buffer}:{})},transfer);
  }catch(error){self.postMessage({id:data.id,error:{message:error.message,code:error.code||'STORAGE_ERROR'},...(data.data?{buffer:data.data.buffer}:{})},data.data?[data.data.buffer]:[]);}finally{pending--;queuedBytes-=bytes;controllers.delete(data.id);}};
  queue=queue.then(run,run);
};
