import packageInfo from '../package.json' with { type: 'json' };
import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {HELP_IMAGES} from '../src/help-content.js';
test('the published Pages beta loads its exact modules and completes a real edit',async({page},testInfo)=>{
 test.skip(!process.env.PLAYWRIGHT_BASE_URL,'Live verification runs after Pages deployment.');
 await expect.poll(async()=>{const response=await page.request.get(new URL('build.json',process.env.PLAYWRIGHT_BASE_URL).href+'?commit='+process.env.GITHUB_SHA);return response.ok()?(await response.json()).commit:null;},{timeout:60000}).toBe(process.env.GITHUB_SHA);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('./');await page.waitForFunction(()=>Boolean(window.websoundedit?.ready));await page.evaluate(()=>websoundedit.ready);
 expect(await page.evaluate(()=>websoundedit.version)).toBe(packageInfo.version);
 const result=await page.evaluate(async()=>{
  const api=websoundedit;await api.execute('project.new',{name:'Published beta verification',sampleRate:8000,outputLayout:'5.1'});
  await api.execute('audio.generate',{duration:.02,frequency:500,amplitude:.25,layout:'5.1'});
  await api.execute('effect.reverse');await api.execute('effect.normalize',{targetDb:-3});
  await api.execute('effect.preset',{presetId:'auto-limiter'});
  await api.execute('effect.preset',{presetId:'normalize-headroom'});
  const script=await api.execute('macro.run',{text:'random.seed({seed:2026}); let rows=[]; for (a of [1,2]) { let row=[]; for (b of [3,4]) { row=array.append({values:row,value:a+b}); } rows=array.append({values:rows,value:row}); } let value=random.int({min:1,max:4});'});
  const exported=await api.execute('file.export',{scope:'clip',raw:true,format:'flac',download:false});
  const project=await api.execute('project.save');const all=api.commandCatalog();
  await api.execute('ui.options',{page:'general'});
  return {tracks:project.tracks.length,layout:project.outputLayout,methods:all.map(command=>command.method),rows:script.variables.rows,random:script.variables.value,flacMagic:String.fromCharCode(...exported.bytes.slice(0,4)),flacBytes:exported.bytes.length,themes:document.querySelectorAll('#theme-select option').length,visualizerMode:document.querySelector('[data-live-mode]')?.value};
 });
 expect(result.tracks).toBe(1);expect(result.layout).toBe('5.1');
 for(const method of ['macro.run','loop.capture.start','recordings.export','stream.start','file.export','ui.help','effect.preset','effect.noiseGate','edit.insertSilence','selection.zeroCrossing','clip.extractChannels'])expect(result.methods).toContain(method);
 expect(result.rows).toEqual([[4,5],[5,6]]);expect(result.random).toBeGreaterThanOrEqual(1);expect(result.random).toBeLessThanOrEqual(4);
 expect(result.flacMagic).toBe('fLaC');expect(result.flacBytes).toBeGreaterThan(100);expect(result.themes).toBe(10);expect(result.visualizerMode).toBe('waveform');
 await expect(page.locator('#options-tooltips')).toBeVisible();expect(errors).toEqual([]);
 for(const name of ['SCRIPTING','BROWSER_SUPPORT']){
  const guide=await page.request.get(new URL(`docs/${name}.md`,process.env.PLAYWRIGHT_BASE_URL).href);
  expect(guide.ok()).toBe(true);expect((await guide.text()).trim()).toMatch(/^# /);
 }
 await page.screenshot({path:testInfo.outputPath('published-options.png'),fullPage:true});
 await page.locator('[data-view-close]').click();
 await page.screenshot({path:testInfo.outputPath('published-editor.png'),fullPage:true});
 await page.evaluate(()=>websoundedit.execute('ui.help',{chapter:'navigation'}));
 const helpImage=page.locator('.help-figure img').first(),expectedImage=HELP_IMAGES.find(item=>item.chapter==='navigation');
 expect(expectedImage).toBeTruthy();await helpImage.scrollIntoViewIfNeeded();
 await expect.poll(()=>helpImage.evaluate(img=>({loaded:img.complete&&img.naturalWidth>0,width:img.naturalWidth,height:img.naturalHeight}))).toEqual({loaded:true,width:expectedImage.width,height:expectedImage.height});
 await expect(helpImage).toHaveAttribute('alt',expectedImage.alt);
 await page.screenshot({path:testInfo.outputPath('published-help.png'),fullPage:true});
 expect(errors).toEqual([]);
 const evidence=testInfo.outputPath('published-check.json');
 await writeFile(evidence,JSON.stringify({url:page.url(),commit:process.env.GITHUB_SHA,version:packageInfo.version,result,pageErrors:errors},null,2)+'\n');
 await testInfo.attach('published-check.json',{path:evidence,contentType:'application/json'});
});
