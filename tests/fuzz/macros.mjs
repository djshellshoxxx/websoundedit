/** Independent deterministic Macro 1 / command-schema corpus.
 * node tests/fuzz/macros.mjs [report.json]
 * Generated source is interpreted only by MacroRunner, never eval/Function.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseMacro, formatMacro, validateMacro, MacroRunner, MACRO_LIMITS } from '../../src/macro.js';
import { coreCommandDescriptors, validateCommandParams } from '../../src/command-schema.js';
import { CommandRuntime } from '../../src/command-runtime.js';
import { COMMANDS } from '../../src/engine.js';

const SEEDS = { parser: 0x4d414331, programs: 0x4d414332, negative: 0x4d414333 };
function generator(seed) { let value = seed; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; }; }
const parserRandom = generator(SEEDS.parser), programRandom = generator(SEEDS.programs), negativeRandom = generator(SEEDS.negative);
const catalog = coreCommandDescriptors(COMMANDS), commands = new Map(catalog.map(command => [command.method, command]));
const counters = {
  parserCases: 0, parserAccepted: 0, parserRejected: 0, astRoundTrips: 0,
  oraclePrograms: 0, oraclePassed: 0, schemaValid: 0, schemaInvalid: 0,
  staticPreflight: 0, dynamicErrors: 0, executionBounds: 0, hostileData: 0,
  cases: 0, passed: 0, failed: 0, unexpectedRawErrors: 0,
  forbiddenGetterCalls: 0, ambientNetworkCalls: 0, prototypeMutations: 0,
  dataToolCases: 0,
};
const started = performance.now(), corpusHash = createHash('sha256'), failures = [], phaseTimes = {};
const sourceFilesSha256 = Object.fromEntries(await Promise.all(['src/macro.js', 'src/macro-builtins.js', 'src/command-schema.js', 'src/command-runtime.js', 'tests/fuzz/macros.mjs'].map(async file => [file, createHash('sha256').update(await readFile(new URL(`../../${file}`, import.meta.url))).digest('hex')])));
const encode = text => new TextEncoder().encode(text), semantic = value => {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'loc').map(([key, child]) => [key, semantic(child)]));
  return value;
};
function digest(value) { const text = typeof value === 'string' ? value : JSON.stringify(value); corpusHash.update(text); corpusHash.update('\0'); return createHash('sha256').update(text).digest('hex'); }
function failure(phase, index, error, source, hash) {
  counters.failed++;
  if (failures.length < 32) failures.push({ phase, index, sha256: hash, name: error.name, code: error.code, message: error.message, ...(typeof source === 'string' ? { source: source.slice(0, 3000), sourceTruncated: source.length > 3000 } : {}) });
}
async function exercise(phase, index, source, callback) {
  const hash = digest(source); counters.cases++;
  try { await callback(); counters.passed++; } catch (error) { failure(phase, index, error, source, hash); }
}
function rejected(error, code) {
  assert.ok(error, 'Expected a rejection');
  assert.ok(['MacroError', 'CommandValidationError', 'EditorError', 'Error'].includes(error.name), `Uncontrolled error type: ${error.name}`);
  if (code) assert.equal(error.code, code); return error;
}
async function captureFailure(action, code) { let caught; try { await action(); } catch (error) { caught = error; } return rejected(caught, code); }
const fakeRunner = (calls, extra = {}) => new MacroRunner({ execute: async (method, params) => { calls.push({ method, params }); return {}; }, getCommands: () => catalog, getContext: () => ({ external: 120 }), ...extra });
const originalFetch = globalThis.fetch, prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
globalThis.fetch = () => { counters.ambientNetworkCalls++; throw new Error('Unexpected ambient fetch'); };

try {
  // Syntax mutation: both structural mutations and arbitrary small UTF-16 edits.
  const bases = [
    'let x=1+2*3; let y=(x-2)/5; if(x>1 && y<=4){track.add({name:"A"});}',
    'repeat(3){effect.gain({db:-2});} while(false){break;}',
    'for(item of [1,2,3]){if(item==2){continue;}let n=item%2;}',
    'let o={"voice":"音色 🎵",numbers:[1,2,3]};let x=o.numbers[1];',
    'let s="quoted \\\"text\\\""; // line\n/* block */ let y=true||false;',
    'let values=analysis.stats({}); if(values.peakDb>-1){effect.normalize({targetDb:-1});}',
    'wait({seconds:0}); track.update({pan:.25,gainDb:-3});',
    'let a=1; if(a<0){} else if(a===1){a+=2;}else{a-=3;}',
    'let a=["-","+","!", "]", "if"];let b=text.join({values:a,separator:"-"});',
    'random.seed({seed:42});for(item of array.range({end:3})){let x=random.int({min:-4,max:4});}',
  ];
  const fragments = [';', '/*', '*/', '//', '\n', '\0', '"', "'", '.', '{}', '[]', '()', 'constructor', '__proto__', '=>', '1e999', '\\u0000', 'else', 'repeat', '!', '&&', '||', 'true', 'false'];
  const phaseStarted = performance.now();
  for (let index = 0; index < 4096; index++) {
    let source = bases[index % bases.length]; const at = parserRandom() % (source.length + 1), kind = parserRandom() % 8, fragment = fragments[parserRandom() % fragments.length];
    if (kind === 0) source = source.slice(0, at) + fragment + source.slice(at);
    else if (kind === 1) source = source.slice(0, at) + source.slice(at + 1 + parserRandom() % 8);
    else if (kind === 2) source = source.slice(0, at);
    else if (kind === 3) source = source.slice(0, at) + String.fromCharCode(parserRandom() & 255) + source.slice(at + 1);
    else if (kind === 4) source = `if (true) {${source}}`;
    else if (kind === 5) source += '\n' + fragment;
    else if (kind === 6) source = source.replaceAll(';', ';/* spaced */\n');
    else source = source.replaceAll(' ', '\t');
    counters.parserCases++; const hash = digest(source); counters.cases++;
    let ast;
    try { ast = parseMacro(source); counters.parserAccepted++; }
    catch (error) {
      counters.parserRejected++;
      if (error.name !== 'MacroError') { counters.unexpectedRawErrors++; failure('parser', index, error, source, hash); } else counters.passed++;
      continue;
    }
    try { const formatted = formatMacro(ast), parsed = parseMacro(formatted); assert.deepEqual(semantic(parsed), semantic(ast)); assert.equal(formatMacro(parsed), formatted); counters.astRoundTrips++; counters.passed++; }
    catch (error) { failure('parser-roundtrip', index, error, source, hash); }
  }
  phaseTimes.parserMs = Math.round(performance.now() - phaseStarted);

  // Numeric oracle is computed directly from generated scalar inputs, separately
  // from either AST representation or the interpreter's evaluation helpers.
  const programStarted = performance.now();
  for (let index = 0; index < 512; index++) {
    const a = programRandom() % 31 - 15, b = programRandom() % 19 + 1, n = programRandom() % 9 + 1, threshold = programRandom() % 11 - 5;
    const values = Array.from({ length: 5 }, () => programRandom() % 15 - 7), skip = programRandom() % 3, stop = programRandom() % 8 + 1;
    let expected = (a + b * 3) - (b - 2) * 2, k = 0;
    for (let i = 0; i < n; i++) expected += a > threshold ? a + i : b - i;
    for (const value of values) { if (value % 3 === skip) continue; expected += value; }
    while (k < n) { k++; if (k === stop) break; expected += k % 2 ? -k : k; }
    const truth = ((a < b) && (n >= 1)) || a === threshold, quotient = (a * b + n) / b;
    const source = `let result=(${a}+${b}*3)-(${b}-2)*2;let index=0;repeat(${n}){if(${a}>${threshold}){result+=${a}+index;}else{result+=${b}-index;}index+=1;}for(value of ${JSON.stringify(values)}){if(value%3===${skip}){continue;}result+=value;}let k=0;while(k<${n}){k+=1;if(k===${stop}){break;}if(k%2){result-=k;}else{result+=k;}}let truth=((${a}<${b})&&(${n}>=1))||(${a}===${threshold});let quotient=(${a}*${b}+${n})/${b};let fields={sum:result,ok:truth,list:[quotient,k]};let picked=fields.list[0];`;
    counters.oraclePrograms++;
    await exercise('oracle', index, source, async () => {
      const runner = new MacroRunner({ execute: async () => { throw new Error('Oracle programs must not dispatch commands'); } });
      const result = await runner.run(source);
      assert.equal(result.completedSteps, 0); assert.equal(result.variables.result, expected); assert.equal(result.variables.k, k); assert.equal(result.variables.index, n);
      assert.equal(result.variables.truth, truth); assert.equal(result.variables.quotient, quotient); assert.equal(result.variables.picked, quotient);
      assert.equal(result.variables.fields.sum, expected); counters.oraclePassed++;
    });
  }
  phaseTimes.oracleMs = Math.round(performance.now() - programStarted);

  const schemaStarted = performance.now();
  const schemaCases = [
    { method: 'effect.gain', good: r => ({ db: -96 + r % 133 }), bad: r => ({ db: r & 1 ? 37 + r % 100 : '1' }) },
    { method: 'track.update', good: r => ({ pan: (r % 201 - 100) / 100, gainDb: -10 }), bad: r => ({ pan: r & 1 ? 1.01 : null }) },
    { method: 'project.new', good: r => ({ name: `Seed ${r}`, sampleRate: [8000, 44100, 48000, 192000][r % 4], outputLayout: ['mono', 'stereo', '5.1', '7.1'][r % 4] }), bad: r => ({ sampleRate: r & 1 ? 7999 : 48000.25 }) },
    { method: 'audio.render', good: r => ({ scope: ['mix', 'track', 'clip', 'selection'][r % 4], outputLayout: 'stereo', respectMute: true }), bad: r => ({ scope: r & 1 ? 'all-tracks' : 2 }) },
    { method: 'clip.key', good: r => ({ tonic: r % 12, mode: r & 1 ? 'major' : 'minor' }), bad: r => ({ tonic: r & 1 ? 12 : -.1 }) },
    { method: 'selection.set', good: r => ({ start: (r % 10) / 10, end: 2, channels: [0, 1] }), bad: r => ({ channels: r & 1 ? [8] : 'surround' }) },
    { method: 'effect.eq', good: r => ({ bands: [{ frequency: 100 + r % 18000, gainDb: 0, q: 1, type: 'peaking' }] }), bad: r => ({ bands: [{ frequency: r & 1 ? 4 : 1000, gainDb: 37, q: 1 }] }) },
    { method: 'audio.generate', good: r => ({ duration: .01, frequency: 100 + r % 19000, amplitude: .25, type: 'tone' }), bad: r => ({ amplitude: r & 1 ? 1.01 : false }) },
  ];
  for (let index = 0; index < 256; index++) {
    const item = schemaCases[index % schemaCases.length], random = negativeRandom(), valid = index < 128, params = valid ? item.good(random) : item.bad(random);
    counters[valid ? 'schemaValid' : 'schemaInvalid']++;
    await exercise('schema', index, { method: item.method, valid, params }, () => {
      if (valid) validateCommandParams(params, commands.get(item.method));
      else assert.throws(() => validateCommandParams(params, commands.get(item.method)), { name: 'CommandValidationError' });
    });
  }
  const staticBad = [
    'effect.gain({db:999,bpm:external});',
    'track.update({pan:2,name:external});',
    'audio.generate({duration:601,name:external});',
    'effect.apply({effect:"gain",params:{db:999,bpm:external}});',
    'effect.eq({bands:[{gainDb:99,frequency:external}]});',
    'audio.render({scope:"bad",trackId:external});',
    'effect.gain({params:{db:999,bpm:external}});',
    'effect.gain({unknown:external});',
    'unknown.command({value:external});',
    'effect.gain({db:(1e308*1e308)});',
    'wait({seconds:1,beats:2});',
    'track.add({name:42});',
    'selection.set({channels:[8],start:external});',
    'project.update({beatsPerBar:17,bpm:external});',
    'audio.generate({channels:4,name:external});',
    'effect.echo({wet:2,timeMs:external});',
  ];
  for (let index = 0; index < 128; index++) {
    const source = `track.add({name:"before-${index}"});\n${staticBad[index % staticBad.length]}`; counters.staticPreflight++;
    await exercise('static-preflight', index, source, async () => { const calls = [], runner = fakeRunner(calls); await captureFailure(() => runner.run(source)); assert.equal(calls.length, 0, 'Statically invalid later arguments must precede all edits'); });
  }
  for (let index = 0; index < 64; index++) {
    const bad = 37 + negativeRandom() % 1000, source = `track.add({name:"completed"});\nlet bad=${bad};\neffect.gain({db:bad});`; counters.dynamicErrors++;
    await exercise('dynamic-error', index, source, async () => {
      const calls = [], runner = fakeRunner(calls), error = await captureFailure(() => runner.run(source), 'INVALID_ARGUMENT');
      assert.deepEqual(calls.map(call => call.method), ['track.add']); assert.equal(error.completedSteps, 1); assert.equal(error.command, 'effect.gain'); assert.equal(error.line, 3); assert.ok(error.column >= 1);
    });
  }
  phaseTimes.schemaMs = Math.round(performance.now() - schemaStarted);

  const boundsStarted = performance.now();
  for (let index = 0; index < 32; index++) {
    const variant = index % 8; counters.executionBounds++;
    await exercise('execution-bound', index, { variant }, async () => {
      const calls = [], runner = fakeRunner(calls);
      if (variant === 0) await captureFailure(() => runner.run('while(true){}', { limits: { iterations: 10 + index } }), 'RESOURCE_LIMIT');
      if (variant === 1) { const error = await captureFailure(() => runner.run('repeat(20){track.add({});}', { limits: { commands: 3 } }), 'RESOURCE_LIMIT'); assert.equal(calls.length, 3); assert.equal(error.completedSteps, 3); }
      if (variant === 2) await captureFailure(() => runner.run('let a="abcdefgh";repeat(10){a=a+a;}', { limits: { valueBytes: 256 } }), 'RESOURCE_LIMIT');
      if (variant === 3) {
        let timer; try { const error = await captureFailure(() => runner.run('wait({seconds:.05});track.add({});', { onEvent: event => { if (event.type === 'start') timer = setTimeout(() => runner.cancel(), 0); } }), 'ABORTED'); assert.equal(error.completedSteps, 0); assert.equal(calls.length, 0); }
        finally { clearTimeout(timer); runner.cancel(); }
        assert.equal((await runner.run('track.add({});')).completedSteps, 1);
      }
      if (variant === 4) {
        let release; const gate = new Promise(resolve => { release = resolve; }), busy = fakeRunner(calls, { getCommands: async () => { await gate; return catalog; } });
        const first = busy.run('track.add({});');
        try { await captureFailure(() => busy.run('track.add({});'), 'MACRO_BUSY'); busy.cancel(); }
        finally { release(); }
        await captureFailure(() => first, 'ABORTED'); assert.equal(calls.length, 0);
      }
      if (variant === 5) {
        const controller = new AbortController(); controller.abort(); await captureFailure(() => runner.run('track.add({});', { signal: controller.signal }), 'ABORTED'); assert.equal(calls.length, 0);
      }
      if (variant === 6) await captureFailure(() => runner.run('wait({seconds:.1});', { limits: { wallMs: 1 } }), 'RESOURCE_LIMIT');
      if (variant === 7) {
        const runtime = new CommandRuntime(); let release; const gate = new Promise(resolve => { release = resolve; });
        runtime.register({ method: 'fuzz.pending', recordable: false, schema: { type: 'object', additionalProperties: false } }, () => gate);
        const pending = Array.from({ length: 64 }, () => runtime.execute('fuzz.pending'));
        try { await captureFailure(() => runtime.execute('fuzz.pending'), 'RESOURCE_LIMIT'); }
        finally { release(null); await Promise.all(pending); runtime.dispose(); }
        assert.equal(runtime.inFlight, 0);
      }
    });
  }
  phaseTimes.boundsMs = Math.round(performance.now() - boundsStarted);

  const dataToolStarted = performance.now();
  for (let index = 0; index < 128; index++) {
    const start = programRandom() % 21 - 10, count = programRandom() % 12 + 1, step = programRandom() % 4 + 1;
    const source = `random.seed({seed:${index}});let original=array.range({start:${start},end:${start + count * step},step:${step}});let shuffled=array.shuffle({values:original});let result=[];for(x of shuffled){let row=[];repeat(3){row=array.append({values:row,value:random.int({min:-8,max:8})});}result=array.append({values:result,value:row});}let total=array.sum({values:original});let label=text.join({values:original,separator:"-"});`;
    counters.dataToolCases++;
    await exercise('data-tools', index, source, async () => {
      const calls = [], a = await fakeRunner(calls).run(source), b = await fakeRunner(calls).run(source);
      const expected = Array.from({ length: count }, (_, item) => start + item * step);
      assert.deepEqual(a.variables, b.variables); assert.deepEqual(a.variables.original, expected);
      assert.deepEqual(a.variables.shuffled.slice().sort((x, y) => x - y), expected);
      assert.equal(a.variables.total, expected.reduce((sum, value) => sum + value, 0)); assert.equal(a.variables.label, expected.join('-'));
      assert.equal(a.variables.result.length, count); assert.ok(a.variables.result.every(row => row.length === 3 && row.every(value => Number.isInteger(value) && value >= -8 && value <= 8)));
      assert.equal(calls.length, 0);
    });
  }
  phaseTimes.dataToolsMs = Math.round(performance.now() - dataToolStarted);

  const attacks = [];
  const addAttack = (name, action) => attacks.push({ name, action });
  for (const key of ['__proto__', 'constructor', 'prototype', 'caller', '__defineGetter__']) addAttack(`forbidden-key-${key}`, async () => {
    const calls = [], runner = fakeRunner(calls); await captureFailure(() => runner.run(`let x={${JSON.stringify(key)}:1};track.add({});`)); assert.equal(calls.length, 0);
  });
  for (const source of ['eval("1");', 'globalThis.fetch({});', 'Function("return 1");', 'let x=values["constructor"];', 'let x=values.__proto__;']) addAttack(`ambient-${source}`, async () => {
    const calls = [], runner = fakeRunner(calls, { getContext: () => ({ values: [] }) }); await captureFailure(() => runner.run(source)); assert.equal(calls.length, 0);
  });
  addAttack('root-ast-getter', () => { let hits = 0; const ast = { body: [] }; Object.defineProperty(ast, 'type', { get() { hits++; return 'Program'; } }); assert.throws(() => formatMacro(ast)); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('nested-ast-getter', () => { let hits = 0; const ast = parseMacro('repeat(1){}'); Object.defineProperty(ast.body[0].body, 'type', { get() { hits++; return 'BlockStatement'; } }); assert.throws(() => formatMacro(ast)); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('ast-array-index-getter', () => { let hits = 0; const ast = parseMacro('let a=1;'); Object.defineProperty(ast.body, '0', { get() { hits++; return { type: 'BreakStatement' }; } }); assert.throws(() => formatMacro(ast)); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('dot-property-injection', () => { const ast = parseMacro('let a=x.y;'); ast.body[0].init.property.value = 'y; track.remove({}); //'; assert.throws(() => formatMacro(ast)); });
  addAttack('ast-cycle', () => { const ast = { type: 'Program', body: [] }; ast.body.push(ast); assert.throws(() => formatMacro(ast)); });
  addAttack('ast-source-budget', () => { const ast = parseMacro('let a="x";'); ast.body[0].init.value = 'x'.repeat(MACRO_LIMITS.sourceBytes + 1); assert.throws(() => formatMacro(ast)); });
  addAttack('raw-source-budget', () => assert.throws(() => parseMacro(' '.repeat(MACRO_LIMITS.sourceBytes + 1)), { name: 'MacroError' }));
  addAttack('utf8-source-budget', () => assert.throws(() => parseMacro('let a="' + '音'.repeat(44000) + '";'), { name: 'MacroError' }));
  addAttack('deep-parse', () => assert.throws(() => parseMacro('let a=' + '('.repeat(200) + '1' + ')'.repeat(200) + ';'), { name: 'MacroError' }));
  addAttack('left-chain-depth', () => assert.throws(() => parseMacro('let a=' + '1+'.repeat(2000) + '1;'), { name: 'MacroError' }));
  addAttack('context-getter', async () => { let hits = 0; const values = {}; Object.defineProperty(values, 'name', { enumerable: true, get() { hits++; return 1; } }); await captureFailure(() => fakeRunner([]).run('let a=1;', { variables: values })); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('array-owned-map', async () => { let hits = 0; const values = [1]; values.map = () => { hits++; return []; }; await captureFailure(() => fakeRunner([]).run('let a=1;', { variables: { values } })); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('sparse-values', async () => { const error = await captureFailure(() => fakeRunner([]).run('let a=1;', { variables: { values: new Array(200000) } })); assert.equal(error.name, 'MacroError'); });
  addAttack('binary-aggregate', () => { const bytes = new Uint8Array(1024 * 1024); assert.throws(() => validateCommandParams({ values: Array(257).fill(bytes) }, { schema: { type: 'object' } }), /aggregate binary/); });
  addAttack('text-aggregate', () => { const value = 'x'.repeat(1024 * 1024); assert.throws(() => validateCommandParams({ values: Array(385).fill(value) }, { schema: { type: 'object' } }), /aggregate text|aggregate command/); });
  addAttack('api-data-cycle', () => { const value = {}; value.self = value; assert.throws(() => validateCommandParams(value, { schema: { type: 'object' } }), /cyclic/); });
  addAttack('api-enumerable-getter', () => { let hits = 0; const value = {}; Object.defineProperty(value, 'name', { enumerable: true, get() { hits++; return 'x'; } }); assert.throws(() => validateCommandParams(value, commands.get('track.add'))); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('api-hidden-getter', () => { let hits = 0; const value = {}; Object.defineProperty(value, 'name', { enumerable: false, get() { hits++; return 'x'; } }); assert.throws(() => validateCommandParams(value, commands.get('track.add')), 'Hidden accessors must be rejected before a handler reads them'); counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); });
  addAttack('api-hidden-array-element-getter', () => { let hits = 0; const values = [0]; Object.defineProperty(values, '0', { enumerable: false, get() { hits++; return 0; } }); let error; try { validateCommandParams({ channels: values }, commands.get('selection.set')); } catch (caught) { error = caught; } counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); assert.ok(error); });
  addAttack('ast-inherited-location-getter', () => { let hits = 0; const ast = parseMacro('let a=1;'); ast.loc = Object.create({ get line() { hits++; return 1; }, column: 1 }); let error; try { formatMacro(ast); } catch (caught) { error = caught; } counters.forbiddenGetterCalls += hits; assert.equal(hits, 0); assert.ok(error); });
  addAttack('data-prototype-object', async () => { const values = Object.create({ hidden: 1 }); values.safe = 2; await captureFailure(() => fakeRunner([]).run('let a=1;', { variables: values })); });
  addAttack('unknown-method-unavailable', async () => { let calls = 0; const runner = new MacroRunner({ execute: async () => { calls++; }, getCommands: () => [{ method: 'audio.input.start', available: false }] }); await captureFailure(() => runner.run('audio.input.start({});'), 'UNSUPPORTED_CAPABILITY'); assert.equal(calls, 0); });
  assert.equal(attacks.length, 32);
  const attacksStarted = performance.now();
  for (const [index, attack] of attacks.entries()) { counters.hostileData++; await exercise('hostile-data', index, attack.name, attack.action); }
  phaseTimes.hostileDataMs = Math.round(performance.now() - attacksStarted);
} finally {
  globalThis.fetch = originalFetch;
  if (!assertDescriptorsEqual(prototypeBefore, Object.getOwnPropertyDescriptors(Object.prototype))) counters.prototypeMutations++;
}
function assertDescriptorsEqual(a, b) {
  const keys = Reflect.ownKeys(a); if (keys.length !== Reflect.ownKeys(b).length) return false;
  return keys.every(key => Object.hasOwn(b, key) && Reflect.ownKeys(a[key]).every(field => Object.is(a[key][field], b[key][field])));
}
const report = {
  seeds: Object.fromEntries(Object.entries(SEEDS).map(([key, value]) => [key, `0x${value.toString(16)}`])), node: process.version,
  corpusSha256: corpusHash.digest('hex'), counts: counters, elapsedMs: Math.round(performance.now() - started), phaseTimes,
  limits: MACRO_LIMITS, sourceFilesSha256, failures,
};
// Source hashes describe files read before the deterministic corpus begins.
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (counters.failed || counters.ambientNetworkCalls || counters.prototypeMutations || counters.forbiddenGetterCalls) process.exitCode = 1;
