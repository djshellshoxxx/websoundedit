/** Runs only in the verified main publication job with a repository-scoped token. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
const execute=promisify(execFile),tag='v1.0.0-beta.1',repository=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA;
if(repository!=='djshellshoxxx/websoundedit'||process.env.GITHUB_REF!=='refs/heads/main'||!sha||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Release publication requires the verified main job.');
const packageInfo=JSON.parse(await readFile('package.json','utf8'));
if('v'+packageInfo.version!==tag)throw new Error('Release tag and package version differ.');
async function api(path){return JSON.parse((await execute('gh',['api',path],{maxBuffer:1024*1024})).stdout);}
let ref;
try{ref=await api('repos/'+repository+'/git/ref/tags/'+tag);}catch(error){if(!/HTTP 404|Not Found/.test(error.stderr||''))throw error;}
if(ref){
 let object=ref.object;
 for(let depth=0;object.type==='tag'&&depth<4;depth++)object=(await api('repos/'+repository+'/git/tags/'+object.sha)).object;
 if(object.type!=='commit'||object.sha!==sha)throw new Error('The existing beta tag points to another commit; refusing to replace it.');
 const release=await api('repos/'+repository+'/releases/tags/'+tag);
 if(!release.prerelease||release.draft)throw new Error('Existing release is not the expected published prerelease.');
 for(const name of ['websoundedit-web-1.0.0-beta.1.zip','websoundedit-companion-1.0.0-beta.1.tar.gz','SHA256SUMS.txt','RELEASE_NOTES.md'])if(!release.assets.some(asset=>asset.name===name))throw new Error('Existing beta release is incomplete: '+name);
 console.log('The exact verified commit is already published: '+release.html_url);
}else{
 const args=['release','create',tag,'--repo',repository,'--target',sha,'--prerelease','--title','WebSoundEdit 1.0 beta','--notes-file','docs/releases/1.0.0-beta.1.md',
 'artifacts/websoundedit-web-1.0.0-beta.1.zip','artifacts/websoundedit-companion-1.0.0-beta.1.tar.gz','artifacts/SHA256SUMS.txt','artifacts/RELEASE_NOTES.md'];
 console.log((await execute('gh',args,{maxBuffer:1024*1024})).stdout);
}
