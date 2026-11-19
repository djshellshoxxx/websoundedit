import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {assertEncodingBudget,assertEncodedSize,outputPolicy,readBoundedFFmpegOutput,ENCODING_LIMITS} from '../src/codec-budget.js';
import {encodeAudio,codecCapabilities} from '../src/codecs.js';
import {encodeAudioBytes,readBoundedNativeOutput,nativeCapabilities} from '../scripts/node-codecs.mjs';
import {encodeOpus} from '../src/opus.js';
const resource=error=>error.code==='RESOURCE_LIMIT';
test('browser and native capability reports publish the same actual encoded and projected PCM limits',async()=>{
  assert.deepEqual(codecCapabilities()[0].exportLimits,ENCODING_LIMITS);assert.deepEqual((await nativeCapabilities()).exportLimits,ENCODING_LIMITS);
});
test('export projection rejects multi-gigabyte resampling using dimensions alone, before any large buffer exists',()=>{
  assert.throws(()=>assertEncodingBudget({frames:600*8000,sampleRate:8000,outputSampleRate:192000,channels:8,format:'wav',bitDepth:32}),resource);
  assert.throws(()=>assertEncodingBudget({frames:600*8000,sampleRate:8000,outputSampleRate:48000,channels:8,format:'flac',bitDepth:24}),resource);
  assert.throws(()=>assertEncodingBudget({frames:8000*5,sampleRate:8000,channels:1,format:'aiff',bitDepth:32},{maxOutputBytes:65536}),resource);
  const safe=assertEncodingBudget({frames:8000,sampleRate:8000,channels:2,format:'wav',bitDepth:16});assert.equal(safe.pcmBytes,64000);assert.ok(safe.uncompressedBytes<safe.rejectAt);assert.ok(safe.rejectAt<safe.fileLimit);
});
test('browser and native uncompressed encoders apply a small injected cap before resampling or allocating output',async()=>{
  const audio={sampleRate:8000,channels:[new Float32Array(1024).fill(.1)]},policy={maxOutputBytes:4096};
  await assert.rejects(encodeAudioBytes(audio,{sampleRate:16000,format:'wav',bitDepth:32,float:true},policy),resource);
  await assert.rejects(encodeAudio(audio,{sampleRate:16000,format:'wav',bitDepth:32},policy),resource);
  assert.equal(audio.channels[0].length,1024);assert.equal(audio.channels[0][0],Math.fround(.1));
});
test('native output stat rejects encoder-bound/truncated and oversized files before readFile',async()=>{
  const policy=outputPolicy(8192);let reads=0;
  for(const size of [policy.rejectAt,3_700_000_000])await assert.rejects(readBoundedNativeOutput('fixture',policy,{statFile:async()=>({size,isFile:()=>true}),read:async()=>{reads++;throw new Error('Oversized read must not occur');}}),resource);
  assert.equal(reads,0);const bytes=await readBoundedNativeOutput('fixture',policy,{statFile:async()=>({size:4,isFile:()=>true}),read:async()=>Uint8Array.of(1,2,3,4)});assert.deepEqual(bytes,Uint8Array.of(1,2,3,4));assert.throws(()=>assertEncodedSize(NaN,policy));
});
test('browser FFmpeg probes only a tiny size report and refuses oversized output before transferring the file',async()=>{
  const reads=[],deleted=[];let args;const codec={ffprobe:async values=>{args=values;return 0;},readFile:async path=>{reads.push(path);if(path==='websoundedit-output-size.txt')return new TextEncoder().encode('3700000000\n');throw new Error('Oversized output must not be transferred');},deleteFile:async path=>deleted.push(path)};
  await assert.rejects(readBoundedFFmpegOutput(codec,'result.wav',outputPolicy()),resource);assert.deepEqual(reads,['websoundedit-output-size.txt']);assert.ok(args.includes('format=size'));assert.deepEqual(deleted,['websoundedit-output-size.txt']);
  codec.readFile=async path=>path==='websoundedit-output-size.txt'?new TextEncoder().encode('4\n'):Uint8Array.of(1,2,3,4);assert.deepEqual(await readBoundedFFmpegOutput(codec,'result.wav',outputPolicy()),Uint8Array.of(1,2,3,4));
});
test('Opus counts pages against a small output cap before final concatenation and releases its encoder on failure',async()=>{
  const audio={sampleRate:48000,channels:[Float32Array.from({length:48000},(_,i)=>Math.sin(i*.17)*.2)]};await assert.rejects(encodeOpus(audio,{bitrate:320,maxOutputBytes:1024}),resource);
  const small=await encodeOpus({sampleRate:48000,channels:[audio.channels[0].slice(0,17)]});assert.ok(small.byteLength>0);
});
const nativeAvailable=spawnSync('ffmpeg',['-version'],{stdio:'ignore',timeout:10000}).status===0;
test('native FFmpeg -fs output is rejected as bounded/truncated with a small real encoded fixture',{skip:!nativeAvailable},async()=>{
  let state=61;const audio={sampleRate:48000,channels:[Float32Array.from({length:24000},()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296-.5;})]};
  await assert.rejects(encodeAudioBytes(audio,{format:'mp3',bitrate:192},{maxOutputBytes:4096}),resource);
  const surround={sampleRate:8000,layout:'5.1',channels:Array.from({length:6},()=>new Float32Array(160).fill(.1))};assert.ok((await encodeAudioBytes(surround,{format:'mp3',channels:2})).byteLength>0);
});
