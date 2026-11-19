import { test, expect } from '@playwright/test';

const FORMAT_IDS = ['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aiff', 'alac', 'wma'];

function hasSignature(format, bytes) {
  const header = Buffer.from(bytes).toString('latin1');
  switch (format) {
    case 'wav': return header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE';
    case 'mp3': return header.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224;
    case 'flac': return header.startsWith('fLaC');
    case 'ogg': return header.startsWith('OggS') && header.includes('vorbis');
    case 'opus': return header.startsWith('OggS') && header.includes('OpusHead');
    case 'm4a': return header.includes('ftyp') && header.includes('mp4a');
    case 'alac': return header.includes('ftyp') && header.includes('alac');
    case 'aac': return bytes[0] === 255 && (bytes[1] & 246) === 240;
    case 'aiff': return header.startsWith('FORM') && ['AIFF', 'AIFC'].includes(header.slice(8, 12));
    case 'wma': return bytes[0] === 48 && bytes[1] === 38 && bytes[2] === 178 && bytes[3] === 117;
    default: return false;
  }
}

function diagnostics(page, testInfo, label) {
  const evidence = { label, stages: [], pageErrors: [], externalRequests: [], crashed: false };
  const origin = new URL(testInfo.project.use.baseURL).origin;
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('crash', () => { evidence.crashed = true; });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== origin) evidence.externalRequests.push(url.href);
  });
  return {
    evidence,
    async step(name, action) {
      const stage = { name, status: 'started' };
      evidence.stages.push(stage);
      // Node-side output and attachments survive a renderer crash, unlike a
      // result assembled at the end of one large page.evaluate callback.
      console.log('[codec:' + label + '] ' + name);
      try {
        const result = await test.step(label + ': ' + name, action);
        stage.status = 'passed';
        return result;
      } catch (error) {
        stage.status = 'failed';
        stage.error = error.message;
        throw error;
      }
    },
    async attach() {
      await testInfo.attach('codec-' + label + '-evidence.json', {
        body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
      });
    },
  };
}

async function fixture(page, diagnostic, channels = 2) {
  await diagnostic.step('load editor', async () => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.websoundedit?.ready));
    await page.evaluate(() => window.websoundedit.ready);
  });
  await diagnostic.step('import ' + (channels === 1 ? 'mono' : 'stereo') + ' PCM fixture', () => page.evaluate(async channelCount => {
    const helpers = await import(new URL('api.js', document.baseURI).href);
    const api = window.websoundedit;
    await api.execute('project.new', { name: 'Codec test', sampleRate: 48000 });
    const audio = helpers.generateAudio({ type: 'tone', frequency: 440, duration: 0.5, amplitude: 0.3, channels: channelCount, sampleRate: 48000 });
    const source = await api.importFile(new File([helpers.encodeWav(audio, { bitDepth: 32, float: true })], 'source.wav', { type: 'audio/wav' }));
    window.__codecTest = { helpers, source };
  }, channels));
  const capabilities = await diagnostic.step('load and probe bundled codecs', () => page.evaluate(async () => {
    const result = await window.websoundedit.loadCodecs();
    return result.formats.map(({ id, available }) => ({ id, available }));
  }));
  diagnostic.evidence.capabilities = capabilities;
  expect(capabilities.map(format => format.id)).toEqual(FORMAT_IDS);
  expect(capabilities.filter(format => format.available).map(format => format.id), 'all ten advertised formats are included').toEqual(FORMAT_IDS);
}

async function encodeFixture(page, diagnostic, format) {
  const encoded = await diagnostic.step('encode ' + format, () => page.evaluate(async id => {
    const state = window.__codecTest;
    const output = await window.websoundedit.exportAudio({ scope: 'clip', raw: true, clipId: state.source.clipId, format: id, bitDepth: 24, bitrate: 128, download: false });
    state.encodedFile = new File([output.bytes], 'roundtrip-' + id + '.' + output.ext, { type: output.mime });
    return { bytes: output.bytes.length, header: Array.from(output.bytes.subarray(0, 16384)) };
  }, format));
  diagnostic.evidence.encoded = { bytes: encoded.bytes, signature: hasSignature(format, encoded.header) };
  expect(encoded.bytes).toBeGreaterThan(100);
  expect(diagnostic.evidence.encoded.signature, format + ': actual container/codec signature').toBe(true);
}

async function importEncoded(page, diagnostic, name) {
  await diagnostic.step(name, () => page.evaluate(async () => {
    window.__codecTest.imported = await window.websoundedit.importFile(window.__codecTest.encodedFile);
  }));
  return diagnostic.step('inspect PCM after ' + name, () => page.evaluate(async () => {
    const state = window.__codecTest;
    const audio = await window.websoundedit.execute('clip.getAudio', { clipId: state.imported.clipId });
    const { duration, channels, sampleRate, rmsDb } = state.helpers.analyzeAudio(audio);
    return { duration, channels, sampleRate, rmsDb, finite: audio.channels.every(channel => channel.every(Number.isFinite)) };
  }));
}

function expectDecoded(audio, channels) {
  expect(audio.finite, 'finite decoded PCM').toBe(true);
  expect(audio.duration, 'duration lower bound').toBeGreaterThan(0.35);
  expect(audio.duration, 'encoder-padding tolerance').toBeLessThan(0.65);
  expect(audio.rmsDb, 'audible tone').toBeGreaterThan(-30);
  expect(audio.channels, 'source channel count preserved').toBe(channels);
  expect(audio.sampleRate, 'working sample rate preserved').toBe(48000);
}

// Each codec gets its own page, worker, and decoder state. This identifies the
// exact failed format/stage and avoids accumulating ten native decoder graphs.
for (const format of FORMAT_IDS) {
  test('bundled ' + format + ' encoder produces a real file and imports finite stereo PCM', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const diagnostic = diagnostics(page, testInfo, format);
    try {
      await fixture(page, diagnostic);
      await encodeFixture(page, diagnostic, format);
      diagnostic.evidence.decoded = await importEncoded(page, diagnostic, 'import ' + format);
      expectDecoded(diagnostic.evidence.decoded, 2);
      expect(diagnostic.evidence.pageErrors).toEqual([]);
      expect(diagnostic.evidence.externalRequests).toEqual([]);
    } finally {
      await diagnostic.attach();
    }
  });
}

test('mono MP3 preserves channels through native decoding and forced WASM fallback', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const diagnostic = diagnostics(page, testInfo, 'mono-mp3-fallback');
  try {
    await fixture(page, diagnostic, 1);
    await encodeFixture(page, diagnostic, 'mp3');
    await diagnostic.step('instrument native decoder', () => page.evaluate(() => {
      const state = window.__codecTest;
      state.nativeMethod = OfflineAudioContext.prototype.decodeAudioData;
      state.nativeCalls = 0; state.nativeSucceeded = 0; state.forcedCalls = 0;
      OfflineAudioContext.prototype.decodeAudioData = function (...args) {
        state.nativeCalls++;
        return state.nativeMethod.apply(this, args).then(audio => { state.nativeSucceeded++; return audio; });
      };
    }));
    diagnostic.evidence.native = await importEncoded(page, diagnostic, 'native mono MP3 import');
    expectDecoded(diagnostic.evidence.native, 1);
    await diagnostic.step('force native decoder failure', () => page.evaluate(() => {
      OfflineAudioContext.prototype.decodeAudioData = function () {
        window.__codecTest.forcedCalls++;
        return Promise.reject(new Error('Test fixture: native decoder unavailable'));
      };
    }));
    diagnostic.evidence.fallback = await importEncoded(page, diagnostic, 'WASM mono MP3 import');
    expectDecoded(diagnostic.evidence.fallback, 1);
    diagnostic.evidence.calls = await diagnostic.step('restore native decoder and inspect counters', () => page.evaluate(() => {
      const state = window.__codecTest;
      OfflineAudioContext.prototype.decodeAudioData = state.nativeMethod;
      return { native: state.nativeCalls, succeeded: state.nativeSucceeded, forced: state.forcedCalls };
    }));
    expect(diagnostic.evidence.calls).toEqual({ native: 1, succeeded: 1, forced: 1 });
    expect(diagnostic.evidence.native.duration).toBeCloseTo(0.5, 1);
    expect(diagnostic.evidence.fallback.duration).toBeCloseTo(0.5, 1);
    expect(diagnostic.evidence.pageErrors).toEqual([]);
    expect(diagnostic.evidence.externalRequests).toEqual([]);
  } finally {
    // Playwright disposes this test's context even if the renderer crashed.
    await diagnostic.attach();
  }
});
