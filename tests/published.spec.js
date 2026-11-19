import {test,expect} from '@playwright/test';
test('the published Pages beta loads its exact modules and completes a real edit',async({page})=>{
 test.skip(!process.env.PLAYWRIGHT_BASE_URL,'Live verification runs after Pages deployment.');
 await expect.poll(async()=>{const response=await page.request.get(new URL('build.json',process.env.PLAYWRIGHT_BASE_URL).href+'?commit='+process.env.GITHUB_SHA);return response.ok()?(await response.json()).commit:null;},{timeout:60000}).toBe(process.env.GITHUB_SHA);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('./');await page.waitForFunction(()=>Boolean(window.websoundedit?.ready));await page.evaluate(()=>websoundedit.ready);
 expect(await page.evaluate(()=>websoundedit.version)).toBe('1.0.0-beta.1');
 const result=await page.evaluate(async()=>{
  const api=websoundedit;await api.execute('project.new',{name:'Published beta verification',sampleRate:8000,outputLayout:'5.1'});
  await api.execute('audio.generate',{duration:.02,frequency:500,amplitude:.25,layout:'5.1'});
  await api.execute('effect.reverse');await api.execute('effect.normalize',{targetDb:-3});
  const project=await api.execute('project.save');const all=api.commandCatalog();
  await api.execute('ui.options',{page:'general'});
  return {tracks:project.tracks.length,layout:project.outputLayout,methods:all.map(command=>command.method)};
 });
 expect(result.tracks).toBe(1);expect(result.layout).toBe('5.1');
 for(const method of ['macro.run','loop.capture.start','recordings.export','stream.start','file.export','ui.help'])expect(result.methods).toContain(method);
 await expect(page.locator('#options-tooltips')).toBeVisible();expect(errors).toEqual([]);
});
