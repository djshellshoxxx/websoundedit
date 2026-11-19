import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecoder } from 'libopus-wasm';
import { createOggPage, oggCrc, encodeOpus, probeOpus } from '../src/opus.js';

const RATE = 48000;
const signal = (frames, channels=2) => ({ sampleRate: RATE,
  channels: Array.from({length:channels}, (_, c) => Float32Array.from({length:frames}, (_, i) => Math.sin(2*Math.PI*(c?880:440)*i/RATE)*0.4)) });
function independentCrc(bytes) {
  let register = 0;
  for(const byte of bytes) {
    register ^= byte << 24;
    for(let bit=0;bit<8;bit++) register = register & 0x80000000 ? (register << 1) ^ 0x04c11db7 : register << 1;
  }
  return register>>>0;
}
function parseOgg(bytes) {
  const pages=[],packets=[]; let offset=0;
  while(offset<bytes.length) {
    const view=new DataView(bytes.buffer,bytes.byteOffset+offset,bytes.byteLength-offset);
    assert.equal(new TextDecoder().decode(bytes.subarray(offset,offset+4)),'OggS');
    const laces=bytes.subarray(offset+27,offset+27+bytes[offset+26]);
    const size=27+laces.length+laces.reduce((sum,n)=>sum+n,0),page=bytes.slice(offset,offset+size);
    const crc=view.getUint32(22,true);page.fill(0,22,26);assert.equal(independentCrc(page),crc);
    const record={flags:bytes[offset+5],sequence:view.getUint32(18,true),serial:view.getUint32(14,true),granule:Number(view.getBigUint64(6,true)),laces:[...laces]};
    pages.push(record);
    let payload=offset+27+laces.length,start=payload;
    for(const length of laces) {payload+=length;if(length<255){packets.push(bytes.slice(start,payload));start=payload;}}
    assert.equal(start,payload,'No partial packets should be emitted by this muxer.');
    offset+=size;
  }
  assert.equal(offset,bytes.length);
  return {pages,packets};
}
async function decodePackets(bytes) {
  const {pages,packets}=parseOgg(bytes),head=packets[0],view=new DataView(head.buffer,head.byteOffset,head.byteLength);
  assert.equal(new TextDecoder().decode(head.subarray(0,8)),'OpusHead');
  assert.equal(new TextDecoder().decode(packets[1].subarray(0,8)),'OpusTags');
  const channels=head[9],preSkip=view.getUint16(10,true),frames=pages.at(-1).granule-preSkip;
  const decoder=await createDecoder({channels,sampleRate:RATE});
  try {
    const decoded=packets.slice(2).map(packet=>decoder.decodeFloat(packet));
    const pcm=new Float32Array(decoded.reduce((sum,data)=>sum+data.length,0));let offset=0;
    for(const data of decoded){pcm.set(data,offset);offset+=data.length;}
    return {channels,frames,preSkip,pcm:pcm.slice(preSkip*channels,(preSkip+frames)*channels),pages};
  } finally {decoder.free();}
}

test('Ogg page uses non-reflected CRC, exact-255 terminator laces, and 64-bit granules',()=>{
  const page=createOggPage([new Uint8Array(255).fill(1),new Uint8Array(510).fill(2),Uint8Array.of(3)],{serial:42,sequence:12,granule:4294967296+123,flags:4});
  const {pages,packets}=parseOgg(page);
  assert.deepEqual(pages[0].laces,[255,0,255,255,0,1]);
  assert.equal(pages[0].granule,4294967296+123);assert.equal(pages[0].sequence,12);
  assert.deepEqual(packets.map(p=>p.length),[255,510,1]);
  const clean=page.slice();clean.fill(0,22,26);assert.equal(oggCrc(clean),independentCrc(clean));
  assert.throws(()=>createOggPage([new Uint8Array(65025)],{serial:1,sequence:0,granule:0}),/255-segment/);
});
test('full-complexity dedicated encoder probes mono and stereo without FFmpeg',async()=>{
  const result=await probeOpus();assert.equal(result.available,true);assert.match(result.version,/libopus/);assert.equal(result.complexity,10);assert.deepEqual(result.channels,[1,2]);
});
test('Opus pre-skip and final trim preserve subframe, odd and exact-frame sample counts for mono/stereo',async()=>{
  for(const channels of [1,2])for(const frames of [1,17,647,648,649,960,961,48001]) {
    const input=signal(frames,channels),bytes=await encodeOpus(input),decoded=await decodePackets(bytes);
    assert.equal(decoded.channels,channels);assert.equal(decoded.frames,frames);assert.equal(decoded.pcm.length,frames*channels);
    assert.ok(decoded.pcm.every(Number.isFinite));assert.ok(decoded.preSkip>0);
    assert.equal(decoded.pages[0].flags,2);assert.equal(decoded.pages[0].granule,0);assert.equal(decoded.pages[1].granule,0);assert.equal(decoded.pages.at(-1).flags,4);
    decoded.pages.forEach((page,i)=>{assert.equal(page.sequence,i);assert.equal(page.serial,decoded.pages[0].serial);});
  }
});
test('long stereo Opus crosses multiple pages with monotonic granules and preserves distinct channels',async()=>{
  const input=signal(48000*3+123,2),progress=[];
  const decoded=await decodePackets(await encodeOpus(input,{bitrate:192,onProgress:p=>progress.push(p)}));
  assert.ok(decoded.pages.length>=5);assert.equal(decoded.frames,input.channels[0].length);
  for(let i=3;i<decoded.pages.length;i++)assert.ok(decoded.pages[i].granule>decoded.pages[i-1].granule);
  assert.equal(progress[0],0);assert.equal(progress.at(-1),1);for(let i=1;i<progress.length;i++)assert.ok(progress[i]>=progress[i-1]);
  const energyAt=(channel,frequency)=>{let re=0,im=0;for(let i=2400;i<decoded.frames-2400;i++){const value=decoded.pcm[i*2+channel],phase=2*Math.PI*frequency*i/RATE;re+=value*Math.cos(phase);im+=value*Math.sin(phase);}return re*re+im*im;};
  assert.ok(energyAt(0,440)>energyAt(0,880)*100);assert.ok(energyAt(1,880)>energyAt(1,440)*100);
  let error=0,total=0;for(let i=2400;i<decoded.frames-2400;i++)for(let c=0;c<2;c++){error+=(decoded.pcm[i*2+c]-input.channels[c][i])**2;total+=input.channels[c][i]**2;}
  assert.ok(10*Math.log10(total/error)>15,'Lossy reconstruction should align with the original after pre-skip.');
});
test('high-complexity noise and anti-phase stereo encode without a memory trap',async()=>{
  const frames=48000*2+77,left=new Float32Array(frames);let random=741;
  for(let i=0;i<frames;i++){random^=random<<13;random^=random>>>17;random^=random<<5;left[i]=((random>>>0)/4294967296*2-1)*.8;}
  const input={sampleRate:RATE,channels:[left,Float32Array.from(left,x=>-x)]};
  const out=await decodePackets(await encodeOpus(input,{bitrate:320}));
  assert.equal(out.frames,frames);assert.equal(out.channels,2);assert.ok(out.pcm.every(Number.isFinite));
  let cross=0,l2=0,r2=0;for(let i=1000;i<frames-1000;i++){const l=out.pcm[i*2],r=out.pcm[i*2+1];cross+=l*r;l2+=l*l;r2+=r*r;}
  assert.ok(cross/Math.sqrt(l2*r2)<-.95);
});
const nativeAvailable=spawnSync('ffmpeg',['-version'],{stdio:'ignore',timeout:10000}).status===0&&spawnSync('ffprobe',['-version'],{stdio:'ignore',timeout:10000}).status===0;
test('independent native FFmpeg/ffprobe accept Ogg Opus and decode exact duration/channel count',{skip:!nativeAvailable},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'websoundedit-opus-'));
  try {
    for(const channels of [1,2])for(const frames of [17,960,96001]) {
      const path=join(directory,`${channels}-${frames}.opus`);await writeFile(path,await encodeOpus(signal(frames,channels)));
      const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,sample_rate,channels','-of','json',path],{encoding:'utf8',timeout:15000})).streams[0];
      assert.equal(metadata.codec_name,'opus');assert.equal(+metadata.sample_rate,RATE);assert.equal(metadata.channels,channels);
      const pcm=execFileSync('ffmpeg',['-v','error','-threads','1','-i',path,'-f','f32le','-acodec','pcm_f32le','pipe:1'],{maxBuffer:4*1024*1024,timeout:15000});
      assert.equal(pcm.length,frames*channels*4,`${channels}ch / ${frames} frames`);
      if(frames>1000) {
        let power=0;for(let i=0;i<pcm.length;i+=4){const value=pcm.readFloatLE(i);assert.ok(Number.isFinite(value));power+=value*value;}
        assert.ok(Math.sqrt(power/(frames*channels))>.2);
      }
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('Opus validates input and releases encoder on cancellation',async()=>{
  await assert.rejects(encodeOpus({...signal(10),sampleRate:44100}),/48 kHz/);
  await assert.rejects(encodeOpus({sampleRate:RATE,channels:[Float32Array.of(NaN)]}),/non-finite/);
  await assert.rejects(encodeOpus(signal(0)),/nonempty/);
  await assert.rejects(encodeOpus(signal(10),{bitrate:Infinity}),/bitrate/);
  const abort=new AbortController();
  await assert.rejects(encodeOpus(signal(RATE*2),{signal:abort.signal,onProgress:()=>abort.abort()}),{name:'AbortError'});
  assert.ok((await encodeOpus(signal(17))).length>0);
});
