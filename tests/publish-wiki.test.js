import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishWiki, readWikiSources, validateWikiContext, verifyWikiPublic, verifyWikiHTML, WIKI_REMOTE, WIKI_REPOSITORY, WIKI_LIMITS } from '../scripts/publish-wiki.mjs';

const execute = promisify(execFile), TOKEN = 'fake_wiki_test_token_not_a_credential';
const context = () => ({...process.env,GITHUB_REPOSITORY:WIKI_REPOSITORY,GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_TOKEN:TOKEN});
const localGit = async (args, cwd, env=process.env) => (await execute('git', ['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','core.autocrlf=false','-c','commit.gpgsign=false',...args], {cwd,env:{...env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ALLOW_PROTOCOL:'file'},encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024})).stdout;

async function fixture(t, {targetSymlink=false, attributes=false}={}) {
  const directory = await mkdtemp(join(tmpdir(), 'websoundedit-wiki-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sourceDir=join(directory,'sources'), seed=join(directory,'seed'), remote=join(directory,'wiki.git');
  await mkdir(sourceDir); await mkdir(seed);
  await writeFile(join(sourceDir,'Home.md'), '# Published home\n');
  await writeFile(join(sourceDir,'User-Guide.md'), '# Published guide\n');
  await writeFile(join(sourceDir,'Developer-Guide.md'), '# Published developer guide\n');
  await writeFile(join(sourceDir,'_Sidebar.md'), '* [Home](Home)\n* [User Guide](User-Guide)\n');
  await localGit(['init','--bare','--initial-branch=master',remote],directory);
  await localGit(['init','--initial-branch=master'],seed);
  await localGit(['config','user.name','Wiki Test'],seed);
  await localGit(['config','user.email','wiki-test@example.invalid'],seed);
  if(targetSymlink) await symlink(join(directory,'outside.md'),join(seed,'Home.md'));
  else await writeFile(join(seed,'Home.md'),'# Previous home\n');
  await writeFile(join(seed,'Human-Notes.md'),'Human-owned page stays byte-identical.\n');
  if(attributes) await writeFile(join(seed,'.gitattributes'),'*.md text eol=lf\n');
  await localGit(['add','--all'],seed); await localGit(['commit','-m','Initial human wiki'],seed);
  await localGit(['remote','add','origin',remote],seed); await localGit(['push','--set-upstream','origin','master'],seed);
  const original=(await localGit(['rev-parse','HEAD'],seed)).trim();
  const calls=[], requests=[];
  const git=async(args,options)=>{
    calls.push([...args]);
    assert.ok(!args.join('\n').includes(TOKEN),'token never appears in process arguments');
    assert.equal(options.env.GITHUB_TOKEN,undefined);
    assert.equal(options.env.WIKI_PUBLISH_TOKEN,TOKEN);
    assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');
    assert.equal(options.env.GIT_TRACE,undefined);
    const askpass=await readFile(options.env.GIT_ASKPASS,'utf8');
    assert.ok(!askpass.includes(TOKEN)); assert.match(askpass,/WIKI_PUBLISH_TOKEN/);
    assert.equal((await lstat(options.env.GIT_ASKPASS)).mode & 0o777,0o700);
    if(args[0]==='remote'&&args[1]==='get-url')return WIKI_REMOTE+'\n';
    const translated=args.map(value=>value===WIKI_REMOTE?remote:value);
    const result=await localGit(translated,options.cwd,options.env);
    if(args[0]==='push') assert.ok(!(await readFile(join(options.cwd,'.git','config'),'utf8')).includes(TOKEN));
    return result;
  };
  const fetcher=async(url,options)=>{
    requests.push(url); const target=new URL(url);
    assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,undefined); assert.equal(options.headers.authorization,undefined);
    assert.equal(options.credentials,undefined);
    assert.equal(target.searchParams.get('websoundedit_publish'),(await localGit(['rev-parse','HEAD'],remote)).trim());
    if(target.origin==='https://raw.githubusercontent.com') {
      assert.ok(target.pathname.startsWith('/wiki/'+WIKI_REPOSITORY+'/'));
      const name=decodeURIComponent(target.pathname.split('/').at(-1));
      return new Response(await localGit(['show','HEAD:'+name],remote),{headers:{'content-type':'text/plain; charset=utf-8'}});
    }
    assert.equal(target.origin,'https://github.com');
    assert.ok(['/wiki','/wiki/User-Guide','/wiki/Developer-Guide'].some(path=>target.pathname==='/'+WIKI_REPOSITORY+path));
    const stem=target.pathname.endsWith('/wiki')?'Home':target.pathname.split('/').at(-1),content=await localGit(['show','HEAD:'+stem+'.md'],remote),heading=content.match(/^# (.+)$/m)[1];
    return new Response('<!doctype html><html><head><title>'+stem.replace(/-/g,' ')+' · '+WIKI_REPOSITORY+' Wiki · GitHub</title></head><body><h1>'+heading+'</h1></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  };
  const options={env:{...context(),GIT_TRACE:'1'},sourceDir,temporaryDirectory:directory,git,fetcher,verificationAttempts:1,wait:async()=>{}};
  return {directory,sourceDir,seed,remote,original,calls,requests,git,fetcher,options};
}

test('wiki publication refuses wrong repository/ref/SHA or missing token before transport',async()=>{
  let calls=0;
  for(const patch of [
    {GITHUB_REPOSITORY:'someone/else'}, {GITHUB_REF:'refs/pull/3/merge'}, {GITHUB_REF:'refs/heads/beta'},
    {GITHUB_SHA:'HEAD'}, {GITHUB_SHA:'A'.repeat(40)}, {GITHUB_TOKEN:''}, {GITHUB_TOKEN:'token\nextra'}
  ]) await assert.rejects(publishWiki({env:{...context(),...patch},git:async()=>calls++}),error=>['WIKI_CONTEXT','WIKI_TOKEN'].includes(error.code));
  assert.equal(calls,0);
  assert.equal(validateWikiContext(context()).sha,'a'.repeat(40));
});

test('normal publication preserves unrelated pages, uses a fast-forward push and verifies anonymous public bytes and pages',async t=>{
  const f=await fixture(t), result=await publishWiki(f.options);
  assert.equal(result.changed,true); assert.equal(result.pages.length,4);
  assert.equal(result.pages.filter(page=>page.pageUrl).length,3);
  assert.equal((await localGit(['show','HEAD:Human-Notes.md'],f.remote)),'Human-owned page stays byte-identical.\n');
  assert.equal((await localGit(['rev-parse','HEAD^'],f.remote)).trim(),f.original);
  for(const name of ['Home.md','User-Guide.md','Developer-Guide.md','_Sidebar.md']) assert.equal(await localGit(['show','HEAD:'+name],f.remote),await readFile(join(f.sourceDir,name),'utf8'));
  assert.deepEqual(f.calls.find(call=>call[0]==='push'),['push','--porcelain','origin','HEAD:refs/heads/master']);
  assert.equal(f.calls.filter(call=>call[0]==='clone').length,1);
  assert.ok(f.calls[0].includes(WIKI_REMOTE));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(f.requests.length,7);
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('websoundedit-wiki-')),false);
  const count=f.calls.length, requests=f.requests.length;
  const unchanged=await publishWiki(f.options);
  assert.equal(unchanged.changed,false); assert.equal(unchanged.wikiCommit,result.wikiCommit);
  assert.equal(f.calls.slice(count).some(call=>call[0]==='push'||call.includes('commit')),false);
  assert.equal(f.requests.length-requests,7,'unchanged publication still verifies public visibility');
});

test('unavailable wiki fails actionably without leaking process output or altering sources',async t=>{
  const f=await fixture(t), source=await readFile(join(f.sourceDir,'Home.md'));
  await assert.rejects(publishWiki({...f.options,git:async()=>{throw Object.assign(new Error(TOKEN),{stderr:TOKEN});}}),error=>error.code==='WIKI_UNAVAILABLE'&&/create and save Home/.test(error.message)&&!error.message.includes(TOKEN));
  assert.deepEqual(await readFile(join(f.sourceDir,'Home.md')),source);
  assert.equal((await localGit(['rev-parse','HEAD'],f.remote)).trim(),f.original);
  assert.equal(f.requests.length,0);
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('websoundedit-wiki-')),false);
});

test('empty wiki repository is never initialized by the publisher',async t=>{
  const f=await fixture(t), empty=join(f.directory,'empty.git');
  await localGit(['init','--bare','--initial-branch=master',empty],f.directory);
  await assert.rejects(publishWiki({...f.options,git:async(args,options)=>{
    if(args[0]==='clone')return localGit(args.map(value=>value===WIKI_REMOTE?empty:value),options.cwd,options.env);
    return f.git(args,options);
  }}),error=>error.code==='WIKI_UNINITIALIZED'&&/initial Home page/.test(error.message));
  assert.equal(await localGit(['show-ref'],empty).catch(()=>''),'');
  assert.equal(f.calls.some(call=>call[0]==='add'||call[0]==='push'||call.includes('commit')),false);
  assert.equal(f.requests.length,0);
});

test('wiki target symlink is rejected before staging or push',async t=>{
  const f=await fixture(t,{targetSymlink:true});
  const outside=join(f.directory,'outside.md'); await writeFile(outside,'Outside file unchanged.\n');
  await assert.rejects(publishWiki(f.options),{code:'WIKI_TARGET'});
  assert.equal(await readFile(outside,'utf8'),'Outside file unchanged.\n');
  assert.equal((await localGit(['rev-parse','HEAD'],f.remote)).trim(),f.original);
  assert.equal(f.calls.some(call=>call[0]==='add'||call[0]==='push'),false);
});

test('source symlinks, directories, unsafe names, invalid text and size budgets are rejected',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'websoundedit-wiki-input-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const run=async(setup)=>{const source=await mkdtemp(join(directory,'case-'));for(const name of ['Home.md','User-Guide.md','Developer-Guide.md','_Sidebar.md'])await writeFile(join(source,name),'# Page\n');await setup(source);await assert.rejects(readWikiSources(source),{code:'WIKI_SOURCE'});};
  await run(source=>symlink(join(source,'Home.md'),join(source,'Alias.md')));
  await run(source=>mkdir(join(source,'nested')));
  await run(source=>writeFile(join(source,'Bad Name.md'),'bad'));
  await run(source=>writeFile(join(source,'home.md'),'case collision'));
  await run(source=>writeFile(join(source,'Home.md'),Buffer.from([0xff])));
  await run(source=>writeFile(join(source,'Home.md'),'NUL\0text'));
  await run(source=>writeFile(join(source,'Home.md'),'No heading here.\n'));
  await run(source=>writeFile(join(source,'Home.md'),'# A **formatted** heading\n'));
  await run(source=>writeFile(join(source,'Home.md'),'x'.repeat(WIKI_LIMITS.pageBytes+1)));
  await run(async source=>{for(let i=0;i<9;i++)await writeFile(join(source,'Page-'+i+'.md'),'x'.repeat(WIKI_LIMITS.pageBytes));});
  await run(async source=>{for(let i=0;i<32;i++)await writeFile(join(source,'Page-'+i+'.md'),'# Page\n');});
});

test('every required guide and sidebar must exist before publication transport',async t=>{
  const f=await fixture(t);
  for(const name of ['Home.md','User-Guide.md','Developer-Guide.md','_Sidebar.md']) {
    const path=join(f.sourceDir,name), bytes=await readFile(path);
    await rm(path);
    await assert.rejects(publishWiki(f.options),error=>error.code==='WIKI_SOURCE'&&error.message.includes(name));
    await writeFile(path,bytes);
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.requests.length,0);
});

test('concurrent wiki update rejects publication instead of force pushing or rebasing',async t=>{
  const f=await fixture(t);let intervened=false;
  await assert.rejects(publishWiki({...f.options,git:async(args,options)=>{
    if(args[0]==='push'&&!intervened){intervened=true;await writeFile(join(f.seed,'Human-Notes.md'),'Concurrent human edit.\n');await localGit(['add','Human-Notes.md'],f.seed);await localGit(['commit','-m','Human updated wiki'],f.seed);await localGit(['push','origin','master'],f.seed);}
    return f.git(args,options);
  }}),{code:'WIKI_PUSH'});
  assert.equal(await localGit(['show','HEAD:Home.md'],f.remote),'# Previous home\n');
  assert.equal(await localGit(['show','HEAD:Human-Notes.md'],f.remote),'Concurrent human edit.\n');
  assert.equal(f.calls.filter(call=>call[0]==='push').length,1);
  assert.equal(f.calls.some(call=>call.some(arg=>arg.includes('force')||arg==='rebase')),false);
  assert.equal(f.requests.length,0);
});

test('Git content transformations are detected before any push',async t=>{
  const f=await fixture(t,{attributes:true});await writeFile(join(f.sourceDir,'Home.md'),'# Windows newlines\r\n');
  await assert.rejects(publishWiki(f.options),{code:'WIKI_CONTENT'});
  assert.equal(f.calls.some(call=>call[0]==='push'),false);
  assert.equal((await localGit(['rev-parse','HEAD'],f.remote)).trim(),f.original);
});

test('successful push is not reported as published when anonymous public verification fails',async t=>{
  const f=await fixture(t);
  await assert.rejects(publishWiki({...f.options,fetcher:async()=>new Response('not found',{status:404})}),{code:'WIKI_VERIFY'});
  assert.equal(f.calls.filter(call=>call[0]==='push').length,1,'push happened but verification failure remains fatal');
  assert.equal((await readdir(f.directory)).some(name=>name.startsWith('websoundedit-wiki-')),false);
});

test('public verification rejects wrong raw bytes, oversized bodies, redirects and non-HTML pages; retries are bounded',async()=>{
  const files=[{name:'Home.md',bytes:Buffer.from('# Home\n'),sha256:'test'}], commit='b'.repeat(40);
  for(const fetcher of [
    async()=>new Response('# Wrong\n'),
    async()=>new Response('x'.repeat(100)),
    async()=>new Response('',{status:302,headers:{location:'https://example.invalid/login'}}),
    async url=>url.includes('raw.githubusercontent.com')?new Response('# Home\n'):new Response('not html',{headers:{'content-type':'text/plain'}})
  ])await assert.rejects(verifyWikiPublic(files,{commit,fetcher,attempts:1}),{code:'WIKI_VERIFY'});
  let calls=0, waits=0;
  await assert.rejects(verifyWikiPublic(files,{commit,fetcher:async()=>{calls++;return new Response('missing',{status:404});},attempts:3,wait:async milliseconds=>{assert.equal(milliseconds,5000);waits++;}}),{code:'WIKI_VERIFY'});
  assert.equal(calls,3); assert.equal(waits,2);
});

test('public HTML must identify the expected wiki page and render its source heading',async()=>{
  const file={name:'User-Guide.md',bytes:Buffer.from('# User guide & reference\n'),sha256:'test'},commit='c'.repeat(40);
  const title='User Guide · '+WIKI_REPOSITORY+' Wiki · GitHub';
  const document=(pageTitle,body)=>'<!doctype html><html><head><title>'+pageTitle+'</title></head><body>'+body+'</body></html>';
  const cases=[
    document('Sign in to GitHub','<h1>Sign in</h1>'),
    document('User Guide · someone/else Wiki · GitHub','<h1>User guide &amp; reference</h1>'),
    document('Home · '+WIKI_REPOSITORY+' Wiki · GitHub','<h1>User guide &amp; reference</h1>'),
    document(title,'<h1>Sign in</h1>'),
    document(title,'<!-- <h1>User guide &amp; reference</h1> -->'),
    document(title,'<script>const hidden="<h1>User guide &amp; reference</h1>";</script>'),
    document(title,'&lt;h1&gt;User guide &amp; reference&lt;/h1&gt;')
  ];
  for(const html of cases) {
    assert.throws(()=>verifyWikiHTML(Buffer.from(html),file),{code:'WIKI_VERIFY'});
    await assert.rejects(verifyWikiPublic([file],{commit,attempts:1,fetcher:async url=>new Response(url.includes('raw.githubusercontent.com')?file.bytes:html,{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}})}),{code:'WIKI_VERIFY'});
  }
  verifyWikiHTML(Buffer.from(document(title.replaceAll('·','&#183;'),'<h1 class="heading"><a href="#user-guide"></a> User guide &amp; reference </h1>')),file);
});
