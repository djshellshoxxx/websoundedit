import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { exportAudacity, importAudacity, encodeAudacityAU, decodeAudacityAU, loadAudacityCodec } from '../src/audacity.js';
import { xmlNode, encodeBinaryXML, decodeBinaryXML, readXML, writeXML } from '../src/audacity-xml.js';
import { zipSync, unzipSync } from 'fflate';

async function fixture() {
  const engine = new AudioEditor({ name: 'Café & <sample>', sampleRate: 8000, bpm: 128 });
  const mono = await engine.execute('track.add', { name: 'Mono' });
  await engine.execute('track.update', { trackId: mono.id, gainDb: -3, pan: -.35, mute: true });
  const first = await engine.execute('clip.add', { trackId: mono.id, name: 'First', start: .1, audio: { sampleRate: 8000, channels: [Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i * .17) * .5)] } });
  const stereo = await engine.execute('track.add', { name: 'Stereo' });
  await engine.execute('track.update', { trackId: stereo.id, gainDb: 2, pan: .4, solo: true });
  await engine.execute('clip.add', { trackId: stereo.id, name: 'Second', start: .2, audio: { sampleRate: 8000, channels: [Float32Array.of(.25, -.5, .75, 1), Float32Array.of(-1, .75, -.5, .25)] } });
  engine.getProject().metadata = { title: 'Café & tone', artist: 'Producer', album: 'Album', date: '2026', track: '2/10', comment: 'One\nTwo' };
  engine.getProject().markers = [{ id: 'label-1', name: 'Verse <A>', time: .15 }];
  engine.getProject().settings.audacityLabelEnds = { 'label-1': .25 };
  return { engine, first };
}
function comparable(project) {
  return { sampleRate: project.sampleRate, bpm: project.bpm, metadata: project.metadata,
    tracks: project.tracks.map(track => ({ name: track.name, gainDb: Math.round(track.gainDb * 1e7) / 1e7, pan: track.pan, mute: track.mute, solo: track.solo, clips: track.clips.map(clip => ({ name: clip.name, start: clip.start, audio: clip.audio })) })),
    markers: project.markers.map(marker => ({ name: marker.name, time: marker.time })) };
}

test('genuine AUP3 SQLite export and import preserve PCM, layout, stereo, tags, mix and labels', async () => {
  const { engine } = await fixture(), project = await engine.execute('project.save');
  const exported = await exportAudacity(project);
  assert.equal(exported.ext, 'aup3'); assert.equal(new TextDecoder().decode(exported.bytes.subarray(0,16)), 'SQLite format 3\0');
  const SQL = await loadAudacityCodec(), db = new SQL.Database(exported.bytes);
  assert.equal(db.exec('PRAGMA application_id')[0].values[0][0], 0x41554459);
  assert.equal(db.exec('SELECT count(*) FROM sampleblocks')[0].values[0][0], 3); db.close();
  const result = await importAudacity(exported.bytes, { name: 'fixture.aup3' });
  assert.deepEqual(comparable(result.project), comparable(project));
  assert.equal(result.project.settings.audacityLabelEnds['aud-marker-1'], .25);
  const loaded = new AudioEditor(); await loaded.execute('project.load', { project: result.project });
  assert.deepEqual(await loaded.execute('audio.render'), await engine.execute('audio.render'));
});

test('legacy ZIP contains real AUP XML and companion AU files, round-trips both channels', async () => {
  const { engine } = await fixture(), project = await engine.execute('project.save'), exported = await exportAudacity(project, { format: 'aup' });
  const files = unzipSync(exported.bytes);
  assert.match(new TextDecoder().decode(files['project.aup']), /^<\?xml/);
  assert.equal(Object.keys(files).filter(name => name.endsWith('.au')).length, 3);
  assert.deepEqual(comparable((await importAudacity(exported.bytes)).project), comparable(project));
  assert.deepEqual(comparable((await importAudacity(files['project.aup'], { files: new Map(Object.entries(files)) })).project), comparable(project));
  await assert.rejects(importAudacity(files['project.aup']), /Missing or ambiguous/);
});

test('AU writer includes real summaries and reader handles little and big endian float blocks', () => {
  const input = Float32Array.of(-2, .5, 1, -.25), bytes = encodeAudacityAU(input, 48000);
  assert.deepEqual(decodeAudacityAU(bytes, 4), input);
  assert.equal(new TextDecoder().decode(bytes.subarray(24,44)), 'AudacityBlockFile112');
  const big = new Uint8Array(24 + input.length * 4), view = new DataView(big.buffer);
  [0x2e736e64, 24, 16, 6, 48000, 1].forEach((value,i) => view.setUint32(i * 4, value));
  input.forEach((value,i) => view.setFloat32(24+i*4,value));
  assert.deepEqual(decodeAudacityAU(big,4), input);
  assert.throws(() => decodeAudacityAU(bytes, 5), /length/);
});

test('binary XML correctly decodes Unicode and rejects truncated, unknown and unsafe structures', () => {
  const root = xmlNode('project', { name: '音色 🎵', rate: 48000 }, [xmlNode('tags')]);
  const encoded = encodeBinaryXML(root), decoded = decodeBinaryXML(encoded.dict,encoded.doc);
  assert.equal(decoded.attrs.name, root.attrs.name); assert.equal(decoded.attrs.rate, '48000');
  assert.throws(() => decodeBinaryXML(encoded.dict, encoded.doc.subarray(0,encoded.doc.length-1)), /Truncated/);
  assert.throws(() => decodeBinaryXML(encoded.dict, Uint8Array.of(99)), /Unsupported/);
  assert.throws(() => readXML('<!DOCTYPE project [<!ENTITY x "bad">]><project/>'), /entities/);
  assert.equal(readXML(writeXML(root)).attrs.name, root.attrs.name);
});

test('AUP3 rejects recovery state and unsupported processing instead of silently discarding it', async () => {
  const { engine } = await fixture(), encoded = await exportAudacity(await engine.execute('project.save')), SQL = await loadAudacityCodec();
  const db = new SQL.Database(encoded.bytes); db.run('INSERT INTO autosave SELECT * FROM project');
  await assert.rejects(importAudacity(db.export()), /recovery\/autosave/); db.run('DELETE FROM autosave');
  const [dict,doc] = db.exec('SELECT dict,doc FROM project')[0].values[0], root=decodeBinaryXML(dict,doc);
  root.children.find(n=>n.name==='wavetrack').children[0].attrs.centShift=100;
  const data=encodeBinaryXML(root);db.run('UPDATE project SET dict=?,doc=?',[data.dict,data.doc]);
  await assert.rejects(importAudacity(db.export()), /pitch\/stretch/); db.close();
});

test('malicious ZIP paths and missing or inconsistent audio blocks fail before replacement', async () => {
  await assert.rejects(importAudacity(zipSync({'../escape.aup':new TextEncoder().encode('<project/>')})), /unsafe file path/);
  const {engine}=await fixture(), out=await exportAudacity(await engine.execute('project.save'));
  const SQL=await loadAudacityCodec(),db=new SQL.Database(out.bytes);db.run('DELETE FROM sampleblocks WHERE blockid=1');
  await assert.rejects(importAudacity(db.export()), /missing/);db.close();
});

test('pan-law conversion preserves mono/stereo audible gains and separates mixed-layout tracks', async () => {
  const engine=new AudioEditor({sampleRate:8000}),track=await engine.execute('track.add',{name:'Mixed'});
  await engine.execute('track.update',{trackId:track.id,pan:.43,gainDb:-96});
  await engine.execute('clip.add',{trackId:track.id,name:'Mono',start:0,audio:{sampleRate:8000,channels:[Float32Array.of(.2,.5,-.4)]}});
  await engine.execute('clip.add',{trackId:track.id,name:'Stereo',start:.001,audio:{sampleRate:8000,channels:[Float32Array.of(.8,.4,-.2),Float32Array.of(-.1,.3,.7)]}});
  const exported=await exportAudacity(await engine.execute('project.save'));
  assert.ok(exported.warnings.some(x=>/split by channel layout/.test(x)));
  const {project}=await importAudacity(exported.bytes);assert.equal(project.tracks.length,2);
  const loaded=new AudioEditor();await loaded.execute('project.load',{project});
  const expected=await engine.execute('audio.render'),actual=await loaded.execute('audio.render');
  for(let ch=0;ch<2;ch++)for(let i=0;i<expected.channels[ch].length;i++)assert.ok(Math.abs(actual.channels[ch][i]-expected.channels[ch][i])<1e-10);
  const SQL=await loadAudacityCodec(),db=new SQL.Database(exported.bytes),[dict,doc]=db.exec('SELECT dict,doc FROM project')[0].values[0];
  const xml=decodeBinaryXML(dict,doc);db.close();
  for(const [i,source] of [engine.getProject().tracks[0].clips[0],engine.getProject().tracks[0].clips[1]].entries()){
    const xmlTrack=xml.children.filter(x=>x.name==='wavetrack')[i===0?0:1],a=xmlTrack.attrs;
    const leftGain=Number(a.gain)*(Number(a.pan)>0?1-Number(a.pan):1),rightGain=Number(a.gain)*(Number(a.pan)<0?1+Number(a.pan):1);
    const p=.43,g=10**(-96/20),leftExpected=g*(i?Math.cos(p*Math.PI/2):Math.cos((p+1)*Math.PI/4)),rightExpected=g*(i?1:Math.sin((p+1)*Math.PI/4));
    assert.ok(Math.abs(leftGain-leftExpected)<1e-14);assert.ok(Math.abs(rightGain-rightExpected)<1e-14);
  }
});
