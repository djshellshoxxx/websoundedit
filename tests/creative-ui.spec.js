import { test, expect } from '@playwright/test';
import { decodeWav } from '../src/wav.js';
import { encodeMidiFile, parseMidiFile } from '../src/midi.js';

async function boot(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => websoundedit.ready);
  return errors;
}

test('sample keys, metadata, themes and collapsed inspector survive project round-trip', async ({ page }, testInfo) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const sampleRate = 16000;
    const channel = Float32Array.from({ length: sampleRate * 1.5 }, (_, frame) => [48, 60, 64, 67].reduce((sum, note, voice) => sum + (voice === 1 ? .18 : .1) * Math.sin(2 * Math.PI * 440 * 2 ** ((note - 69) / 12) * frame / sampleRate), 0));
    await websoundedit.execute('project.new', { name: 'Creative round trip', sampleRate });
    await websoundedit.execute('clip.add', { name: 'C major sample', audio: { sampleRate, channels: [channel] } });
    window.__creativeBefore = await websoundedit.execute('clip.getAudio');
  });
  await page.locator('[data-action="analysis.key"]').click();
  await expect(page.locator('#sample-key-badge')).toHaveText('C major');
  await page.locator('[data-action="panel.keys"]').click();
  await page.locator('[data-key-override]').selectOption('9:minor');
  await expect(page.locator('#sample-key-badge')).toHaveText('A minor');
  await page.locator('#modal-close').click();
  await page.locator('[data-action="panel.metadata"]').click();
  await page.getByLabel('Metadata Title', { exact: true }).fill('Night & <light>');
  await page.getByLabel('Metadata Artist', { exact: true }).fill('Studio artist');
  await page.getByLabel('Metadata Comment', { exact: true }).fill('Tagged in the browser');
  await page.locator('#metadata-save').click();
  await expect(page.locator('#modal')).not.toBeVisible();

  const widthBefore = await page.locator('.track-waveform').evaluate(canvas => canvas.clientWidth);
  await page.locator('#theme-select').selectOption('daylight');
  await page.locator('#inspector-toggle').click();
  await expect(page.locator('#inspector-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sound-inspector')).not.toBeVisible();
  expect(await page.locator('.track-waveform').evaluate(canvas => canvas.clientWidth)).toBeGreaterThan(widthBefore + 150);
  await page.screenshot({ path: testInfo.outputPath('daylight-collapsed-desktop.png'), fullPage: true });
  const result = await page.evaluate(async () => {
    const project = await websoundedit.saveProject({ download: false });
    const other = websoundedit.saveSettings(); other.theme = 'terminal'; other.inspectorCollapsed = false;
    websoundedit.loadSettings(other);
    await websoundedit.execute('project.load', { project });
    const audio = await websoundedit.execute('clip.getAudio');
    const output = await websoundedit.exportAudio({ format: 'wav', scope: 'clip', raw: true, bitDepth: 32, download: false });
    return {
      metadata: websoundedit.getState().metadata,
      key: websoundedit.getState().tracks[0].clips[0].keyAnalysis.key,
      settings: { theme: websoundedit.saveSettings().theme, collapsed: websoundedit.saveSettings().inspectorCollapsed },
      unchanged: audio.channels[0].every((value, frame) => value === window.__creativeBefore.channels[0][frame]),
      bytes: Array.from(output.bytes),
    };
  });
  expect(result.metadata).toEqual({ title: 'Night & <light>', artist: 'Studio artist', comment: 'Tagged in the browser' });
  expect(result.key).toBe('A minor');
  expect(result.settings).toEqual({ theme: 'daylight', collapsed: true });
  expect(result.unchanged).toBe(true);
  expect(decodeWav(Uint8Array.from(result.bytes)).metadata).toEqual(result.metadata);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('daylight-collapsed-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('an invalid project UI payload cannot replace the current audio or settings', async ({ page }) => {
  const errors = await boot(page);
  const result = await page.evaluate(async () => {
    const project = await websoundedit.saveProject({ download: false });
    const before = websoundedit.getState(), beforeSettings = websoundedit.saveSettings();
    const invalid = structuredClone(project);
    invalid.name = 'Must not be installed';
    invalid.settings.ui.rack.chain = [{ id: 'bad', effect: 'filter', enabled: true, wet: 1, params: { frequency: 999999 } }];
    try { await websoundedit.loadProject(invalid); return { rejected: false }; }
    catch {
      const after = websoundedit.getState();
      return { rejected: true, name: after.name === before.name, revision: after.revision === before.revision,
        settings: JSON.stringify(websoundedit.saveSettings()) === JSON.stringify(beforeSettings),
        clips: JSON.stringify(after.tracks) === JSON.stringify(before.tracks) };
    }
  });
  expect(result).toEqual({ rejected: true, name: true, revision: true, settings: true, clips: true });
  expect(errors).toEqual([]);
});

test('MIDI mock devices connect on request, learn CC mapping, preserve the other XY axis and disconnect on project replacement', async ({ page }) => {
  await page.addInitScript(() => {
    const input = { id: 'test-input', name: 'Mock controller', state: 'connected', onmidimessage: null, close: async () => {} };
    const output = { id: 'test-output', name: 'Mock synth', state: 'connected', send: bytes => window.__midiSent.push([...bytes]) };
    const access = { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), onstatechange: null };
    window.__midiRequests = 0; window.__midiSent = []; window.__midiInput = input;
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async options => { window.__midiRequests++; window.__midiOptions = options; return access; } });
    window.__sendMidi = bytes => input.onmidimessage?.({ data: Uint8Array.from(bytes) });
  });
  const errors = await boot(page);
  expect(await page.evaluate(() => window.__midiRequests)).toBe(0);
  await page.locator('[data-panel="effects"]').click();
  await page.locator('[data-rack-choice]').selectOption('filter');
  await page.locator('[data-rack-add]').click();
  const stage = await page.evaluate(() => websoundedit.saveSettings().rack.chain[0]);
  await page.locator('[data-rack-axis="x"]').selectOption(`${stage.id}:wet`);
  await page.locator('[data-rack-axis="y"]').selectOption(`${stage.id}:frequency`);
  await page.evaluate(id => websoundedit.rack.setParameter(id, 'frequency', 3500), stage.id);
  await page.locator('[data-action="panel.midi"]').click();
  await page.locator('#midi-connect').click();
  await expect(page.locator('#midi-status')).toContainText('1 input(s)');
  expect(await page.evaluate(() => window.__midiOptions)).toEqual({ sysex: false });
  await page.locator('#midi-target').selectOption('xy:x');
  await page.locator('#midi-learn').click();
  await page.evaluate(() => window.__sendMidi([0xb2, 74, 32]));
  await expect(page.locator('#midi-mappings')).toContainText('CH 3 · CC 74');
  const values = await page.evaluate(() => websoundedit.saveSettings());
  expect(values.rack.chain[0].wet).toBeCloseTo(32 / 127, 2);
  expect(values.rack.chain[0].params.frequency).toBeCloseTo(3500, 4);
  expect(values.midi.mappings).toEqual([{ channel: 2, controller: 74, target: 'xy:x' }]);
  await page.locator('#midi-output').selectOption('test-output');
  await page.locator('#midi-start-out').click();
  expect(await page.evaluate(() => window.__midiSent.some(bytes => bytes.length === 1 && bytes[0] === 0xfa))).toBe(true);
  const connection = await page.evaluate(async () => {
    const project = await websoundedit.saveProject({ download: false });
    await websoundedit.loadProject(project);
    return { detached: window.__midiInput.onmidimessage === null, mappings: websoundedit.saveSettings().midi.mappings };
  });
  expect(connection.detached).toBe(true);
  expect(connection.mappings).toEqual(values.midi.mappings);
  expect(errors).toEqual([]);
});

test('MIDI files import through the file control and export their original note timing', async ({ page }) => {
  const errors = await boot(page);
  const sequence = { version: 1, notes: [{ note: 60, velocity: 100, channel: 1, start: 0, duration: .25 }, { note: 67, velocity: 70, channel: 1, start: .3, duration: .5 }] };
  await page.locator('[data-action="panel.midi"]').click();
  await page.locator('#midi-file-input').setInputFiles({ name: 'phrase.mid', mimeType: 'audio/midi', buffer: Buffer.from(encodeMidiFile(sequence)) });
  await expect(page.locator('#status')).toContainText('Imported 2 MIDI notes');
  const exported = await page.evaluate(() => Array.from(websoundedit.midi.export({ download: false })));
  const parsed = parseMidiFile(Uint8Array.from(exported));
  expect(parsed.notes.map(({ track, ...note }) => note)).toEqual(sequence.notes);
  await expect(page.locator('.track-waveform')).toHaveCount(4);
  expect(errors).toEqual([]);
});
