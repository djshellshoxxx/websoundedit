import assert from 'node:assert/strict';
// The public API must remain a real DOM-free ES module after bundling.
const { AudioEditor, COMMANDS, generateAudio, encodeWav, decodeWav, createCoreRuntime, MacroRunner, createBrowserRuntime, importReaper, exportReaper } = await import('../dist/api.js');
assert.equal(typeof AudioEditor, 'function');
assert.ok(COMMANDS.some(command => command.method === 'effect.pitch'));
const editor = new AudioEditor();
const source = generateAudio({ type: 'tone', frequency: 440, duration: 0.1, amplitude: 0.25 });
await editor.execute('clip.add', { audio: source });
await editor.execute('effect.reverse');
const result = await editor.execute('audio.render', { scope: 'clip', raw: true });
assert.equal(result.channels[0].length, source.channels[0].length);
assert.equal(result.channels[0][0], source.channels[0].at(-1));
assert.equal(decodeWav(encodeWav(result)).channels.length, 1);
for(const method of [createBrowserRuntime,importReaper,exportReaper])assert.equal(typeof method,'function');
const runtime=createCoreRuntime({engine:editor}),runner=new MacroRunner({execute:runtime.execute.bind(runtime),getCommands:()=>runtime.commands()});
const macro=await runner.run('effect.reverse({}); let stats=analysis.stats({});');
assert.equal(macro.completedSteps,2);assert.ok(macro.variables.stats.peakDb<0&&macro.variables.stats.peakDb>(-13));
runtime.dispose();
console.log('Built API verified: DOM-free exports, real PCM edit/WAV round trip and interpreted typed macro.');
