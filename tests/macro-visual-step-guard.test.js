import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMacro, macroToSteps, stepsToMacro, MacroRunner } from '../src/macro.js';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { CommandRuntime } from '../src/command-runtime.js';

test('visual conversion rejects the project-reset command hidden in one track step', () => {
  const paramsSource = '{name: project.new({name: "Replaced"})}';
  const source = 'track.add(' + paramsSource + ');';
  assert.equal(parseMacro(source).body.length, 1);
  assert.throws(() => stepsToMacro([{method:'track.add', paramsSource}]), /visual step cannot hide a nested command/);
  assert.equal(macroToSteps(source), null);
  assert.equal(macroToSteps(parseMacro(source)), null);
});

test('visual conversion detects nested calls in every expression container, including inactive branches', () => {
  for (const paramsSource of [
    'project.state({})',
    '{meta: [1, {aux: project.new({name: "Replaced"})}]}',
    '{meta: false || project.state({})}',
    '{meta: false && project.state({})}',
    '{meta: !project.state({})}',
    '{meta: 1 + project.state({}).sampleRate}',
    '{name: project.state({}).name}',
    '{name: labels[project.state({}).selectedTrackId]}'
  ]) {
    const source = 'track.add(' + paramsSource + ');';
    assert.throws(() => stepsToMacro([{method:'track.add', paramsSource}]), /nested command/, paramsSource);
    assert.equal(macroToSteps(source), null, paramsSource);
    assert.equal(macroToSteps(parseMacro(source)), null, paramsSource);
  }
});

test('ordinary visual steps preserve pure literals, variables, arithmetic and property reads', () => {
  const source = stepsToMacro([
    {method:'track.add', params:{name:'Visible step'}},
    {method:'custom.command', paramsSource:'{value: [-offset + settings.gain * 2, enabled && !disabled, labels[input.index], {count: 1 + 2}, null]}'}
  ]);
  const steps = macroToSteps(source);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].params.name, 'Visible step');
  assert.equal(steps[1].params, undefined);
  assert.equal(stepsToMacro(steps), source);
});

test('visual AST inspection does not read ignored extra fields or property-wrapper getters', () => {
  const ast = parseMacro('track.add({name:"Safe"});');
  let hits = 0;
  const argument = ast.body[0].expression.argument;
  argument.extra = {get type(){hits++; return 'CallExpression';}};
  Object.defineProperty(argument.properties[0], 'type', {get(){hits++; return 'CallExpression';}});
  assert.equal(macroToSteps(ast)[0].params.name, 'Safe');
  assert.equal(hits, 0);
});

test('text scripts still execute nested registered commands and consume their results', async () => {
  const editor = new AudioEditor({sampleRate:8000});
  const runtime = new CommandRuntime({coreExecute:editor.execute.bind(editor),coreCommands:COMMANDS,getState:editor.getState.bind(editor)});
  await runtime.execute('project.new', {name:'Nested text result'});
  const calls = [];
  const runner = new MacroRunner({
    execute:(method,params,options)=>{calls.push(method); return runtime.execute(method,params,options);},
    getCommands:()=>runtime.commands(),
    getContext:()=>({project:editor.getState()})
  });
  const source = 'track.add({name: project.state({}).name});';
  assert.equal(macroToSteps(source), null);
  const result = await runner.run(source);
  assert.deepEqual(calls, ['project.state', 'track.add']);
  assert.equal(result.completedSteps, 2);
  assert.equal(editor.getState().tracks.length, 1);
  assert.equal(editor.getState().tracks[0].name, 'Nested text result');
});
