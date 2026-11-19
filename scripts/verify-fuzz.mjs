/** Release gate: deterministic bounded corpora, saved reports and explicit invariants. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const directory='test-results/audits';await mkdir(directory,{recursive:true});
const cases=[
 ['audio', ['scripts/fuzz-audio.mjs','--out='+directory+'/audio.json']],
 ['live-audio',['scripts/fuzz-live-audio.mjs','--out='+directory+'/live-audio.json']],
 ['macro',['tests/fuzz/macros.mjs',directory+'/macro.json']],
 ['audacity',['tests/fuzz/interchange-baseline.mjs','--out',directory+'/audacity.json']],
 ['reaper',['tests/fuzz/reaper-interchange.mjs',directory+'/reaper.json']],
 ['api-baseline',['scripts/audit-api-baseline.mjs']],
 ['companion',['tests/fuzz/companion.mjs',directory+'/companion.json']],
];
const results=[];
for(const [name,args]of cases){
 const start=Date.now();await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:'inherit',shell:false});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(name+' fuzz exited '+code)));});
 const report=JSON.parse(await readFile(directory+'/'+name+'.json','utf8'));
 assert.equal((report.failures||report.unexpected||report.findings||[]).length,0,name+' findings');
 if(name==='audacity'){
  assert.equal(report.globalPrototypeIntact,true);
  for(const family of Object.values(report.families)){assert.equal(family.invalidAccepted,0);assert.equal(family.inputMutations,0);}
  for(const focused of report.focused)assert.equal(focused.outcome,focused.id==='binary-writer-reader-depth-boundary'?'accepted':'rejected',focused.id);
 }
 results.push({name,elapsedMs:Date.now()-start,status:'passed',report:name+'.json'});
}
await writeFile(directory+'/fuzz-summary.json',JSON.stringify({status:'passed',results},null,2)+'\n');
console.log('Every deterministic fuzz corpus and regression invariant passed.');
