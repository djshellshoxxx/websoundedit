import { test, expect } from '@playwright/test';

test('bundled single-thread codecs encode real formats and round-trip through native and forced fallback import', async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== new URL(testInfo.project.use.baseURL).origin) externalRequests.push(request.url()); });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
  await page.evaluate(() => window.websoundedit.ready);
  const results = await page.evaluate(async () => {
    const api = websoundedit;
    const { encodeWav, generateAudio, analyzeAudio } = await import(new URL('api.js', document.baseURI).href);
    await api.execute('project.new', { name: 'Codec test', sampleRate: 48000 });
    const audio = generateAudio({ type: 'tone', frequency: 440, duration: 0.5, amplitude: 0.3, channels: 2 });
    const source = await api.importFile(new File([encodeWav(audio, { bitDepth: 32, float: true })], 'source.wav', { type: 'audio/wav' }));
    const capability = await api.loadCodecs(), results = [];
    window.__codecFiles = {};
    for (const format of capability.formats) {
      if (!format.available) { results.push({ id: format.id, available: false }); continue; }
      try {
        const output = await api.exportAudio({ scope: 'clip', clipId: source.clipId, format: format.id, bitDepth: 24, bitrate: 128, download: false });
        const header = String.fromCharCode(...output.bytes.slice(0, 16384));
        const bytes = output.bytes;
        const signature = format.id === 'wav' ? header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE'
          : format.id === 'mp3' ? header.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224
          : format.id === 'flac' ? header.startsWith('fLaC')
          : format.id === 'ogg' ? header.startsWith('OggS') && header.includes('vorbis')
          : format.id === 'opus' ? header.startsWith('OggS') && header.includes('OpusHead')
          : format.id === 'm4a' ? header.includes('ftyp') && header.includes('mp4a')
          : format.id === 'alac' ? header.includes('ftyp') && header.includes('alac')
          : format.id === 'aac' ? bytes[0] === 255 && (bytes[1] & 246) === 240
          : format.id === 'aiff' ? header.startsWith('FORM') && ['AIFF', 'AIFC'].includes(header.slice(8, 12))
          : format.id === 'wma' ? bytes[0] === 48 && bytes[1] === 38 && bytes[2] === 178 && bytes[3] === 117 : false;
        const file = new File([bytes], `roundtrip-${format.id}.${output.ext}`, { type: output.mime });
        window.__codecFiles[format.id] = file;
        const imported = await api.importFile(file);
        const decoded = await api.execute('clip.getAudio', { clipId: imported.clipId });
        const stats = analyzeAudio(decoded);
        results.push({ id: format.id, available: true, bytes: bytes.length, signature, duration: stats.duration, channels: stats.channels, sampleRate: stats.sampleRate, rmsDb: stats.rmsDb, finite: decoded.channels.every(c => c.every(Number.isFinite)) });
      } catch (error) { results.push({ id: format.id, available: true, error: error.message }); }
    }
    const nativeMethod = OfflineAudioContext.prototype.decodeAudioData;
    let calls = 0, nativeSucceeded = 0, forcedCalls = 0;
    let nativeResult, fallbackResult;
    if (window.__codecFiles.mp3) {
      try {
        OfflineAudioContext.prototype.decodeAudioData = function (...args) {
          calls++;
          return nativeMethod.apply(this, args).then(audio => { nativeSucceeded++; return audio; });
        };
        const native = await api.importFile(window.__codecFiles.mp3);
        nativeResult = analyzeAudio(await api.execute('clip.getAudio', { clipId: native.clipId }));
        OfflineAudioContext.prototype.decodeAudioData = function () { forcedCalls++; return Promise.reject(new Error('Test fixture: native decoder unavailable')); };
        const fallback = await api.importFile(window.__codecFiles.mp3);
        fallbackResult = analyzeAudio(await api.execute('clip.getAudio', { clipId: fallback.clipId }));
      } finally { OfflineAudioContext.prototype.decodeAudioData = nativeMethod; }
    }
    return { formats: results, native: { calls, nativeSucceeded, forcedCalls, nativeResult, fallbackResult } };
  });
  await testInfo.attach('codec-roundtrip-evidence.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.formats.map(format => format.id)).toEqual(['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aiff', 'alac', 'wma']);
  for (const format of results.formats.filter(format => format.available)) {
    expect.soft(format.error, `${format.id}: encoding and decoding should succeed`).toBeUndefined();
    expect.soft(format.signature, `${format.id}: actual container/codec signature`).toBe(true);
    expect.soft(format.bytes, `${format.id}: nonempty encoded payload`).toBeGreaterThan(100);
    expect.soft(format.finite, `${format.id}: finite decoded PCM`).toBe(true);
    expect.soft(format.duration, `${format.id}: duration lower bound`).toBeGreaterThan(0.35);
    expect.soft(format.duration, `${format.id}: padding tolerance`).toBeLessThan(0.65);
    expect.soft(format.rmsDb, `${format.id}: audible tone`).toBeGreaterThan(-30);
    expect.soft(format.channels, `${format.id}: stereo preserved`).toBe(2);
  }
  expect(results.formats.find(format => format.id === 'mp3')?.available).toBe(true);
  expect(results.native.calls).toBe(1);
  expect(results.native.nativeSucceeded).toBe(1);
  expect(results.native.forcedCalls).toBe(1);
  expect(results.native.nativeResult.duration).toBeCloseTo(0.5, 1);
  expect(results.native.fallbackResult.duration).toBeCloseTo(0.5, 1);
  expect(results.native.fallbackResult.rmsDb).toBeGreaterThan(-30);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});
