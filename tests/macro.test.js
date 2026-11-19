import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMacro, validateMacro, formatMacro, stepsToMacro, macroToSteps, MacroRunner } from '../src/macro.js';
import { coreCommandDescriptors, validateCommandParams } from '../src/command-schema.js';
import { CommandRuntime } from '../src/command-runtime.js';
import { ActionRecorder } from '../src/macro-recorder.js';
import { AudioEditor, COMMANDS } from '../src/engine.js';
const catalog=coreCommandDescriptors(COMMANDS);
test('silent analysis is usable as JSON-compatible null dB data in macros',async()=>{
  const {runner,editor}=fixture();
  const result=await runner.run('audio.generate({duration:.01,amplitude:0}); let stats=analysis.stats({}); if(stats.peakDb===null){track.update({name:"silent"});}');
  assert.equal(result.variables.stats.peakDb,null);assert.equal(result.variables.stats.rmsDb,null);assert.equal(editor.getState().tracks[0].name,'silent');
  await assert.rejects(runner.run('let x=1;',{variables:{invalid:-Infinity}}),/finite/);
});
test('typed core runtime preserves legacy recipe aliases and serialized project loading',async()=>{
  for(const params of [{commands:[{method:'track.add'}]},{steps:[{method:'track.add'}]},{recipe:[{method:'track.add'}]},{recipe:{steps:[{method:'track.add'}]}}]){
    const {runtime,editor}=fixture();await runtime.execute('recipe.run',params);assert.equal(editor.getState().tracks.length,1);
    const saved=await runtime.execute('project.save');await runtime.execute('project.new');await runtime.execute('project.load',{project:JSON.stringify(saved)});assert.equal(editor.getState().tracks.length,1);
  }
});
function fixture(){
  const editor=new AudioEditor({sampleRate:8000});
  const runtime=new CommandRuntime({coreExecute:editor.execute.bind(editor),coreCommands:COMMANDS,getState:editor.getState.bind(editor)});
  const runner=new MacroRunner({execute:runtime.execute.bind(runtime),getCommands:()=>runtime.commands(),getContext:()=>({project:editor.getState()})});
  return{editor,runtime,runner};
}
test('macro variables, all loop kinds, branching, own-property access and actual PCM operations',async()=>{
  const {editor,runner}=fixture();
  const result=await runner.run('audio.generate({duration:.02,amplitude:.5,frequency:500}); let sum=0; for (x of [1,2,3]) { if(x==2){continue;} sum+=x; } let count=0; while(count<3){count+=1;if(count===2){break;}} repeat(2){effect.gain({db:-3});} let s=analysis.stats({}); if(s.peakDb<(-10) && count===2){track.update({name:"processed"});} else {track.update({name:"wrong"});}');
  assert.equal(result.variables.sum,4);assert.equal(result.variables.count,2);assert.equal(editor.getState().tracks[0].name,'processed');
  assert.ok(result.variables.s.peakDb>(-13)&&result.variables.s.peakDb<(-11));assert.equal(result.completedSteps,5);
});
test('canonical text preserves structured programs and simple visual step meaning',()=>{
  const text='let n=2; repeat(n){if(n>1){effect.gain({db:-3});}else{effect.reverse({});}}';
  assert.deepEqual(parseMacro(formatMacro(parseMacro(text))).body.map(x=>x.type),['VariableDeclaration','RepeatStatement']);
  assert.equal(macroToSteps(text),null);
  const rendered=stepsToMacro([{method:'file.import',paramsSource:'{input:input,replace:true}'},{method:'effect.gain',params:{db:-1}}]);
  assert.equal(macroToSteps(rendered)[0].params,undefined);assert.equal(macroToSteps(rendered)[1].params.db,-1);
  assert.throws(()=>stepsToMacro([{method:'effect.gain',paramsSource:'{}); track.remove({}); effect.gain({}'}]));
});
test('syntax, command names, static arguments and unavailable capabilities preflight before any edit',async()=>{
  for(const tail of ['while (','unknown.command({});','effect.gain({db:999});','effect.apply({effect:"gain",params:{db:999}});','wait({seconds:1,beats:1});','break;','let x=missing;']){
    const {editor,runner}=fixture();await assert.rejects(runner.run('audio.generate({duration:.01});'+tail));assert.equal(editor.getState().tracks.length,0,tail);
  }
  let calls=0;const runner=new MacroRunner({execute:async()=>calls++,getCommands:()=>[{method:'audio.input.start',available:false}]});
  await assert.rejects(runner.run('audio.input.start({});'),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(calls,0);
});
test('dynamic command arguments validated even with a permissive injected command handler',async()=>{
  let calls=0;const runner=new MacroRunner({execute:async()=>calls++,getCommands:()=>catalog});
  await assert.rejects(runner.run('let x=999; effect.gain({db:x});'),error=>error.code==='INVALID_ARGUMENT'&&error.completedSteps===0);
  assert.equal(calls,0);
});
test('forbidden ambient execution, prototype keys and getters never execute',async()=>{
  for(const source of ['eval("1");','Function("return 1");','globalThis.fetch({});','let x = { "__proto__": 1 };','let x = [].constructor;','let x = a["constructor"];']){
    const runner=new MacroRunner({execute:async()=>{throw new Error('must not execute');},getContext:()=>({a:{}})});
    await assert.rejects(runner.run(source),source);
  }
  let hit=false;const variables={};Object.defineProperty(variables,'x',{enumerable:true,get(){hit=true;return 1;}});
  const runner=new MacroRunner({execute:async()=>null});await assert.rejects(runner.run('let y=1;',{variables}));assert.equal(hit,false);
});
test('parser and external AST paths reject excessive depth, cycles and unknown nodes',()=>{
  for(const source of [
    'if(true){} else '.repeat(300)+'{}',
    'let x='+('1+'.repeat(2000))+'1;',
    'let x='+('a.'.repeat(500))+'b;',
    'let x='+('('.repeat(100))+'1'+(')'.repeat(100))+';',
  ])assert.throws(()=>parseMacro(source),error=>error.name==='MacroError');
  const ast={type:'Program',body:[]};ast.body.push(ast);assert.throws(()=>formatMacro(ast),{name:'MacroError'});
  assert.equal(validateMacro({type:'Program',body:[{type:'Evil'}]},catalog).valid,false);
});
test('runtime bounds stop empty infinite loops and aggregate variable growth',async()=>{
  const runner=new MacroRunner({execute:async()=>null});
  await assert.rejects(runner.run('while(true){}',{limits:{iterations:20}}),{code:'RESOURCE_LIMIT'});
  await assert.rejects(runner.run('let x="0123456789";repeat(15){x=x+x;}',{limits:{valueBytes:1024}}),{code:'RESOURCE_LIMIT'});
  await assert.rejects(runner.run('let a=items; let b=items; let c=items;',{variables:{items:Array(80).fill(0)},limits:{valueNodes:200}}),{code:'RESOURCE_LIMIT'});
  await assert.rejects(runner.run('let x=1;',{limits:{sourceBytes:4}}),{name:'MacroError'});
});
test('cancel interrupts a wait, preserves completed edits, and permits a later run',async()=>{
  const {editor,runner}=fixture();const promise=runner.run('audio.generate({duration:.01});wait({seconds:30});track.remove({});',{onEvent:event=>{if(event.type==='step')runner.cancel();}});
  await assert.rejects(promise,error=>error.code==='ABORTED'&&error.completedSteps===1);assert.equal(editor.getState().tracks.length,1);
  assert.equal((await runner.run('effect.reverse({});')).completedSteps,1);
});
test('busy lock includes asynchronous preflight and canceled input does not mutate',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);let calls=0;
  const runner=new MacroRunner({execute:async()=>calls++,getCommands:async()=>{await pending;return catalog;}});
  const first=runner.run('track.add({});');await assert.rejects(runner.run('track.add({});'),{code:'MACRO_BUSY'});runner.cancel();release();
  await assert.rejects(first,{code:'ABORTED'});assert.equal(calls,0);
});
test('wait by beats reads the current project tempo and accepts zero duration',async()=>{
  const runner=new MacroRunner({execute:async()=>null,getContext:()=>({project:{bpm:60}})});
  const start=Date.now();const result=await runner.run('wait({beats:.01});wait({seconds:0});');assert.equal(result.completedSteps,2);assert.ok(Date.now()-start>=5);
});
test('runtime validates schemas, reports success once, prevents duplicate nested recording',async()=>{
  const {runtime}=fixture();runtime.register({method:'test.composite',schema:{type:'object',additionalProperties:false},description:'Nested semantic operation'},async(params,context)=>{await context.execute('track.add',{name:'nested'});return 'done';});
  runtime.recorder.start();const events=[];runtime.subscribe(event=>events.push(event));
  await runtime.execute('test.composite',{}, {origin:'ui'});
  assert.equal(events.length,2);assert.equal(runtime.recorder.stop().steps.length,1);
  await assert.rejects(runtime.execute('track.add',{name:42}),{code:'INVALID_ARGUMENT'});
  runtime.subscribe(()=>{throw new Error('observer');});assert.equal(await runtime.execute('test.composite'), 'done');
  runtime.dispose();await assert.rejects(runtime.execute('project.state'),{code:'DISPOSED'});
});
test('recorded aliases, timing, exact clicked-track export and script roundtrip',()=>{
  const recorder=new ActionRecorder();recorder.start({timing:true});
  const event=(method,params,startedAt,completedAt)=>recorder.capture({method,params,startedAt,completedAt,descriptor:{recordable:true},origin:'ui',context:{selectedTrackId:'a',selectedClipId:'b'}});
  event('file.import',{input:'alias-1',replace:true},0,200);
  event('selection.set',{trackId:'a',clipId:'b',start:0,end:1},1200,1300);
  event('file.export',{trackId:'other',scope:'track',format:'wav'},1400,1500);
  const result=recorder.stop();assert.equal(result.steps[0].params,undefined);assert.match(result.text,/"input": input/);
  assert.equal(result.steps[1].method,'wait');assert.equal(result.steps[1].params.seconds,1);
  assert.equal(result.steps[2].params.trackId,undefined);assert.equal(result.steps[4].params.trackId,'other');
  assert.doesNotThrow(()=>parseMacro(result.text));
});
test('schema validates creative effect ranges and rejects accessor data atomically',()=>{
  const gain=catalog.find(x=>x.method==='effect.gain'), echo=catalog.find(x=>x.method==='effect.echo');
  assert.throws(()=>validateCommandParams({db:37},gain));assert.throws(()=>validateCommandParams({timeMs:5},echo));
  assert.doesNotThrow(()=>validateCommandParams({effect:'gain'},catalog.find(x=>x.method==='effect.apply')));
  let hit=false;const params={};Object.defineProperty(params,'db',{enumerable:true,get(){hit=true;return 0;}});
  assert.throws(()=>validateCommandParams(params,gain));assert.equal(hit,false);
});
test('recorder excludes credentials and never turns completed work into failure',()=>{
  const recorder=new ActionRecorder();recorder.start();recorder.capture({method:'companion.connect',params:{token:'not-saved'},descriptor:{recordable:false}});
  assert.equal(recorder.getState().count,0);recorder.capture({method:'test.action',params:{token:'not-saved'},descriptor:{recordable:true}});
  assert.equal(recorder.getState().recording,false);assert.ok(recorder.getState().error);assert.doesNotMatch(recorder.getState().text,/not-saved/);
});


test('partial static validation catches invalid known fields before an earlier edit',async()=>{
  const {editor,runner}=fixture();
  await assert.rejects(runner.run('track.add({name:"before"});effect.gain({db:999,bpm:project.bpm});'));
  assert.equal(editor.getState().tracks.length,0);
  await assert.rejects(runner.run('track.add({name:"before"});effect.gain({typo:project.bpm});'));assert.equal(editor.getState().tracks.length,0);
});
test('dynamic failure identifies command and source location after completed operations',async()=>{
  const {editor,runner}=fixture();
  await assert.rejects(runner.run('track.add({});\nlet db=999; effect.gain({db:db});'),error=>{
    assert.equal(error.command,'effect.gain');assert.equal(error.line,2);assert.ok(error.column>1);assert.equal(error.completedSteps,1);return true;
  });assert.equal(editor.getState().tracks.length,1);
});
test('AST getters, dot-property injection and oversized formatted output are rejected',()=>{
  let calls=0;const ast={get type(){calls++;return 'Program';},body:[]};assert.throws(()=>formatMacro(ast));assert.equal(calls,0);
  const poisoned=parseMacro('let a=x.y;');poisoned.body[0].init.property.value='y; track.remove({}); //';assert.throws(()=>formatMacro(poisoned));
  const giant=parseMacro('let x="a";');giant.body[0].init.value='x'.repeat(131073);assert.throws(()=>formatMacro(giant),{code:'RESOURCE_LIMIT'});
});
test('sparse arrays and aggregate binary payloads are rejected without stack errors',async()=>{
  const runner=new MacroRunner({execute:async()=>null});
  await assert.rejects(runner.run('let x=1;',{variables:{sparse:new Array(200000)}}),error=>error.name==='MacroError');
  const one=new Uint8Array(1024*1024);assert.throws(()=>validateCommandParams({buffers:Array(300).fill(one)},{schema:{type:'object'}}),/aggregate binary/);
});
test('nested AST accessors and array-owned methods never run during data validation',async()=>{
  let hits=0;const ast=parseMacro('repeat(1){}');
  Object.defineProperty(ast.body[0].body,'type',{get(){hits++;return 'BlockStatement';},enumerable:true});
  assert.throws(()=>formatMacro(ast));assert.equal(hits,0);
  const values=[1];values.map=()=>{hits++;return [];};
  const runner=new MacroRunner({execute:async()=>null});
  await assert.rejects(runner.run('let x=1;',{variables:{values}}));assert.equal(hits,0);
});
