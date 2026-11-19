/** Streaming float32 WAVE/RF64 headers. Payload is interleaved little-endian PCM.
 * RF64 sizes are 64-bit; ordinary small exports use the same extensible layout.
 */
import { CHANNEL_LAYOUTS, normalizeLayout } from './channel-layout.js';
const ascii=(view,offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
export function createStreamWavHeader({sampleRate,layout,frames}){
  normalizeLayout(layout);if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000||!Number.isSafeInteger(frames)||frames<0)throw new RangeError('Invalid streaming WAV dimensions.');
  const count=CHANNEL_LAYOUTS[layout].count,dataBytes=BigInt(frames)*BigInt(count*4),rf64=dataBytes+72n>0xffffffffn,headerSize=rf64?116:80;
  const bytes=new Uint8Array(headerSize),view=new DataView(bytes.buffer);ascii(view,0,rf64?'RF64':'RIFF');view.setUint32(4,rf64?0xffffffff:Number(dataBytes)+headerSize-8,true);ascii(view,8,'WAVE');
  let cursor=12;if(rf64){ascii(view,cursor,'ds64');view.setUint32(cursor+4,28,true);view.setBigUint64(cursor+8,dataBytes+BigInt(headerSize-8),true);view.setBigUint64(cursor+16,dataBytes,true);view.setBigUint64(cursor+24,BigInt(frames),true);view.setUint32(cursor+32,0,true);cursor+=36;}
  ascii(view,cursor,'fmt ');view.setUint32(cursor+4,40,true);view.setUint16(cursor+8,0xfffe,true);view.setUint16(cursor+10,count,true);view.setUint32(cursor+12,sampleRate,true);view.setUint32(cursor+16,sampleRate*count*4,true);view.setUint16(cursor+20,count*4,true);view.setUint16(cursor+22,32,true);view.setUint16(cursor+24,22,true);view.setUint16(cursor+26,32,true);view.setUint32(cursor+28,CHANNEL_LAYOUTS[layout].mask,true);view.setUint16(cursor+32,3,true);bytes.set([0,0,0,0,16,0,128,0,0,170,0,56,155,113],cursor+34);cursor+=48;
  ascii(view,cursor,'fact');view.setUint32(cursor+4,4,true);view.setUint32(cursor+8,Math.min(frames,0xffffffff),true);cursor+=12;ascii(view,cursor,'data');view.setUint32(cursor+4,rf64?0xffffffff:Number(dataBytes),true);
  return {bytes,rf64,dataBytes:Number(dataBytes),totalBytes:Number(dataBytes)+headerSize,mime:'audio/wav',extension:'wav'};
}
export async function writeStreamWav({sampleRate,layout,frames,read},writable,{chunkFrames=16384,signal,onProgress=()=>{}}={}){
  if(!writable?.write||!Number.isInteger(chunkFrames)||chunkFrames<1||chunkFrames>65536)throw new TypeError('Provide a writable file and bounded chunk size.');
  const header=createStreamWavHeader({sampleRate,layout,frames}),block=CHANNEL_LAYOUTS[layout].count*4;
  let written=0;
  try{if(signal?.aborted)throw Object.assign(new Error('Export cancelled.'),{code:'ABORTED'});await writable.write(header.bytes);written=header.bytes.length;for(let frame=0;frame<frames;frame+=chunkFrames){if(signal?.aborted)throw Object.assign(new Error('Export cancelled.'),{code:'ABORTED'});const count=Math.min(chunkFrames,frames-frame),bytes=await read(frame,count);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==count*block)throw new RangeError('Recording payload was truncated during export.');await writable.write(bytes);written+=bytes.byteLength;onProgress({bytesWritten:written,totalBytes:header.totalBytes});}if(signal?.aborted)throw Object.assign(new Error('Export cancelled.'),{code:'ABORTED'});await writable.close?.();return{...header,bytes:undefined,bytesWritten:written};}
  catch(error){try{await writable.abort?.(error);}catch{}throw error;}
}
