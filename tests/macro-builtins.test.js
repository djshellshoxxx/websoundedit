import test from 'node:test';
import assert from 'node:assert/strict';
import { MacroRunner, parseMacro, validateMacro, formatMacro } from '../src/macro.js';
import { MACRO_BUILTINS } from '../src/macro-builtins.js';
import { MACRO_EXAMPLES, BATCH_AUDIO_FORMATS, batchConversionScript } from '../src/macro-examples.js';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { CommandRuntime } from '../src/command-runtime.js';
import { NodeWorkbench } from '../scripts/node-runtime.mjs';
import { encodeWav, decodeWav } from '../src/wav.js';
import { decodeAudioBytes } from '../scripts/node-codecs.mjs';

const runner = () => new MacroRunner({ execute: () => { throw new Error('Data tools must not invoke the host.'); } });
const fixture = () => {
  const editor = new AudioEditor({ sampleRate: 8000 });
  const runtime = new CommandRuntime({ coreExecute: editor.execute.bind(editor), coreCommands: COMMANDS, getState: editor.getState.bind(editor) });
  const run = new MacroRunner({ execute: runtime.execute.bind(runtime), getCommands: () => runtime.commands() });
  return { editor, runtime, run };
};
const example = id => MACRO_EXAMPLES.find(item => item.id === id).text;

test('strings matching operators, punctuation or keywords remain literal data', async () => {
  const values = ['-', '+', '!', ']', '}', ')', 'if', 'else', 'repeat', 'while', 'for', 'break', 'continue', '=', ',', ';', '&&'];
  const source = 'let values=' + JSON.stringify(values) + '; let joined="take"+"-"+"one";';
  const result = await runner().run(source);
  assert.deepEqual(result.variables.values, values); assert.equal(result.variables.joined, 'take-one');
  assert.deepEqual((await runner().run(formatMacro(parseMacro(source)))).variables, result.variables);
  for (const value of values) assert.equal((await runner().run(JSON.stringify(value) + ';')).lastResult, null);
});

test('seeded random floats match a golden sequence and each execution has independent state', async () => {
  const source = 'random.seed({seed:1}); let a=random.float({}); let b=random.float({}); let c=random.float({});';
  const shared = runner(), first = await shared.run(source), second = await shared.run(source);
  assert.deepEqual([first.variables.a, first.variables.b, first.variables.c], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  assert.deepEqual(first.variables, second.variables);
  const textSeed = 'random.seed({seed:"音色 🎵"}); let values=[];repeat(8){values=array.append({values:values,value:random.int({min:-4,max:4})});}';
  assert.deepEqual((await runner().run(textSeed)).variables.values, (await runner().run(textSeed)).variables.values);
});

test('nested loops, random integers, choice and shuffle produce bounded repeatable data without modifying arrays', async () => {
  const result = await runner().run(`random.seed({seed: 73}); let original=[1,2,3,4,5]; let chosen=random.choice({values:original}); let shuffled=array.shuffle({values:original}); let matrix=[];
    for(row of array.range({start:0,end:8})){let cells=[];repeat(8){cells=array.append({values:cells,value:random.int({min:-7,max:7})});}matrix=array.append({values:matrix,value:cells});}
    let tiny=random.float({min:1,max:1.0000000000000002}); let endpoints=[];
    repeat(80){endpoints=array.append({values:endpoints,value:random.int({min:0,max:1})});}`);
  assert.deepEqual(result.variables.original, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.variables.shuffled.slice().sort(), [1, 2, 3, 4, 5]);
  assert.notDeepEqual(result.variables.shuffled, result.variables.original);
  assert.ok(result.variables.original.includes(result.variables.chosen));
  assert.equal(result.variables.matrix.length, 8); assert.ok(result.variables.matrix.every(row => row.length === 8 && row.every(value => Number.isInteger(value) && value >= -7 && value <= 7)));
  assert.equal(result.variables.tiny, 1); assert.deepEqual([...new Set(result.variables.endpoints)].sort(), [0, 1]);
});

test('array helpers preserve input and nested values, slice correctly and use numeric sorting', async () => {
  const { variables: v } = await runner().run(`let source=[3,20,-1,3]; let copy=array.set({values:source,index:1,value:8}); let appended=array.append({values:copy,value:{nested:[9]}});
    let joined=array.concat({arrays:[[1,2],[],[3,4]]}); let middle=array.slice({values:source,start:1,end:-1}); let reversed=array.reverse({values:source});
    let sorted=array.sort({values:source}); let descending=array.sort({values:source,descending:true}); let empty=array.range({start:3,end:0});
    let count=array.length({values:appended}); let backwards=array.range({start:5,end:-2,step:-2}); let total=array.sum({values:[.1,.2,.3]}); let mean=array.mean({values:[3,6,9]});`);
  assert.deepEqual(v.source, [3, 20, -1, 3]); assert.deepEqual(v.copy, [3, 8, -1, 3]); assert.deepEqual(v.appended[4].nested, [9]);
  assert.deepEqual(v.joined, [1, 2, 3, 4]); assert.deepEqual(v.middle, [20, -1]); assert.deepEqual(v.reversed, [3, -1, 20, 3]);
  assert.deepEqual(v.sorted, [-1, 3, 3, 20]); assert.deepEqual(v.descending, [20, 3, 3, -1]); assert.deepEqual(v.empty, []);
  assert.deepEqual(v.backwards, [5, 3, 1, -1]); assert.equal(v.count, 5); assert.ok(Math.abs(v.total - .6) < 1e-15); assert.equal(v.mean, 6);
});

test('math and literal text tools compose in arguments with finite, typed results', async () => {
  const { variables: v } = await runner().run(`let numbers=[-2.4,3.7,9]; let absolute=math.abs({value:-4}); let ceil=math.ceil({value:-2.4}); let floor=math.floor({value:3.7});
    let rounded=math.round({value:1.23456,digits:3}); let root=math.sqrt({value:81}); let power=math.pow({base:2,exponent:10});
    let min=math.min({values:numbers});let max=math.max({values:numbers});let clamped=math.clamp({value:6,min:-1,max:1});let lerp=math.lerp({start:-4,end:8,amount:.25});
    let gain=math.dbToGain({db:-6});let db=math.gainToDb({gain:gain});let silence=math.gainToDb({gain:0});
    let upper=text.upper({value:"Straße"});let lower=text.lower({value:"AUDIO"});let trim=text.trim({value:"  take  "});
    let textValue=text.join({values:["take",3,true,null],separator:"-"});let parts=text.split({value:"a||b|",separator:"|"});
    let literal=text.replace({value:"aba",search:"a",replacement:"$&"});let once=text.replace({value:"aba",search:"a",replacement:"x",all:false});
    let numeric=text.number({value:" -1.25e2 "});let scalar=text.string({value:2.5});`);
  assert.deepEqual([v.absolute, v.ceil, v.floor, v.rounded, v.root, v.power, v.min, v.max, v.clamped, v.lerp], [4, -2, 3, 1.235, 9, 1024, -2.4, 9, 1, -1]);
  assert.ok(Math.abs(v.db + 6) < 1e-12); assert.equal(v.silence, null); assert.equal(v.upper, 'STRASSE'); assert.equal(v.lower, 'audio'); assert.equal(v.trim, 'take');
  assert.equal(v.textValue, 'take-3-true-null'); assert.deepEqual(v.parts, ['a', '', 'b', '']); assert.equal(v.literal, '$&b$&'); assert.equal(v.once, 'xba'); assert.equal(v.numeric, -125); assert.equal(v.scalar, '2.5');
});

test('invalid builtin inputs preflight before edits and dynamic failures include source locations', async () => {
  for (const bad of ['random.int({min:1.5,max:3});', 'random.choice({values:[]});', 'math.abs({value:"3"});', 'array.set({values:[],index:-1,value:0});', 'text.replace({value:"a",search:"",replacement:"b"});', 'random.float({typo:1});']) {
    const { run, editor } = fixture(); await assert.rejects(run.run('audio.generate({duration:.01});' + bad), { code: 'INVALID_ARGUMENT' }); assert.equal(editor.getState().tracks.length, 0, bad);
  }
  for (const bad of ['random.int({min:4,max:2});', 'random.float({min:2,max:2});', 'array.range({end:1,step:0});', 'array.set({values:[1],index:1,value:2});', 'array.sort({values:[1,"x"]});', 'math.sqrt({value:-1});', 'math.pow({base:10,exponent:999});', 'text.number({value:"12hz"});', 'math.clamp({value:2,min:4,max:1});']) {
    await assert.rejects(runner().run('\n' + bad), error => error.code === 'INVALID_ARGUMENT' && error.line === 2 && Boolean(error.command));
  }
});

test('large helper results and helper work share the reduced execution and memory budgets', async () => {
  await assert.rejects(runner().run('let x=array.range({end:1000000000});'), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(runner().run('let x=array.range({end:20});', { limits: { valueNodes: 16 } }), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(runner().run('let x=array.sort({values:input});', { variables: { input: Array.from({ length: 1000 }, (_, index) => -index) }, limits: { operations: 100 } }), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(runner().run('let x=text.replace({value:input,search:"a",replacement:input});', { variables: { input: 'a'.repeat(10000) } }), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(runner().run('let x=text.split({value:input,separator:","});', { variables: { input: ','.repeat(10001) } }), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(runner().run('repeat(10){repeat(10){let x=math.abs({value:-1});}}', { limits: { iterations: 20 } }), { code: 'RESOURCE_LIMIT' });
});

test('nested builtin calls cannot exceed a command budget then execute an outer audio edit', async () => {
  const { editor, run } = fixture();
  await assert.rejects(run.run('audio.generate({duration:math.abs({value:-.01})});', { limits: { commands: 1 } }), error => error.code === 'RESOURCE_LIMIT' && error.completedSteps === 1);
  assert.equal(editor.getState().tracks.length, 0);
  const result = await run.run('audio.generate({duration:math.abs({value:-.01})});', { limits: { commands: 2 } });
  assert.equal(result.completedSteps, 2); assert.equal(editor.getState().tracks.length, 1);
});

test('builtins cannot be shadowed by host descriptors and cancellation stops helper-heavy loops', async () => {
  let hostCalls = 0; const run = new MacroRunner({ execute: () => hostCalls++, getCommands: () => [{ method: 'random.float', available: true }] });
  assert.equal((await run.run('random.seed({seed:1}); let n=random.float({});')).variables.n, .6270739405881613); assert.equal(hostCalls, 0);
  await assert.rejects(run.run('repeat(10000){let a=array.shuffle({values:[1,2,3]});}', { onEvent: event => { if (event.completedSteps === 3) run.cancel(); } }), error => error.code === 'ABORTED' && error.completedSteps === 3);
  assert.equal((await run.run('let value=math.abs({value:-3});')).variables.value, 3);
});

test('helper work yields to an asynchronously requested cancellation between commands', async () => {
  const controller = new AbortController();
  let timeoutId, timerRan = false;
  try {
    await assert.rejects(runner().run('repeat(1000){array.reverse({values:input});}', {
      variables: { input: Array.from({ length: 123 }, (_, row) => Array.from({ length: 30 }, (_, column) => row + column)) },
      signal: controller.signal,
      onEvent: event => {
        if (event.type === 'step' && event.completedSteps === 1) timeoutId = setTimeout(() => { timerRan = true; controller.abort(); }, 0);
      },
    }), error => error.code === 'ABORTED' && error.completedSteps > 0 && error.completedSteps < 1000);
    assert.equal(timerRan, true);
  } finally { clearTimeout(timeoutId); }
});

test('all example scripts parse and format, data examples execute, and conversion builders use only allowed formats', async () => {
  assert.equal(MACRO_BUILTINS.length, 35); assert.ok(Object.isFrozen(MACRO_BUILTINS[0].schema.properties));
  for (const item of MACRO_EXAMPLES) assert.doesNotThrow(() => parseMacro(formatMacro(parseMacro(item.text))), item.id);
  assert.equal(validateMacro(parseMacro(example('array-workbench')), []).valid, true);
  const { variables } = await runner().run(example('array-workbench'));
  assert.equal(variables.count, 6); assert.equal(variables.rows.length, 6); assert.ok(variables.rows.every(row => row.length === 3)); assert.equal(variables.averageGain, -31 / 6);
  assert.equal(BATCH_AUDIO_FORMATS.length, 10);
  for (const format of BATCH_AUDIO_FORMATS) assert.match(batchConversionScript({ format }), new RegExp(`format: "${format}"`));
  assert.match(batchConversionScript({ format: 'flac', presetId: 'auto-limiter', normalize: true }), /effect\.preset.*\n.*effect\.normalize.*\n.*file\.export/);
  assert.throws(() => batchConversionScript({ format: 'unknown' })); assert.throws(() => batchConversionScript({ presetId: '"); project.new({});' }));
});

test('sound-bank and conditional-cleanup examples process real audio', async () => {
  const { run, editor } = fixture(); await run.run(example('nested-sound-bank'));
  const clips = editor.getState().tracks.flatMap(track => track.clips); assert.equal(clips.length, 6); assert.ok(clips.every(clip => clip.frames === 960));
  const original = await editor.execute('clip.getAudio'); await run.run(example('conditional-cleanup')); const changed = await editor.execute('clip.getAudio');
  assert.equal(changed.channels[0].length, original.channels[0].length); assert.ok(Math.max(...changed.channels[0].map(Math.abs)) < .9);
});

test('batch conversion examples export real WAV/FLAC/MP3 files and preserve the source project', async () => {
  const editor = new AudioEditor({ sampleRate: 8000 }), workbench = new NodeWorkbench({ editor });
  const pcm = { sampleRate: 8000, channels: [Float32Array.from({ length: 1600 }, (_, frame) => .2 * Math.sin(2 * Math.PI * 400 * frame / 8000))] };
  await workbench.execute('clip.add', { name: 'Keep this session', audio: pcm }); const original = await workbench.execute('project.save');
  const input = workbench.supply(encodeWav(pcm), { name: 'take.wav' });
  for (const id of ['batch-wav', 'batch-multiformat']) {
    const result = await workbench.execute('macro.batch', { text: example(id), inputIds: [input.id] }); assert.equal(result.results[0].success, true);
    assert.deepEqual(await workbench.execute('project.save'), original);
  }
  const artifacts = [...workbench.artifacts.values()]; assert.equal(artifacts.length, 4);
  for (const artifact of artifacts) {
    const decoded = artifact.ext === 'wav' ? decodeWav(artifact.bytes) : await decodeAudioBytes(artifact.bytes, { sampleRate: 8000 });
    assert.equal(decoded.channels.length, 1); assert.equal(decoded.channels[0].length, 1600); assert.ok(Math.max(...decoded.channels[0].map(Math.abs)) > .1);
  }
});

test('seeded variation example produces six WAV artifacts and restores exact PCM using its undo steps', async () => {
  const editor = new AudioEditor({ sampleRate: 8000 }), workbench = new NodeWorkbench({ editor });
  const pcm = { sampleRate: 8000, channels: [Float32Array.from({ length: 1600 }, (_, frame) => .2 * Math.sin(2 * Math.PI * 500 * frame / 8000))] };
  await workbench.execute('clip.add', { audio: pcm });
  await workbench.execute('macro.run', { text: example('seeded-variations') });
  assert.equal(workbench.artifacts.size, 6);
  assert.deepEqual((await workbench.execute('clip.getAudio')).channels, pcm.channels);
  for (const output of workbench.artifacts.values()) { const decoded = decodeWav(output.bytes); assert.equal(decoded.channels[0].length, 1600); assert.ok(Math.max(...decoded.channels[0].map(Math.abs)) < .19); }
});
