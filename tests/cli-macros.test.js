import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeWav, decodeWav } from '../src/wav.js';
const execute=promisify(execFile),cli=resolve('scripts/cli.mjs');
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'websoundedit-cli-beta-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const input=()=>({sampleRate:8000,channels:[Float32Array.from({length:800},(_,i)=>i<160||i>=640?0:Math.sin(i*.2)*.2)]});
const source='effect.trimSilence({thresholdDb:-40,minDuration:.01,padding:0}); effect.normalize({targetDb:-3}); file.export({format:"wav",scope:"track",name:input.stem});';
test('CLI macros trim endpoints, normalize and export real PCM without overwriting existing outputs',()=>fixture(async root=>{
  const audio=join(root,'take.wav'),macro=join(root,'cleanup.wsemacro'),out=join(root,'exports');
  await writeFile(audio,encodeWav(input()));await writeFile(macro,source);await mkdir(out);await writeFile(join(out,'take.wav'),'existing');
  await execute(process.execPath,[cli,'--input',audio,'--macro',macro,'--output-dir',out,'--sample-rate','8000']);
  assert.equal(await readFile(join(out,'take.wav'),'utf8'),'existing');
  const decoded=decodeWav(new Uint8Array(await readFile(join(out,'take (2).wav'))));
  assert.ok(decoded.channels[0].length>=475&&decoded.channels[0].length<=480);assert.equal(decoded.sampleRate,8000);
  assert.ok(Math.abs(Math.max(...decoded.channels[0].map(Math.abs))-10**(-3/20)*Math.SQRT1_2)<.0001);
}));
test('CLI batch isolates valid files, continues after a bad file and reports partial failure',()=>fixture(async root=>{
  const a=join(root,'a.wav'),bad=join(root,'bad.wav'),b=join(root,'b.wav'),macro=join(root,'batch.wsemacro'),out=join(root,'exports');
  await writeFile(a,encodeWav(input()));await writeFile(b,encodeWav(input()));await writeFile(bad,'invalid');
  await writeFile(macro,'effect.normalize({targetDb:-6}); file.export({format:"wav",scope:"track",name:input.stem});');
  let failure;try{await execute(process.execPath,[cli,'--batch','--continue-on-error','--input',a,'--input',bad,'--input',b,'--macro',macro,'--output-dir',out]);}catch(error){failure=error;}
  assert.equal(failure?.code,1);assert.match(failure.stdout,/"success": false/);assert.match(failure.stdout,/"success": true/);
  assert.deepEqual((await readdir(out)).sort(),['a.wav','b.wav']);
  for(const name of ['a.wav','b.wav']){const pcm=decodeWav(new Uint8Array(await readFile(join(out,name))));assert.equal(pcm.channels.length,2);assert.equal(pcm.channels[0].length,4800);}
}));
test('CLI rejects invalid static macros before import or creation of any output file',()=>fixture(async root=>{
  const audio=join(root,'take.wav'),macro=join(root,'bad.wsemacro'),out=join(root,'exports');
  await writeFile(audio,encodeWav(input()));await writeFile(macro,'effect.normalize({targetDb:-3}); effect.gain({db:900}); file.export({});');
  await assert.rejects(execute(process.execPath,[cli,'--input',audio,'--macro',macro,'--output-dir',out]),error=>error.code===1&&/range/.test(error.stderr));
  assert.deepEqual(await readdir(out),[]);
}));
