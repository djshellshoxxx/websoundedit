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
    const result=await panel.batch({inputIds:inputs.map(input=>input.id)});assert.equal(result.results.length,2);assert.deepEqual(importTrackCounts,[0,0]);assert.equal(panel.lastOutputs.length,2);assert.deepEqual(await editor.execute('project.save'),saved);assert.equal(restores,1);
    panel.settings.draft='wait({seconds:5}); effect.gain({db:-6});';const running=panel.batch({inputIds:inputs.map(input=>input.id)});setTimeout(()=>panel.cancel(),10);await assert.rejects(running,/cancel/i);assert.equal(restores,2);assert.equal(panel.running,false);assert.deepEqual(await editor.execute('project.save'),saved);
    failTeardown=true;panel.settings.draft='effect.gain({db:-1});';await assert.rejects(panel.batch({inputIds:[inputs[0].id]}),/teardown failed/);assert.equal(restores,3);assert.equal(panel.running,false);assert.deepEqual(await editor.execute('project.save'),saved);
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
