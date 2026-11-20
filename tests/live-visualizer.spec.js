import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ hasTouch: true });

const coloredPixels = locator => locator.evaluate(canvas => {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]), low = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (high > 90 && high - low > 65) count++;
  }
  return count;
});

async function boot(page) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => Boolean(window.websoundedit?.ready)); await page.evaluate(() => websoundedit.ready);
  await page.locator('#live-visualizer').scrollIntoViewIfNeeded();
  return errors;
}

test('live visualizer starts silently and its mobile source controls do not request a device', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('[data-live-mode]')).toHaveValue('waveform');
  await expect(page.locator('#live-visualizer')).toHaveAttribute('data-visual-state', 'idle');
  expect(await page.evaluate(() => websoundedit.live.getState().context.state)).toBe('not-started');
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('#live-visualizer').scrollIntoViewIfNeeded();
  await page.locator('[data-live-source]').selectOption('input');
  await expect(page.locator('[data-live-status]')).toContainText('Start an audio input in Options');
  const state = await page.evaluate(() => websoundedit.live.getState());
  expect(state.context.state).toBe('not-started'); expect(state.input.active).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  for (const selector of ['[data-live-source]', '[data-live-mode]', '[data-live-freeze]']) expect((await page.locator(selector).boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(errors).toEqual([]);
});

test('native Web Audio renders a known program tone and freezes without changing playback', async ({ page }, testInfo) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    await websoundedit.execute('project.new', { sampleRate: 48000 });
    await websoundedit.execute('audio.generate', { duration: 4, frequency: 1000, amplitude: .4, channels: 2 });
    await websoundedit.execute('transport.set', { loop: true, loopStart: 0, loopEnd: 4 });
  });
  await page.locator('#play-button').click();
  await page.locator('#live-visualizer').scrollIntoViewIfNeeded();
  await expect(page.locator('#live-visualizer')).toHaveAttribute('data-visual-state', 'live');
  await page.locator('[data-live-mode]').selectOption('spectrogram');
  await expect.poll(() => coloredPixels(page.locator('[data-live-canvas]'))).toBeGreaterThan(80);
  await page.locator('[data-live-freeze]').tap();
  const frames = await page.locator('#live-visualizer').getAttribute('data-visual-frames');
  await page.waitForTimeout(180);
  expect(await page.locator('#live-visualizer').getAttribute('data-visual-frames')).toBe(frames);
  expect(await page.evaluate(() => websoundedit.live.getState().transport.playing)).toBe(true);
  await page.locator('#live-visualizer').screenshot({ path: testInfo.outputPath('native-program-spectrogram.png') });
  await page.evaluate(() => websoundedit.execute('project.new', { sampleRate: 48000 }));
  await expect(page.locator('#live-visualizer')).toHaveAttribute('data-visual-frames', '0');
  expect(errors).toEqual([]);
});

test('persisted page lifecycle preserves unsaved audio and leaves live playback usable', async ({ page }) => {
  const errors = await boot(page);
  const before = await page.evaluate(async () => {
    await websoundedit.execute('project.new', { name: 'Unsaved cache session', sampleRate: 48000 });
    await websoundedit.execute('audio.generate', { duration: .25, frequency: 375, amplitude: .4, channels: 2 });
    await websoundedit.execute('selection.set', { start: .03, end: .18, channels: 'all' });
    await websoundedit.execute('live.rack.set', { chain: [{ id: 'cached-filter', effect: 'filter', wet: .5, params: { frequency: 9000 } }] });
    const audio = await websoundedit.execute('clip.getAudio');
    return { state: websoundedit.getState(), channels: audio.channels.map(values => Array.from(values.slice(0, 256))), racks: websoundedit.live.getState().racks };
  });
  // Exercise the persisted event contract even in automated browsers that
  // disable history caching. No reload, project recovery or reinitialization.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const after = await page.evaluate(async () => {
    await websoundedit.execute('audio.capabilities');
    const audio = await websoundedit.execute('clip.getAudio');
    return { state: websoundedit.getState(), channels: audio.channels.map(values => Array.from(values.slice(0, 256))), racks: websoundedit.live.getState().racks };
  });
  expect(after).toEqual(before);
  await page.evaluate(() => websoundedit.execute('transport.set', { loop: true, loopStart: 0, loopEnd: .25 }));
  await page.locator('#play-button').click();
  await page.locator('#live-visualizer').scrollIntoViewIfNeeded();
  await expect(page.locator('#live-visualizer')).toHaveAttribute('data-visual-state', 'live');
  await expect.poll(async () => Number(await page.locator('#live-visualizer').getAttribute('data-visual-frames'))).toBeGreaterThan(2);
  await page.evaluate(() => websoundedit.execute('transport.stop'));
  expect(errors).toEqual([]);
});

// This fixture tests actual browser Canvas/observer behavior with declared
// synthetic analyser data. The separate native test above covers Web Audio.
async function syntheticAnalyserPage(page) {
  const module = await readFile(new URL('../src/live-visualizer.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/live-visualizer.css', import.meta.url), 'utf8');
  await page.route('**/__visualizer-module.js', route => route.fulfill({ contentType: 'text/javascript', body: module }));
  await page.route('**/__visualizer-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#0e1116;color:#e6e8ec;font:13px system-ui;--panel:#171b22;--deep:#11151c;--text:#e6e8ec;--muted:#a0a8b4;--edge:#46566a;--green:#7bc96f;--mono:monospace}button,select{background:var(--deep);color:var(--text);border:1px solid var(--edge);border-radius:4px}button{cursor:pointer}${css}</style><section id="fixture"></section><script type="module">
    import {LiveVisualizer} from '/__visualizer-module.js';
    class Node { constructor(){this.connections=[];this.gain={value:1};} connect(node,...args){this.connections.push([node,...args]);return node;} disconnect(node){this.connections=node?this.connections.filter(entry=>entry[0]!==node):[];} }
    const source=new Node(),audible=new Node();source.connect(audible);let nextChannel=0;
    const context={sampleRate:48000,state:'running',destination:new Node(),get currentTime(){return performance.now()/1000+(fixture.clockOffset||0);},createGain:()=>new Node(),createChannelSplitter:()=>new Node(),createAnalyser(){const channel=nextChannel++%2,node=new Node();node.getFloatTimeDomainData=data=>{for(let i=0;i<data.length;i++)data[i]=(channel?-1:1)*fixture.level*Math.sin(2*Math.PI*1000*i/48000);};node.getFloatFrequencyData=data=>{data.fill(-120);if(fixture.level)for(const [bin,db,width=2] of fixture.tones||[[11,-20],[43,-6],[171,-38]])for(let d=-width;d<=width;d++)data[bin+d]=db-Math.abs(d)*10+20*Math.log10(fixture.level);};return node;}};
    window.fixture={level:0,source,audible,context};
    fixture.view=new LiveVisualizer(document.querySelector('#fixture'),{getSource:kind=>kind==='master'?{context,node:source,channels:2}:null});
    window.fixtureReady=true;
  </script>` }));
  await page.goto('/__visualizer-fixture'); await page.waitForFunction(() => window.fixtureReady);
}

test('synthetic analyser data drives all color views, bounded frames, mobile freeze and cleanup', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await syntheticAnalyserPage(page);
  await page.locator('[data-live-mode]').selectOption('spectrogram');
  await expect.poll(() => page.locator('#fixture').getAttribute('data-visual-frames')).not.toBe('0');
  expect(await coloredPixels(page.locator('[data-live-canvas]'))).toBe(0);
  await page.evaluate(() => { fixture.level = .5; });
  await expect.poll(() => coloredPixels(page.locator('[data-live-canvas]'))).toBeGreaterThan(80);
  const start = await page.evaluate(() => ({ time: performance.now(), frames: Number(document.querySelector('#fixture').dataset.visualFrames) }));
  await page.waitForTimeout(220);
  const end = await page.evaluate(() => ({ time: performance.now(), frames: Number(document.querySelector('#fixture').dataset.visualFrames) }));
  expect(end.frames - start.frames).toBeLessThanOrEqual(Math.ceil((end.time - start.time) * .03) + 2);
  for (const mode of ['spectrogram', 'waterfall', 'waveform']) {
    await page.locator('[data-live-mode]').selectOption(mode);
    await expect(page.locator('[data-live-canvas]')).toHaveAttribute('aria-label', new RegExp(mode, 'i'));
    await page.locator('#fixture').screenshot({ path: testInfo.outputPath(`synthetic-${mode}-desktop.png`) });
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('[data-live-freeze]').tap();
  const frames = await page.locator('#fixture').getAttribute('data-visual-frames'), pixels = await page.locator('[data-live-canvas]').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(180);
  expect(await page.locator('#fixture').getAttribute('data-visual-frames')).toBe(frames);
  expect(await page.locator('[data-live-canvas]').evaluate(canvas => canvas.toDataURL())).toBe(pixels);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.locator('#fixture').screenshot({ path: testInfo.outputPath('synthetic-waveform-mobile320.png') });
  await page.locator('[data-live-freeze]').tap();
  await page.evaluate(() => { const spacer = document.createElement('div'); spacer.style.height = '2000px'; document.body.prepend(spacer); scrollTo(0, 0); });
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'suspended');
  expect(await page.evaluate(() => fixture.source.connections.length)).toBe(1);
  await page.locator('#fixture').scrollIntoViewIfNeeded();
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'live');
  expect(await page.evaluate(() => fixture.source.connections.length)).toBe(2);
  await expect.poll(async () => Number(await page.locator('#fixture').getAttribute('data-visual-frames'))).toBeGreaterThan(1);
  // Simulate a hidden tab and a minute of real audio-clock time in this declared
  // fixture; retained columns must not compress that uncaptured gap on return.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'suspended');
  expect(await page.evaluate(() => fixture.source.connections.length)).toBe(1);
  await page.evaluate(() => { fixture.clockOffset = 60; Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => Number(await page.locator('#fixture').getAttribute('data-visual-frames'))).toBeGreaterThan(1);
  expect(await page.evaluate(() => fixture.view.history.capturedSeconds)).toBeLessThan(1);
  await page.evaluate(() => { delete document.hidden; });
  await page.locator('[data-live-source]').selectOption('input');
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'idle');
  expect(await page.evaluate(() => fixture.source.connections.length)).toBe(1);
  // This narrow16 kHz signal lands in odd log band185. Coarser waterfall
  // drawing must preserve its peak when combining neighboring bands.
  await page.evaluate(() => { fixture.tones = [[683, -6, 0]]; });
  await page.locator('[data-live-mode]').selectOption('waterfall');
  await page.locator('[data-live-source]').selectOption('master');
  await expect.poll(() => coloredPixels(page.locator('[data-live-canvas]'))).toBeGreaterThan(10);
  await page.evaluate(() => fixture.view.dispose());
  expect(await page.evaluate(() => fixture.source.connections[0][0] === fixture.audible)).toBe(true);
  expect(errors).toEqual([]);
});

test('reduced motion waits for an explicit Resume before reading a live signal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await syntheticAnalyserPage(page);
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'paused');
  expect(await page.evaluate(() => fixture.source.connections.length)).toBe(1);
  await page.locator('[data-live-freeze]').tap();
  await expect(page.locator('#fixture')).toHaveAttribute('data-visual-state', 'live');
  await expect.poll(async () => Number(await page.locator('#fixture').getAttribute('data-visual-frames'))).toBeGreaterThan(0);
  await page.evaluate(() => fixture.view.dispose());
});
