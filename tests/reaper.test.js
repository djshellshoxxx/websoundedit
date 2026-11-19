import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, unzipSync } from 'fflate';
import { AudioEditor } from '../src/engine.js';
import { CHANNEL_LAYOUTS } from '../src/channel-layout.js';
import { encodeWav } from '../src/wav.js';
import { importReaper, exportReaper, parseRpp, writeRpp } from '../src/reaper.js';
import { quoteRpp, tokenizeRppLine, RPP_LIMITS } from '../src/rpp-text.js';

const bytes = value => new TextEncoder().encode(value);
const signal = (layout, frames = 80, sampleRate = 8000) => ({ sampleRate, layout, channels: CHANNEL_LAYOUTS[layout].channels.map((_, ch) => Float32Array.from({ length: frames }, (_, i) => .08 * Math.sin((i + 1) * (ch + 1) * .2))) });
const treeShape = node => ({ tag: node.tag, args: node.args, ...(node.children ? { children: node.children.map(treeShape) } : {}) });
function maxDifference(a, b) {
  assert.equal(a.sampleRate, b.sampleRate); assert.equal(a.channels.length, b.channels.length); let maximum = 0;
  for (let ch = 0; ch < a.channels.length; ch++) { assert.equal(a.channels[ch].length, b.channels[ch].length); for (let i = 0; i < a.channels[ch].length; i++) maximum = Math.max(maximum, Math.abs(a.channels[ch][i] - b.channels[ch][i])); }
  return maximum;
}
async function open(project) { const editor = new AudioEditor(); await editor.execute('project.load', { project }); return editor; }
function independentRpp({ reference = 'tone.wav', item = '', track = '', project = '', length = .005, offset = .002, pan = .25 } = {}) {
  return `<REAPER_PROJECT 0.1 "7.86" 1
SAMPLERATE 8000 1 0
TEMPO 128 4 4
PANLAW 1
MASTER_NCH 2 2
MASTER_VOLUME 1 0 1 1 1
${project}
MARKER 1 0.01 "Point" 0
<TRACK
NAME "Native track"
NCHAN 2
VOLPAN 0.5 ${pan} 1 -1 1
PANMODE 3
PANLAWFLAGS 2
MUTESOLO 0 0 0
${track}
<ITEM
POSITION 0.02
LENGTH ${length}
SOFFS ${offset}
LOOP 0
PLAYRATE 1 1 0 -1 0 0.0025
VOLPAN 1 0 1 -1
FADEIN 1 0 0 -1 0 0
FADEOUT 1 0 0 -1 0 0
MIXFLAG 1
NAME "Visible take"
${item}
<SOURCE WAVE
FILE ${quoteRpp(reference)}
>
>
>
>
`;
}

test('Cockos line grammar preserves quoted backslashes, all quote styles, comments and nested blocks', () => {
  assert.deepEqual(tokenizeRppLine(' FILE "C:\\Samples\\tone.wav" ; ignored'), ['FILE', 'C:\\Samples\\tone.wav']);
  assert.deepEqual(tokenizeRppLine("NAME 'one \"two\"' `three 'four'` # ignored"), ['NAME', 'one "two"', "three 'four'"]);
  for (const value of ['plain', 'two words', 'a"b', "a'b\"c", '音色🎵', 'C:\\Samples\\file.wav', '#name', '']) assert.deepEqual(tokenizeRppLine(quoteRpp(value)), [value]);
  const source = independentRpp(); assert.deepEqual(treeShape(parseRpp(writeRpp(parseRpp(source)))), treeShape(parseRpp(source)));
  assert.throws(() => quoteRpp('a\nb'), /control/); assert.throws(() => quoteRpp('one "two\'three` four'), /three quote/);
  assert.throws(() => parseRpp('<REAPER_PROJECT\nNAME "oops\n>'), /unterminated/);
  assert.throws(() => parseRpp('<REAPER_PROJECT\n>\nEXTRA 0'), /one project root/);
});

test('RPP parser and writer enforce depth, token, line and record resource boundaries', () => {
  assert.throws(() => parseRpp(`<REAPER_PROJECT\n${'<X\n'.repeat(65)}${'>\n'.repeat(66)}`), /64 levels/);
  assert.throws(() => parseRpp(`<REAPER_PROJECT\n${'NAME x\n'.repeat(20000)}>\n`), /too complex/);
  assert.throws(() => parseRpp(`<REAPER_PROJECT\nNAME "${'x'.repeat(RPP_LIMITS.tokenCharacters + 1)}"\n>`), /token exceeds/);
  assert.throws(() => tokenizeRppLine(`NAME ${'x'.repeat(RPP_LIMITS.lineBytes)}`), /64 KiB/);
  assert.throws(() => parseRpp(new Uint8Array([0xff])), /encoded data/);
  assert.throws(() => parseRpp('<REAPER_PROJECT\n' + '\n'.repeat(50001) + '>'), /physical lines/);
});

test('real RPP/media ZIP round trips all four layouts, metadata, markers, gain/pan and overlapping sums', async () => {
  for (const layout of Object.keys(CHANNEL_LAYOUTS)) {
    const editor = new AudioEditor({ name: `Café ${layout}`, sampleRate: 8000, outputLayout: layout, bpm: 132 });
    const track = await editor.execute('track.add', { name: `Source ${layout}` });
    await editor.execute('track.update', { trackId: track.id, gainDb: -4, pan: -.31, solo: true });
    await editor.execute('clip.add', { trackId: track.id, name: 'First take', start: .003, audio: signal(layout) });
    await editor.execute('clip.add', { trackId: track.id, name: 'Overlap', start: .006, audio: signal(layout, 32) });
    await editor.execute('markers.add', { name: 'Verse', time: .006 });
    await editor.execute('metadata.update', { metadata: { title: 'Café title', artist: 'Producer', comment: 'One\nTwo', key: 'Dm' } });
    const source = await editor.execute('project.save'), exported = await exportReaper(source), files = unzipSync(exported.bytes);
    assert.equal(exported.ext, 'zip'); assert.match(new TextDecoder().decode(files['project.rpp']), /^<REAPER_PROJECT/);
    assert.equal(Object.keys(files).filter(path => path.endsWith('.wav')).length, 2);
    const imported = await importReaper(exported.bytes), loaded = await open(imported.project);
    assert.equal(imported.project.name, source.name); assert.equal(imported.project.outputLayout, layout); assert.equal(imported.project.bpm, 132);
    assert.deepEqual(imported.project.metadata, source.metadata); assert.equal(imported.project.markers[0].name, 'Verse');
    assert.ok(maxDifference(await editor.execute('audio.render'), await loaded.execute('audio.render')) < 1e-7, layout);
    for (let clip = 0; clip < 2; clip++) assert.deepEqual(loaded.getProject().tracks[0].clips[clip].audio.channels, editor.getProject().tracks[0].clips[clip].audio.channels);
  }
});

test('mixed layouts split pan translations and surround downmix is explicitly rendered', async () => {
  for (const outputLayout of ['stereo', 'mono', '5.1']) {
    const editor = new AudioEditor({ sampleRate: 8000, outputLayout }), track = await editor.execute('track.add', { name: 'Mixed' });
    await editor.execute('track.update', { trackId: track.id, gainDb: -6, pan: .42 });
    for (const [index, layout] of ['mono', 'stereo', '7.1'].entries()) await editor.execute('clip.add', { trackId: track.id, name: layout, start: index * .003, audio: signal(layout, 40) });
    const result = await exportReaper(await editor.execute('project.save')), imported = await importReaper(result.bytes), loaded = await open(imported.project);
    assert.ok(result.warnings.some(warning => warning.includes('rendered through'))); assert.equal(imported.project.tracks.length, 3);
    assert.ok(maxDifference(await editor.execute('audio.render'), await loaded.execute('audio.render')) < 1e-7, outputLayout);
  }
});

test('maximum valid quoted metadata fits its escaped JSON package manifest', async () => {
  const editor = new AudioEditor({ sampleRate: 8000 });
  const metadata = Object.fromEntries(['title', 'artist', 'album', 'albumArtist', 'composer', 'genre', 'date', 'track'].map(key => [key, '"'.repeat(1024)]));
  await editor.execute('metadata.update', { metadata });
  const exported = await exportReaper(await editor.execute('project.save'));
  assert.deepEqual((await importReaper(exported.bytes)).project.metadata, metadata);
});

test('independent loose RPP imports visible trims and constant native linear pan without mutating media', async () => {
  const source = signal('stereo'), wav = encodeWav(source, { float: true, bitDepth: 32 }), saved = wav.slice();
  const { project, warnings } = await importReaper(bytes(independentRpp()), { name: 'independent.rpp', files: new Map([['tone.wav', wav]]) });
  assert.deepEqual(wav, saved); assert.equal(project.bpm, 128); assert.equal(project.tracks[0].clips[0].start, .02); assert.equal(project.markers[0].name, 'Point');
  const editor = await open(project), clip = editor.getProject().tracks[0].clips[0];
  assert.deepEqual(clip.audio.channels[0], source.channels[0].slice(16, 56)); assert.ok(warnings.some(warning => warning.includes('Visible source trims')));
  const render = await editor.execute('audio.render');
  for (let i = 0; i < 40; i++) { assert.ok(Math.abs(render.channels[0][160 + i] - source.channels[0][16 + i] * .5 * .75) < 1e-8); assert.ok(Math.abs(render.channels[1][160 + i] - source.channels[1][16 + i] * .5) < 1e-8); }
});

test('absolute references require supplied aliases or an unambiguous uploaded basename; never fetch', async () => {
  const wav = encodeWav(signal('stereo'), { float: true, bitDepth: 32 }), reference = 'C:\\Original\\audio\\tone.wav';
  const exact = await importReaper(bytes(independentRpp({ reference })), { files: new Map([[reference, wav]]) });
  assert.ok(!exact.warnings.some(warning => warning.includes('remapped')));
  const unique = await importReaper(bytes(independentRpp({ reference })), { files: new Map([['uploaded/tone.wav', wav]]) });
  assert.ok(unique.warnings.some(warning => warning.includes('explicitly remapped')));
  await assert.rejects(importReaper(bytes(independentRpp({ reference })), { files: new Map([['a/tone.wav', wav], ['b/tone.wav', wav]]) }), /Ambiguous media/);
  await assert.rejects(importReaper(bytes(independentRpp({ reference: 'https://invalid.example/private.wav' }))), /Missing media/);
  const explicitUrl = await importReaper(bytes(independentRpp({ reference: 'https://invalid.example/tone.wav' })), { files: new Map([['https://invalid.example/tone.wav', wav]]) });
  assert.equal(explicitUrl.project.tracks.length, 1);
});

test('package-relative references work and unsafe archives or ambiguous RPP roots fail', async () => {
  const wav = encodeWav(signal('stereo'), { float: true, bitDepth: 32 });
  const valid = zipSync({ 'session/project.rpp': bytes(independentRpp({ reference: 'media/tone.wav' })), 'session/media/tone.wav': wav });
  assert.equal((await importReaper(valid)).project.tracks.length, 1);
  await assert.rejects(importReaper(zipSync({ '../project.rpp': bytes(independentRpp()) })), /unsafe file path/);
  await assert.rejects(importReaper(zipSync({ 'a.rpp': bytes(independentRpp()), 'b.rpp': bytes(independentRpp()) })), /exactly one RPP/);
  await assert.rejects(importReaper(valid, { files: new Map([['session/media/tone.wav', wav]]) }), /duplicate supplied/);
});

test('unsupported native sound-bearing states reject before any project is returned', async () => {
  const options = { files: new Map([['tone.wav', encodeWav(signal('stereo'), { float: true, bitDepth: 32 })]]) };
  for (const [change, pattern] of [
    [{ track: 'AUXRECV 0 0 1' }, /AUXRECV/], [{ track: '<FXCHAIN\n<VST effect\n>\n>' }, /FXCHAIN/],
    [{ item: 'TAKE' }, /TAKE/], [{ item: '<VOLENV\nPT 0 1 0\n>' }, /VOLENV/],
    [{ project: '<TEMPOENVEX\nPT 0 120 0\n>' }, /TEMPOENVEX/], [{ item: 'REVERSE 1' }, /REVERSE/],
  ]) await assert.rejects(importReaper(bytes(independentRpp(change)), options), pattern);
  await assert.rejects(importReaper(bytes(independentRpp().replace('PLAYRATE 1 1 0', 'PLAYRATE 2 1 0')), options), /PLAYRATE processing/);
  await assert.rejects(importReaper(bytes(independentRpp().replace('FADEIN 1 0 0', 'FADEIN 1 0.001 0')), options), /FADEIN processing/);
  await assert.rejects(importReaper(bytes(independentRpp({ offset: .009 })), options), /outside its source/);
  await assert.rejects(importReaper(bytes(independentRpp().replace('VOLPAN 0.5 0.25 1 -1 1', 'VOLPAN 0.5 0.25 0.707 -1 1')), options), /pan mode\/law/);
  await assert.rejects(importReaper(bytes(independentRpp().replace('VOLPAN 0.5 0.25 1 -1 1', 'VOLPAN 0x1 0.25 1 -1 1')), options), /invalid VOLPAN/);
  await assert.rejects(importReaper(bytes(independentRpp({ project: 'RENDER_FMT 0 4 8000' })), options), /channel routing/);
});

test('genuine REAPER 7.86 defaults are inert while its actual tempo-stretched takes still reject', async () => {
  const native = await readFile(new URL('./fixtures/reaper-7.86/native-probe.rpp', import.meta.url), 'utf8');
  const layouts = ['mono', 'stereo', '5.1', '7.1'];
  const audio = layouts.map(layout => signal(layout, 2400, 48000));
  const files = new Map(layouts.map((layout, index) => [`${layout}.wav`, encodeWav(audio[index], { float: true, bitDepth: 32 })]));
  // The first native probe changed tempo after adding beat-attached items. Keep
  // that untouched native file as a rejection fixture; only this derived case
  // removes the unsupported stretch to exercise its verified default records.
  await assert.rejects(importReaper(bytes(native), { files }), /PLAYRATE processing/);
  const unscaled = native.replaceAll('PLAYRATE 1.06666666666667 1 0 -1 0 0.0025', 'PLAYRATE 1 1 0 -1 0 0.0025');
  const { project } = await importReaper(bytes(unscaled), { files }), editor = await open(project);
  assert.equal(project.outputLayout, '7.1'); assert.equal(project.bpm, 128); assert.equal(project.metadata.title, 'Native title');
  assert.equal(project.markers[0].name, 'Native marker'); assert.equal(project.tracks.length, 4);
  for (const [index, track] of editor.getProject().tracks.entries()) {
    assert.equal(track.name, `${layouts[index]} probe`); assert.equal(track.clips[0].start, .09375);
    assert.deepEqual(track.clips[0].audio.channels, audio[index].channels.map(channel => channel.slice(240, 2040)));
  }
  for (const [changed, message] of [
    [unscaled.replace('FIXEDLANES 9 0 0 0 0', 'FIXEDLANES 9 1 0 0 0'), /fixed lanes/],
    [unscaled.replace('FIXEDLANES 9 0 0 0 0', 'FIXEDLANES 9 0 0 0 0\nFREEMODE 2'), /FREEMODE processing/],
    [unscaled.replace('<TEMPOENVEX', '<TEMPOENVEX\nPT 0 128 0'), /TEMPOENVEX/],
    [unscaled.replace('FADEIN 1 0 -0.9375', 'FADEIN 1 0 0.001'), /automatic fades/],
    [unscaled.replace('VOLPAN 0.7 0.3 1 -1 1', 'VOLPAN 0.7 0.3 0.5 -1 1'), /pan mode\/law/],
  ]) await assert.rejects(importReaper(bytes(changed), { files }), message);
});

test('overlap replacement, excessive lanes and invalid decoder results cannot silently change sound', async () => {
  const editor = new AudioEditor({ sampleRate: 8000 }), track = await editor.execute('track.add', { name: 'Overlapping' });
  for (let i = 0; i < 2; i++) await editor.execute('clip.add', { trackId: track.id, name: `Take ${i}`, audio: signal('mono', 8) });
  const files = unzipSync((await exportReaper(await editor.execute('project.save'))).bytes);
  files['project.rpp'] = bytes(new TextDecoder().decode(files['project.rpp']).replace('MIXFLAG 1', 'MIXFLAG 0'));
  await assert.rejects(importReaper(zipSync(files)), /replacement mixing/);
  const source = independentRpp({ reference: 'tone.mp3' }).replace('SOURCE WAVE', 'SOURCE MP3');
  let received;
  const decoded = await importReaper(bytes(source), { files: new Map([['tone.mp3', Uint8Array.of(1)]]), decodeMedia: async (data, options) => { received = options; return signal('stereo'); } });
  assert.equal(received.name, 'tone.mp3'); assert.equal(received.maxPcmBytes, 256 * 1024 * 1024); assert.equal(decoded.project.tracks.length, 1);
  await assert.rejects(importReaper(bytes(source), { files: new Map([['tone.mp3', Uint8Array.of(1)]]), decodeMedia: async () => ({ sampleRate: 8000, channels: [Float32Array.of(Infinity)] }) }), /finite|unreasonable/);
});
