import { expect } from '@playwright/test';
import { storageTest as test } from './native-storage.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeWav } from '../src/wav.js';

/** Callouts are placed from actual live DOM bounds before capturing the browser.
 * This produces guide images of the tested application, never a fabricated UI.
 */
async function saveManifest(testInfo, manifest, complete = false) {
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(testInfo.outputPath('help-captures.json'), JSON.stringify({ ...manifest, complete, updatedAt: new Date().toISOString() }, null, 2));
}

async function capture(page, testInfo, manifest, { name, chapter, caption, alt, callouts }) {
  for (const callout of callouts) await expect(page.locator(callout.selector).first()).toBeVisible();
  // Frame the complete target group in its shared scroller without changing the UI.
  await page.evaluate(selectors => {
    const elements = selectors.map(selector => document.querySelector(selector));
    let scroller = elements[0].parentElement;
    while (scroller && (!elements.every(element => scroller.contains(element)) || scroller.scrollHeight <= scroller.clientHeight || !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const documentScroll = !scroller || scroller === document.body || scroller === document.documentElement;
    if (documentScroll) scroller = document.scrollingElement;
    const frame = documentScroll ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    const boxes = elements.map(element => element.getBoundingClientRect()), top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.bottom));
    if (bottom - top <= frame.bottom - frame.top - 24) {
      const delta = top < frame.top + 12 ? top - frame.top - 12 : bottom > frame.bottom - 12 ? bottom - frame.bottom + 12 : 0;
      scroller.scrollTop += delta;
    }
  }, callouts.map(item => item.selector));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measured = [];
  for (const callout of callouts) {
    const element = page.locator(callout.selector).first(), box = await element.boundingBox(), viewport = page.viewportSize();
    expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, callout.selector + ' is fully inside the captured viewport').toBe(true);
    const unclipped = await element.evaluate(node => {
      const box = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), frame = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (box.top < frame.top - 1 || box.bottom > frame.bottom + 1)) return false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (box.left < frame.left - 1 || box.right > frame.right + 1)) return false;
      }
      return true;
    });
    expect(unclipped, callout.selector + ' is not hidden by a scrolling panel').toBe(true);
    measured.push({ ...callout, box });
  }
  const placements = await page.evaluate(async items => {
    await document.fonts.ready;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.id = 'help-capture-callouts'; svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`); svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483647', overflow: 'visible' });
    const defs = document.createElementNS(ns, 'defs'), marker = document.createElementNS(ns, 'marker');
    marker.id = 'help-arrow-head'; marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7'); marker.setAttribute('orient', 'auto-start-reverse');
    const triangle = document.createElementNS(ns, 'path'); triangle.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); triangle.setAttribute('fill', '#e4512b'); marker.append(triangle); defs.append(marker); svg.append(defs);
    const dialogs = [...document.querySelectorAll('dialog[open]')]; (dialogs.at(-1) || document.body).append(svg);
    const textNode = () => { const text = document.createElementNS(ns, 'text'); text.setAttribute('fill', '#251e18'); text.setAttribute('font-family', 'system-ui,sans-serif'); text.setAttribute('font-size', '12'); text.setAttribute('font-weight', '650'); return text; };
    const measure = textNode(); measure.setAttribute('visibility', 'hidden'); svg.append(measure);
    const measureText = value => { measure.textContent = value; return measure.getComputedTextLength(); };
    const placed = [], overlap = (a, b) => Math.max(0, Math.min(a.x + a.width + 8, b.x + b.width) - Math.max(a.x - 8, b.x)) * Math.max(0, Math.min(a.y + a.height + 8, b.y + b.height) - Math.max(a.y - 8, b.y));
    for (const [index, item] of items.entries()) {
      const { box } = item, width = Math.min(230, innerWidth - 24), rows = [];
      let row = '';
      for (const word of `${index + 1}. ${item.label}`.split(' ')) {
        const next = row ? `${row} ${word}` : word;
        if (row && measureText(next) > width - 24) { rows.push(row); row = word; }
        else row = next;
        if (measureText(row) > width - 24) throw new Error(`Guide label contains a word wider than its box: ${item.label}`);
      }
      if (row) rows.push(row);
      const height = Math.max(44, rows.length * 16 + 12), targetX = box.x + box.width / 2, targetY = box.y + box.height / 2;
      const position = side => ({ x: side === 'left' ? box.x - width - 18 : side === 'right' ? box.x + box.width + 18 : targetX - width / 2, y: side === 'below' ? box.y + box.height + 18 : side === 'left' || side === 'right' ? targetY - height / 2 : box.y - height - 20 });
      const preferred = position(item.side || 'above'); preferred.x += item.dx || 0; preferred.y += item.dy || 0;
      const choices = [preferred, ...['above', 'below', 'left', 'right'].map(position), ...[12, innerWidth - width - 12].flatMap(x => [12, innerHeight / 2 - height / 2, innerHeight - height - 12].map(y => ({ x, y })))].map(point => ({ x: Math.max(12, Math.min(innerWidth - width - 12, point.x)), y: Math.max(12, Math.min(innerHeight - height - 12, point.y)), width, height }));
      const cost = (candidate, rank) => placed.reduce((total, other) => total + overlap(candidate, other) * 100, 0) + items.reduce((total, other) => total + overlap(candidate, other.box) * 10, 0) + rank * 30;
      const { rect } = choices.map((rect, rank) => ({ rect, score: cost(rect, rank) })).sort((a, b) => a.score - b.score)[0], { x, y } = rect;
      const line = document.createElementNS(ns, 'line'); for (const [key, value] of Object.entries({ x1: x + width / 2, y1: y + height / 2, x2: targetX, y2: targetY, stroke: '#e4512b', 'stroke-width': 3, 'marker-end': 'url(#help-arrow-head)' })) line.setAttribute(key, value); svg.append(line);
      const labelBox = document.createElementNS(ns, 'rect'); for (const [key, value] of Object.entries({ x, y, width, height, rx: 5, fill: '#fff7ed', stroke: '#e4512b', 'stroke-width': 2 })) labelBox.setAttribute(key, value); svg.append(labelBox);
      const textBoxes = [];
      for (const [row, label] of rows.entries()) {
        const text = textNode(); text.setAttribute('x', x + 12); text.setAttribute('y', y + (height - (rows.length - 1) * 16) / 2 + 4 + row * 16); text.textContent = label; svg.append(text);
        const bounds = text.getBBox(), textBox = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        if (textBox.x < x + 4 || textBox.x + textBox.width > x + width - 4 || textBox.y < y + 4 || textBox.y + textBox.height > y + height - 4) throw new Error(`Guide label text escaped its measured box: ${item.label}`);
        textBoxes.push(textBox);
      }
      placed.push({ ...rect, textBoxes });
    }
    measure.remove(); return placed;
  }, measured);
  const file = `${name}.png`, path = testInfo.outputPath(file);
  try {
    await page.screenshot({ path, animations: 'disabled' });
    manifest.images.push({ file, chapter, caption, alt, ...page.viewportSize(), callouts: measured.map(({ selector, label, box }, index) => { const { textBoxes, ...labelBox } = placements[index]; return { selector, label, box, labelBox, textBoxes }; }) });
    await saveManifest(testInfo, manifest);
  } finally {
    await page.evaluate(() => document.querySelector('#help-capture-callouts')?.remove());
  }
}

test('capture the actual beta guide with measured arrows on desktop and mobile',async({page},testInfo)=>{
  test.setTimeout(180000);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1440,height:1250});await page.goto('/');await page.waitForFunction(()=>Boolean(window.websoundedit?.ready));await page.evaluate(()=>websoundedit.ready);
  await page.evaluate(()=>websoundedit.execute('ui.tooltips.set',{enabled:false}));const manifest={version:await page.evaluate(()=>websoundedit.version),commit:process.env.GITHUB_SHA||null,createdAt:new Date().toISOString(),images:[]};await saveManifest(testInfo,manifest);
  await capture(page,testInfo,manifest,{name:'guide-editor-desktop',chapter:'navigation',caption:'The running workbench: selection zoom changes the view, track actions keep their explicit target, and sound tools collapse for more waveform space.',alt:'WebSoundEdit beta editor with arrows to Selection zoom, track Save / Export and Hide sound tools.',callouts:[{selector:'[data-action="view.zoomSelection"]',label:'Zoom without changing samples',side:'above',dx:-70},{selector:'[data-track-export]',label:'Save this exact track',side:'below',dx:110},{selector:'#inspector-toggle',label:'Give the waveform more room',side:'above',dy:-15}]});
  await page.locator('[data-panel="effects"]').click();await page.evaluate(()=>{websoundedit.rack.add('echo');websoundedit.rack.add('tape');websoundedit.rack.add('filter');});
  await page.locator('[data-rack-id] details').evaluateAll(elements=>elements.forEach(element=>element.open=false));
  const assignments=await page.evaluate(()=>{const chain=websoundedit.rack.get().chain;return{first:chain[0].id,last:chain[2].id};});await page.locator('[data-rack-axis="x"]').selectOption(`${assignments.first}:wet`);await page.locator('[data-rack-axis="y"]').selectOption(`${assignments.last}:frequency`);
  await page.setViewportSize({width:1440,height:1600});
  await capture(page,testInfo,manifest,{name:'guide-effects-desktop',chapter:'effects',caption:'An actual three-stage rack with stable effect order, individual wet/dry controls and independent XY assignments.',alt:'Effects rack with echo, tape, filter, wet/dry controls and XY pad.',callouts:[{selector:'[data-rack-drag]',label:'Drag or use the arrow keys',side:'left',dx:-30},{selector:'[data-rack-wet]',label:'Each stage has wet / dry',side:'left',dy:40},{selector:'[data-rack-xy]',label:'Two chosen parameters at once',side:'left'},{selector:'#processing-mode',label:'Choose selection or live mode',side:'left',dy:-38}]});
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>websoundedit.execute('ui.options',{page:'layout'}));
  await capture(page,testInfo,manifest,{name:'guide-channel-layout',chapter:'surround',caption:'Project layout and canonical speaker order are explicit. Output hardware capability is a separate setting.',alt:'Options Channel layout page with mono, stereo, 5.1 and 7.1 channel orders.',callouts:[{selector:'#project-output-layout',label:'Choose the rendered layout',side:'below'},{selector:'.channel-layout-cards',label:'Read the exact speaker order',side:'below',dy:15},{selector:'a[href="#options/output"]',label:'Set actual monitoring output',side:'right'}]});
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'midi'}));await page.locator('#midi-action-target').scrollIntoViewIfNeeded();
  await capture(page,testInfo,manifest,{name:'guide-midi-pedals',chapter:'midi',caption:'Pedal mappings select a command, press threshold and debounce. Arming is a separate local action; release never retriggers.',alt:'MIDI Options pedal mapping controls with local arm, command selection and debounce.',callouts:[{selector:'#midi-actions-armed',label:'Arm only after reviewing actions',side:'right',dx:180},{selector:'#midi-action-debounce',label:'Debounce switch chatter',side:'above'},{selector:'#midi-action-target',label:'Choose a command or macro',side:'below'}]});
  await page.evaluate(()=>websoundedit.execute('ui.macros',{page:'editor'}));await page.locator('#macro-source').fill('// WebSoundEdit Macro 1\nfor (file of inputs) {\n  file.import({input: file, replace: true});\n  effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});\n  effect.normalize({targetDb: -1});\n  file.export({scope: "track", format: "flac", name: file.stem});\n}');await page.locator('#macro-validate').click();await page.locator('#macro-run').scrollIntoViewIfNeeded();
  await capture(page,testInfo,manifest,{name:'guide-macros-desktop',chapter:'macros',caption:'Canonical text retains loops and variables. Validate before running; Record actions and Batch files use the same command language.',alt:'Macro editor showing a loop that imports, trims quiet ends, normalizes and exports files.',callouts:[{selector:'#macro-source',label:'Structured logic stays as text',side:'right',dx:-40},{selector:'#macro-validate',label:'Validate before running',side:'above',dx:-100}]});
  await page.evaluate(()=>websoundedit.execute('ui.performance',{page:'recorder'}));await page.evaluate(()=>websoundedit.execute('recordings.list'));
  await capture(page,testInfo,manifest,{name:'guide-long-recorder',chapter:'recording',caption:'The long recorder before capture. Its disk archive is separate from the bounded waveform editor; counters distinguish committed and queued bytes.',alt:'Long recorder source, start/pause controls, elapsed time and written/queued storage counters.',callouts:[{selector:'#recorder-source',label:'Choose the program or input',side:'below'},{selector:'#recorder-start',label:'Start capture explicitly',side:'above',dx:-100},{selector:'#recorder-written',label:'Committed audio on disk',side:'below'},{selector:'#recorder-queued',label:'Bounded pending data',side:'right'}]});
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'streaming'}));
  await capture(page,testInfo,manifest,{name:'guide-companion-streaming',chapter:'streaming',caption:'The disconnected companion surface. Credentials stay in memory, and destinations/profiles come from an explicitly connected local companion.',alt:'Streaming Options with empty token field, loopback endpoint and disabled destination/profile selectors.',callouts:[{selector:'#companion-connect',label:'Connect the local companion',side:'above',dx:-60},{selector:'#companion-token',label:'Per-run token stays in memory',side:'below'},{selector:'#stream-destination',label:'Only configured destinations',side:'below'}]});
  await page.locator('[data-view-close]').click();await page.locator('[data-action="panel.projects"]').first().click();
  await capture(page,testInfo,manifest,{name:'guide-project-compatibility',chapter:'compatibility',caption:'Genuine editable formats are separate choices. Audacity surround requires explicit speaker-labeled mono splitting; REAPER export includes its referenced media.',alt:'Project dialog offering native JSON, Audacity AUP3, legacy Audacity ZIP and REAPER project ZIP.',callouts:[{selector:'#project-native-save',label:'Keep the full native session',side:'above'},{selector:'#project-reaper-save',label:'Genuine RPP plus WAV media',side:'above',dx:30},{selector:'#project-multichannel',label:'Choose surround policy explicitly',side:'below'}]});
  await page.locator('#modal-close').click();await page.evaluate(()=>websoundedit.execute('analysis.keyAll'));await page.locator('[data-action="panel.keys"]').click();
  await capture(page,testInfo,manifest,{name:'guide-sample-keys',chapter:'keys',caption:'Key estimates keep written labels and confidence alongside tonic colors. Manual overrides remain available for ambiguous material.',alt:'Sample keys dialog showing estimated sample keys and individual manual-key selectors.',callouts:[{selector:'#keys-detect-all',label:'Analyze every sample',side:'above'},{selector:'.sample-key-value',label:'Read the label and confidence',side:'below',dx:-60},{selector:'[data-key-override]',label:'Override an uncertain estimate',side:'below',dx:80}]});
  await page.locator('#modal-close').click();await page.evaluate(()=>websoundedit.execute('metadata.update',{metadata:{title:'Afterhours sketch',artist:'Circuit Drift Labs'}}));await page.locator('[data-action="file.export"]').first().click();
  await capture(page,testInfo,manifest,{name:'guide-export-metadata',chapter:'export',caption:'Choose scope, exact track, format and explicit committed/live render behavior. Metadata support is reported for the selected format.',alt:'Export dialog with track scope, source choice, channel layout and metadata support.',callouts:[{selector:'#export-scope',label:'Choose the audio or session scope',side:'above'},{selector:'#export-source',label:'Committed audio or live render',side:'below'},{selector:'#export-metadata-note',label:'See format-specific tag support',side:'below'}]});
  await page.locator('#modal-close').click();await page.locator('#play-button').click();await page.evaluate(()=>websoundedit.execute('loop.capture.start',{source:'master',beats:.25,quantize:'off',name:'Captured program loop'}));await expect.poll(()=>page.evaluate(()=>websoundedit.live.getState().loops.length)).toBe(1);await page.evaluate(()=>websoundedit.execute('transport.stop'));await page.locator('[data-action="performance"]').click();
  await capture(page,testInfo,manifest,{name:'guide-live-layers',chapter:'looping',caption:'An actual short program capture created a new loop layer. Beat boundaries, source choice and independent layer controls are visible.',alt:'Live loop panel containing a real captured layer and independent play, stop, mute and delete buttons.',callouts:[{selector:'#loop-capture-quantize',label:'Use sample-clock beat boundaries',side:'below'},{selector:'#loop-capture-start',label:'Capture a new layer',side:'above',dx:-90},{selector:'[data-loop-layer]',label:'Control each layer independently',side:'below'}]});
  await page.locator('[data-view-close]').click();await page.evaluate(()=>websoundedit.execute('ui.theme.set',{theme:'daylight'}));await page.locator('#inspector-toggle').click();await page.setViewportSize({width:390,height:844});await page.locator('#timeline').scrollIntoViewIfNeeded();
  await capture(page,testInfo,manifest,{name:'guide-editor-mobile',chapter:'tracks',caption:'The real mobile workbench with sound tools collapsed. Track actions and selection zoom remain available at a narrow width.',alt:'Mobile waveform editor with direct track export and selection zoom controls.',callouts:[{selector:'[data-action="view.zoomSelection"]',label:'Zoom the selected region',side:'above'},{selector:'[data-track-export]',label:'Save this track',side:'below',dx:90}]});
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'general'}));
  await capture(page,testInfo,manifest,{name:'guide-options-mobile',chapter:'navigation',caption:'Addressable Options on mobile keeps the current session alive and provides a global guidance switch.',alt:'Mobile Options page with wrapped section navigation, theme selector and tooltip preference.',callouts:[{selector:'#options-theme',label:'Choose a theme',side:'below'},{selector:'#options-tooltips',label:'One switch for all tips',side:'above',dx:50}]});
  // Additional workflows use real idle device state and explicit application actions.
  // Keep them after the original thirteen so an interrupted run retains those images.
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(async()=>{for(const layer of websoundedit.live.getState().loops)await websoundedit.execute('loop.track.stop',{trackId:layer.trackId});await websoundedit.execute('ui.theme.set',{theme:'studio'});});
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'input'}));
  await expect(page.locator('#device-state')).toContainText('Input: idle');await expect(page.locator('#input-monitor')).not.toBeChecked();
  await capture(page,testInfo,manifest,{name:'guide-input-options',chapter:'recording',caption:'Audio input settings before acquisition. Start input requests permission explicitly; source channels and gain are configurable, and monitoring remains off.',alt:'Idle Audio input Options showing microphone or display source, device, channel indices, gain, processing preferences and unchecked monitoring.',callouts:[{selector:'#input-source',label:'Choose microphone or system audio',side:'above'},{selector:'#input-channels',label:'Declare physical input channels',side:'left'},{selector:'#input-monitor',label:'Monitoring starts off',side:'below'}]});
  await page.evaluate(()=>websoundedit.execute('ui.options',{page:'output'}));
  await expect(page.locator('#device-state')).toContainText('actual maximum');
  await capture(page,testInfo,manifest,{name:'guide-output-options',chapter:'surround',caption:'Audio output shows the browser\'s reported destination capability separately from the selected monitoring layout.',alt:'Audio output Options with the real device-selection capability, monitoring layout, Apply routing button and reported maximum channel count.',callouts:[{selector:'#output-layout',label:'Choose the monitoring layout',side:'above'},{selector:'#device-state',label:'Read actual device capability',side:'below'}]});
  await page.locator('[data-view-close]').click();await page.locator('[data-action="panel.metadata"]').first().click();
  await page.locator('[data-metadata="title"]').fill('Afterhours — guide session');await page.locator('[data-metadata="artist"]').fill('Local synth demo');await page.locator('#metadata-save').click();
  await expect(page.locator('#modal')).not.toBeVisible();await page.locator('[data-action="panel.metadata"]').first().click();await expect(page.locator('[data-metadata="title"]')).toHaveValue('Afterhours — guide session');
  await capture(page,testInfo,manifest,{name:'guide-metadata-editor',chapter:'export',caption:'The actual metadata editor after saving the title and artist. Project tags remain editable and are embedded only by formats that support them.',alt:'Audio metadata dialog with a saved title and artist, other available tag fields and Save metadata button.',callouts:[{selector:'[data-metadata="title"]',label:'Edit the saved file tags',side:'above'},{selector:'#metadata-save',label:'Save tags before exporting',side:'below'}]});
  await page.locator('#metadata-cancel').click();await page.evaluate(()=>websoundedit.execute('ui.macros',{page:'record'}));await page.locator('#macro-record-timing').uncheck();await page.locator('#macro-record-start').click();await expect(page.locator('#macro-record-stop')).toBeEnabled();
  await page.locator('#macro-return-editor').click();await page.evaluate(async()=>{await websoundedit.execute('effect.gain',{db:-1});await websoundedit.execute('effect.normalize',{targetDb:-1});});
  await page.evaluate(()=>websoundedit.execute('ui.macros',{page:'record'}));await expect(page.locator('#macro-recorded-text')).toContainText('effect.gain');await expect(page.locator('#macro-recorded-text')).toContainText('effect.normalize');
  await capture(page,testInfo,manifest,{name:'guide-macro-recording',chapter:'macros',caption:'Two successful editing commands captured without thinking time. Enable Record timing to retain elapsed waits in the resulting script.',alt:'Active action recorder with two genuine captured editing commands, an unchecked Record timing option and Finish recording button.',callouts:[{selector:'#macro-record-timing',label:'Choose whether to record waits',side:'above'},{selector:'#macro-recorded-text',label:'Successful edits become commands',side:'below'},{selector:'#macro-record-stop',label:'Finish and review the script',side:'left'}]});
  await page.locator('#macro-record-stop').click();await page.locator('#macro-visual-tab').click();await expect(page.locator('[data-macro-step]')).toHaveCount(2);await page.locator('[data-step-move="1"][data-direction="-1"]').scrollIntoViewIfNeeded();
  await capture(page,testInfo,manifest,{name:'guide-macro-visual-steps',chapter:'macros',caption:'The two recorded commands shown as editable visual steps. Edit arguments and use move controls to change order; structured programs remain available as script text.',alt:'Visual macro editor with two real recorded effect steps, editable command arguments and accessible order controls.',callouts:[{selector:'[data-step-params="0"]',label:'Edit command arguments',side:'left'},{selector:'[data-step-move="1"][data-direction="-1"]',label:'Move this step earlier',side:'above'}]});
  await page.locator('#macro-script-tab').click();await page.locator('#macro-source').fill('// WebSoundEdit Macro 1\neffect.trimSilence({thresholdDb:-48,minDuration:0.05,padding:0.01});\neffect.normalize({targetDb:-1});\nfile.export({format:"wav",scope:"clip",name:input.stem});');await page.locator('#macro-name').fill('Clean up and export WAV');await page.locator('#macro-validate').click();await expect(page.locator('#macro-validation')).toContainText('Valid syntax');await page.locator('#macro-save').click();
  const batchMacro=await page.locator('#macro-library').inputValue();expect(batchMacro).not.toBe('');await page.locator('a[href="#macros/batch"]').click();await page.locator('#batch-macro').selectOption(batchMacro);
  const sample=encodeWav({sampleRate:8000,channels:[Float32Array.from({length:800},(_,index)=>Math.sin(2*Math.PI*220*index/8000)*.2)]},{bitDepth:32,float:true});
  await page.locator('#batch-files').setInputFiles([{name:'guide-synth-one.wav',mimeType:'audio/wav',buffer:Buffer.from(sample)},{name:'guide-synth-two.wav',mimeType:'audio/wav',buffer:Buffer.from(sample)}]);await expect(page.locator('#batch-input-count')).toHaveText('2 files supplied');await expect(page.locator('#batch-run')).toBeEnabled();
  await capture(page,testInfo,manifest,{name:'guide-batch-preparation',chapter:'macros',caption:'A saved cleanup-and-export macro with two supplied local synthesized WAV files. This is preparation before Run batch; progress, errors and collected outputs appear during execution.',alt:'Batch preparation page showing the chosen cleanup macro, two supplied local audio files, error policy and Run batch control.',callouts:[{selector:'#batch-files',label:'Supply explicit local files',side:'above'},{selector:'#batch-continue',label:'Choose the per-file error policy',side:'right'},{selector:'#batch-run',label:'Run with session restoration',side:'below'}]});
  await page.evaluate(async()=>{const stage=websoundedit.rack.get().chain.find(item=>item.effect==='filter');if(!stage)throw new Error('The guide filter stage is missing.');await websoundedit.execute('live.rack.set',{target:'master',chain:[stage]});});await page.evaluate(()=>websoundedit.execute('ui.performance',{page:'automation'}));
  await page.locator('#automation-param').selectOption('frequency');await page.locator('#automation-points').fill('[\n  {"time":0,"value":500,"curve":"linear"},\n  {"time":4,"value":5500,"curve":"linear"}\n]');await page.locator('#automation-apply').click();await expect(page.locator('#automation-state')).toContainText('Automation lane set.');
  await capture(page,testInfo,manifest,{name:'guide-effect-automation',chapter:'effects',caption:'A saved filter-frequency lane schedules 500 Hz at zero seconds and 5500 Hz at four seconds. These audio-clock points are separate from action recorder waits.',alt:'Effect automation panel with the master filter frequency selected, two linear time/value points and successful saved-lane status.',callouts:[{selector:'#automation-param',label:'Choose a numeric effect parameter',side:'above'},{selector:'#automation-points',label:'Set timeline time/value points',side:'left'},{selector:'#automation-apply',label:'Save the repeatable audio-clock lane',side:'below'}]});
  await page.locator('[data-view-close]').click();await page.setViewportSize({width:1440,height:1400});if(await page.locator('#inspector-toggle').getAttribute('aria-expanded')==='false')await page.locator('#inspector-toggle').click();
  await page.evaluate(async()=>{const track=websoundedit.getState().tracks.find(item=>item.clips.some(clip=>clip.duration>=4)),clip=track.clips.find(item=>item.duration>=4);await websoundedit.execute('project.select',{trackId:track.id,clipId:clip.id});await websoundedit.execute('selection.set',{clipId:clip.id,start:2,end:4,channels:'all'});websoundedit.previewEffect('gain',{db:-3});});await expect(page.locator('#preview-state')).toContainText('preview ready');
  await capture(page,testInfo,manifest,{name:'guide-selection-editing',chapter:'editing',caption:'A real two-second region is selected and gain has been previewed. IN/OUT and channel scope define the edit; Apply commits the preview to that scope.',alt:'Waveform editor with a selected region, precise selection bounds, All channels scope and a ready gain preview with Apply control.',callouts:[{selector:'#selection-start',label:'Set precise selection boundaries',side:'above'},{selector:'#channel-scope',label:'Choose which channels change',side:'below'},{selector:'#apply-effect',label:'Commit the ready preview',side:'left'}]});
  await page.evaluate(()=>websoundedit.execute('selection.set',{start:2,end:4,channels:'all'}));await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>websoundedit.execute('ui.options',{page:'help'}));
  await capture(page,testInfo,manifest,{name:'guide-recovery-controls',chapter:'recovery',caption:'Help and local recovery controls keep the open project separate from the browser recovery copy. The Clear recovery control is shown without deleting data; save a portable session for a durable copy.',alt:'Options Help and recovery page with recovery guidance links and a Clear recovery copy button that has not been activated.',callouts:[{selector:'a[href="#help/recovery"]',label:'Read recovery limits and steps',side:'above'},{selector:'#options-clear-recovery',label:'Clear only the recovery copy',side:'below'}]});
  expect(errors).toEqual([]);await saveManifest(testInfo,manifest,true);
});
