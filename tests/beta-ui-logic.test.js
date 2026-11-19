import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { encodeWav, decodeWav } from '../src/wav.js';
import { readProjectZip } from '../src/project-archive.js';
import { BrowserFileIO, safeFilename, uniqueFilename } from '../src/file-ui.js';
import { FILE_COMMANDS } from '../src/file-commands.js';
import { CommandRuntime } from '../src/command-runtime.js';
import { MacroPanel, normalizeMacroSettings } from '../src/macro-ui.js';
import { normalizeWorkbenchPreferences } from '../src/options-ui.js';
import { LiveAudioRuntime } from '../src/live-audio.js';
import { createRackEffect } from '../src/rack-config.js';
import { decodeAudioFile } from '../src/codecs.js';
import { MidiActionEdges, normalizeMidiActions } from '../src/midi-actions.js';

const SR = 8000;
const pcm = (value = .2, frames = 800) => ({ sampleRate: SR, channels: [new Float32Array(frames).fill(value)] });
const mapping = (extra = {}) => normalizeMidiActions([{ id: 'pedal-a', kind: 'cc', channel: 0, number: 64, threshold: 64, debounceMs: 250, action: { method: 'loop.capture.toggle', params: { beats: 4 } }, ...extra }]);
test('MIDI pedal edges debounce presses, ignore releases and keep input devices independent', () => {
  const edges = new MidiActionEdges(), mappings = mapping();
  const input = (value, now, inputId = 'a', armed = true) => edges.update({ type:'cc',channel:0,controller:64,value,inputId }, mappings, { armed, now });
  assert.equal(input(127, 0).length, 1); assert.equal(input(127, 10).length, 0);
  assert.equal(input(0, 20).length, 0); assert.equal(input(127, 100).length, 0);
  assert.equal(input(0, 200).length, 0); assert.equal(input(127, 300).length, 1);
  assert.equal(input(127, 301, 'b').length, 1);
  edges.reset(); assert.equal(input(127, 900, 'a', false).length, 0);
  assert.equal(input(127, 1000).length, 0, 'arming a held pedal must not synthesize a new edge');
  input(0, 1001); assert.equal(input(127, 1002).length, 1);
});
test('MIDI note actions use velocity-zero/note-off as release and definitions omit armed state', () => {
  const source = { id:'pad',kind:'note',channel:2,number:60,threshold:1,debounceMs:0,armed:true,action:{macroId:'macro-1'} };
  const mappings = normalizeMidiActions([source]), edges = new MidiActionEdges();
  assert.equal(Object.hasOwn(mappings[0], 'armed'), false);
  assert.equal(edges.update({type:'noteon',channel:2,note:60,velocity:100},mappings,{armed:true,now:0}).length,1);
  assert.equal(edges.update({type:'noteoff',channel:2,note:60,velocity:80},mappings,{armed:true,now:1}).length,0);
  assert.equal(edges.update({type:'noteon',channel:2,note:60,velocity:0},mappings,{armed:true,now:2}).length,0);
  assert.equal(edges.update({type:'noteon',channel:2,note:60,velocity:1},mappings,{armed:true,now:3}).length,1);
  for (const extra of [{channel:16},{number:-1},{threshold:0},{threshold:128},{debounceMs:Infinity},{action:{method:'transport.stop',macroId:'m'}}]) assert.throws(() => mapping(extra));
  assert.equal(source.armed,true);
});
test('portable preferences and macros preserve definitions without importing permission or trigger arming', () => {
  const preferences = normalizeWorkbenchPreferences({ tooltips:false,input:{deviceId:'usb',channels:[0,1],gainDb:-3,monitor:true,active:true},output:{deviceId:'out',monitorLayout:'5.1'},token:'secret',streaming:true });
  assert.equal(preferences.tooltips,false); assert.deepEqual(preferences.input.channels,[0,1]);
  assert.equal(Object.hasOwn(preferences.input,'monitor'),false); assert.equal(Object.hasOwn(preferences,'token'),false);
  assert.throws(() => normalizeWorkbenchPreferences({input:{channels:[0,0]}}));
  assert.equal(normalizeWorkbenchPreferences().import.layout,'auto');
  assert.equal(normalizeWorkbenchPreferences({import:{layout:'5.1'}}).import.layout,'5.1');
  assert.throws(() => normalizeWorkbenchPreferences({import:{layout:'unknown'}}),/Auto/);
  const macros = normalizeMacroSettings({macros:[{id:'m',name:'Trim',text:'effect.gain({db:-2});',shortcut:'ctrl+shift+1'}],onImportId:'m',onImportArmed:true,shortcutsArmed:true});
  assert.equal(macros.onImportId,'m'); assert.equal(Object.hasOwn(macros,'onImportArmed'),false);
  assert.throws(() => normalizeMacroSettings({macros:[...macros.macros,{...macros.macros[0],id:'m2'}]}),/unique/);
});
test('safe stem names are case-insensitively unique and never contain traversal or device names', () => {
  const used = new Set();
  assert.equal(uniqueFilename('../CON', 'wav', used).includes('/'),false);
  assert.equal(safeFilename('NUL'), 'audio'); assert.equal(safeFilename('x\\y\0z'), 'x-y-z');
  assert.equal(uniqueFilename('Kick','wav',used),'Kick.wav'); assert.equal(uniqueFilename('kick','wav',used),'kick (2).wav');
  assert.ok(safeFilename('a'.repeat(99)+'😀').length<=100);
});
function filesFor(editor) {
  return new BrowserFileIO({ getState:()=>editor.getState(),getProject:trackId=>editor.execute(trackId?'project.saveTrack':'project.save',trackId?{trackId}:{}),executeCore:(method,params)=>editor.execute(method,params),executeLive:()=>{throw new Error('No live route in this fixture');},download:()=>{},importOne:async(file,params)=>editor.execute('clip.add',{name:file.name,audio:decodeWav(new Uint8Array(await file.arrayBuffer()))}) });
}
test('concrete export targets the clicked track, independent stems ignore mute/solo and align to project length', async () => {
  const editor = new AudioEditor({sampleRate:SR});
  const first = await editor.execute('clip.add',{name:'Bass / One',audio:pcm(.2,800)}),second = await editor.execute('clip.add',{name:'bass - one',audio:pcm(.7,400)});
  await editor.execute('track.update',{trackId:first.trackId,mute:true,gainDb:-6}); await editor.execute('track.update',{trackId:second.trackId,solo:true});
  const io = filesFor(editor), single = await io.export({scope:'track',trackId:first.trackId,respectMute:false,respectSolo:false,format:'wav',bitDepth:32,download:false});
  const expected = .2*10**(-6/20)*Math.SQRT1_2;
  assert.ok(Math.abs(decodeWav(single.bytes).channels[0][100]-expected)<1e-6);
  const archive = await io.exportStems({format:'wav',bitDepth:32,download:false});
  const entries = [...readProjectZip(archive.bytes)]; assert.equal(entries.length,2); assert.equal(new Set(entries.map(([name])=>name.toLowerCase())).size,2);
  for(const [name,bytes] of entries){assert.equal(name.includes('/'),false);assert.equal(decodeWav(bytes).channels[0].length,800);}
  assert.ok(Math.abs(decodeWav(entries[0][1]).channels[0][100]-expected)<1e-6);
  assert.equal(editor.getState().selectedTrackId,second.trackId);
});
test('file aliases are bounded and export collection rejects excess without retaining partial bytes', async () => {
  const editor=new AudioEditor({sampleRate:SR}),io=filesFor(editor),file=new File([encodeWav(pcm())],'a.wav');
  const [alias]=io.supply([file]); const result=await io.import({input:alias}); assert.ok(result.clipId); assert.deepEqual(result.clipIds,[result.id]);
  await assert.rejects(io.import({input:'http://example.test/audio.wav'}),/alias/);
  assert.throws(()=>io.supply(Array(129).fill(file)),/128/);
  io.beginCollection({limit:8}); io.emit({bytes:new Uint8Array(4),ext:'wav',mime:'audio/wav'},'a');
  assert.throws(()=>io.emit({bytes:new Uint8Array(5),ext:'wav',mime:'audio/wav'},'b'),/exceed/);
  const resultCollection=io.finishCollection();assert.equal(resultCollection.total,4);assert.equal(resultCollection.files.length,1);
  assert.ok(FILE_COMMANDS.every(command=>command.schema.additionalProperties===false));
});
test('audio replacement UI decodes first and rolls back the full project on invalid post-decode parameters', async () => {
  const text=await readFile(new URL('../src/app.js',import.meta.url),'utf8'),start=text.indexOf('async function importOne('),end=text.indexOf('\nfunction download(',start);
  const editor=new AudioEditor({sampleRate:SR});await editor.execute('clip.add',{name:'Keep me',audio:pcm(.3)});await editor.execute('selection.set',{start:.01,end:.05,channels:'all'});
  const before=await editor.execute('project.save');let calls=0;
  const context={state:editor.getState(),decodeAudioFile:async()=>pcm(.9),duration:audio=>audio.channels[0].length/audio.sampleRate,setBusy:()=>{},status:()=>{},demo:false};
  context.coreRaw=async(method,params)=>{calls++;const result=await editor.execute(method,params);context.state=editor.getState();return result;};
  const importOne=vm.runInNewContext('('+text.slice(start,end)+')',context);
  await assert.rejects(importOne({name:'new.wav'},{replace:true,name:'x'.repeat(201)}));
  assert.equal(calls,1);assert.deepEqual(await editor.execute('project.save'),before);
  context.decodeAudioFile=async()=>{throw new Error('bad source');};calls=0;
  await assert.rejects(importOne({name:'bad.wav'},{replace:true}),/bad source/);assert.equal(calls,0);assert.deepEqual(await editor.execute('project.save'),before);
});
test('macro batch isolates files, preserves the original selection and tears down before one restore on success and cancel', async () => {
  const previousDocument=globalThis.document;globalThis.document={querySelectorAll:()=>[],querySelector:()=>null};
  try{
    const editor=new AudioEditor({sampleRate:SR});await editor.execute('clip.add',{name:'Original',audio:pcm(.3)});await editor.execute('selection.set',{start:.02,end:.07,channels:'all'});
    const saved=await editor.execute('project.save'),runtime=new CommandRuntime({coreExecute:(m,p)=>editor.execute(m,p),coreCommands:COMMANDS,getState:()=>editor.getState()}),io=filesFor(editor);io.register(runtime);
    const inputs=io.supply([new File([encodeWav(pcm(.1))],'one.wav'),new File([encodeWav(pcm(.2))],'two.wav')]);let restores=0,teardowns=0,failTeardown=false;const importTrackCounts=[];
    const originalImport=io.importOne;io.importOne=async(...args)=>{importTrackCounts.push(editor.getState().tracks.length);return originalImport(...args);};
    const panel=new MacroPanel({runtime,routes:{register:()=>{},active:''},fileIO:io,getState:()=>editor.getState(),getProject:()=>editor.execute('project.save'),executeCore:(m,p)=>editor.execute(m,p),restoreProject:async project=>{assert.equal(teardowns,restores+1);restores++;await editor.execute('project.load',{project});},teardown:async()=>{teardowns++;if(failTeardown)throw new Error('Capture teardown failed');},persist:()=>{},download:()=>{}});panel.register();
    panel.settings.draft='effect.gain({db:-6}); file.export({format:"wav",scope:"track"});';
    const getProject=panel.getProject;let releaseSnapshot;panel.getProject=async()=>{await new Promise(resolve=>{releaseSnapshot=resolve;});return getProject();};
    const firstRun=panel.batch({inputIds:inputs.map(input=>input.id)});await assert.rejects(panel.batch({inputIds:[inputs[0].id]}),/already running/);releaseSnapshot();const result=await firstRun;panel.getProject=getProject;assert.equal(result.results.length,2);assert.deepEqual(importTrackCounts,[0,0]);assert.equal(panel.lastOutputs.length,2);assert.deepEqual(await editor.execute('project.save'),saved);assert.equal(restores,1);
    panel.settings.draft='wait({seconds:5}); effect.gain({db:-6});';const running=panel.batch({inputIds:inputs.map(input=>input.id)});setTimeout(()=>panel.cancel(),10);await assert.rejects(running,/cancel/i);assert.equal(restores,2);assert.equal(panel.running,false);assert.deepEqual(await editor.execute('project.save'),saved);
    panel.getProject=async()=>{await new Promise(resolve=>{releaseSnapshot=resolve;});return getProject();};const pendingSnapshot=panel.batch({inputIds:[inputs[0].id]});panel.cancel();releaseSnapshot();await assert.rejects(pendingSnapshot,/Stopped|cancel/i);panel.getProject=getProject;assert.equal(restores,3);assert.equal(panel.running,false);assert.deepEqual(await editor.execute('project.save'),saved);
    failTeardown=true;panel.settings.draft='effect.gain({db:-1});';await assert.rejects(panel.batch({inputIds:[inputs[0].id]}),/teardown failed/);assert.equal(restores,4);assert.equal(panel.running,false);assert.deepEqual(await editor.execute('project.save'),saved);
    panel.dispose();runtime.dispose();
  }finally{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});

test('project-replacing recipes prevalidate final live racks before any teardown or core mutation', async () => {
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8'),start=source.indexOf('function prepareRecipeReplacement('),end=source.indexOf('\nasync function core(',start);
  const editor=new AudioEditor({sampleRate:SR});await editor.execute('clip.add',{audio:pcm()});const project=await editor.execute('project.save');
  project.settings.live={version:1,racks:{master:{chain:[createRackEffect('filter')],automation:[]}}};
  const prepare=vm.runInNewContext('('+source.slice(start,end)+')',{settings:{theme:'studio'},macroPanel:null,validateSettings:value=>({value}),liveAudio:{validateSettings:(settings,options)=>LiveAudioRuntime.prototype.validateSettings.call({},settings,options)}});
  const loaded=prepare({commands:[{method:'project.new'},{method:'project.load',params:{project}}]});assert.equal(loaded.liveSettings.racks.master.chain[0].effect,'filter');
  const invalid=structuredClone(project);invalid.settings.live.racks.master.chain[0].wet=9;assert.throws(()=>prepare({steps:[{method:'project.new'},{method:'project.load',params:{project:invalid}}]}),/wet/);
  assert.throws(()=>prepare({commands:[{method:'project.load',params:{project}},{method:'settings.load',params:{settings:invalid.settings}}]}),/wet/);
  const empty=prepare({commands:[{method:'project.load',params:{project}},{method:'project.new'}]});assert.equal(empty.liveSettings.racks.master.chain.length,0);
});

test('explicit source layout reaches the real decoder through canonical file import without inferred surround or partial replacement', async () => {
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8'),start=source.indexOf('async function importOne('),end=source.indexOf('\nfunction download(',start);
  const editor=new AudioEditor({sampleRate:SR});await editor.execute('clip.add',{name:'Original',audio:pcm()});const before=await editor.execute('project.save');
  const audio={sampleRate:SR,layout:'5.1',channels:Array.from({length:6},(_,channel)=>new Float32Array(80).fill((channel+1)/16))},bytes=encodeWav(audio,{bitDepth:32,float:true});new DataView(bytes.buffer).setUint32(40,0,true);
  const context={state:editor.getState(),decodeAudioFile,duration:audio=>audio.channels[0].length/audio.sampleRate,setBusy:()=>{},status:()=>{},demo:false};
  context.coreRaw=async(method,params)=>{const result=await editor.execute(method,params);context.state=editor.getState();return result;};
  const importOne=vm.runInNewContext('('+source.slice(start,end)+')',context),io=filesFor(editor);io.importOne=importOne;
  const runtime=new CommandRuntime({coreExecute:(m,p)=>editor.execute(m,p),coreCommands:COMMANDS,getState:()=>editor.getState()});io.register(runtime);
  const [alias]=io.supply([new File([bytes],'maskless.wav')]);
  await assert.rejects(runtime.execute('file.import',{input:alias.id,replace:true}),/explicit channel layout/);assert.deepEqual(await editor.execute('project.save'),before);
  await assert.rejects(runtime.execute('file.import',{input:alias.id,replace:true,layout:'7.1'}),/channel|layout/i);assert.deepEqual(await editor.execute('project.save'),before);
  await assert.rejects(runtime.execute('file.import',{input:alias.id,layout:'auto'}),/allowed|one of|enum/i);
  const result=await runtime.execute('file.import',{input:alias.id,replace:true,layout:'5.1'});assert.ok(result.clipId);assert.deepEqual(await editor.execute('clip.getAudio'),audio);assert.equal(editor.getState().outputLayout,'stereo');
  runtime.dispose();
});

test('batch ownership blocks outside edits and exports through snapshot, execution and restore while ordinary macros remain interactive', async () => {
  const previousDocument=globalThis.document;globalThis.document={querySelectorAll:()=>[],querySelector:()=>null};
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
  try{
    const editor=new AudioEditor({sampleRate:SR});await editor.execute('clip.add',{name:'Original',audio:pcm(.3)});await editor.execute('selection.set',{start:.02,end:.07,channels:'all'});const original=await editor.execute('project.save');
    const runtime=new CommandRuntime({coreExecute:(method,params)=>editor.execute(method,params),coreCommands:COMMANDS,getState:()=>editor.getState()}),io=filesFor(editor);io.register(runtime);
    const file=new File([encodeWav(pcm(.1),{bitDepth:32,float:true})],'batch.wav'),[input]=io.supply([file]);
    let stepEntered=deferred(),stepRelease=deferred();const snapshotEntered=deferred(),snapshotRelease=deferred(),restoreEntered=deferred(),restoreRelease=deferred();let restores=0;
    runtime.register({method:'test.hold',schema:{type:'object',additionalProperties:false}},async(params,context)=>{await context.execute('effect.gain',{db:-6});stepEntered.resolve();await stepRelease.promise;return {done:true};});
    runtime.register({method:'ui.help',schema:{type:'object',additionalProperties:false}},()=>({opened:true}));
    runtime.register({method:'ui.options',schema:{type:'object',additionalProperties:false}},(params,context)=>context.execute('effect.gain',{db:-12}));
    runtime.register({method:'ui.project.save',schema:{type:'object',additionalProperties:false}},()=>({saved:true}));
    const panel=new MacroPanel({runtime,routes:{register:()=>{},active:''},fileIO:io,getState:()=>editor.getState(),getProject:async()=>{snapshotEntered.resolve();await snapshotRelease.promise;return editor.execute('project.save');},restoreProject:async project=>{restores++;restoreEntered.resolve();await restoreRelease.promise;await editor.execute('project.load',{project});},teardown:async()=>{},persist:()=>{},download:()=>{}});panel.register();panel.settings.draft='test.hold({});file.export({format:"wav",scope:"clip",raw:true,bitDepth:32});';
    const appSource=await readFile(new URL('../src/app.js',import.meta.url),'utf8'),picker=deferred();let exportDestinationCalls=0,archiveExportCalls=0;
    const exportRecording=vm.runInNewContext('('+appSource.slice(appSource.indexOf('async function exportRecording('),appSource.indexOf('\nfunction interactive('))+')',{macroPanel:panel,window:{showSaveFilePicker:()=>picker.promise},filename:value=>value,liveAudio:{setExportDestination:()=>{exportDestinationCalls++;}},core:()=>{archiveExportCalls++;},download:()=>{}});
    const pendingPicker=exportRecording({recordingId:'previous-recording'});
    const running=runtime.execute('macro.batch',{inputIds:[input.id]});await snapshotEntered.promise;
    const pickerBlocked=assert.rejects(pendingPicker,error=>error.code==='BUSY');picker.resolve({name:'late.wav'});await pickerBlocked;assert.equal(exportDestinationCalls,0);assert.equal(archiveExportCalls,0);
    const busy=async(method,params={},origin='ui')=>assert.rejects(runtime.execute(method,params,{origin}),error=>error.code==='BUSY');
    await busy('effect.gain',{db:-3});await busy('track.add',{name:'Outside'});await busy('selection.clear');await busy('history.undo');
    assert.equal((await runtime.execute('macro.status')).batch,true);assert.deepEqual(await runtime.execute('ui.help'),{opened:true});await busy('ui.options');assert.equal((await runtime.execute('project.state')).name,original.name);
    assert.throws(()=>io.supply([file]),error=>error.code==='BUSY');assert.deepEqual(io.aliases().map(alias=>alias.id),[input.id]);
    snapshotRelease.resolve();await stepEntered.promise;
    const ownedAudio=await editor.execute('clip.getAudio');assert.ok(Math.abs(ownedAudio.channels[0][0]-.1*10**(-6/20))<1e-6,'nested owner commands must execute');
    for(const origin of ['ui','api','midi','macro','internal','batch'])await busy('effect.gain',{db:-6},origin);
    await busy('file.import',{input:input.id});await busy('file.export',{format:'wav',scope:'clip',download:false});await busy('file.exportStems',{format:'wav',download:false});
    await assert.rejects(io.export({format:'wav',scope:'clip'}),error=>error.code==='BUSY');assert.throws(()=>io.emit({bytes:new Uint8Array(4),ext:'wav'},'outside'),error=>error.code==='BUSY');assert.throws(()=>io.finishCollection(),error=>error.code==='BUSY');
    assert.deepEqual(await editor.execute('clip.getAudio'),ownedAudio);assert.equal(io.collection.files.length,0);
    stepRelease.resolve();await restoreEntered.promise;await busy('track.update',{name:'Late outside edit'});await busy('file.export',{format:'wav',scope:'clip'});assert.equal(panel.isBatchRunning(),true);
    restoreRelease.resolve();const result=await running;assert.equal(result.outputCount,1);assert.equal(panel.lastOutputs.length,1);assert.equal(restores,1);assert.deepEqual(await editor.execute('project.save'),original);assert.equal(panel.isBatchRunning(),false);
    stepEntered=deferred();stepRelease=deferred();const ordinary=panel.run('test.hold({});');await stepEntered.promise;await runtime.execute('effect.gain',{db:-1},{origin:'midi'});stepRelease.resolve();await ordinary;assert.equal(panel.isBatchRunning(),false);
    const importEntered=deferred(),importRelease=deferred(),importOne=io.importOne;io.importOne=async(...args)=>{importEntered.resolve();await importRelease.promise;return importOne(...args);};
    const outsideImport=runtime.execute('file.import',{input:input.id});await importEntered.promise;await assert.rejects(runtime.execute('macro.batch',{inputIds:[input.id]}),error=>error.code==='BUSY');assert.equal(panel.isBatchRunning(),false);importRelease.resolve();await outsideImport;
    panel.settings.draft='ui.project.save({});';await assert.rejects(runtime.execute('macro.batch',{inputIds:[input.id]}),/semantic commands/);assert.equal(panel.isBatchRunning(),false);
    panel.dispose();runtime.dispose();
  }finally{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});
