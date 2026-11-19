/** Export admission happens before resampling, container allocation or file reads. */
export const MAX_ENCODED_BYTES=128*1024*1024;
export const MAX_PROJECTED_PCM_BYTES=256*1024*1024;
export const ENCODING_LIMITS=Object.freeze({maxEncodedBytes:MAX_ENCODED_BYTES,maxProjectedPcmBytes:MAX_PROJECTED_PCM_BYTES,maxSeconds:600,containerGuardBytes:131072,streamingArchiveExempt:true});
const resource=message=>Object.assign(new RangeError(message),{code:'RESOURCE_LIMIT'});
export function outputPolicy(maxOutputBytes=MAX_ENCODED_BYTES){
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||maxOutputBytes>MAX_ENCODED_BYTES)throw new RangeError('Encoded output policy must be between 1 KiB and 128 MiB.');
  const guard=Math.min(65536,Math.floor(maxOutputBytes/4)),fileLimit=maxOutputBytes-guard;
  return{maxOutputBytes,fileLimit,rejectAt:fileLimit-Math.min(65536,Math.floor(fileLimit/4))};
}
export function assertEncodingBudget({frames,sampleRate,outputSampleRate=sampleRate,channels,format='wav',bitDepth=32,metadataBytes=0},policy={}){
  const limits=outputPolicy(policy.maxOutputBytes);
  if(!Number.isSafeInteger(frames)||frames<0||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000||!Number.isInteger(outputSampleRate)||outputSampleRate<8000||outputSampleRate>192000||![1,2,6,8].includes(channels)||![16,24,32].includes(bitDepth)||!Number.isSafeInteger(metadataBytes)||metadataBytes<0||metadataBytes>8192)throw new RangeError('Invalid projected audio export dimensions.');
  const outputFrames=Math.ceil(frames*outputSampleRate/sampleRate),pcmBytes=outputFrames*channels*4;
  if(frames/sampleRate>600||!Number.isSafeInteger(pcmBytes)||pcmBytes>MAX_PROJECTED_PCM_BYTES)throw resource('Projected export PCM exceeds 256 MiB / ten minutes. Choose a shorter range, lower output rate or fewer channels.');
  // Includes bounded INFO/ID3 metadata and container headers, before allocating
  // an uncompressed result. Encoded formats are checked again on their file size.
  const uncompressedBytes=['wav','aiff'].includes(format)?outputFrames*channels*(bitDepth/8)+1024+metadataBytes*2:null;
  if(uncompressedBytes!==null&&uncompressedBytes>=limits.rejectAt)throw resource('Projected uncompressed export exceeds the encoded-output limit (128 MiB maximum, with container guard space). Choose a shorter range or lower output rate.');
  return{...limits,outputFrames,pcmBytes,uncompressedBytes};
}
export function assertEncodedSize(size,policy){
  if(!Number.isSafeInteger(size)||size<=0)throw new RangeError('Encoder returned no valid output file.');
  if(size>=policy.rejectAt)throw resource('Encoded output reached its bounded file-size limit and may be truncated. Choose a shorter range or lower output settings.');
  return size;
}
/** FFmpeg.wasm has no public stat method. Its bundled ffprobe reads the virtual
 * file size into a tiny controlled text report before readFile transfers PCM. */
export async function readBoundedFFmpegOutput(ffmpeg,path,policy,{timeout=120000}={}){
  const probe='websoundedit-output-size.txt';
  try{
    // Core 0.12.10 leaves ret at -1 after successful ffprobe calls. Never infer
    // success from that sentinel: require a fresh, strictly numeric report.
    // A failed unlink could retain a stale report, so truncation must succeed.
    await ffmpeg.writeFile(probe,new Uint8Array());
    const code=await ffmpeg.ffprobe(['-v','error','-show_entries','format=size','-of','default=noprint_wrappers=1:nokey=1',path,'-o',probe],timeout);
    if(code!==0&&code!==-1)throw new Error('Could not verify the encoded output size before loading it.');
    const report=await ffmpeg.readFile(probe),text=typeof report==='string'?report:new TextDecoder().decode(report);
    if(text.length>32||!/^\s*\d{1,16}\s*$/.test(text))throw new Error('Invalid encoded output size report.');
    const size=assertEncodedSize(Number(text.trim()),policy),bytes=await ffmpeg.readFile(path);
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==size)throw new Error('Encoded output changed after its size check.');return bytes;
  }finally{try{await ffmpeg.deleteFile(probe);}catch{}}
}
