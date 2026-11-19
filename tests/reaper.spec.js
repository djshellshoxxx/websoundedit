import { test, expect } from '@playwright/test';

for (const [layout, channelCount] of [['mono', 1], ['stereo', 2], ['5.1', 6], ['7.1', 8]]) {
  test(`browser exports and reopens genuine REAPER ${layout} media package`, async ({ page }, testInfo) => {
    const errors = [], external = [], origin = new URL(testInfo.project.use.baseURL).origin;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== origin) external.push(url.href); });
    await page.goto('/'); await page.waitForFunction(() => Boolean(window.websoundedit?.ready)); await page.evaluate(() => window.websoundedit.ready);
    const bytes = await page.evaluate(async ({ layout, channelCount }) => {
      const api = window.websoundedit;
      await api.execute('project.new', { name: `REAPER ${layout} browser fixture`, sampleRate: 48000, bpm: 133, outputLayout: layout });
      const track = await api.execute('track.add', { name: 'Distinct speaker channels' });
      await api.execute('track.update', { trackId: track.id, gainDb: -3, pan: .24 });
      await api.execute('clip.add', { trackId: track.id, name: 'Speaker identity', start: .2, audio: { sampleRate: 48000, layout, channels: Array.from({ length: channelCount }, (_, ch) => Float32Array.of((ch + 1) * .05, -.125, .25, -.375)) } });
      await api.execute('markers.add', { name: 'Cue', time: .2 });
      await api.execute('metadata.update', { metadata: { title: `Browser ${layout}`, artist: 'Producer', comment: 'First\nSecond' } });
      const output = await api.execute('file.export', { format: 'reaper', scope: 'mix', download: false });
      return Array.from(output.bytes);
    }, { layout, channelCount });
    expect(bytes.slice(0, 2)).toEqual([80, 75]);
    await page.evaluate(() => window.websoundedit.execute('project.new', { name: 'Replacement' }));
    await page.locator('#project-input').setInputFiles({ name: 'reaper-project.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
    await expect.poll(() => page.evaluate(() => window.websoundedit.getState()?.metadata?.title)).toBe(`Browser ${layout}`);
    const state = await page.evaluate(() => window.websoundedit.getState());
    expect(state.outputLayout).toBe(layout); expect(state.bpm).toBe(133); expect(state.tracks).toHaveLength(1); expect(state.tracks[0].clips[0].channels).toBe(channelCount); expect(state.tracks[0].clips[0].start).toBe(.2); expect(state.markers[0].name).toBe('Cue');
    const channels = await page.evaluate(async () => { const api = window.websoundedit, audio = await api.execute('clip.getAudio', { clipId: api.getState().tracks[0].clips[0].id }); return audio.channels.map(channel => Array.from(channel)); });
    expect(channels).toHaveLength(channelCount);
    for (let ch = 0; ch < channelCount; ch++) { expect(channels[ch][0]).toBeCloseTo((ch + 1) * .05, 6); expect(channels[ch].slice(1)).toEqual([-.125, .25, -.375]); }
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}

test('browser Audacity surround export requires an explicit channel-stem choice', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => Boolean(window.websoundedit?.ready)); await page.evaluate(() => window.websoundedit.ready);
  const result = await page.evaluate(async () => {
    const api = window.websoundedit;
    await api.execute('project.new', { name: 'Surround channel stems', sampleRate: 48000, outputLayout: '5.1' });
    await api.execute('clip.add', { name: 'Surround', audio: { sampleRate: 48000, layout: '5.1', channels: Array.from({ length: 6 }, (_, ch) => Float32Array.of((ch + 1) * .1, -.2)) } });
    let rejected = '';
    try { await api.execute('file.export', { format: 'aup3', download: false }); } catch (error) { rejected = error.message; }
    const stems = await api.execute('file.export', { format: 'aup3', multichannel: 'split-mono', download: false });
    return { rejected, warnings: stems.warnings, bytes: Array.from(stems.bytes) };
  });
  expect(result.rejected).toContain('split-mono'); expect(result.warnings.join(' ')).toContain('not a surround project mixer');
  await page.locator('#project-input').setInputFiles({ name: 'channel-stems.aup3', mimeType: 'application/octet-stream', buffer: Buffer.from(result.bytes) });
  await expect.poll(() => page.evaluate(() => window.websoundedit.getState()?.tracks?.length)).toBe(6);
  const tracks = await page.evaluate(() => window.websoundedit.getState().tracks);
  for (const [index, speaker] of ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'].entries()) { expect(tracks[index].name).toContain(`[5.1 ${speaker}]`); expect(tracks[index].clips[0].channels).toBe(1); }
});
