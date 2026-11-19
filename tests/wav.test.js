import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav } from '../src/wav.js';
const audio={sampleRate:48000,channels:[Float32Array.of(-1,-.5,0,.5,1),Float32Array.of(1,.5,0,-.5,-1)]};
test('PCM 16/24/32-bit exports round-trip signed, interleaved channels',()=>{
 for(const bitDepth of [16,24,32]) {
  const bytes=encodeWav(audio,{bitDepth}),decoded=decodeWav(bytes);
  assert.equal(decoded.sampleRate,audio.sampleRate);assert.equal(decoded.channels.length,2);
  const tolerance=2**(-(bitDepth-1))+1e-7;
  for(let c=0;c<2;c++)for(let i=0;i<5;i++)assert.ok(Math.abs(decoded.channels[c][i]-audio.channels[c][i])<tolerance);
 }
});
test('IEEE float export preserves unclipped PCM including values over full scale',()=>{
 const input={sampleRate:48000,channels:[Float32Array.of(-2,-.3,0,.7,2)]};
 const bytes=encodeWav(input,{bitDepth:32,float:true});assert.deepEqual(decodeWav(bytes),input);
 const clipped=decodeWav(encodeWav(input));assert.equal(clipped.channels[0][0],-1);assert.ok(clipped.channels[0].at(-1)<1);
});
test('24-bit odd-length data chunks are padded and Node-buffer subviews decode correctly',()=>{
 const input={sampleRate:8000,channels:[Float32Array.of(.25)]},bytes=encodeWav(input,{bitDepth:24});
 assert.equal(bytes.length%2,0);
 const padded=Buffer.alloc(bytes.length+100);Buffer.from(bytes).copy(padded,23);
 const out=decodeWav(padded.subarray(23,23+bytes.length));assert.ok(Math.abs(out.channels[0][0]-.25)<1e-6);
});
test('WAV parser skips unknown odd-sized chunks and accepts zero-frame files',()=>{
 const bytes=encodeWav(audio);const extended=new Uint8Array(bytes.length+10);extended.set(bytes.subarray(0,12),0);
 extended.set([74,85,78,75,1,0,0,0,99,0],12);extended.set(bytes.subarray(12),22);
 new DataView(extended.buffer).setUint32(4,extended.length-8,true);
 assert.deepEqual(decodeWav(extended),decodeWav(bytes));
 assert.equal(decodeWav(encodeWav({sampleRate:48000,channels:[new Float32Array(0)]})).channels[0].length,0);
});
test('malformed or nonfinite WAV data rejects before allocating audio',()=>{
 const bytes=encodeWav(audio);
 assert.throws(()=>decodeWav(bytes.subarray(0,20)),/truncated/);
 const bad=bytes.slice();new DataView(bad.buffer).setUint16(32,99,true);assert.throws(()=>decodeWav(bad),/alignment/);
 const impossible=bytes.slice();new DataView(impossible.buffer).setUint32(40,0xffffffff,true);assert.throws(()=>decodeWav(impossible),/Truncated/);
 assert.throws(()=>encodeWav({sampleRate:48000,channels:[Float32Array.of(NaN)]}),/non-finite/);
 const floats=encodeWav(audio,{bitDepth:32,float:true});new DataView(floats.buffer).setFloat32(56,NaN,true);assert.throws(()=>decodeWav(floats),/non-finite/);
 assert.throws(()=>encodeWav(audio,{bitDepth:24,float:true}),/32/);
});
