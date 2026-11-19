import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeMetadata, ffmpegMetadataArgs, metadataWarnings } from '../src/metadata.js';
import { encodeWav, decodeWav } from '../src/wav.js';
import { encodeOpus } from '../src/opus.js';
import { encodeAudioBytes } from '../scripts/node-codecs.mjs';

test('metadata accepts bounded Unicode text and rejects unknown, nested and control values', () => {
  assert.deepEqual(normalizeMetadata({title:'  Café  ', track:3, comment:'One\nTwo', artist:''}),{title:'Café',track:'3',comment:'One\nTwo'});
  for(const input of [{title:'a\0b'}, {title:{}}, {title:'a'.repeat(1025)}, JSON.parse('{"__proto__":"bad"}')]) assert.throws(()=>normalizeMetadata(input));
  const args=ffmpegMetadataArgs({title:'$(echo unsafe) `not executed` = ok',artist:'X'},'mp3');
  assert.deepEqual(args,['-map_metadata','-1','-metadata','title=$(echo unsafe) `not executed` = ok','-metadata','artist=X']);
  assert.match(metadataWarnings({title:'A'},'aac')[0],/does not embed/);
  assert.match(metadataWarnings({albumArtist:'A'},'wav')[0],/albumArtist/);
});
test('WAV RIFF INFO tags round-trip without changing float audio samples', () => {
  const audio={sampleRate:48000,channels:[Float32Array.of(-1.5,0,.2,.7)]},metadata={title:'Café & tone',artist:'Producer',album:'Album',date:'2026',track:'2/12',genre:'Electronic',comment:'One\nTwo',copyright:'© 2026'};
  const decoded=decodeWav(encodeWav(audio,{bitDepth:32,float:true,metadata}));
  assert.deepEqual(decoded.metadata,metadata);delete decoded.metadata;assert.deepEqual(decoded,audio);
});
let native=false;try{execFileSync('ffprobe',['-version'],{stdio:'ignore'});native=true;}catch{}
test('independent ffprobe reads embedded WAV, MP3, FLAC, M4A, AIFF and Opus tags', {skip:!native}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'websoundedit-tags-'));
  try {
    const audio={sampleRate:48000,channels:[Float32Array.from({length:4800},(_,i)=>Math.sin(i*.1)*.3)]},metadata={title:'Tag test',artist:'Producer',album:'Album',date:'2026',track:'2/12',comment:'Notes'};
    for(const format of ['wav','mp3','flac','m4a','aiff','opus']) {
      const bytes=format==='opus'?await encodeOpus(audio,{metadata}):await encodeAudioBytes(audio,{format,metadata,bitDepth:16});
      const path=join(dir,`test.${format}`);await writeFile(path,bytes);
      const data=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{encoding:'utf8'}));
      const tags=Object.fromEntries(Object.entries({...data.format.tags,...data.streams[0].tags}).map(([key,value])=>[key.toLowerCase(),value]));
      assert.equal(tags.title,metadata.title,format);assert.equal(tags.artist,metadata.artist,format);assert.equal(data.streams[0].channels,1,format);
      assert.ok(Math.abs(Number(data.format.duration)-.1)<.07,format);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
