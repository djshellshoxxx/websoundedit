import { FFmpeg } from '@ffmpeg/ffmpeg';
import { encodeWav, decodeWav } from './wav.js';
import { resampleAudio } from './dsp.js';
import { normalizeMetadata, ffmpegMetadataArgs, metadataWarnings } from './metadata.js';

export const FORMATS = [
  {id:'wav',name:'WAV · uncompressed PCM',ext:'wav',mime:'audio/wav'},
  {id:'mp3',name:'MP3 · compatible & compact',ext:'mp3',mime:'audio/mpeg',encoder:'libmp3lame',args:['-c:a','libmp3lame']},
  {id:'flac',name:'FLAC · compressed lossless',ext:'flac',mime:'audio/flac',encoder:'flac',args:['-c:a','flac']},
  {id:'ogg',name:'Ogg Vorbis · open lossy',ext:'ogg',mime:'audio/ogg',encoder:'libvorbis',args:['-c:a','libvorbis']},
  {id:'opus',name:'Opus · efficient audio',ext:'opus',mime:'audio/ogg',backend:'libopus-wasm'},
  {id:'m4a',name:'M4A / AAC · MPEG-4',ext:'m4a',mime:'audio/mp4',encoder:'aac',args:['-c:a','aac']},
  {id:'aac',name:'AAC · ADTS stream',ext:'aac',mime:'audio/aac',encoder:'aac',args:['-c:a','aac','-f','adts']},
  {id:'aiff',name:'AIFF · uncompressed PCM',ext:'aiff',mime:'audio/aiff',encoder:'pcm_s16be',args:['-c:a','pcm_s16be']},
  {id:'alac',name:'ALAC · Apple lossless',ext:'m4a',mime:'audio/mp4',encoder:'alac',args:['-c:a','alac']},
  {id:'wma',name:'WMA v2 · legacy',ext:'wma',mime:'audio/x-ms-wma',encoder:'wmav2',args:['-c:a','wmav2']}
];
let ffmpeg, loading, codecSet, serial=Promise.resolve();
let nativeDecoder = null, nativeDecoderRate = null;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 600;
const CODEC_TIMEOUT_MS = 120000;
let report = ()=>{};
export function setCodecReporter(fn) { report=fn; }
export async function loadCodecs() {
  if (loading) return loading;
  loading=(async()=>{
    report('Loading local conversion engine (about 31 MB)…');
    ffmpeg=new FFmpeg(); const lines=[];
    ffmpeg.on('log', ({message})=>{lines.push(message); if(lines.length>1200)lines.shift();});
    ffmpeg.on('progress', ({progress})=>report(`Converting audio · ${Math.min(99,Math.max(0,Math.round(progress*100)))}%`));
    // Official API: https://ffmpegwasm.netlify.app/docs/getting-started/usage/
    const base=new URL('codecs/',document.baseURI);
    await ffmpeg.load({coreURL:new URL('ffmpeg-core.js',base).href,wasmURL:new URL('ffmpeg-core.wasm',base).href});
    const probeCode = await ffmpeg.exec(['-encoders'], 30000);
    if (probeCode !== 0) throw new Error('Encoder capability discovery failed.');
    codecSet=new Set();
    for(const f of FORMATS) if(!f.encoder || lines.some(line=>new RegExp(`\\b${f.encoder}\\b`).test(line))) codecSet.add(f.id);
    report('Conversion engine ready · audio stays on this device');
    return {formats:FORMATS.map(f=>({...f,available:codecSet.has(f.id)}))};
  })().catch(error=>{loading=null; codecSet=null; ffmpeg?.terminate(); ffmpeg=null;throw new Error(`Conversion engine could not load: ${error?.message || String(error)}`);});
  return loading;
}
function queued(fn){ const job=serial.then(fn);serial=job.catch(()=>{});return job; }
export function codecCapabilities(){return FORMATS.map(f=>({...f,available:!f.encoder?true:codecSet?codecSet.has(f.id):null}));}
function checkSize(size){if(size>192*1024*1024)throw new Error('Conversion input exceeds the 192 MB safety limit. Export a smaller selection or use the local CLI.');}
function encodeOpusInWorker(audio,bitrate,metadata) {
  return new Promise((resolve,reject)=>{
    // This encoder has its own adequate WASM stack; core 0.12.10's libopus
    // stereo path can overflow its small stack. Keep encoding off the UI thread.
    const worker=new Worker(new URL('./opus-worker.js',import.meta.url),{type:'module'});
    let finished=false;
    const finish=(error,bytes)=>{
      if(finished)return;finished=true;clearTimeout(timer);worker.terminate();
      if(error)reject(error);else resolve(bytes);
    };
    const timer=setTimeout(()=>finish(new Error('Opus encoding exceeded two minutes. Export a smaller selection.')),CODEC_TIMEOUT_MS);
    worker.onerror=event=>finish(new Error(event.message||'The Opus encoding worker failed.'));
    worker.onmessage=({data})=>{
      if(data.type==='progress')report(`Encoding Opus · ${Math.min(99,Math.max(0,Math.round(data.progress*100)))}%`);
      else if(data.type==='result')finish(null,data.bytes);
      else if(data.type==='error')finish(new Error(data.message||'Opus encoding failed.'));
    };
    try {
      const channels=audio.channels.map(channel=>new Float32Array(channel));
      worker.postMessage({audio:{sampleRate:audio.sampleRate,channels},bitrate,metadata},channels.map(channel=>channel.buffer));
    }catch(error){finish(error);}
  });
}
export async function decodeAudioFile(file,sampleRate=48000) {
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000)throw new Error('Working sample rate must be an integer between 8000 and 192000 Hz.');
  checkSize(file.size); const buffer=await file.arrayBuffer();
  const header=new Uint8Array(buffer,0,Math.min(12,buffer.byteLength));
  const isWave=header.length===12&&String.fromCharCode(...header.subarray(0,4))==='RIFF'&&String.fromCharCode(...header.subarray(8,12))==='WAVE';
  if(isWave){
    try {const audio=decodeWav(buffer);return audio.sampleRate===sampleRate?audio:resampleAudio(audio,sampleRate);}
    catch(error){
      // Compressed WAV needs another decoder. Structural/resource/channel errors
      // are validation failures, not permission to silently downmix or truncate.
      if(!/Unsupported (?:extensible )?WAV encoding/i.test(error.message))throw error;
    }
  }
  let decoded=null;
  try {
    // Reuse the decoder context for a working rate. A batch import should not
    // leave a new native audio context/decoder graph alive for every small file.
    if(!nativeDecoder||nativeDecoderRate!==sampleRate){
      nativeDecoder=new OfflineAudioContext(2,1,sampleRate); nativeDecoderRate=sampleRate;
    }
    decoded=await nativeDecoder.decodeAudioData(buffer.slice(0));
  }catch{/* Only actual decoder failures trigger the WASM fallback. */}
  if(decoded){
    if(decoded.numberOfChannels<1||decoded.numberOfChannels>2)throw new Error('Use a mono or stereo source; multichannel audio is not silently downmixed.');
    if(decoded.duration>MAX_AUDIO_SECONDS||decoded.length*decoded.numberOfChannels*4>MAX_DECODED_BYTES)throw new Error('Audio exceeds the 10-minute / 256 MiB decoded-audio limit.');
    return {sampleRate:decoded.sampleRate,channels:Array.from({length:decoded.numberOfChannels},(_,i)=>new Float32Array(decoded.getChannelData(i)))};
  }
  return queued(async()=>{
    await loadCodecs(); const ext=(file.name?.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'').slice(0,8);const input=`source.${ext}`;
    try{
      report(`Decoding ${file.name||'audio'} with the local conversion engine…`);
      await ffmpeg.writeFile(input,new Uint8Array(buffer));
      // Preserve source channels. decodeWav validates supported channel/layout
      // and resource bounds; the tiny overrun ensures oversized audio is rejected.
      const result=await ffmpeg.exec(['-i',input,'-map','0:a:0','-vn','-ar',String(sampleRate),'-c:a','pcm_f32le','-t',String(MAX_AUDIO_SECONDS+.001),'-fs',String(MAX_DECODED_BYTES+1048576),'decoded.wav'],CODEC_TIMEOUT_MS);
      if(result!==0)throw new Error('This file could not be decoded by the available codecs, or decoding exceeded two minutes.');
      return decodeWav(await ffmpeg.readFile('decoded.wav'));
    } finally { for(const file of [input,'decoded.wav'])try{await ffmpeg.deleteFile(file);}catch{} }
  });
}
export async function encodeAudio(audio, {format='wav',sampleRate=audio.sampleRate,bitDepth=24,bitrate=192,channels='original',metadata={}}={}) {
  metadata=normalizeMetadata(metadata);
  const descriptor=FORMATS.find(f=>f.id===format);if(!descriptor)throw new Error('Unknown output format.');
  if(![8000,16000,22050,24000,32000,44100,48000,88200,96000].includes(+sampleRate))throw new Error('Unsupported export sample rate.');
  if(channels==='mono'&&audio.channels.length>1){const mono=new Float32Array(audio.channels[0].length);for(let i=0;i<mono.length;i++)mono[i]=(audio.channels[0][i]+audio.channels[1][i])/2;audio={...audio,channels:[mono]};}
  if(format==='opus')sampleRate=48000;
  if(+sampleRate!==audio.sampleRate)audio=resampleAudio(audio,+sampleRate);
  const warnings=metadataWarnings(metadata,format);
  if(format==='wav')return {bytes:encodeWav(audio,{bitDepth:+bitDepth,float:+bitDepth===32,metadata}),...descriptor,warnings};
  if(format==='opus')return queued(async()=>{
    report('Loading the local Opus encoder…');
    return {bytes:await encodeOpusInWorker(audio,Math.max(32,Math.min(320,+bitrate)),metadata),...descriptor,warnings};
  });
  return queued(async()=>{
    await loadCodecs(); if(!codecSet.has(format))throw new Error(`${descriptor.name} is not included in this encoder build.`);
    const bytes=encodeWav(audio,{bitDepth:32,float:true});checkSize(bytes.length);
    const output=`result.${descriptor.ext}`;
    try{
      await ffmpeg.writeFile('input.wav',bytes);
      const args=['-i','input.wav','-vn',...descriptor.args,...ffmpegMetadataArgs(metadata,format)];
      if(['mp3','ogg','opus','m4a','aac','wma'].includes(format))args.push('-b:a',`${Math.max(32,Math.min(320,+bitrate))}k`);
      if(format==='flac')args.push('-sample_fmt',+bitDepth===16?'s16':'s32');
      if(format==='aiff'&&+bitDepth===24){args.splice(args.indexOf('pcm_s16be'),1,'pcm_s24be');}
      if(format==='m4a'||format==='alac')args.push('-movflags','+faststart');
      args.push(output);
      const code=await ffmpeg.exec(args,CODEC_TIMEOUT_MS);
      if(code!==0)throw new Error(`The ${descriptor.name} encoder rejected these settings. Try 44.1 or 48 kHz.`);
      return {bytes:await ffmpeg.readFile(output),...descriptor,warnings};
    } finally {for(const file of ['input.wav',output])try{await ffmpeg.deleteFile(file);}catch{} }
  });
}
