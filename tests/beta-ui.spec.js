import packageInfo from '../package.json' with { type: 'json' };
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeWav, decodeWav } from '../src/wav.js';

async function boot(page, hash = '') {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/' + hash); await page.waitForFunction(() => Boolean(window.websoundedit?.ready)); await page.evaluate(() => websoundedit.ready);
  expect(await page.evaluate(() => websoundedit.version)).toBe(packageInfo.version); return errors;
}
test('Options and help routes retain the project, theme and global guidance opt-out', async ({ page }) => {
  const errors = await boot(page, '#options/general');
  const before = await page.evaluate(() => ({ name:websoundedit.getState().name,selection:websoundedit.getState().selection,ids:websoundedit.getState().tracks.map(track=>track.id) }));
  await expect(page.locator('#workbench-view')).toBeVisible(); await expect(page.locator('#options-theme')).toBeVisible();
  await page.locator('#options-save').focus(); await expect(page.locator('#feature-guidance')).toBeVisible(); await expect(page.locator('#feature-guidance')).toContainText('Save settings JSON');
  await page.keyboard.press('Escape'); await expect(page.locator('#feature-guidance')).not.toBeVisible(); await expect(page.locator('#workbench-view')).toBeVisible();
  await page.locator('#options-theme').selectOption('daylight'); await expect(page.locator('html')).toHaveAttribute('data-theme','daylight');
  await page.locator('#options-tooltips').uncheck(); await page.locator('#options-save').focus(); await expect(page.locator('#feature-guidance')).not.toBeVisible();
  await expect(page.locator('#options-save')).toHaveAccessibleName('Save settings JSON');
  await page.setViewportSize({width:390,height:844});
  const guidanceLayout=await page.locator('#options-tooltips').evaluate(input=>{const box=input.getBoundingClientRect(),label=input.closest('label').getBoundingClientRect();return{width:box.width,height:box.height,labelHeight:label.height,labelRight:label.right,viewport:innerWidth};});
  expect(guidanceLayout.width).toBeLessThanOrEqual(24);expect(guidanceLayout.height).toBeLessThanOrEqual(24);expect(guidanceLayout.labelHeight).toBeLessThan(90);expect(guidanceLayout.labelRight).toBeLessThanOrEqual(guidanceLayout.viewport);
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('a[href="#options/layout"]').click(); await expect(page).toHaveURL(/#options\/layout$/);
  await page.goBack(); await expect(page.locator('#options-theme')).toBeVisible();
  await page.locator('#options-content').getByRole('link', { name: 'Open the illustrated guide ↗', exact: true }).click(); await expect(page).toHaveURL(/#help\/navigation$/);
  await page.locator('#help-search').fill('debounce'); await expect(page.locator('#help-search-results')).toContainText('Pedal');
  await page.locator('[data-view-close]').click(); await expect(page.locator('#workbench-view')).not.toBeVisible();
  const after = await page.evaluate(() => ({ name:websoundedit.getState().name,selection:websoundedit.getState().selection,ids:websoundedit.getState().tracks.map(track=>track.id) }));
  expect(after).toEqual(before); expect(await page.locator('#theme-select').inputValue()).toBe('daylight');
  const catalog = await page.evaluate(() => { const commands=websoundedit.commandCatalog(), ids=new Set(commands.map(command=>command.method)); return { duplicate:commands.length!==ids.size, missing:[...document.querySelectorAll('[data-action]')].map(node=>'ui.'+node.dataset.action).filter(method=>!ids.has(method)), schemas:commands.every(command=>command.schema?.type==='object'&&command.description) }; });
  expect(catalog).toEqual({duplicate:false,missing:[],schemas:true});
  expect(await page.evaluate(()=>websoundedit.saveSettings().workbench.tooltips)).toBe(false); expect(errors).toEqual([]);
});
test('visible selection zoom preserves sample boundaries and direct track save targets the clicked track', async ({ page }) => {
  const errors = await boot(page);
  const before = await page.evaluate(() => websoundedit.getState().selection);
  await page.locator('[data-action="view.zoomSelection"]').click(); expect(await page.evaluate(()=>websoundedit.getState().selection)).toEqual(before);
  expect(Number(await page.locator('#view-end-label').textContent().then(value=>value.replace('s','')))).toBeLessThan(5);
  const ids = await page.evaluate(async()=>{const state=websoundedit.getState();await websoundedit.execute('project.select',{trackId:state.tracks[2].id});return state.tracks.map(track=>track.id);});
  await page.locator(`[data-track-export="${ids[0]}"]`).click(); await expect(page.locator('#export-track')).toHaveValue(ids[0]);
  await page.locator('#export-format').selectOption('session'); const event=page.waitForEvent('download'); await page.locator('#export-go').click();const file=await event;
  const project=JSON.parse(await readFile(await file.path(),'utf8'));expect(project.tracks).toHaveLength(1);expect(project.tracks[0].id).toBe(ids[0]);
  await page.locator('#modal-close').click(); await page.locator(`[data-track-close="${ids[0]}"]`).click();await expect(page.locator('.track-waveform')).toHaveCount(2);
  await page.locator('[data-action="history.undo"]').click();await expect(page.locator('.track-waveform')).toHaveCount(3);expect(errors).toEqual([]);
});
test('surround selection UI identifies speakers and changes only the chosen channel', async ({ page }) => {
  const errors=await boot(page);
  await page.evaluate(async()=>{await websoundedit.execute('project.new',{sampleRate:8000,outputLayout:'5.1'});await websoundedit.execute('audio.generate',{type:'tone',duration:.1,frequency:330,channels:6,layout:'5.1'});window.__surroundBefore=await websoundedit.execute('clip.getAudio');});
  await expect(page.locator('#channel-scope option')).toContainText(['All channels','FL only','FR only','FC only','LFE only','BL only','BR only','Choose channels…']);
  await page.locator('#channel-scope').selectOption('indices:2'); await page.evaluate(()=>websoundedit.execute('effect.gain',{db:-6}));
  const result=await page.evaluate(async()=>{const after=await websoundedit.execute('clip.getAudio'),before=window.__surroundBefore;return {layout:after.layout,selection:websoundedit.getState().selection.channels,untouched:after.channels.every((channel,index)=>index===2||channel.every((value,i)=>value===before.channels[index][i])),centerChanged:after.channels[2].some((value,i)=>value!==before.channels[2][i])};});
  expect(result).toEqual({layout:'5.1',selection:[2],untouched:true,centerChanged:true});expect(errors).toEqual([]);
});
test('manual import offers an explicit source-layout declaration after rejecting unidentified surround', async ({ page }) => {
  const errors=await boot(page),audio={sampleRate:48000,layout:'5.1',channels:Array.from({length:6},(_,index)=>new Float32Array(4800).fill((index+1)/16))},bytes=encodeWav(audio,{bitDepth:32,float:true});new DataView(bytes.buffer).setUint32(40,0,true);
  const before=await page.evaluate(()=>websoundedit.getState().tracks.map(track=>track.id));
  await page.locator('#audio-input').setInputFiles({name:'unidentified-surround.wav',mimeType:'audio/wav',buffer:Buffer.from(bytes)});
  await expect(page.locator('#status')).toContainText('explicit channel layout');expect(await page.evaluate(()=>websoundedit.getState().tracks.map(track=>track.id))).toEqual(before);
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'general'}));await expect(page.locator('#options-import-layout')).toHaveValue('auto');await page.locator('#options-import-layout').selectOption('5.1');await page.locator('[data-view-close]').click();
  await page.locator('#audio-input').setInputFiles({name:'declared-surround.wav',mimeType:'audio/wav',buffer:Buffer.from(bytes)});await expect(page.locator('.track-waveform')).toHaveCount(4);
  const result=await page.evaluate(async()=>{const audio=await websoundedit.execute('clip.getAudio');return{layout:audio.layout,channels:audio.channels.map(channel=>channel[0]),projectLayout:websoundedit.getState().outputLayout,preference:websoundedit.saveSettings().workbench.import.layout};});
  expect(result).toEqual({layout:'5.1',channels:[1/16,2/16,3/16,4/16,5/16,6/16],projectLayout:'stereo',preference:'5.1'});
  await page.evaluate(()=>websoundedit.execute('ui.importLayout.set',{layout:'auto'}));expect(await page.evaluate(()=>websoundedit.saveSettings().workbench.import.layout)).toBe('auto');expect(errors).toEqual([]);
});
test('macro action recording uses successful semantic edits and structured scripts stay intact', async ({ page }) => {
  const errors=await boot(page);await page.locator('[data-action="macros"]').click();await page.locator('a[href="#macros/record"]').click();await page.locator('#macro-record-start').click();
  await page.locator('#macro-return-editor').click();await page.evaluate(async()=>{await websoundedit.execute('effect.gain',{db:-6});try{await websoundedit.execute('effect.gain',{db:999});}catch{}});
  await page.locator('[data-action="macros"]').click();await page.locator('a[href="#macros/record"]').click();await page.locator('#macro-record-stop').click();
  const recorded=await page.locator('#macro-source').inputValue();expect(recorded).toContain('effect.gain');expect(recorded).toContain('-6');expect(recorded).not.toContain('999');expect((recorded.match(/effect\.gain/g)||[])).toHaveLength(1);
  const structured='// WebSoundEdit Macro 1\nrepeat (2) { effect.gain({db: -1}); }';await page.locator('#macro-source').fill(structured);await page.locator('#macro-visual-tab').click();await expect(page.locator('#macro-validation')).toContainText('structured logic');await expect(page.locator('#macro-source')).toHaveValue(structured);
  await page.locator('#macro-validate').click();await expect(page.locator('#macro-validation')).toContainText('Valid syntax');expect(errors).toEqual([]);
});
test('a running batch rejects outside edits and exports and restores once when stopped from the editor', async ({ page }) => {
  const errors=await boot(page),downloads=[];page.on('download',file=>downloads.push(file.suggestedFilename()));
  const bytes=Buffer.from(encodeWav({sampleRate:8000,channels:[new Float32Array(800).fill(.125)]},{bitDepth:32,float:true}));
  await page.locator('[data-action="macros"]').click();
  await page.locator('#macro-source').fill('wait({seconds:60});file.export({format:"wav",scope:"clip",raw:true});');
  await page.locator('a[href="#macros/batch"]').click();
  await page.locator('#batch-files').setInputFiles({name:'batch-input.wav',mimeType:'audio/wav',buffer:bytes});
  await page.evaluate(async()=>{
    window.__batchOriginal=await websoundedit.saveProject({download:false});
    window.__batchTheme=websoundedit.saveSettings().theme;
    const read=File.prototype.text;
    File.prototype.text=function(){if(this.name==='deferred-settings.json')return new Promise(resolve=>{window.__releaseSettings=()=>{File.prototype.text=read;resolve(JSON.stringify({...websoundedit.saveSettings(),theme:'terminal'}));};});return read.call(this);};
  });
  // The read begins before ownership is acquired and resolves afterward.
  await page.locator('#settings-input').setInputFiles({name:'deferred-settings.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await expect.poll(()=>page.evaluate(()=>typeof window.__releaseSettings)).toBe('function');
  await page.locator('#batch-run').click();
  await expect.poll(()=>page.evaluate(async()=>(await websoundedit.execute('macro.status')).batch)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>websoundedit.getState().tracks.flatMap(track=>track.clips).map(clip=>clip.name))).toEqual(['batch-input']);
  await page.locator('[data-view-close]').click();await expect(page.locator('#batch-ownership-banner')).toBeVisible();
  const blocked=await page.evaluate(async()=>{
    const before=await websoundedit.execute('clip.getAudio'),input=websoundedit.inputs.list()[0];
    const operations=[
      ()=>websoundedit.execute('effect.gain',{db:-12}),
      ()=>websoundedit.execute('track.add',{name:'Outside edit'}),
      ()=>websoundedit.execute('file.import',{input:input.id}),
      ()=>websoundedit.execute('file.export',{format:'wav',scope:'clip',download:false}),
      ()=>websoundedit.execute('file.exportStems',{format:'wav',download:false}),
      ()=>websoundedit.loadProject(window.__batchOriginal),
      ()=>websoundedit.loadSettings({...websoundedit.saveSettings(),theme:'terminal'}),
      ()=>websoundedit.rack.add('delay'),
      ()=>websoundedit.setPlaybackRate(1.5),
      ()=>websoundedit.inputs.supply([new File(['outside'],'outside.wav')]),
      ()=>websoundedit.importFile(new File(['outside'],'outside.wav')),
    ];
    const codes=[];for(const operation of operations){try{await operation();codes.push('accepted');}catch(error){codes.push(error.code);}}
    window.__releaseSettings();
    const after=await websoundedit.execute('clip.getAudio');
    return{codes,same:before.channels.every((channel,index)=>channel.every((value,frame)=>value===after.channels[index][frame])),inputs:websoundedit.inputs.list().map(item=>item.name)};
  });
  expect(blocked.codes).toEqual(Array(11).fill('BUSY'));expect(blocked.same).toBe(true);expect(blocked.inputs).toEqual(['batch-input.wav']);
  await expect(page.locator('#status')).toContainText('batch is using');
  expect(await page.evaluate(()=>websoundedit.saveSettings().theme===window.__batchTheme)).toBe(true);
  await page.locator('[data-action="track.add"]').click();await expect(page.locator('.track-waveform')).toHaveCount(1);
  await page.locator('#audio-input').setInputFiles({name:'outside-import.wav',mimeType:'audio/wav',buffer:bytes});await expect(page.locator('.track-waveform')).toHaveCount(1);
  await page.locator('#batch-ownership-banner [data-batch-cancel]').click();
  await expect.poll(()=>page.evaluate(async()=>(await websoundedit.execute('macro.status')).batch)).toBe(false);
  await expect(page.locator('#batch-ownership-banner')).not.toBeVisible();
  expect(await page.evaluate(async()=>JSON.stringify(await websoundedit.saveProject({download:false}))===JSON.stringify(window.__batchOriginal))).toBe(true);
  expect((await page.evaluate(()=>websoundedit.execute('macro.status'))).outputs.count).toBe(0);expect(downloads).toEqual([]);
  await page.evaluate(()=>websoundedit.execute('track.add',{name:'Editing resumed'}));await expect(page.locator('.track-waveform')).toHaveCount(4);
  expect(errors).toEqual([]);
});
test('saved macro import triggers are definitions only and invalid live settings reject before project replacement', async ({ page }) => {
  const errors=await boot(page);
  const result=await page.evaluate(async()=>{
    const settings=websoundedit.saveSettings();settings.macros={macros:[{id:'m1',name:'Quiet',text:'effect.gain({db:-1});',shortcut:'ctrl+shift+1'}],draft:'effect.gain({db:-1});',selectedId:'m1',onImportId:'m1',onImportArmed:true,shortcutsArmed:true};websoundedit.loadSettings(settings);
    const project=await websoundedit.saveProject({download:false}),before=websoundedit.getState();project.settings.live={version:1,racks:{master:{chain:[{id:'bad',effect:'delay',enabled:true,wet:999,params:{}}],automation:[]}}};let rejected=false;try{await websoundedit.loadProject(project);}catch{rejected=true;}
    let recipeRejected=false;try{await websoundedit.execute('recipe.run',{commands:[{method:'project.new',params:{name:'Do not replace'}},{method:'project.load',params:{project}}]});}catch{recipeRejected=true;}
    return{rejected,recipeRejected,same:JSON.stringify(before)===JSON.stringify(websoundedit.getState()),saved:websoundedit.saveSettings().macros};
  });
  expect(result.rejected).toBe(true);expect(result.recipeRejected).toBe(true);expect(result.same).toBe(true);expect(result.saved.onImportId).toBe('m1');expect(result.saved.onImportArmed).toBeUndefined();
  await page.evaluate(()=>websoundedit.execute('ui.macros',{page:'triggers'}));await expect(page.locator('#macro-import-armed')).not.toBeChecked();await expect(page.locator('#macro-shortcuts-armed')).not.toBeChecked();expect(errors).toEqual([]);
});
test('MIDI pedal UI fires on the press edge once and project loading disarms its saved definition', async ({ page }) => {
  await page.addInitScript(() => {
    const input={id:'pedal-input',name:'Fixture pedal',state:'connected',type:'input',onmidimessage:null,close:async()=>{}},access={inputs:new Map([[input.id,input]]),outputs:new Map(),onstatechange:null};
    Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async()=>access});window.__betaMidiInput=input;
  });
  const errors=await boot(page);await page.evaluate(async()=>{window.__pedalBefore=await websoundedit.execute('clip.getAudio');});
  await page.locator('[data-action="panel.midi"]').click();await page.locator('#midi-connect').click();await expect(page.locator('#midi-status')).toContainText('1 input');
  await page.locator('#midi-action-target').selectOption('effect.gain');await page.locator('#midi-action-params').fill('{"db":-6}');await page.locator('#midi-action-add').click();await page.locator('#midi-actions-armed').check();
  await page.evaluate(()=>{for(const value of [127,127,0])window.__betaMidiInput.onmidimessage({data:Uint8Array.of(0xb0,64,value)});});
  const ratio=await page.evaluate(async()=>{const after=await websoundedit.execute('clip.getAudio'),before=window.__pedalBefore,selection=websoundedit.getState().selection;let a=0,b=0;for(let i=Math.round(selection.start*after.sampleRate);i<Math.round(selection.end*after.sampleRate);i++){a+=after.channels[0][i]**2;b+=before.channels[0][i]**2;}return Math.sqrt(a/b);});
  expect(ratio).toBeCloseTo(10**(-6/20),5);
  await page.evaluate(async()=>{const project=await websoundedit.saveProject({download:false});await websoundedit.loadProject(project);});await expect(page.locator('#midi-actions-armed')).not.toBeChecked();
  expect(await page.evaluate(()=>websoundedit.saveSettings().midi.actions.length)).toBe(1);expect(await page.evaluate(()=>window.__betaMidiInput.onmidimessage)).toBeNull();expect(errors).toEqual([]);
});
test('live rack knobs and drag order keep transport running and settings restore without input permission', async ({ page }) => {
  const errors=await boot(page);await page.locator('[data-panel="effects"]').click();await page.locator('#processing-mode').selectOption('live');
  await expect(page.locator('#processing-mode')).toHaveValue('live');await expect(page.locator('#processing-mode-note')).toContainText('playback continues');
  const ids=await page.evaluate(()=>[websoundedit.rack.add('delay'),websoundedit.rack.add('tremolo')]);expect(ids.every(id=>typeof id==='string'&&id.length>0)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().racks.find(rack=>rack.target==='master').chain.length)).toBe(2);
  await page.locator('#play-button').click();await expect(page.locator('#play-button')).toHaveClass(/playing/);
  const clock=await page.locator('#playhead-time').textContent();
  await page.locator(`[data-rack-id="${ids[0]}"] [data-rack-wet-number]`).fill('72');await page.locator(`[data-rack-id="${ids[0]}"] [data-rack-wet-number]`).press('Tab');
  await page.locator(`[data-rack-id="${ids[1]}"] [data-rack-up]`).click();
  await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().racks.find(rack=>rack.target==='master').chain[0].effect)).toBe('tremolo');await expect(page.locator('#play-button')).toHaveClass(/playing/);await expect.poll(()=>page.locator('#playhead-time').textContent()).not.toBe(clock);
  const result=await page.evaluate(async()=>{const project=await websoundedit.saveProject({download:false});await websoundedit.loadProject(project);const state=websoundedit.live.getState();return{chain:state.racks.find(rack=>rack.target==='master').chain.map(stage=>({effect:stage.effect,wet:stage.wet})),input:state.input.status,playing:state.transport.playing};});
  expect(result.chain.map(stage=>stage.effect)).toEqual(['tremolo','delay']);expect(result.chain[1].wet).toBeCloseTo(.72,4);expect(result.input).toBe('idle');expect(result.playing).toBe(false);expect(errors).toEqual([]);
});
test('actual worklet loop capture creates one layer with independent stop, mute and removal', async ({ page }) => {
  const errors=await boot(page);await page.locator('#play-button').click();await expect(page.locator('#play-button')).toHaveClass(/playing/);
  await page.evaluate(()=>websoundedit.execute('loop.capture.start',{source:'master',beats:.25,quantize:'off',name:'Browser loop'}));
  await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().loops.length)).toBe(1);await expect(page.locator('.track-waveform')).toHaveCount(4);
  await page.locator('[data-action="performance"]').click();await expect(page.locator('[data-loop-layer]')).toHaveCount(1);await page.locator('[data-layer-action="mute"]').click();await expect(page.locator('[data-layer-action="mute"]')).toHaveAttribute('aria-pressed','true');await page.locator('[data-layer-action="stop"]').click();await expect(page.locator('[data-layer-action="play"]')).toBeEnabled();
  await page.locator('[data-layer-action="remove"]').click();await expect(page.locator('[data-loop-layer]')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>websoundedit.getState().tracks.length)).toBe(3);expect(errors).toEqual([]);
});
test('actual OPFS master recording exports committed frames and range import remains bounded', async ({ page }) => {
  const errors=await boot(page);await page.locator('#play-button').click();await expect(page.locator('#play-button')).toHaveClass(/playing/);
  const started=await page.evaluate(()=>websoundedit.execute('recorder.start',{source:'master',name:'Browser archive',maxSeconds:2}));
  await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().recorder.frames)).toBeGreaterThan(4000);
  await page.evaluate(()=>websoundedit.execute('recorder.pause'));const paused=await page.evaluate(()=>websoundedit.live.getState().recorder.frames);
  await page.waitForTimeout(120);expect(await page.evaluate(()=>websoundedit.live.getState().recorder.frames)).toBe(paused);
  await page.evaluate(()=>websoundedit.execute('recorder.resume'));await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().recorder.frames)).toBeGreaterThan(paused+1000);
  await page.evaluate(()=>websoundedit.execute('recorder.stop'));
  const exported=await page.evaluate(async()=>{const result=await websoundedit.execute('recordings.list'),recordings=Array.isArray(result)?result:result.recordings,recording=recordings.find(item=>item.name==='Browser archive');const output=await websoundedit.execute('recordings.export',{recordingId:recording.id});await websoundedit.execute('recordings.importRange',{recordingId:recording.id,start:0,end:.05});await websoundedit.execute('recordings.delete',{recordingId:recording.id});return{bytes:Array.from(output.bytes),frames:recording.frames,channels:recording.channels,count:websoundedit.getState().tracks.length};});
  const audio=decodeWav(Uint8Array.from(exported.bytes));expect(audio.channels[0].length).toBe(exported.frames);expect(audio.channels.length).toBe(exported.channels);expect(audio.channels.some(channel=>channel.some(sample=>Math.abs(sample)>.0001))).toBe(true);expect(exported.count).toBe(4);expect(errors).toEqual([]);
});

test('known missing live capabilities fail macro preflight before an earlier edit',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:undefined}));
  const errors=await boot(page);
  const result=await page.evaluate(async()=>{
    const before=JSON.stringify(websoundedit.getState());let message='';
    try{await websoundedit.macros.run('audio.generate({duration:.02}); live.rack.set({chain:[]});');}catch(error){message=error.message;}
    return{same:before===JSON.stringify(websoundedit.getState()),message,available:websoundedit.commandCatalog().find(command=>command.method==='live.rack.set').available};
  });
  expect(result.available).toBe(false);expect(result.message).toMatch(/unavailable/i);expect(result.same).toBe(true);expect(errors).toEqual([]);
});
