import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEditor } from '../src/engine.js';
import { exportAudacity, importAudacity, encodeAudacityAU, decodeAudacityAU, loadAudacityCodec } from '../src/audacity.js';
import { xmlNode, encodeBinaryXML, decodeBinaryXML, readXML, writeXML } from '../src/audacity-xml.js';
import { zipSync, unzipSync } from 'fflate';
import { CHANNEL_LAYOUTS } from '../src/channel-layout.js';

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

test('Audacity surround is explicit: reject by default, split named PCM channel stems on request', async () => {
  for (const layout of ['5.1', '7.1']) {
    const engine = new AudioEditor({ sampleRate: 8000, outputLayout: layout }), track = await engine.execute('track.add', { name: 'Surround' });
    const audio = { sampleRate: 8000, layout, channels: CHANNEL_LAYOUTS[layout].channels.map((_, i) => Float32Array.of(.01 * (i + 1), -.25, .5)) };
    await engine.execute('track.update', { trackId: track.id, gainDb: -3, pan: .4, solo: true });
    await engine.execute('clip.add', { trackId: track.id, name: 'Clip', start: .1, audio });
    const portable = await engine.execute('project.save');
    await assert.rejects(exportAudacity(portable), /split-mono/);
    for (const format of ['aup3', 'aup']) {
      const exported = await exportAudacity(portable, { format, multichannel: 'split-mono' });
      assert.ok(exported.warnings.some(warning => warning.includes('not a surround project mixer')));
      const imported = await importAudacity(exported.bytes), loaded = new AudioEditor(); await loaded.execute('project.load', { project: imported.project });
      assert.equal(loaded.getProject().tracks.length, audio.channels.length);
      for (const [ch, stem] of loaded.getProject().tracks.entries()) {
        assert.ok(stem.name.endsWith(`[${layout} ${CHANNEL_LAYOUTS[layout].channels[ch]}]`));
        assert.equal(stem.pan, 0); assert.ok(Math.abs(stem.gainDb + 3) < 1e-10); assert.equal(stem.solo, true);
        assert.equal(stem.clips[0].start, .1); assert.deepEqual(stem.clips[0].audio.channels, [audio.channels[ch]]);
      }
    }
  }
});

test('Audacity split-mono expansion respects the shared track and clip budgets', async () => {
  const engine = new AudioEditor({ sampleRate: 8000, outputLayout: '7.1' });
  for (let i = 0; i < 9; i++) await engine.execute('clip.add', { name: `Surround ${i}`, audio: { sampleRate: 8000, layout: '7.1', channels: Array.from({ length: 8 }, () => Float32Array.of(.1)) } });
  await assert.rejects(exportAudacity(await engine.execute('project.save'), { multichannel: 'split-mono' }), /exceed 64 Audacity tracks/);
});
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
  assert.match(new TextDecoder().decode(files['README.txt']), /sample rate to 8000 Hz/);
  assert.ok(exported.warnings.some(warning => warning.includes('8000 Hz')));
  assert.equal(Object.keys(files).filter(name => name.endsWith('.au')).length, 3);
  assert.deepEqual(comparable((await importAudacity(exported.bytes)).project), comparable(project));
  assert.deepEqual(comparable((await importAudacity(files['project.aup'], { files: new Map(Object.entries(files)) })).project), comparable(project));
  await assert.rejects(importAudacity(files['project.aup']), /Missing or ambiguous/);
});

test('native Audacity aligned stereo link value 3 imports both channels', async () => {
  const { engine } = await fixture(), original = await engine.execute('project.save');
  const exported = await exportAudacity(original), SQL = await loadAudacityCodec(), db = new SQL.Database(exported.bytes);
  try {
    const [dict, doc] = db.exec('SELECT dict,doc FROM project')[0].values[0], root = decodeBinaryXML(dict, doc);
    root.children.find(item => item.name === 'wavetrack' && Number(item.attrs.linked) > 0).attrs.linked = 3;
    const native = encodeBinaryXML(root); db.run('UPDATE project SET dict=?,doc=?', [native.dict, native.doc]);
    assert.deepEqual(comparable((await importAudacity(db.export())).project), comparable(original));
  } finally { db.close(); }
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
  assert.throws(() => readXML(`<project>${'<a/>'.repeat(40065)}</project>`), /markup tokens/);
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

test('ZIP validation and extraction agree on counts, comments, sizes and ZIP64 rejection', async () => {
  const xml = new TextEncoder().encode('<project version="1.3.0" name="Comment fixture" rate="8000"/>');
  const archive = zipSync({ 'project.aup': xml }, { level: 0 }), end = archive.length - 22;
  const central = new DataView(archive.buffer).getUint32(end + 16, true);
  const mismatch = archive.slice(), mismatchView = new DataView(mismatch.buffer);
  mismatchView.setUint16(end + 10, 0, true); mismatchView.setUint32(end + 12, 0, true);
  await assert.rejects(importAudacity(mismatch), /multipart/);

  const stored = archive.slice(); new DataView(stored.buffer).setUint32(central + 24, 1, true);
  await assert.rejects(importAudacity(stored), /payload size/);
  const offset = archive.slice(); new DataView(offset.buffer).setUint32(central + 42, central, true);
  await assert.rejects(importAudacity(offset), /payload/);

  // A valid archive comment can contain a fake EOCD signature. The real EOCD
  // declares that comment; an extractor must not independently choose the fake.
  const comment = new Uint8Array(archive.length + 22); comment.set(archive);
  const commentView = new DataView(comment.buffer);
  commentView.setUint16(end + 20, 22, true);
  commentView.setUint32(archive.length, 0x06054b50, true);
  commentView.setUint16(archive.length + 20, 1, true);
  assert.equal((await importAudacity(comment)).project.name, 'Comment fixture');

  const zip64 = new Uint8Array(archive.length + 20);
  zip64.set(archive.subarray(0, end)); zip64.set(archive.subarray(end), end + 20);
  new DataView(zip64.buffer).setUint32(end, 0x07064b50, true);
  await assert.rejects(importAudacity(zip64), /ZIP64/);
});

test('compressed legacy external audio references and overlapping native clips are rejected', async () => {
  await assert.rejects(importAudacity(new TextEncoder().encode('<project version="1.3.0" rate="44100"><import filename="external.ogg"/></project>')), /self-contained AUP3/);
  const { engine } = await fixture(), exported = await exportAudacity(await engine.execute('project.save'));
  const SQL = await loadAudacityCodec(), db = new SQL.Database(exported.bytes);
  try {
    const [dict, doc] = db.exec('SELECT dict,doc FROM project')[0].values[0], xml = decodeBinaryXML(dict, doc);
    const track = xml.children.find(child => child.name === 'wavetrack');
    track.children.push(structuredClone(track.children[0]));
    const changed = encodeBinaryXML(xml); db.run('UPDATE project SET dict=?,doc=?', [changed.dict, changed.doc]);
    await assert.rejects(importAudacity(db.export()), /Overlapping clips/);
  } finally { db.close(); }
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

test('overlapping mono and stereo clips export as disjoint lanes with unchanged PCM and summed mix', async () => {
  const engine = new AudioEditor({ sampleRate: 8000 }), track = await engine.execute('track.add', { name: 'Stacked' });
  await engine.execute('track.update', { trackId: track.id, gainDb: -4, pan: -.27, solo: true });
  const specs = [['Mono A', 1, 0, 8], ['Mono B', 1, 3, 8], ['Mono adjacent', 1, 8, 3], ['Stereo A', 2, 0, 6], ['Stereo B', 2, 2, 8], ['Stereo adjacent', 2, 10, 4]];
  for (const [name, count, start, frames] of specs) await engine.execute('clip.add', {
    trackId: track.id, name, start: start / 8000,
    audio: { sampleRate: 8000, channels: Array.from({ length: count }, (_, ch) => Float32Array.from({ length: frames }, (_, i) => (i % 2 ? -.2 : .3) / (ch + 1))) },
  });
  const originalClips = engine.getProject().tracks[0].clips, expected = await engine.execute('audio.render');
  for (const format of ['aup3', 'aup']) {
    const exported = await exportAudacity(await engine.execute('project.save'), { format });
    assert.ok(exported.warnings.some(warning => warning.includes('Overlapping clips')));
    const { project } = await importAudacity(exported.bytes), loaded = new AudioEditor();
    await loaded.execute('project.load', { project });
    assert.deepEqual(project.tracks.map(item => item.name), ['Stacked (mono)', 'Stacked (mono) — lane 2', 'Stacked (stereo)', 'Stacked (stereo) — lane 2']);
    assert.equal(project.tracks.reduce((sum, item) => sum + item.clips.length, 0), originalClips.length);
    for (const lane of loaded.getProject().tracks) {
      assert.equal(lane.solo, true); assert.equal(lane.mute, false);
      let end = -1;
      for (const clip of lane.clips) {
        const start = Math.round(clip.start * 8000);
        assert.ok(start >= end, `${format}: clips in ${lane.name} are disjoint`);
        end = start + clip.audio.channels[0].length;
        const original = originalClips.find(item => item.name === clip.name);
        assert.equal(clip.start, original.start); assert.deepEqual(clip.audio, original.audio);
      }
    }
    const actual = await loaded.execute('audio.render');
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < expected.channels[ch].length; i++) assert.ok(Math.abs(actual.channels[ch][i] - expected.channels[ch][i]) < 1e-6, `${format}: audible sum`);
  }
});

test('overlap lane expansion respects the 64-track project limit', async () => {
  const engine = new AudioEditor({ sampleRate: 8000 }), track = await engine.execute('track.add', { name: 'Stacked' });
  for (let i = 0; i < 65; i++) await engine.execute('clip.add', { trackId: track.id, name: `Clip ${i}`, audio: { sampleRate: 8000, channels: [Float32Array.of(.1)] } });
  await assert.rejects(exportAudacity(await engine.execute('project.save')), /exceed 64 Audacity tracks/);
});
