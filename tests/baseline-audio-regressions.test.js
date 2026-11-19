/** Correctness assertions introduced by the post-publication 0.2 audit.
 * These failed against the published baseline and remain active after the fixes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';

test('ordinary thirty-second portable PCM saves and reopens without recursive base64 validation',async()=>{
  const editor=new AudioEditor({sampleRate:48000});
  await editor.execute('audio.generate',{duration:30});
  const project=await editor.execute('project.save'),restored=new AudioEditor();
  await restored.execute('project.load',{project});
  assert.deepEqual(await restored.execute('project.save'),project);
});
test('portable PCM rejects misplaced padding, bad alphabet, and truncated payload atomically',async()=>{
  const editor=new AudioEditor({sampleRate:8000});
  await editor.execute('clip.add',{audio:{sampleRate:8000,channels:[Float32Array.of(.25)]}});
  const project=await editor.execute('project.save');
  for(const encoded of ['=AAAAA==','AAAAA===','AAA AA==','AAAAAA=A','AAAAAA-_','AAAA','AAAAAAA=']) {
    const malformed=structuredClone(project);malformed.tracks[0].clips[0].audio.channels[0]=encoded;
    await assert.rejects(editor.execute('project.load',{project:malformed}));
    assert.deepEqual(await editor.execute('project.save'),project);
  }
});
test('generated track and loop names stay bounded without cutting a Unicode pair',async()=>{
  const editor=new AudioEditor({sampleRate:8000});
  const originalName='x'.repeat(194)+'😀'+'y'.repeat(4);
  await editor.execute('clip.add',{name:originalName,audio:{sampleRate:8000,channels:[new Float32Array(80).fill(.1)]}});
  await editor.execute('track.update',{name:originalName});
  await editor.execute('clip.duplicate',{newTrack:true});
  await editor.execute('loop.create',{repeats:2,crossfadeMs:0});
  const project=await editor.execute('project.save');
  for(const track of project.tracks)for(const value of [track.name,...track.clips.map(c=>c.name)]) {
    assert.ok(value.length<=200);assert.ok(value.isWellFormed());
  }
  const restored=new AudioEditor();await restored.execute('project.load',{project});
  assert.deepEqual(await restored.execute('project.save'),project);
});
for (const [samples, noncanonical] of [[1,'AACAPh=='],[2,'AACAPgAAgD5=']])test(`portable PCM rejects nonzero unused base64 bits with ${samples===1?'two':'one'} padding characters`,async()=>{
  const editor=new AudioEditor({sampleRate:8000});
  await editor.execute('clip.add',{audio:{sampleRate:8000,channels:[new Float32Array(samples).fill(.25)]}});
  const project=await editor.execute('project.save'),malformed=structuredClone(project);
  assert.deepEqual(Buffer.from(noncanonical,'base64'),Buffer.from(project.tracks[0].clips[0].audio.channels[0],'base64'));
  malformed.tracks[0].clips[0].audio.channels[0]=noncanonical;
  await assert.rejects(editor.execute('project.load',{project:malformed}),/noncanonical base64/);
  assert.deepEqual(await editor.execute('project.save'),project);
});
for(const method of ['clip.duplicate','clip.split'])test(`${method} bounds generated names so its own portable session reopens`,async()=>{
  const editor=new AudioEditor({sampleRate:8000});
  await editor.execute('clip.add',{name:'x'.repeat(200),audio:{sampleRate:8000,channels:[new Float32Array(80).fill(.1)]}});
  await editor.execute(method,{at:.005});
  const project=await editor.execute('project.save');
  assert.ok(project.tracks.every(t=>t.clips.every(c=>c.name.length<=200)));
  const restored=new AudioEditor();await restored.execute('project.load',{project});
  assert.deepEqual(await restored.execute('project.save'),project);
});
test('explicit trim of another clip keeps selected IDs, selection, placement and undo coherent',async()=>{
  const editor=new AudioEditor({sampleRate:8000});
  const first=await editor.execute('audio.generate',{duration:1,name:'First'});
  await editor.execute('audio.generate',{duration:1,name:'Second'});
  const before=await editor.execute('project.save');
  await editor.execute('edit.trim',{target:{clipId:first.clipId,start:.25,end:.75}});
  const state=editor.getState();
  assert.equal(state.selectedClipId,first.clipId);assert.equal(state.selectedTrackId,first.trackId);
  assert.equal(state.selection.clipId,state.selectedClipId);assert.equal(state.selection.trackId,state.selectedTrackId);
  const clip=state.tracks.flatMap(t=>t.clips).find(c=>c.id===first.clipId);
  assert.equal(clip.start,.25);assert.equal(clip.frames,4000);
  await editor.execute('history.undo');assert.deepEqual(await editor.execute('project.save'),before);
});
