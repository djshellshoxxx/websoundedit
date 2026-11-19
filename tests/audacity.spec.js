import { test, expect } from '@playwright/test';

for (const format of ['aup3', 'aup']) test(`browser saves and opens genuine Audacity ${format} with local codecs`, async ({page}, testInfo) => {
  const errors=[],external=[];const origin=new URL(testInfo.project.use.baseURL).origin;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.protocol.startsWith('http')&&url.origin!==origin)external.push(url.href);});
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.websoundedit?.ready));await page.evaluate(()=>window.websoundedit.ready);
  const bytes=await page.evaluate(async format=>{
    const api=window.websoundedit;
    await api.execute('project.new',{name:'Audacity browser fixture',sampleRate:48000,bpm:128});
    const track=await api.execute('track.add',{name:'Stereo fixture'});
    await api.execute('clip.add',{trackId:track.id,name:'Distinct channels',start:.2,audio:{sampleRate:48000,channels:[Float32Array.of(.25,.5,-.25,-.5),Float32Array.of(-.8,.4,.2,-.1)]}});
    await api.execute('metadata.update',{metadata:{title:'Saved in browser',artist:'Producer'}});
    const output=await api.exportAudacity(format,{download:false});
    return Array.from(output.bytes);
  },format);
  expect(bytes.length).toBeGreaterThan(100);
  if(format==='aup3')expect(Buffer.from(bytes.slice(0,16)).toString()).toBe('SQLite format 3\0');
  else expect(bytes.slice(0,2)).toEqual([80,75]);
  await page.evaluate(()=>window.websoundedit.execute('project.new',{name:'Replacement check'}));
  await page.locator('#project-input').setInputFiles({name:`fixture.${format==='aup3'?'aup3':'zip'}`,mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});
  await expect.poll(()=>page.evaluate(()=>window.websoundedit.getState()?.metadata?.title)).toBe('Saved in browser');
  const state=await page.evaluate(()=>window.websoundedit.getState());
  expect(state.bpm).toBe(128);expect(state.tracks).toHaveLength(1);expect(state.tracks[0].clips[0].channels).toBe(2);expect(state.tracks[0].clips[0].start).toBe(.2);
  const pcm=await page.evaluate(async()=>{const api=window.websoundedit;const audio=await api.execute('clip.getAudio',{clipId:api.getState().tracks[0].clips[0].id});return audio.channels.map(channel=>Array.from(channel));});
  expect(pcm[0]).toEqual([.25,.5,-.25,-.5]);expect(pcm[1][0]).toBeCloseTo(-.8,6);
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
