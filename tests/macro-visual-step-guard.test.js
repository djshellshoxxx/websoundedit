import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMacro, macroToSteps, stepsToMacro } from '../src/macro.js';

test('visual step builder refuses commands hidden in parameter expressions', () => {
  const disguised = 'track.add({name: project.new({name: "Replaced"})});';
  assert.equal(parseMacro(disguised).body.length, 1);
  assert.throws(
    () => stepsToMacro([{ method: 'track.add', paramsSource: '{name: project.new({name: "Replaced"})}' }]),
    /visual step cannot hide a nested command/
  );
  assert.equal(macroToSteps(disguised), null);
  // Multiple operations remain explicitly available through the text language.
  assert.equal(parseMacro(disguised).body[0].expression.argument.properties[0].value.type, 'CallExpression');
  assert.equal(macroToSteps('track.add({name: "New track"});')[0].method, 'track.add');
});

test('nested command anywhere in a visual argument object or array is rejected', () => {
  for (const paramsSource of [
    '{name: project.new({name: "Replaced"})}',
    '{meta: [1, {aux: project.new({name: "Replaced"})}]}',
    '{meta: false || project.new({name: "Replaced"})}'
  ]) {
    assert.throws(() => stepsToMacro([{ method: 'track.add', paramsSource }]), /nested command/);
  }
});
