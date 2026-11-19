import './style.css';
import './creative-ui.css';
import './beta-ui.css';
import { RackPanel } from './rack-ui.js';
import { normalizeRackSettings } from './rack-config.js';
import { CreativeTools, applyTheme, THEMES } from './creative-ui.js';
import { metadataSupport } from './metadata.js';
import { normalizeMidiMappings } from './midi.js';
import { EngineClient } from './client.js';
import { EffectPanel, EFFECT_UI } from './effects-ui.js';
import { drawTrack, drawRuler, drawDetail } from './visuals.js';
import { analyzeAudio, sliceAudio } from './dsp.js';
import { decodeAudioFile, encodeAudio, FORMATS, loadCodecs, codecCapabilities, setCodecReporter } from './codecs.js';
import { Playback } from './playback.js';
import { saveRecovery, loadRecovery, clearRecovery } from './storage.js';
import { CommandRuntime } from './command-runtime.js';
import { LiveAudioRuntime, LIVE_COMMANDS } from './live-audio.js';
import { CompanionBridge, COMPANION_COMMANDS } from './companion.js';
import { CHANNEL_LAYOUTS, layoutForChannels, channelIndices } from './channel-layout.js';
import { WorkbenchRoutes } from './ui-utils.js';
import { GuidanceUI } from './guidance-ui.js';
import { HelpUI } from './help-ui.js';
import { OptionsPanel, normalizeWorkbenchPreferences } from './options-ui.js';
import { BrowserFileIO, ExportPanel } from './file-ui.js';
import { MacroPanel, normalizeMacroSettings } from './macro-ui.js';
import { PerformancePanel } from './performance-ui.js';
import { CompanionPanel } from './companion-ui.js';
import { normalizeMidiActions } from './midi-actions.js';

const $=selector=>document.querySelector(selector);
const $$=selector=>Array.from(document.querySelectorAll(selector));
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=value=>JSON.parse(JSON.stringify(value));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const duration=audio=>(audio?.channels?.[0]?.length||0)/(audio?.sampleRate||48000);
const fmt=n=>Number.isFinite(n)?n.toFixed(1):'−∞';
const colors=['#5ed8e6','#f1a362','#c3a2ef','#9adf83','#f0cf68','#ef94b6'];
function trackColorAt(index){return getComputedStyle(document.documentElement).getPropertyValue(`--wave-${index%6+1}`).trim()||colors[index%colors.length];}
const engine=new EngineClient();
let state=null, registry=[], audioById=new Map(), preview=null, compareOriginal=false, previewTimer, previewSerial=0, busy=0, initialising=true;
let view={start:0,duration:8}, cursor=0, selectionDrag=null, demo=true, loop=false, metronome=false, detailMode='spectrum', recoveryTimer, recoveryDisabled=false;
let activePanel='shape';
let commandRuntime=null,liveAudio=null,companion=null,routes=null,guidance=null,helpPanel=null,optionsPanel=null,macroPanel=null,performancePanel=null,fileIO=null,exportPanel=null;
let processingMode='selection',offlineRack=null,liveRackTarget='master',liveRackChain=[],liveRackRevision=0,liveRefreshPending=false;
let playbackScope='mix', taps=[], recordSession=null;
const recordSessions=new Set();
let settings={format:'websoundedit-ui-settings',version:1,effects:{},shortcuts:{},snap:false,grid:0.25};
try{const stored=JSON.parse(localStorage.getItem('websoundedit.settings.v1')||'null');if(stored?.version===1)settings={...settings,...stored};}catch{}
const actions=new Map();
const playback=new Playback({onTime:time=>{cursor=time;updateClock();drawPlayhead();},onEnded:()=>{$('#play-button').textContent='▶';$('#play-button').classList.remove('playing');},onMeter:values=>drawMeter(values)});
const effectPanel=new EffectPanel($('#effect-controls'),{onChange:(effect,params)=>{activePanel=EFFECT_UI[effect].category;updateTabs();queuePreview(effect,params);persistSettings();},getTracks:()=>state?.tracks||[],getSampleRate:()=>state?.sampleRate||48000});
const rackPanel=new RackPanel($('#rack-controls'),{onChange:(effect,params)=>{activePanel='effects';updateTabs();if(processingMode==='live')void safe(()=>updateLiveRack(params.chain));else queuePreview(effect,params);persistSettings();scheduleRecovery();},getBpm:()=>state?.bpm||120,onMessage:message=>status(message)});
const creative=new CreativeTools({getState:()=>state,getAudio:()=>selectedAudio({processed:!compareOriginal}),core,rack:rackPanel,openModal,closeModal,download,filename,status,safe,saveProject,
  getProject:async()=>{const project=await engine.execute('project.save');project.settings={...project.settings,ui:portableSettings(),...(liveAudio?{live:liveAudio.getSettings()}: {})};return project;},
  persist:()=>{persistSettings();scheduleRecovery();},afterImport:()=>{demo=false;fitView();renderSession();},
  transport:async action=>{if(action==='stop'){stopPlayback(false);return;}if(action==='start')stopPlayback(true);if(!playback.playing)await play('mix');}
});
function currentProcessor(){return activePanel==='effects'?{effect:'rack',params:rackPanel.params()}:{effect:effectPanel.effect,params:effectPanel.params()};}
function processorTitle(effect){return effect==='rack'?'Effects rack':EFFECT_UI[effect]?.title||effect;}
function setInspector(collapsed,{persist=true}={}){const focusInside=$('#sound-inspector').contains(document.activeElement);settings.inspectorCollapsed=Boolean(collapsed);$('.workbench').classList.toggle('inspector-collapsed',settings.inspectorCollapsed);$('#sound-inspector').hidden=settings.inspectorCollapsed;$('#inspector-toggle').setAttribute('aria-expanded',String(!settings.inspectorCollapsed));$('#inspector-toggle').textContent=settings.inspectorCollapsed?'Show sound tools':'Hide sound tools';if(settings.inspectorCollapsed&&focusInside)$('#inspector-toggle').focus({preventScroll:true});if(persist)persistSettings();requestAnimationFrame(()=>{drawWaveforms();drawDetailView();effectPanel.redraw();});}


function status(message,error=false){$('#status').textContent=message;$('.status-row').classList.toggle('error',error);}
function setBusy(delta,label='Processing audio…'){busy=Math.max(0,busy+delta);$('#job-status').textContent=busy?label:'';document.body.classList.toggle('is-busy',busy>0);}
function selectedClip(){return state?.tracks.flatMap(t=>t.clips).find(c=>c.id===state.selectedClipId)||null;}
function selectedTrack(){return state?.tracks.find(t=>t.id===state.selectedTrackId)||null;}
function ensureClip(){const c=selectedClip();if(!c)throw new Error('Import audio or select a clip first.');return c;}
function ensureSelection(){if(!state?.selection)throw new Error('Drag over a waveform or enter IN and OUT times to select a region first.');return state.selection;}
function isMutating(method){return registry.find(c=>c.method===method)?.mutates||['history.undo','history.redo'].includes(method);}
function changesAudio(method){return /^(clip\.(add|remove|duplicate|split)|edit\.(cut|paste|delete|trim)|effect\.(?!preview)|audio\.generate|project\.(new|load)|history\.|loop\.create|recipe\.run)/.test(method);}
function disconnectProjectMidi(){creative.stop();creative.midi.disconnect();creative.learnTarget=null;macroPanel?.disarm();}
function prepareRecipeReplacement(params){
  const steps=params?.commands||params?.steps||params?.recipe?.commands||params?.recipe?.steps||params?.recipe;
  if(!Array.isArray(steps)||steps.length>256)return null;
  const defaults=()=>({format:'websoundedit-ui-settings',version:1,theme:settings.theme,shortcuts:settings.shortcuts,workbench:settings.workbench,macros:macroPanel?.save()||settings.macros});
  let prepared=null,liveProject=null,liveSettings=null;
  for(const step of steps){
    if(step?.method==='project.new'){prepared=validateSettings(defaults());liveProject={tracks:[],sampleRate:step.params?.sampleRate??48000,outputLayout:step.params?.outputLayout||'stereo'};liveSettings={version:1,racks:{}};}
    if(step?.method==='project.load'){
      const raw=step.params?.project,data=typeof raw==='string'?JSON.parse(raw):raw;
      prepared=validateSettings(data?.settings?.ui||defaults());liveProject=data;liveSettings=data?.settings?.live||{version:1,racks:{}};
    }
    if(step?.method==='settings.load'&&prepared){
      const raw=step.params?.settings,next=raw?.format==='websoundedit-settings'?raw.settings:raw;
      prepared=validateSettings(next?.ui||defaults());liveSettings=next?.live||{version:1,racks:{}};
    }
    if(step?.method==='project.update'&&prepared)liveProject={...liveProject,...step.params};
    if(prepared&&liveAudio)prepared.liveSettings=liveAudio.validateSettings(liveSettings,{project:liveProject});
  }
  return prepared;
}
async function core(method,params={},options={}){return commandRuntime?commandRuntime.execute(method,params,{origin:'ui',...options}):coreRaw(method,params,options);}
async function coreRaw(method,params={}, {quiet=false,refresh=true,preservePreview=false}={}){
  const recipeReplacement=method==='recipe.run'?prepareRecipeReplacement(params):null;
  if(['project.new','project.load'].includes(method)||recipeReplacement){pendingRackUpdate=null;liveRackRevision++;if(processingMode==='live')await setProcessingMode('selection',{notify:false});stopRecordingStream();await liveAudio?.resetProject();await companion?.disconnect();}
  if(method==='project.update'&&params.outputLayout&&params.outputLayout!==state.outputLayout){pendingRackUpdate=null;liveRackRevision++;await liveAudio?.resetProject({preserveSettings:true});await companion?.disconnect();}
  if(method==='track.remove')await liveAudio?.releaseTrack(params.trackId||state.selectedTrackId);
  const mutates=isMutating(method), selectionChanges=['selection.set','selection.clear','project.select'].includes(method);
  if((mutates||selectionChanges)&&!(method==='track.remove'&&params.trackId&&params.trackId!==state.selectedTrackId))creative?.sampler.stop();
  if(selectionChanges&&playback.playing)stopPlayback(false);
  if((mutates||selectionChanges)&&!preservePreview)discardPreview(false);
  if(mutates&&playback.playing&&processingMode!=='live'&&!(liveAudio&&method==='track.remove')&&(changesAudio(method)||['track.update','track.remove','clip.update'].includes(method)))stopPlayback(false);
  if(!quiet)setBusy(1);
  try{
    const result=await engine.execute(method,params);state=engine.getState();
    if(['project.new','project.load'].includes(method)||recipeReplacement)disconnectProjectMidi();
    if(refresh){if(changesAudio(method))audioById.clear();await refreshAudio();renderSession();}
    if(recipeReplacement){if(recipeReplacement.liveSettings)await liveAudio.loadSettings(recipeReplacement.liveSettings);applySettings(recipeReplacement);demo=false;cursor=0;fitView();renderSession();}
    if(method==='project.update'&&playback.playing)playback.setTempo(state.bpm,state.beatOffset,state.beatsPerBar);
    if(mutates&&!initialising){scheduleRecovery();if(!quiet)status(`${registry.find(c=>c.method===method)?.description||method} · done. Undo is available.`);}
    return result;
  }finally{if(!quiet)setBusy(-1);}
}
async function refreshAudio(){if(!state)return;const clips=state.tracks.flatMap(t=>t.clips),ids=new Set(clips.map(c=>c.id));for(const key of audioById.keys())if(!ids.has(key))audioById.delete(key);for(const clip of clips)if(!audioById.has(clip.id))audioById.set(clip.id,await engine.execute('clip.getAudio',{clipId:clip.id}));state=engine.getState();}
function renderSession(){if(!state)return;$('#project-name').value=state.name;$('#tempo').value=state.bpm;$('#session-format').textContent=`${state.sampleRate/1000} kHz / FLOAT ENGINE`;$('#track-count').textContent=`${state.tracks.length} TRACK${state.tracks.length===1?'':'S'}`;$('#empty-state').hidden=state.tracks.some(t=>t.clips.length);$('#demo-badge').hidden=!demo;
  const oldFocus=document.activeElement?.dataset?.trackId;const key=document.activeElement?.dataset?.trackField;
  $('#tracks').innerHTML=state.tracks.map((track,i)=>`<div class="track-row ${state.selectedTrackId===track.id?'active':''}" data-track-id="${escapeHTML(track.id)}" style="--track-color:${trackColorAt(i)}"><div class="track-header"><div class="track-name"><button data-track-select="${escapeHTML(track.id)}" title="Select track; double click for track and clip settings">${escapeHTML(track.name)}</button><span>${String(i+1).padStart(2,'0')}</span></div><div class="track-mix-buttons"><button data-track-field="mute" data-track-id="${escapeHTML(track.id)}" aria-label="Mute ${escapeHTML(track.name)}" aria-pressed="${track.mute}">M</button><button data-track-field="solo" data-track-id="${escapeHTML(track.id)}" aria-label="Solo ${escapeHTML(track.name)}" aria-pressed="${track.solo}">S</button><span>${track.clips.length} CLIP${track.clips.length===1?'':'S'}</span></div><label class="track-fader"><span>GAIN</span><input type="range" min="-48" max="12" step="0.5" value="${track.gainDb}" data-track-field="gainDb" data-track-id="${escapeHTML(track.id)}" aria-label="${escapeHTML(track.name)} gain dB"><output>${track.gainDb.toFixed(1)}</output></label><label class="track-fader"><span>PAN</span><input type="range" min="-1" max="1" step="0.01" value="${track.pan}" data-track-field="pan" data-track-id="${escapeHTML(track.id)}" aria-label="${escapeHTML(track.name)} pan"><output>${panLabel(track.pan)}</output></label><div class="track-direct-actions"><button data-track-export="${escapeHTML(track.id)}" aria-label="Save or export ${escapeHTML(track.name)}">Save / Export</button><button data-track-close="${escapeHTML(track.id)}" aria-label="Remove ${escapeHTML(track.name)}">×</button></div></div><div class="track-canvas-wrap"><canvas class="track-waveform" data-track-id="${escapeHTML(track.id)}" tabindex="0" aria-label="${escapeHTML(track.name)} waveform. Drag to select samples, Alt drag a clip to move it, double click to select the entire clip."></canvas><div class="lane-playhead"></div></div></div>`).join('');
  $$('.track-waveform').forEach(canvas=>attachTimeline(canvas));
  $$('[data-track-select]').forEach(button=>{button.addEventListener('click',()=>safe(()=>core('project.select',{trackId:button.dataset.trackSelect})));button.addEventListener('dblclick',()=>safe(()=>openTrack(button.dataset.trackSelect)));});
  $$('[data-track-export]').forEach(button=>button.onclick=()=>safe(()=>core('ui.file.export',{scope:'track',trackId:button.dataset.trackExport})));
  $$('[data-track-close]').forEach(button=>button.onclick=()=>safe(()=>core('track.remove',{trackId:button.dataset.trackClose})));
  $$('[data-track-field]').forEach(control=>{const id=control.dataset.trackId,field=control.dataset.trackField;if(control.tagName==='BUTTON')control.addEventListener('click',()=>safe(()=>core('track.update',{trackId:id,[field]:!state.tracks.find(t=>t.id===id)[field]})));else{control.addEventListener('input',()=>{if(playback.playing&&processingMode!=='live')stopPlayback(false);const t=state.tracks.find(t=>t.id===id);t[field]=+control.value;control.nextElementSibling.textContent=field==='pan'?panLabel(+control.value):(+control.value).toFixed(1);drawWaveforms();});control.addEventListener('change',()=>safe(()=>core('track.update',{trackId:id,[field]:+control.value})));}});
  if(oldFocus&&key){const el=$$('[data-track-field]').find(e=>e.dataset.trackId===oldFocus&&e.dataset.trackField===key);el?.focus({preventScroll:true});}
  const c=selectedClip(),s=state.selection;const sampleKey=c?.keyAnalysis;$('#sample-key-badge').textContent=sampleKey?.key||(sampleKey?'Uncertain':'Not analyzed');$('#sample-key-badge').style.setProperty('--key-color',sampleKey?.color||'#7c8795');$('#selection-label').textContent=s?'SELECTED REGION':'WHOLE CLIP';$('#selected-clip-label').textContent=c?.name||'Select a clip';$('#selection-start').value=(s?.start||0).toFixed(3);$('#selection-end').value=(s?.end??c?.duration??0).toFixed(3);$('#selection-length').textContent=`${(s?s.end-s.start:c?.duration||0).toFixed(3)}s`;updateChannelScope();
  $('#scope-note').textContent=s?`Applies only to ${s.start.toFixed(3)}–${s.end.toFixed(3)}s of “${c?.name}” · ${channelScopeLabel(s.channels,c)}.`:`Applies to the whole selected clip${c?` “${c.name}”`:''}. Select a region to process only part of it.`;
  $$('[data-action="history.undo"]').forEach(b=>b.disabled=!state.canUndo);$$('[data-action="history.redo"]').forEach(b=>b.disabled=!state.canRedo);$$('[data-action="edit.paste"]').forEach(b=>b.disabled=!state.hasClipboard);$('#apply-effect').disabled=!c;
  clampView();drawWaveforms();drawDetailView();updateClock();updateTabs();
}
function panLabel(value){return Math.abs(value)<.01?'C':`${Math.round(Math.abs(value)*100)}${value<0?'L':'R'}`;}
function clampView(){view.duration=clamp(view.duration,.005,600);view.start=clamp(view.start,0,Math.max(0,Math.max(state?.duration||8,view.duration)-view.duration));const total=Math.max(state?.duration||0,view.duration);$('#view-scroll').value=total>view.duration?Math.round(view.start/(total-view.duration)*1000):0;$('#view-start-label').textContent=`${view.start.toFixed(2)}s`;$('#view-end-label').textContent=`${(view.start+view.duration).toFixed(2)}s`;}
function drawWaveforms(){if(!state)return;const selection=selectionDrag?.selection||state.selection;drawRuler($('#ruler'),view,state.bpm,state.beatOffset,state.beatsPerBar,state.markers);$$('.track-waveform').forEach(canvas=>{const i=state.tracks.findIndex(t=>t.id===canvas.dataset.trackId),track=state.tracks[i];drawTrack(canvas,{track:{...track,color:trackColorAt(i)},audioById,preview,selection,view,bpm:state.bpm,beatOffset:state.beatOffset,beatsPerBar:state.beatsPerBar,markers:state.markers,playhead:cursor,compareOriginal});});drawPlayhead();}
function drawPlayhead(){$$('.track-canvas-wrap').forEach(wrap=>{const x=(cursor-view.start)/view.duration*wrap.clientWidth,line=wrap.querySelector('.lane-playhead');line.style.display=x>=0&&x<=wrap.clientWidth?'block':'none';line.style.left=`${x}px`;});}
function selectedAudio({processed=true}={}){const clip=selectedClip();if(!clip)return null;let audio=processed&&preview?.clipId===clip.id?preview.audio:audioById.get(clip.id);if(!audio)return null;const s=state.selection;if(s?.clipId===clip.id){let end=s.end;if(processed&&preview?.clipId===clip.id)end=s.end+duration(preview.audio)-clip.duration;audio=sliceAudio(audio,s.start,Math.max(s.start,end));if(s.channels!=='all'){const indices=channelIndices(s.channels,audio.channels.length);if([1,2,6,8].includes(indices.length))audio={...audio,layout:layoutForChannels(indices.length),channels:indices.map(index=>audio.channels[index])};else audio={...audio,channels:audio.channels.map((channel,index)=>indices.includes(index)?channel:new Float32Array(channel.length))};}}return audio;}
function drawDetailView(){const audio=selectedAudio(),original=selectedAudio({processed:false});drawDetail($('#detail-canvas'),audio,preview?original:null,{mode:detailMode,compareOriginal});if(audio&&audio.channels[0].length){const stats=analyzeAudio(compareOriginal?original:audio);$('#signal-stats').textContent=`${fmt(stats.peakDb)} dBFS PEAK`;$('#analysis-readout').textContent=`${fmt(stats.rmsDb)} dBFS RMS · ${audio.layout||audio.channels.length+' CH'}`;}else{$('#signal-stats').textContent='NO AUDIO';$('#analysis-readout').textContent='Select a waveform to inspect its signal.';}$('#detail-caption').textContent=detailMode==='scope'?'Actual sample detail from the selection. Zoom the arrangement for precise edits.':'Frequency content from selected audio. Pitch moves spectral peaks; all curves use processed samples.';}
function updateClock(){const n=Math.max(0,cursor),minutes=Math.floor(n/60),seconds=n%60;$('#playhead-time').textContent=`${String(minutes).padStart(2,'0')}:${seconds.toFixed(3).padStart(6,'0')}`;if(state){const beat=Math.max(0,(n-state.beatOffset)*state.bpm/60);$('#playhead-bars').textContent=`BAR ${Math.floor(beat/state.beatsPerBar)+1} · BEAT ${Math.floor(beat%state.beatsPerBar)+1}`;}}
function drawMeter({left=0,right=0,clipped=false}={}){const canvas=$('#meter-canvas'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.fillStyle='#0e131a';ctx.fillRect(0,0,w,h);for(const [i,value] of [left,right].entries()){const db=value>0?20*Math.log10(value):-60;const gradient=ctx.createLinearGradient(0,0,w,0);gradient.addColorStop(0,'#4fb6c4');gradient.addColorStop(.7,'#e8532a');gradient.addColorStop(.95,'#f2c14e');ctx.fillStyle=gradient;ctx.fillRect(0,i*11,clamp((db+60)/60,0,1)*w,7);}const peak=Math.max(left,right);$('#peak-meter-value').textContent=`${fmt(peak>0?20*Math.log10(peak):-Infinity)} dB`;if(clipped||peak>1){$('.master-meter').classList.add('clipping');$('#clip-label').textContent='CLIPPED';}}
function quantize(t){return $('#snap').checked?Math.round((t-state.beatOffset)/(60/state.bpm*+$('#snap-grid').value))*(60/state.bpm*+$('#snap-grid').value)+state.beatOffset:t;}
function attachTimeline(canvas){let active=null;const track=state.tracks.find(t=>t.id===canvas.dataset.trackId);const at=e=>{const r=canvas.getBoundingClientRect();return view.start+clamp((e.clientX-r.left)/r.width,0,1)*view.duration;};
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;const time=at(e),clip=[...track.clips].reverse().find(c=>time>=c.start&&time<=c.start+c.duration);if(!clip){cursor=Math.max(0,quantize(time));updateClock();drawPlayhead();return;}e.preventDefault();canvas.focus({preventScroll:true});stopPlayback(false);discardPreview(false);let local=clamp(quantize(time)-clip.start,0,clip.duration);const previous=state.selection?.clipId===clip.id?state.selection:null;const pxPerSecond=canvas.clientWidth/view.duration;let handle=previous&&Math.abs((local-previous.start)*pxPerSecond)<9?'start':previous&&Math.abs((local-previous.end)*pxPerSecond)<9?'end':null;active={clip,anchor:local,move:e.altKey,moveStart:time,initialStart:clip.start,handle,previous};cursor=clip.start+local;selectionDrag={selection:previous};canvas.setPointerCapture(e.pointerId);updateClock();drawWaveforms();});
  canvas.addEventListener('pointermove',e=>{if(!active)return;const time=at(e),c=active.clip;if(active.move){c.start=Math.max(0,quantize(active.initialStart+time-active.moveStart));drawWaveforms();return;}let local=clamp(quantize(time)-c.start,0,c.duration);let start=active.handle==='start'?local:active.handle==='end'?active.previous.start:Math.min(active.anchor,local);let end=active.handle==='end'?local:active.handle==='start'?active.previous.end:Math.max(active.anchor,local);if(end<start)[start,end]=[end,start];selectionDrag={selection:{trackId:track.id,clipId:c.id,start,end,channels:selectedChannelScope()}};$('#selection-start').value=start.toFixed(3);$('#selection-end').value=end.toFixed(3);$('#selection-length').textContent=`${(end-start).toFixed(3)}s`;drawWaveforms();});
  canvas.addEventListener('pointerup',()=>{if(!active)return;const a=active,sel=selectionDrag?.selection;active=null;selectionDrag=null;safe(async()=>{await core('project.select',{trackId:track.id,clipId:a.clip.id},{quiet:true});if(a.move){await core('clip.update',{clipId:a.clip.id,start:a.clip.start});return;}if(sel&&sel.end-sel.start>1/state.sampleRate&&sel.clipId===a.clip.id){await core('selection.set',sel,{quiet:true});status(`Selected ${(sel.end-sel.start).toFixed(3)}s · drag handles or type IN / OUT for precision.`);}else{await core('selection.clear',{}, {quiet:true});status('Cursor placed. Press S to split; drag to select audio.');}});});
  canvas.addEventListener('pointercancel',()=>{active=null;selectionDrag=null;drawWaveforms();});
  canvas.addEventListener('dblclick',e=>safe(async()=>{const time=at(e),clip=track.clips.find(c=>time>=c.start&&time<=c.start+c.duration);if(clip){await core('selection.set',{clipId:clip.id,start:0,end:clip.duration,channels:'all'},{quiet:true});cursor=clip.start;updateClock();}}));
  canvas.addEventListener('contextmenu',e=>{e.preventDefault();safe(()=>openTrack(track.id));});
}
function updateTabs(){$$('[data-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.panel===activePanel)));$('#effect-controls').hidden=activePanel==='effects';$('#rack-controls').hidden=activePanel!=='effects';if(state)updateRackModeUI();}
function queuePreview(effect=currentProcessor().effect,params=currentProcessor().params){if(effect==='rack'&&processingMode==='live')return;if(playback.playing)stopPlayback(false);clearTimeout(previewTimer);const serial=++previewSerial;if(!selectedClip())return;$('.preview-state').className='preview-state processing';$('#preview-state').textContent='Rendering processed samples…';previewTimer=setTimeout(async()=>{setBusy(1,'Rendering preview…');const clipId=state.selectedClipId;try{const audio=await engine.execute('effect.preview',{effect,params});if(serial!==previewSerial||clipId!==state.selectedClipId)return;preview={clipId,audio,effect,params:clone(params)};compareOriginal=false;$('#compare-button').setAttribute('aria-pressed','false');$('.preview-state').className='preview-state ready';$('#preview-state').textContent=`${processorTitle(effect)} · preview ready`;$('#render-indicator').textContent='PROCESSED PREVIEW';drawWaveforms();drawDetailView();}catch(error){if(serial===previewSerial){preview=null;$('.preview-state').className='preview-state';$('#preview-state').textContent=error.message;status(error.message,true);drawWaveforms();drawDetailView();}}finally{setBusy(-1);}},220);}
function discardPreview(redraw=true){if(preview&&playback.playing)stopPlayback(false);clearTimeout(previewTimer);previewSerial++;preview=null;compareOriginal=false;$('#compare-button').setAttribute('aria-pressed','false');$('.preview-state').className='preview-state';$('#preview-state').textContent='Choose an effect to preview';$('#render-indicator').textContent='LIVE PCM VIEW';if(redraw){drawWaveforms();drawDetailView();}}
async function applyPreview(){if(activePanel==='effects'&&processingMode==='live'){status('Live effects are active. Choose an explicit live-effects export or switch to Selection mode to apply an edit.');return;}ensureClip();const {effect,params}=currentProcessor();await core(`effect.${effect}`,params);status(`${processorTitle(effect)} applied to ${state.selection?'the selected region':'the selected clip'}.`);}
function showEffect(effect){setInspector(false,{persist:false});effectPanel.choose(effect);updateTabs();if(innerWidth<800)$('.inspector').scrollIntoView({behavior:'smooth',block:'start'});}
async function play(scope='mix'){if(!['mix','clip','selection'].includes(scope))throw new Error('Playback scope must be mix, clip or selection.');if(scope!=='mix')ensureClip();else if(!state.tracks.some(t=>t.clips.length))throw new Error('Import or generate audio before playing the mix.');if(liveAudio&&!preview){if(playback.playing&&scope===playbackScope){await core('transport.pause');return;}const clip=selectedClip(),selection=state.selection;let start=scope==='selection'?(ensureSelection(),clip.start+selection.start):scope==='clip'?clip.start:0,end=scope==='selection'?clip.start+selection.end:scope==='clip'?clip.start+clip.duration:state.duration;const loopStart=scope==='mix'&&selection?clip.start+selection.start:start,loopEnd=scope==='mix'&&selection?clip.start+selection.end:end;let position=scope==='mix'?clamp(cursor,start,end):start;if(position>=end-.001||loop&&(position<loopStart||position>=loopEnd))position=loop?loopStart:start;playbackScope=scope;await core('transport.play',{scope,position,loop,loopStart,loopEnd,rate:+$('#playback-rate').value,bpm:state.bpm,beatOffset:state.beatOffset,beatsPerBar:state.beatsPerBar,metronome});status(`Playing ${scope==='selection'?'selected audio':scope==='clip'?'selected clip':'the mix'}${loop?' · looping':''}.`);return;}if(playback.playing&&scope===playbackScope){stopPlayback(false);return;}stopPlayback(false);setBusy(1,'Preparing playback…');try{let audio,options={scope};const clip=selectedClip(),s=state.selection;let timelineOffset=scope==='selection'?(ensureSelection(),clip.start+s.start):scope==='clip'?clip.start:0;
  if(preview&&!compareOriginal)audio=await engine.execute('audio.renderPreview',{effect:preview.effect,params:preview.params,scope});else audio=await engine.execute('audio.render',options);
  let offset=scope==='mix'?clamp(cursor,0,duration(audio)):0;if(offset>=duration(audio)-.001)offset=0;
  let loopStart=0,loopEnd=duration(audio);if(scope==='mix'&&s){loopStart=clip.start+s.start;loopEnd=clip.start+s.end+(preview&&!compareOriginal?duration(preview.audio)-clip.duration:0);if(loop&&(offset<loopStart||offset>=loopEnd))offset=loopStart;}
  playbackScope=scope;await playback.play(audio,{offset,loop,loopStart,loopEnd,rate:+$('#playback-rate').value,bpm:state.bpm,beatOffset:state.beatOffset,beatsPerBar:state.beatsPerBar,metronome,timelineOffset});$('#play-button').textContent='Ⅱ';$('#play-button').classList.add('playing');status(`${preview&&!compareOriginal?'Previewing':'Playing'} ${scope==='selection'?'selected audio':scope==='clip'?'selected clip':'the mix'}${loop?' · looping':''}.`);
  }finally{setBusy(-1);}}
function stopPlayback(reset=false){const savedCursor=playback.playing?playback.position:cursor;playback.stop();cursor=reset?0:savedCursor;$('#play-button').textContent='▶';$('#play-button').classList.remove('playing');updateClock();drawPlayhead();drawMeter();}
async function importFiles(files,{origin='ui'}={}){
  if(!files.length)return [];
  const aliases=fileIO.supply(files),results=[],references=files.filter(file=>/\.(rpp|aup)$/i.test(file.name));
  if(references.length>1)throw new Error('Open one referenced project at a time with its supplied media.');
  const chosen=references.length?aliases.filter(alias=>alias.name===references[0].name):aliases;
  const sourceLayout=origin==='ui'?normalizeWorkbenchPreferences(settings.workbench).import.layout:'auto';
  for(const input of chosen)results.push(await commandRuntime.execute('file.import',{input:input.id,...(sourceLayout!=='auto'?{layout:sourceLayout}:{})},{origin}));
  fitView();renderSession();effectPanel.render();await macroPanel?.afterManualImport(results,origin);return results;
}
async function importOne(file,params={},context={}){
  context.signal?.throwIfAborted();
  if(/\.wsemacro$/i.test(file.name)){if(file.size>131072)throw new Error('Macro file exceeds 128 KiB.');macroPanel.setDraft(await file.text());macroPanel.disarm();persistSettings();await macroPanel.open();return {clipIds:[]};}
  if(/\.midi?$/i.test(file.name))return creative.importMidi(file,{...params,execute:coreRaw});
  if(/\.(json|aup3|aup|zip|rpp)$/i.test(file.name)){
    let files;
    if(/\.(aup|rpp)$/i.test(file.name)){files=new Map();let bytes=0;for(const supplied of fileIO.inputs.values()){bytes+=supplied.file.size;if(bytes>360*1024*1024)throw new Error('Supplied project media exceeds 360 MB.');const key=supplied.file.webkitRelativePath||supplied.file.name;if(files.has(key))throw new Error('Supplied media aliases must be unique.');files.set(key,new Uint8Array(await supplied.file.arrayBuffer()));}}
    return loadProjectFile(file,files);
  }
  setBusy(1,`Decoding ${file.name}…`);
  try{const audio=await decodeAudioFile(file,state.sampleRate,{layout:params.layout});context.signal?.throwIfAborted();
    if(params.replace&&params.trackId)throw new Error('A replacement import cannot target an old track ID.');
    const add={audio,name:params.name||file.name.replace(/\.[^.]+$/,''),...(params.trackId?{trackId:params.trackId}:{}),...(params.start!==undefined?{start:params.start}:{})};
    const commands=[...(params.replace?[{method:'project.new',params:{name:add.name,sampleRate:state.sampleRate}}]:[]),{method:'clip.add',params:add}];
    if(audio.metadata&&Object.keys(audio.metadata).length&&(params.replace||!Object.keys(state.metadata||{}).length))commands.push({method:'metadata.update',params:{metadata:audio.metadata}});
    const results=await coreRaw('recipe.run',{commands},{quiet:true}),clip=results[params.replace?1:0];
    demo=false;status(`Imported ${file.name} · ${duration(audio).toFixed(2)}s · ${audio.channels.length} channel(s).`);return clip;
  }finally{setBusy(-1);}
}
function download(value,filename,mime='application/json'){const blob=value instanceof Blob?value:new Blob([typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value,null,2)],{type:mime});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function filename(name){return (name||'audio').replace(/[^a-z0-9_\- .]/gi,'').trim().replace(/\s+/g,'-').slice(0,100)||'audio';}
async function saveProject(){await core('settings.load',{settings:{...state.settings,ui:portableSettings(),...(liveAudio?{live:liveAudio.getSettings()}: {})}},{quiet:true,refresh:false,preservePreview:true});const project=await engine.execute('project.save');download(project,`${filename(state.name)}.websoundedit.json`);$('#save-state').textContent='Project JSON downloaded';status('Portable project saved with audio, tracks, settings, selections and markers.');return project;}
async function loadProject(project){const data=typeof project==='string'?JSON.parse(project):project;const prepared=validateSettings(data?.settings?.ui||{format:'websoundedit-ui-settings',version:1,theme:settings.theme,shortcuts:settings.shortcuts,workbench:settings.workbench,macros:macroPanel?.save()||settings.macros});const liveSettings=liveAudio?.validateSettings(data?.settings?.live||{version:1,racks:{}},{project:data});const result=await coreRaw('project.load',{project:data});if(liveSettings)await liveAudio.loadSettings(liveSettings);applySettings(prepared);demo=false;fitView();renderSession();effectPanel.render();status('Project restored from JSON, including embedded audio.');return result;}
async function loadProjectFile(file,files){
  if(file.size>360*1024*1024)throw new Error('Project exceeds the 360 MB import limit.');
  if(/\.json$/i.test(file.name)){await loadProject(JSON.parse(await file.text()));return {clipIds:state.tracks.flatMap(track=>track.clips.map(clip=>clip.id))};}
  setBusy(1,'Opening DAW project…');
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());let reaper=/\.rpp$/i.test(file.name);
    if(/\.zip$/i.test(file.name)){const {readProjectZip}=await import('./project-archive.js');reaper=[...readProjectZip(bytes,{accept:path=>/\.rpp$/i.test(path)}).keys()].some(path=>/\.rpp$/i.test(path));}
    let result;
    if(reaper){const {importReaper}=await import('./reaper.js');result=await importReaper(bytes,{name:file.name,files,decodeMedia:async(data,{name,sampleRate})=>decodeAudioFile(new File([data],name),sampleRate)});}
    else{const {importAudacity}=await import('./audacity.js');result=await importAudacity(bytes,{name:file.name,files});}
    await loadProject(result.project);status(`${reaper?'REAPER':'Audacity'} project opened.${result.warnings?.length?' '+result.warnings.join(' '):''}`);closeModal();return {clipIds:state.tracks.flatMap(track=>track.clips.map(clip=>clip.id)),warnings:result.warnings||[]};
  }finally{setBusy(-1);}
}
async function loadLegacyFolder(files){const projects=files.filter(file=>/\.(aup|rpp)$/i.test(file.name));if(projects.length!==1)throw new Error('Choose a folder with one .aup or .rpp project and its media.');return importFiles(files);}

function portableSettings(){return {format:'websoundedit-ui-settings',version:1,effects:clone(effectPanel.values),shortcuts:clone(settings.shortcuts),snap:$('#snap').checked,grid:+$('#snap-grid').value,selectedEffect:effectPanel.effect,activePanel,rack:processingMode==='live'&&offlineRack?clone(offlineRack):rackPanel.save(),midi:creative.save(),theme:settings.theme||'studio',inspectorCollapsed:Boolean(settings.inspectorCollapsed),workbench:clone(settings.workbench||normalizeWorkbenchPreferences()),macros:macroPanel?.save()||normalizeMacroSettings(settings.macros)};}
function persistSettings(){settings=portableSettings();if(macroPanel?.isBatchRunning())return;try{localStorage.setItem('websoundedit.settings.v1',JSON.stringify(settings));}catch{status('Browser settings storage is unavailable. Export settings JSON to keep your preferences.');}if(state&&!initialising)scheduleRecovery();}
function validateSettings(value){
  if(value?.format==='websoundedit-settings')value=value.settings?.ui||value.settings;
  if(!value||value.version!==1||typeof value!=='object'||Array.isArray(value))throw new Error('Unsupported settings JSON.');
  const nextShortcuts={};
  if(value.shortcuts!==undefined){
    if(!value.shortcuts||typeof value.shortcuts!=='object'||Array.isArray(value.shortcuts))throw new Error('Shortcuts must be an object.');
    for(const [id,raw] of Object.entries(value.shortcuts)){
      if(!actions.has(id))continue;
      if(typeof raw!=='string'||raw.length>60)throw new Error('Invalid keyboard shortcut.');
      const v=raw.trim().toLowerCase().replace(/\s+/g,' ');
      if(!v||!/^[a-z0-9 +,./;\[\]\\'=\-]+$/.test(v))throw new Error(`Invalid shortcut for ${id}.`);
      nextShortcuts[id]=v;
    }
  }
  const seen=new Set();
  for(const action of actions.values()){const key=nextShortcuts[action.id]??action.shortcut;if(seen.has(key))throw new Error(`Duplicate shortcut: ${key}`);seen.add(key);}
  const rackSettings=normalizeRackSettings(value.rack);
  if(value.midi!==undefined&&(!value.midi||typeof value.midi!=='object'||Array.isArray(value.midi)))throw new Error('Invalid MIDI settings.');
  const midiMappings=normalizeMidiMappings(value.midi?.mappings||[]);
  const midiActions=normalizeMidiActions(value.midi?.actions||[]),workbench=normalizeWorkbenchPreferences(value.workbench),macros=normalizeMacroSettings(value.macros);
  const effectValues=effectPanel.load(value.effects,{validateOnly:true});
  return {value,nextShortcuts,rackSettings,midiMappings,midiActions,workbench,macros,effectValues};
}
function loadSettings(value){applySettings(validateSettings(value));}
function applySettings({value,nextShortcuts,rackSettings,midiMappings,midiActions,workbench,macros,effectValues}){
  processingMode='selection';offlineRack=null;pendingRackUpdate=null;liveRackRevision++;settings.workbench=workbench;guidance?.setEnabled(workbench.tooltips);macroPanel?.load(macros);settings.macros=macros;
  effectPanel.load(effectValues);
  rackPanel.load(rackSettings);creative.load({...value.midi,mappings:midiMappings,actions:midiActions});
  settings.theme=applyTheme(value.theme);settings.inspectorCollapsed=Boolean(value.inspectorCollapsed);
  settings.shortcuts=nextShortcuts;
  $('#snap').checked=Boolean(value.snap);
  if([1,.5,.25,.125,4].includes(value.grid))$('#snap-grid').value=String(value.grid);
  if(Object.hasOwn(EFFECT_UI,value.selectedEffect))effectPanel.choose(value.selectedEffect,{notify:false});
  activePanel=value.activePanel==='effects'?'effects':EFFECT_UI[effectPanel.effect].category;
  setInspector(settings.inspectorCollapsed,{persist:false});discardPreview();persistSettings();updateTabs();drawWaveforms();
}
function scheduleRecovery(){if(recoveryDisabled||macroPanel?.isBatchRunning())return;clearTimeout(recoveryTimer);$('#save-state').textContent='Unsaved file · recovery pending';recoveryTimer=setTimeout(async()=>{try{const project=await engine.execute('project.save');if(macroPanel?.isBatchRunning())return;project.settings={...project.settings,ui:portableSettings(),...(liveAudio?{live:liveAudio.getSettings()}: {})};await saveRecovery(project);$('#save-state').textContent='Recovery saved on this device';}catch(error){$('#save-state').textContent='Recovery unavailable · save project';status(`Browser recovery could not be saved: ${error.message}`);}},1600);}
function fitView(){view={start:0,duration:Math.max(2,state?.duration||8)*1.015};clampView();drawWaveforms();}
function zoom(factor,selection=false){if(selection){const s=ensureSelection(),c=selectedClip();view.start=Math.max(0,c.start+s.start-(s.end-s.start)*.05);view.duration=Math.max(.005,(s.end-s.start)*1.1);}else{const center=cursor>=view.start&&cursor<=view.start+view.duration?cursor:view.start+view.duration/2;const old=view.duration;view.duration=clamp(old/factor,.005,600);view.start=Math.max(0,center-(center-view.start)/old*view.duration);}clampView();drawWaveforms();}
function openModal(title,html,onReady){$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();onReady?.($('#modal-content'));}
function closeModal(){$('#modal').close();}
function field(label,id,value,type='number',extra=''){return `<label>${label}<input id="${id}" type="${type}" value="${escapeHTML(value)}" ${extra}></label>`;}
async function exportAudio(options={}){return commandRuntime.execute('file.export',options,{origin:'api'});}
function openExport(scope='mix',trackId){return exportPanel.open({scope,trackId});}
function openLoop(){const c=ensureClip(),s=state.selection,length=s?s.end-s.start:c.duration,bars=length*state.bpm/60/state.beatsPerBar;openModal('Make a loop.',`<p>Use the selected region as a loop, or select a whole number of beats first. The original stays available when you create a new loop track.</p><div class="info-note">Source: ${length.toFixed(3)} seconds · ${(length*state.bpm/60).toFixed(2)} beats · ${bars.toFixed(2)} bars at ${state.bpm} BPM.</div><div class="form-grid">${field('Number of repetitions','loop-repeats',4,'number','min="1" max="64" step="1"')}${field('Join crossfade (ms)','loop-crossfade',0,'number','min="0" max="500" step="1"')}${field('Loop name','loop-name',`${c.name} loop`,'text')}<label>Placement<select id="loop-place"><option value="new">New track</option><option value="same">Same track</option></select></label></div><div class="info-note">0 ms preserves beat-exact timing. Crossfades overlap adjacent copies, shortening each join by the chosen overlap. Use short source fades to keep an exact beat grid.</div><div class="modal-actions"><button id="loop-play">Loop selection</button><button id="loop-region">Select one bar at cursor</button><button id="loop-save">Save region</button><button id="loop-create" class="primary">Create loop</button></div>`,()=>{$('#loop-play').onclick=()=>safe(async()=>{if(!state.selection)await selectAll();loop=true;$('#loop-button').setAttribute('aria-pressed','true');closeModal();await play('selection');});$('#loop-region').onclick=()=>safe(async()=>{const start=clamp(cursor-c.start,0,c.duration),end=Math.min(c.duration,start+60/state.bpm*state.beatsPerBar);if(end<=start)throw new Error('Place the cursor before the end of the clip.');await core('selection.set',{clipId:c.id,start,end,channels:'all'});openLoop();});$('#loop-save').onclick=()=>safe(()=>{if(!state.selection)return selectAll().then(()=>openExport('selection'));openExport('selection');});$('#loop-create').onclick=()=>safe(async()=>{await core('loop.create',{repeats:+$('#loop-repeats').value,crossfadeMs:+$('#loop-crossfade').value,newTrack:$('#loop-place').value==='new',name:$('#loop-name').value});closeModal();fitView();status('Loop created. The original clip remains available.');});});}
function openGenerate(){openModal('Start with a signal.',`<p>Synthesize audio directly on your device. Seeded noise and drums make your experiments reproducible.</p><div class="form-grid"><label>Signal<select id="gen-type"><option value="tone">Sine tone</option><option value="noise">White noise</option><option value="sweep">Logarithmic sweep</option><option value="drums">Rhythm / drum pattern</option></select></label>${field('Duration (seconds)','gen-duration',4,'number','min="0.01" max="120" step="0.01"')}${field('Frequency (Hz)','gen-frequency',220,'number','min="1" max="20000"')}${field('Sweep end frequency (Hz)','gen-end',12000,'number','min="1" max="20000"')}${field('Amplitude (0–1)','gen-amplitude',0.3,'number','min="0" max="1" step="0.01"')}${field('Seed','gen-seed',42,'number','min="0" max="999999" step="1"')}<label>Channels<select id="gen-channels"><option value="1">Mono</option><option value="2">Stereo</option></select></label>${field('Track name','gen-name','Generated signal','text')}</div><div class="modal-actions"><button id="gen-cancel">Cancel</button><button id="gen-go" class="primary">Generate audio</button></div>`,()=>{$('#gen-cancel').onclick=closeModal;$('#gen-go').onclick=()=>safe(async()=>{await core('audio.generate',{type:$('#gen-type').value,duration:+$('#gen-duration').value,frequency:+$('#gen-frequency').value,endFrequency:+$('#gen-end').value,amplitude:+$('#gen-amplitude').value,seed:+$('#gen-seed').value,channels:+$('#gen-channels').value,name:$('#gen-name').value});closeModal();demo=false;fitView();renderSession();effectPanel.render();});});}
async function openTrack(trackId){const track=trackId?state.tracks.find(item=>item.id===trackId):selectedTrack(),clip=track?.clips.find(item=>item.id===state.selectedClipId)||track?.clips[0]||null;if(!track)throw new Error('Select a track first.');openModal('Track & clip placement',`<div class="form-grid">${field('Track name','track-name-edit',track.name,'text')}${field('Track gain (dB)','track-gain-edit',track.gainDb,'number','min="-96" max="24" step="0.1"')}${field('Track pan (−1 left, 1 right)','track-pan-edit',track.pan,'number','min="-1" max="1" step="0.01"')}${clip?`${field('Clip name','clip-name-edit',clip.name,'text')}${field('Clip timeline start (seconds)','clip-start-edit',clip.start,'number','min="0" max="600" step="0.001"')}<label>Move clip to track<select id="clip-destination">${state.tracks.map(t=>`<option value="${escapeHTML(t.id)}" ${t.id===track.id?'selected':''}>${escapeHTML(t.name)}</option>`).join('')}</select></label>`:''}</div><p class="info-note">You can also Alt-drag a waveform to move its clip on the timeline. Overlapping clips mix together.</p><div class="modal-actions"><button id="track-remove">Remove track</button>${clip?'<button id="clip-remove">Remove clip</button><button id="clip-duplicate">Duplicate clip</button>':''}<button class="primary" id="track-save">Save changes</button></div>`,()=>{$('#track-save').onclick=()=>safe(async()=>{const commands=[{method:'track.update',params:{trackId:track.id,name:$('#track-name-edit').value,gainDb:+$('#track-gain-edit').value,pan:+$('#track-pan-edit').value}}];if(clip)commands.push({method:'clip.update',params:{clipId:clip.id,name:$('#clip-name-edit').value,start:+$('#clip-start-edit').value,destinationTrackId:$('#clip-destination').value}});await core('recipe.run',{commands});closeModal();});$('#track-remove').onclick=()=>safe(async()=>{await core('track.remove',{trackId:track.id});closeModal();});if(clip){$('#clip-remove').onclick=()=>safe(async()=>{await core('clip.remove',{clipId:clip.id});closeModal();});$('#clip-duplicate').onclick=()=>safe(async()=>{await core('clip.duplicate',{clipId:clip.id});closeModal();fitView();});}});}
function openMarkers(){openModal('Markers & beat grid',`<p>Mark useful timeline positions and calibrate the first beat without stretching any audio.</p><div class="form-grid">${field('Marker name','marker-name','Cue','text')}${field('Timeline position (seconds)','marker-time',cursor.toFixed(3),'number','min="0" max="600" step="0.001"')}${field('Beat grid offset (seconds)','beat-offset',state.beatOffset,'number','min="-600" max="600" step="0.001"')}${field('Beats per bar','beats-per-bar',state.beatsPerBar,'number','min="1" max="16" step="1"')}</div><div class="modal-actions"><button id="grid-save">Update beat grid</button><button id="marker-add" class="primary">Add marker</button></div><div id="marker-list">${state.markers.map(m=>`<div class="marker-row"><button data-marker-jump="${m.time}">${m.time.toFixed(3)}s</button><span>${escapeHTML(m.name)}</span><button data-marker-delete="${escapeHTML(m.id)}">Remove</button></div>`).join('')}</div>`,()=>{$('#marker-add').onclick=()=>safe(async()=>{await core('markers.add',{name:$('#marker-name').value,time:+$('#marker-time').value});openMarkers();});$('#grid-save').onclick=()=>safe(async()=>{await core('project.update',{beatOffset:+$('#beat-offset').value,beatsPerBar:+$('#beats-per-bar').value});status('Beat grid updated. Audio samples remain unchanged.');});$$('[data-marker-jump]').forEach(b=>b.onclick=()=>{cursor=+b.dataset.markerJump;updateClock();drawPlayhead();closeModal();});$$('[data-marker-delete]').forEach(b=>b.onclick=()=>safe(async()=>{await core('markers.remove',{markerId:b.dataset.markerDelete});openMarkers();}));});}
async function detectTempo(){const result=await core('analysis.bpm',{}, {refresh:false});if(!result.bpm){status('No reliable tempo found. Select a longer rhythmic passage or set BPM manually.');return result;}const c=selectedClip();await core('project.update',{bpm:result.bpm,beatOffset:(c?.start||0)+(state.selection?.start||0)+(result.beatOffset||0)});status(`Detected ${result.bpm} BPM · heuristic confidence ${Math.round(result.confidence*100)}%. Use ÷2 / ×2, Tap, or type a correction.`);return result;}
async function detectSilenceUI(){const p=effectPanel.values.removeSilence;const selectionBase=state.selection?.start||0;const regions=await core('analysis.silence',p,{refresh:false});const c=ensureClip();openModal('Quiet regions',`<p>${regions.length} quiet region${regions.length===1?'':'s'} detected at ${p.thresholdDb} dBFS. Click a region to select it, or preview silence removal.</p><div>${regions.map((r,i)=>`<div class="marker-row"><span>${i+1}.</span><button data-silent-region="${i}">${(selectionBase+r.start).toFixed(3)} → ${(selectionBase+r.end).toFixed(3)} s</button><span>${(r.end-r.start).toFixed(3)} s</span></div>`).join('')||'<p>No matching quiet regions.</p>'}</div><div class="modal-actions"><button id="silence-close">Close</button><button id="silence-preview" class="primary">Preview removal</button></div>`,()=>{$('[id="silence-close"]').onclick=closeModal;$('#silence-preview').onclick=()=>{closeModal();showEffect('removeSilence');};$$('[data-silent-region]').forEach(b=>b.onclick=()=>safe(async()=>{const r=regions[+b.dataset.silentRegion];await core('selection.set',{clipId:c.id,start:selectionBase+r.start,end:selectionBase+r.end,channels:'all'});closeModal();}));});return regions;}
async function selectAll(){const c=ensureClip();await core('selection.set',{clipId:c.id,start:0,end:c.duration,channels:selectedChannelScope()},{quiet:true});}
async function record(){
  if(recordSession){
    if(recordSession.recorder?.state==='recording')recordSession.recorder.stop();
    else if(!recordSession.recorder)cancelRecording(recordSession);
    return;
  }
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Microphone recording requires HTTPS and a browser with MediaRecorder support.');
  stopPlayback(false);
  const session={cancelled:false,stream:null,recorder:null,chunks:[],timer:null,start:cursor,sampleRate:state.sampleRate};
  recordSession=session;recordSessions.add(session);
  try{
    session.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(session.cancelled){releaseRecording(session);return;}
    const recorder=session.recorder=new MediaRecorder(session.stream);
    recorder.ondataavailable=event=>{if(!session.cancelled&&event.data.size)session.chunks.push(event.data);};
    recorder.onerror=event=>{cancelRecording(session);status(event.error?.message||'Recording failed.',true);};
    recorder.onstop=()=>{
      releaseRecording(session);
      if(session.cancelled){recordSessions.delete(session);return;}
      const mime=recorder.mimeType,blob=new Blob(session.chunks,{type:mime});
      session.chunks=[];
      void safe(async()=>{
        setBusy(1,'Decoding recording…');
        try{
          const file=new File([blob],'Recording.'+(mime.includes('mp4')?'m4a':mime.includes('ogg')?'ogg':'webm'),{type:mime});
          const audio=await decodeAudioFile(file,session.sampleRate);
          if(session.cancelled)return;
          await core('clip.add',{audio,name:'Recording '+new Date().toLocaleTimeString(),start:session.start});
          demo=false;fitView();renderSession();status('Recording added. The microphone has been released.');
        }catch(error){if(!session.cancelled)throw error;}
        finally{recordSessions.delete(session);setBusy(-1);}
      });
    };
    recorder.start(250);
    $('#record-button').classList.add('recording');$('#record-button').setAttribute('aria-label','Stop microphone recording');
    const start=performance.now();
    session.timer=setInterval(()=>{
      status('Recording microphone · '+((performance.now()-start)/1000).toFixed(1)+'s · press R or Record to stop.');
      if(performance.now()-start>300000&&recorder.state==='recording')recorder.stop();
    },250);
  }catch(error){
    const cancelled=session.cancelled;cancelRecording(session);
    if(!cancelled)throw error;
  }
}
function releaseRecording(session){
  session.stream?.getTracks().forEach(track=>track.stop());session.stream=null;
  clearInterval(session.timer);session.timer=null;
  if(recordSession===session){
    recordSession=null;
    $('#record-button').classList.remove('recording');$('#record-button').setAttribute('aria-label','Record microphone');
  }
}
function cancelRecording(session){
  session.cancelled=true;
  if(session.recorder?.state==='recording')try{session.recorder.stop();}catch{}
  releaseRecording(session);recordSessions.delete(session);
}
function stopRecordingStream(){for(const session of recordSessions)cancelRecording(session);}
function stopRecording(){if(recordSession?.recorder?.state==='recording')recordSession.recorder.stop();else if(recordSession)cancelRecording(recordSession);}
function register(id,label,shortcut,run){const index=actions.size;actions.set(id,{id,label,shortcut:shortcut||`u ${String.fromCharCode(97+Math.floor(index/26))} ${String.fromCharCode(97+index%26)}`,run});}
function shortcutFor(action){const value=settings.shortcuts?.[action.id];return typeof value==='string'&&value.trim()?value:action.shortcut;}
async function safe(fn){try{return await fn();}catch(error){console.error(error);status(error.message||String(error),true);if($('#modal').open){let node=$('#modal-error');if(!node){node=document.createElement('p');node.id='modal-error';node.setAttribute('role','alert');node.style.color='#ffb0a6';$('#modal-content').append(node);}node.textContent=error.message||String(error);}if(routes?.dialog.open){let node=$('#workspace-error');if(!node){node=document.createElement('p');node.id='workspace-error';node.setAttribute('role','alert');node.className='result-error';(routes.dialog.querySelector('.workspace-page')||routes.dialog.querySelector('#workbench-view-body')).append(node);}node.textContent=error.message||String(error);}return undefined;}}
async function runAction(id){const action=actions.get(id);if(!action)throw new Error(`Unknown action ${id}`);return commandRuntime?commandRuntime.execute(`ui.${id}`,{},{origin:'ui'}):action.run();}
function openSettings(){return optionsPanel.open('general');}
function openAPI(){openModal('An editor you can script.',`<p>The same audio engine powers this interface, the ES-module API, the CLI, and the authenticated local HTTP API. GitHub Pages hosts the application; the optional companion runs on your computer for scripts that work with your files.</p><div class="inline-buttons"><a href="./docs/API.md" target="_blank" rel="noopener">Full API reference ↗</a><a href="https://github.com/djshellshoxxx/websoundedit/tree/main/examples" target="_blank" rel="noopener">Script examples ↗</a></div><h3>In this browser</h3><pre><code>await websoundedit.execute('selection.set', {
  clipId: websoundedit.getState().selectedClipId,
  start: 1, end: 3, channels: 'all'
});
await websoundedit.execute('effect.pitch', {semitones: 3});
await websoundedit.exportAudio({scope:'selection', format:'wav'});</code></pre><h3>On your computer</h3><pre><code>git clone https://github.com/djshellshoxxx/websoundedit
cd websoundedit
npm ci
npm run edit -- --input input.wav --recipe examples/normalize.json --output output.wav
npm run api</code></pre><p>The API companion prints a random bearer token and listens on 127.0.0.1. Scripts send audio bytes and JSON commands; the static website cannot read arbitrary local paths or accept HTTP processing jobs.</p><h3>Run a JSON recipe on this session</h3><textarea id="recipe-input" class="recipe-editor" aria-label="JSON command recipe">${escapeHTML(JSON.stringify({commands:[{method:'effect.normalize',params:{targetDb:-1}}]},null,2))}</textarea><div class="modal-actions"><button id="recipe-download">Save recipe JSON</button><button id="recipe-run" class="primary">Run recipe</button></div><details><summary class="field-hint">Discover every core method (${registry.length})</summary><div class="api-method-list">${registry.map(c=>`<div><b>${escapeHTML(c.method)}</b> · ${escapeHTML(c.description)}</div>`).join('')}</div></details>`,()=>{$('#recipe-download').onclick=()=>safe(()=>download(JSON.parse($('#recipe-input').value),'websoundedit-recipe.json'));$('#recipe-run').onclick=()=>safe(async()=>{const recipe=JSON.parse($('#recipe-input').value);await core('recipe.run',Array.isArray(recipe)?{commands:recipe}:recipe);status('Recipe completed atomically. Undo restores the previous state.');});});}
function openHelp(){return helpPanel.open('navigation');}
function openNewSession(){openModal('Start a new session?',`<p>Your current audio will be replaced. You can save a portable project first; the new session is also undoable.</p><div class="modal-actions"><button id="new-cancel">Keep editing</button><button id="new-save">Save current project</button><button class="primary" id="new-confirm">Start empty session</button></div>`,()=>{$('#new-cancel').onclick=closeModal;$('#new-save').onclick=()=>safe(saveProject);$('#new-confirm').onclick=()=>safe(async()=>{await core('project.new',{name:'Untitled session',sampleRate:48000,bpm:120});demo=false;cursor=0;fitView();renderSession();closeModal();status('Empty session ready. Import audio, record a take, or generate a signal.');});});}
async function loadDemo(){await liveAudio?.resetProject();await companion?.disconnect();if(processingMode==='live')await setProcessingMode('selection',{notify:false});stopRecordingStream();disconnectProjectMidi();stopPlayback(true);discardPreview(false);initialising=true;try{await engine.execute('project.new',{name:'Afterhours / sketch 01',sampleRate:48000,bpm:120});const drums=await engine.execute('audio.generate',{type:'drums',name:'01 · Night pulse',duration:8,bpm:120,amplitude:.6,seed:17});await engine.execute('track.update',{trackId:drums.trackId,gainDb:-5});const sr=48000,n=8*sr,bass=[new Float32Array(n),new Float32Array(n)],pad=[new Float32Array(n),new Float32Array(n)];const notes=[55,55,65.406,48.999,55,73.416,65.406,48.999];for(let i=0;i<n;i++){const t=i/sr,beat=t%.5,f=notes[Math.floor(t)%8],env=(1-Math.exp(-beat*85))*Math.exp(-beat*6),v=(Math.sin(2*Math.PI*f*t)+.22*Math.sin(2*Math.PI*f*2*t)+.1*Math.sin(2*Math.PI*f*3*t))*.28*env;bass[0][i]=bass[1][i]=v;const swell=Math.sin(Math.PI*(t%2)/2)**2*.12;pad[0][i]=(Math.sin(2*Math.PI*220*t)+Math.sin(2*Math.PI*261.626*t)*.65+Math.sin(2*Math.PI*329.628*t)*.5)*swell;pad[1][i]=(Math.sin(2*Math.PI*220.3*t)+Math.sin(2*Math.PI*261.8*t)*.65+Math.sin(2*Math.PI*330*t)*.5)*swell;}const bassClip=await engine.execute('clip.add',{audio:{sampleRate:sr,channels:bass},name:'02 · Low current'});await engine.execute('track.update',{trackId:bassClip.trackId,gainDb:-3});const padClip=await engine.execute('clip.add',{audio:{sampleRate:sr,channels:pad},name:'03 · Slow glow'});await engine.execute('track.update',{trackId:padClip.trackId,gainDb:-8,pan:.16});await engine.execute('project.select',{trackId:drums.trackId,clipId:drums.clipId});await engine.execute('selection.set',{clipId:drums.clipId,start:2,end:4,channels:'all'});await engine.execute('markers.add',{time:0,name:'IN'});await engine.execute('markers.add',{time:4,name:'TURN'});state=engine.getState();audioById.clear();await refreshAudio();demo=true;fitView();renderSession();effectPanel.render();status('Demo ready · 3 locally synthesized tracks. Drag the waveform to select, or press Space to listen.');$('#save-state').textContent='Demo audio synthesized locally';}finally{initialising=false;}}

register('commands','Find any command','ctrl+k',()=>openCommands());
register('file.import','Import audio files','ctrl+o',()=>$('#audio-input').click());
register('file.export','Export mix / track / clip','ctrl+e',()=>openExport());
register('selection.export','Save selected audio','ctrl+shift+e',()=>openExport('selection'));
register('project.save','Save project JSON','ctrl+s',saveProject);
register('project.open','Open project file','ctrl+shift+o',()=>$('#project-input').click());
register('project.new','New empty session','ctrl+n',openNewSession);
register('demo','Load generated demo','g d',loadDemo);
register('transport.play','Play / pause mix','space',()=>play('mix'));
register('transport.selection','Play only selected region','shift+space',()=>play('selection'));
register('transport.clip','Play selected clip','ctrl+space',()=>play('clip'));
register('transport.stop','Stop playback','escape',()=>core('transport.stop'));
register('transport.start','Return to project start','home',async()=>{await core('transport.stop');await core('transport.seek',{position:0});});
register('transport.loop','Toggle loop playback','l',async()=>{loop=!loop;$('#loop-button').setAttribute('aria-pressed',String(loop));const clip=selectedClip(),selection=state.selection;await core('transport.set',{loop,...(selection?{loopStart:clip.start+selection.start,loopEnd:clip.start+selection.end}:state.duration?{loopStart:0,loopEnd:state.duration}:{})});status(loop?'Loop playback enabled. A selection defines the loop boundaries.':'Loop playback disabled.');});
register('transport.metronome','Toggle metronome','m',async()=>{metronome=!metronome;$('#metronome-button').setAttribute('aria-pressed',String(metronome));await core('transport.set',{metronome});status(metronome?'Metronome enabled during playback.':'Metronome disabled.');});
register('transport.slower','Slower audition speed','[',()=>{const rates=[.5,.75,1,1.25,1.5,2],v=+$('#playback-rate').value;$('#playback-rate').value=rates[Math.max(0,rates.indexOf(v)-1)];return core('transport.set',{rate:+$('#playback-rate').value});});
register('transport.faster','Faster audition speed',']',()=>{const rates=[.5,.75,1,1.25,1.5,2],v=+$('#playback-rate').value;$('#playback-rate').value=rates[Math.min(rates.length-1,rates.indexOf(v)+1)];return core('transport.set',{rate:+$('#playback-rate').value});});
register('record','Record / stop microphone','r',record);
register('history.undo','Undo','ctrl+z',()=>core('history.undo'));
register('history.redo','Redo','ctrl+shift+z',()=>core('history.redo'));
for(const [method,label,key] of [['cut','Cut selected audio','ctrl+x'],['copy','Copy selected audio','ctrl+c'],['delete','Delete selected audio','delete'],['trim','Trim to selection','ctrl+t']])register(`edit.${method}`,label,key,()=>core(`edit.${method}`));
register('edit.paste','Paste audio at cursor','ctrl+v',()=>{const c=selectedClip();return core('edit.paste',c?{at:clamp(cursor-c.start,0,c.duration)}:{});});
register('clip.split','Split clip at cursor','s',()=>{const c=ensureClip();return core('clip.split',{clipId:c.id,at:cursor-c.start});});
register('clip.duplicate','Duplicate selected clip','ctrl+shift+d',()=>core('clip.duplicate').then(fitView));
register('clip.remove','Remove selected clip','shift+delete',()=>core('clip.remove'));
register('selection.all','Select entire clip','ctrl+a',selectAll);
register('selection.clear','Clear selection','ctrl+d',()=>core('selection.clear',{}, {quiet:true}));
register('selection.left','Edit left channel','g l',()=>{const c=ensureClip(),s=state.selection;return core('selection.set',{clipId:c.id,start:s?.start||0,end:s?.end||c.duration,channels:'left'},{quiet:true});});
register('selection.right','Edit right channel','g r',()=>{const c=ensureClip(),s=state.selection;return core('selection.set',{clipId:c.id,start:s?.start||0,end:s?.end||c.duration,channels:'right'},{quiet:true});});
register('selection.both','Edit both channels','g b',()=>{const c=ensureClip(),s=state.selection;return core('selection.set',{clipId:c.id,start:s?.start||0,end:s?.end||c.duration,channels:'all'},{quiet:true});});
register('track.add','Add empty track','ctrl+shift+n',()=>core('track.add',{name:`Track ${state.tracks.length+1}`}));
register('track.settings','Track / clip settings','g t',openTrack);
register('track.mute','Toggle selected track mute','shift+m',()=>{const t=selectedTrack();if(t)return core('track.update',{trackId:t.id,mute:!t.mute});});
register('track.solo','Toggle selected track solo','shift+s',()=>{const t=selectedTrack();if(t)return core('track.update',{trackId:t.id,solo:!t.solo});});
register('track.remove','Remove selected track','ctrl+delete',()=>core('track.remove'));
register('view.zoomIn','Zoom in','+',()=>core('view.zoom',{factor:2}));register('view.zoomOut','Zoom out','-',()=>core('view.zoom',{factor:.5}));register('view.fit','Fit full project','f',()=>core('view.fit'));register('view.zoomSelection','Zoom to selection','z',()=>core('view.zoomSelection'));register('view.selection','Zoom to selection (legacy)','',()=>core('view.zoomSelection'));
register('view.snap','Toggle beat snapping','g s',()=>{$('#snap').checked=!$('#snap').checked;persistSettings();status($('#snap').checked?'Beat snapping on.':'Beat snapping off.');});
register('view.spectrum','Show spectrum','g f',()=>{detailMode='spectrum';$('#spectrum-tab').setAttribute('aria-pressed','true');$('#scope-tab').setAttribute('aria-pressed','false');drawDetailView();});
register('view.scope','Show sample detail','g w',()=>{detailMode='scope';$('#spectrum-tab').setAttribute('aria-pressed','false');$('#scope-tab').setAttribute('aria-pressed','true');drawDetailView();});
register('preview.apply','Apply selected effect','enter',applyPreview);
register('preview.audition','Audition effect / selected clip','p',()=>play(state.selection?'selection':'clip'));
register('preview.compare','Compare original / processed','a',()=>{compareOriginal=!compareOriginal;$('#compare-button').setAttribute('aria-pressed',String(compareOriginal));$('#preview-state').textContent=compareOriginal?'A · original signal':'B · processed signal';drawWaveforms();drawDetailView();if(playback.playing){const scope=playbackScope;stopPlayback(false);return play(scope);}});
register('preview.discard','Discard effect preview','backspace',()=>discardPreview());
const effectKeys={gain:'g',pitch:'p',stretch:'t',speed:'v',fadeIn:'i',fadeOut:'o',reverse:'r',phase:'h',invert:'x',pan:'a',eq:'q',compressor:'c',limiter:'l',normalize:'n',duck:'d',loop:'u',beatRepeat:'b',removeSilence:'s',trimSilence:'j',silence:'z',dcRemove:'f',mono:'m',swap:'w',granular:'e'};
for(const [id,info] of Object.entries(EFFECT_UI))register(`effect.${id}`,info.title,`e ${effectKeys[id]}`,()=>id==='reverse'?core('effect.reverse'):showEffect(id));
register('analysis.bpm','Detect BPM','b',detectTempo);register('analysis.silence','Detect silent regions','g q',detectSilenceUI);register('analysis.stats','Measure selected audio','g a',async()=>{const s=await core('analysis.stats',{}, {refresh:false});openModal('Signal measurements',`<pre><code>${escapeHTML(JSON.stringify(s,null,2))}</code></pre><p>Sample peak and RMS are measured over the selected samples. Correlation is a stereo phase relationship indicator.</p>`);});
register('tempo.tap','Tap tempo','t',async()=>{const now=performance.now();if(taps.length&&now-taps.at(-1)>2500)taps=[];taps.push(now);taps=taps.slice(-9);if(taps.length>2){const intervals=taps.slice(1).map((v,i)=>v-taps[i]).sort((a,b)=>a-b),median=intervals[Math.floor(intervals.length/2)],bpm=clamp(Math.round(60000/median*100)/100,20,300);await core('project.update',{bpm},{quiet:true});status(`Tapped ${bpm} BPM · ${taps.length} taps.`);}else status(`Tap ${taps.length} · keep tapping to set the tempo.`);});
register('tempo.half','Halve project BPM','shift+b',()=>core('project.update',{bpm:Math.max(20,state.bpm/2)}));register('tempo.double','Double project BPM','ctrl+b',()=>core('project.update',{bpm:Math.min(400,state.bpm*2)}));
register('tempo.match','Stretch selection to project tempo','g v',async()=>{const r=await core('analysis.bpm',{}, {refresh:false});if(!r.bpm)throw new Error('Could not detect source tempo. Set the stretch ratio manually.');const ratio=r.bpm/state.bpm;if(ratio<.5||ratio>2)throw new Error('Tempo match exceeds the 0.5–2× stretch range. Correct source/project BPM first.');effectPanel.values.stretch.ratio=+ratio.toFixed(4);showEffect('stretch');status(`Detected source ${r.bpm} BPM → project ${state.bpm} BPM. Preview the stretch before applying.`);});
register('panel.loop','Open Loop studio','g o',openLoop);register('panel.generate','Open signal generator','g g',openGenerate);register('panel.beatRepeat','Open Beat rearranger','g e',()=>showEffect('beatRepeat'));register('panel.granular','Open Texture lab','g x',()=>showEffect('granular'));register('panel.markers','Markers & beat grid','g m',openMarkers);register('panel.edit','Track / clip tools','g c',openTrack);
register('analysis.key','Detect selected sample key','g k',()=>creative.detectKeys());
register('analysis.keyAll','Detect all sample keys','shift+k',()=>creative.detectKeys(true));
register('panel.keys','Sample keys and colors','g y',()=>creative.openKeys());
register('panel.midi','MIDI devices and pedals','g n',()=>optionsPanel.open('midi'));
register('panel.metadata','Audio metadata','g u',()=>creative.openMetadata());
register('panel.projects','Projects and Audacity','g j',()=>creative.openProjects());
register('panel.effects','Creative effects rack','g h',()=>{activePanel='effects';setInspector(false);updateTabs();queuePreview();});
register('view.inspector','Collapse or expand sound tools','g z',()=>setInspector(!settings.inspectorCollapsed));
register('options','Open Options','',openSettings);register('macros','Macros and batch processing','ctrl+shift+m',()=>macroPanel.open());register('performance','Live performance and recording','g p',()=>performancePanel.open());
register('settings','Options and keyboard shortcuts','ctrl+,',openSettings);register('api','API & JSON recipe runner','g i',openAPI);register('help','Quick guide','f1',openHelp);

let commandMatches=[],commandIndex=0;
function openCommands(){$('#command-search').value='';commandIndex=0;filterCommands();$('#command-palette').showModal();$('#command-search').focus();}
function filterCommands(){const query=$('#command-search').value.toLowerCase().trim();commandMatches=[...actions.values()].filter(a=>(a.label+' '+a.id).toLowerCase().includes(query));commandIndex=clamp(commandIndex,0,Math.max(0,commandMatches.length-1));$('#command-results').innerHTML=commandMatches.map((a,i)=>`<button class="command-result ${i===commandIndex?'selected':''}" role="option" aria-selected="${i===commandIndex}" data-command-id="${escapeHTML(a.id)}"><span>${escapeHTML(a.label)}</span><small>${escapeHTML(shortcutFor(a))}</small></button>`).join('')||'<p class="effect-note" style="padding:16px">No matching commands.</p>';$('#command-results').querySelectorAll('button').forEach(b=>b.onclick=()=>{const id=b.dataset.commandId;$('#command-palette').close();safe(()=>runAction(id));});}
$('#command-search').addEventListener('input',()=>{commandIndex=0;filterCommands();});
$('#command-search').addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commandIndex=clamp(commandIndex+(e.key==='ArrowDown'?1:-1),0,Math.max(0,commandMatches.length-1));filterCommands();$('#command-results .selected')?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'){e.preventDefault();const action=commandMatches[commandIndex];if(action){$('#command-palette').close();safe(()=>runAction(action.id));}}});
let keySequence='',keyTimer;
function eventKey(e){let key=e.key.toLowerCase();if(key===' ')key='space';if(key==='esc')key='escape';if(key==='+')return '+';const modifiers=[];if(e.ctrlKey||e.metaKey)modifiers.push('ctrl');if(e.altKey)modifiers.push('alt');if(e.shiftKey)modifiers.push('shift');return [...modifiers,key].join('+');}
document.addEventListener('keydown',e=>{if(e.isComposing||e.defaultPrevented||e.target.closest('[data-rack-interactive]'))return;const key=eventKey(e),editing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)||e.target.isContentEditable;if($('#command-palette').open)return;if(($('#modal').open||routes?.dialog.open)&&key!=='ctrl+k')return;if(e.target.closest('button,summary,a[href]')&&['enter','space'].includes(key))return;if(editing&&!['ctrl+k','ctrl+s','ctrl+e','ctrl+shift+e','escape'].includes(key)){if(e.key==='Enter'&&($('#effect-controls').contains(e.target)||$('#rack-controls').contains(e.target))){e.preventDefault();e.target.blur();safe(applyPreview);}return;}
  if(!editing&&['arrowleft','arrowright','shift+arrowleft','shift+arrowright'].includes(key)){e.preventDefault();const direction=e.key==='ArrowLeft'?-1:1,step=$('#snap').checked?60/state.bpm*+$('#snap-grid').value:view.duration/200;cursor=clamp(cursor+direction*step,0,state.duration);if(e.shiftKey&&selectedClip()){const c=selectedClip(),s=state.selection,start=s?.start??clamp(cursor-c.start,0,c.duration),end=clamp((s?.end??start)+direction*step,0,c.duration);if(end>start)safe(()=>core('selection.set',{clipId:c.id,start,end,channels:s?.channels||'all'},{quiet:true}));}updateClock();drawPlayhead();return;}
  const candidate=keySequence?`${keySequence} ${key}`:key;const macroMatches=macroPanel?.shortcutMatches(candidate)||[];const macroExact=macroMatches.find(item=>item.shortcut===candidate);if(macroExact){e.preventDefault();clearTimeout(keyTimer);keySequence='';safe(()=>commandRuntime.execute('macro.run',{id:macroExact.id},{origin:'shortcut'}));return;}const exact=[...actions.values()].find(a=>shortcutFor(a)===candidate);if(exact){e.preventDefault();clearTimeout(keyTimer);keySequence='';safe(()=>runAction(exact.id));return;}const prefix=macroMatches.some(item=>item.shortcut.startsWith(candidate+' '))||[...actions.values()].some(a=>shortcutFor(a).startsWith(candidate+' '));if(prefix){e.preventDefault();keySequence=candidate;clearTimeout(keyTimer);keyTimer=setTimeout(()=>{keySequence='';},1400);status(`Shortcut ${candidate.toUpperCase()} …`);}else keySequence='';});
document.addEventListener('click',e=>{const button=e.target.closest('[data-action]');if(button){e.preventDefault();safe(()=>runAction(button.dataset.action));}});
$$('[data-panel]').forEach(b=>b.addEventListener('click',()=>{discardPreview();if(b.dataset.panel==='effects'){activePanel='effects';updateTabs();queuePreview('rack',rackPanel.params());persistSettings();}else effectPanel.selectCategory(b.dataset.panel);}));
$('#theme-select').addEventListener('change',e=>safe(()=>core('ui.theme.set',{theme:e.target.value})));
$('#processing-mode').addEventListener('change',e=>safe(()=>core('ui.processing.set',{mode:e.target.value})));
$('#live-rack-target').addEventListener('change',e=>safe(()=>core('ui.liveTarget.set',{target:e.target.value})));
$('#legacy-project-input').addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';if(files.length)safe(()=>loadLegacyFolder(files));});
$('#midi-file-input').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(file)safe(()=>importFiles([file]));});
$('#reaper-project-input').addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';if(files.length)safe(()=>importFiles(files));});
$('#modal-close').onclick=closeModal;$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
$('#audio-input').addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';safe(()=>importFiles(files));});$('#project-input').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(file)safe(()=>importFiles([file]));});$('#settings-input').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(file)safe(async()=>{macroPanel?.assertInteractive();if(file.size>1024*1024)throw new Error('Settings file is too large.');const value=JSON.parse(await file.text());macroPanel?.assertInteractive();loadSettings(value);status('Settings restored from JSON.');if($('#modal').open)openSettings();});});
$('#project-name').addEventListener('change',e=>safe(()=>core('project.update',{name:e.target.value},{quiet:true})));$('#tempo').addEventListener('change',e=>safe(async()=>{await core('project.update',{bpm:+e.target.value});playback.setTempo(state.bpm,state.beatOffset,state.beatsPerBar);}));
$('#playback-rate').addEventListener('change',e=>safe(async()=>{await core('transport.set',{rate:+e.target.value});status('Audition speed changed. Export uses rendered edits; use Speed / varispeed to commit this change.');}));$('#clip-reset').onclick=()=>{$('.master-meter').classList.remove('clipping');$('#clip-label').textContent='CLEAR';};
async function selectionFromInputs(){if($('#channel-scope').value==='choose'){openChannelChooser();return;}const c=ensureClip();await core('selection.set',{clipId:c.id,start:+$('#selection-start').value,end:+$('#selection-end').value,channels:selectedChannelScope()},{quiet:true});status('Selection updated. Effect changes apply only to this region and channel scope.');}
for(const id of ['selection-start','selection-end','channel-scope'])$(`#${id}`).addEventListener('change',()=>safe(selectionFromInputs));
$('#view-scroll').addEventListener('input',e=>{view.start=(Math.max(state?.duration||0,view.duration)-view.duration)*(+e.target.value/1000);clampView();drawWaveforms();});$('#snap').addEventListener('change',persistSettings);$('#snap-grid').addEventListener('change',persistSettings);
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}});document.addEventListener('dragleave',e=>{if(--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true;}});document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;const files=[...e.dataTransfer.files];if(files.length)safe(()=>importFiles(files));});
const resize=new ResizeObserver(()=>{drawWaveforms();drawDetailView();effectPanel.redraw();});resize.observe($('.workbench'));
setCodecReporter(message=>{status(message);if($('#export-progress'))$('#export-progress').textContent=message;});
window.addEventListener('pagehide',()=>{stopRecordingStream();macroPanel?.cancel();void companion?.disconnect();void liveAudio?.dispose();playback.stop();creative.close();});
$('#modal').addEventListener('close',()=>{creative.learnTarget=null;});

function selectedChannelScope(){const value=$('#channel-scope').value;if(value.startsWith('indices:'))return value.slice(8).split(',').map(Number);return value;}
function channelScopeLabel(scope,clip=selectedClip()){if(scope==='all')return 'all channels';const labels=CHANNEL_LAYOUTS[clip?.layout||layoutForChannels(clip?.channels||2)]?.channels||[];try{return channelIndices(scope,clip?.channels||2).map(index=>labels[index]||`Channel ${index+1}`).join(', ');}catch{return 'selected channels';}}
function updateChannelScope(){const clip=selectedClip(),count=clip?.channels||2,labels=CHANNEL_LAYOUTS[clip?.layout||layoutForChannels(count)].channels,scope=state.selection?.channels||'all';let options='<option value="all">All channels</option>';
  for(let index=0;index<count;index++){const value=count===2?(index?'right':'left'):`indices:${index}`;options+=`<option value="${value}">${labels[index]} only</option>`;}
  if(Array.isArray(scope)&&scope.length>1)options+=`<option value="indices:${scope.join(',')}">${escapeHTML(channelScopeLabel(scope,clip))}</option>`;
  if(count>2)options+='<option value="choose">Choose channels…</option>';
  $('#channel-scope').innerHTML=options;$('#channel-scope').value=Array.isArray(scope)?scope.length===1&&count===2?(scope[0]?'right':'left'):`indices:${scope.join(',')}`:scope;
}
function openChannelChooser(){const clip=ensureClip(),audio=audioById.get(clip.id),count=audio.channels.length,labels=CHANNEL_LAYOUTS[audio.layout||layoutForChannels(count)].channels,selected=channelIndices(state.selection?.channels||'all',count);openModal('Choose editing channels',`<p>Only checked channels are changed by a selection edit. Speaker order and other channel samples are preserved.</p><div class="form-grid">${labels.map((label,index)=>`<label class="checkbox-field"><input data-edit-channel="${index}" type="checkbox"${selected.includes(index)?' checked':''}>${index}: ${label}</label>`).join('')}</div><div class="modal-actions"><button id="channel-choose-cancel">Cancel</button><button id="channel-choose-apply" class="primary">Use these channels</button></div>`,()=>{$('#channel-choose-cancel').onclick=()=>{closeModal();updateChannelScope();};$('#channel-choose-apply').onclick=()=>safe(async()=>{const channels=$$('[data-edit-channel]:checked').map(input=>+input.dataset.editChannel);if(!channels.length)throw new Error('Choose at least one channel.');await core('selection.set',{clipId:clip.id,start:state.selection?.start||0,end:state.selection?.end??clip.duration,channels:channels.length===count?'all':channels},{quiet:true});closeModal();});});}
function getLiveTarget(){return liveRackTarget==='master'?'master':{trackId:liveRackTarget.slice(6)};}
function liveTargetKey(target){return target&&typeof target==='object'?`track:${target.trackId}`:'master';}
function currentLiveRack(target=getLiveTarget()){return liveAudio?.getState().racks?.find(rack=>liveTargetKey(rack.target)===liveTargetKey(target));}
function updateRackModeUI(){const live=processingMode==='live';$('#processing-mode').value=processingMode;$('#processing-mode-bar').hidden=activePanel!=='effects';$('#live-rack-target-label').hidden=!live;$('#live-automation-link').hidden=!live;$('#processing-mode-note').textContent=live?'Live controls update the audio clock while playback continues. Export explicitly to render live settings.':'Preview a selection, compare, then Apply to commit.';const previewControls=$('.preview-controls');previewControls.hidden=live&&activePanel==='effects';const targets=$('#live-rack-target');targets.innerHTML='<option value="master">Master program</option>'+state.tracks.map(track=>`<option value="track:${escapeHTML(track.id)}">${escapeHTML(track.name)}</option>`).join('');if(liveRackTarget!=='master'&&!state.tracks.some(track=>`track:${track.id}`===liveRackTarget)){liveRackTarget='master';pendingRackUpdate=null;liveRackRevision++;if(live)rackPanel.load({chain:currentLiveRack('master')?.chain||[]});}targets.value=liveRackTarget;const help=$('#rack-xy-help');if(help)help.textContent=live?'Drag the pad, use arrow keys, or adjust the sliders. Live changes keep transport running.':'Drag the pad, use arrow keys, or adjust the sliders. Changes render a preview; Apply keeps the result.';}
async function setProcessingMode(mode,{notify=true}={}){if(!['selection','live'].includes(mode))throw new Error('Choose Selection or Live processing.');if(mode===processingMode){updateRackModeUI();return;}
  const previous={mode:processingMode,offlineRack,rack:rackPanel.save(),activePanel};discardPreview();pendingRackUpdate=null;liveRackRevision++;
  try{if(mode==='live'){offlineRack=rackPanel.save();processingMode='live';const current=currentLiveRack();if(current)rackPanel.load({chain:current.chain});else if(notify)await core('live.rack.set',{target:getLiveTarget(),chain:rackPanel.params().chain});liveRackChain=clone(rackPanel.params().chain);}
  else{processingMode='selection';if(offlineRack)rackPanel.load(offlineRack);offlineRack=null;}
  activePanel='effects';updateTabs();updateRackModeUI();persistSettings();}catch(error){processingMode=previous.mode;offlineRack=previous.offlineRack;activePanel=previous.activePanel;rackPanel.load(previous.rack);updateTabs();updateRackModeUI();throw error;}
}
async function setLiveTarget(target){if(target!=='master'&&(!target.startsWith('track:')||!state.tracks.some(track=>track.id===target.slice(6))))throw new Error('Choose an available live rack target.');liveRackTarget=target;liveRackRevision++;if(processingMode!=='live')await setProcessingMode('live');rackPanel.load({chain:currentLiveRack()?.chain||[]});liveRackChain=clone(rackPanel.params().chain);updateRackModeUI();}
let pendingRackUpdate=null,rackUpdatePromise=null;
async function updateLiveRack(chain){pendingRackUpdate={chain:clone(chain),target:getLiveTarget(),revision:liveRackRevision};if(rackUpdatePromise)return rackUpdatePromise;
  rackUpdatePromise=(async()=>{while(pendingRackUpdate){const update=pendingRackUpdate;pendingRackUpdate=null;if(update.revision!==liveRackRevision||processingMode!=='live')continue;const previous=currentLiveRack(update.target)?.chain||[],current=()=>update.revision===liveRackRevision&&processingMode==='live';
    try{const structural=previous.length!==update.chain.length||update.chain.some((stage,index)=>stage.id!==previous[index]?.id||stage.effect!==previous[index]?.effect||stage.enabled!==previous[index]?.enabled||Object.entries(stage.params).some(([key,value])=>typeof value==='string'&&value!==previous[index]?.params[key]));
      if(structural)await core('live.rack.set',{target:update.target,chain:update.chain});else parameterUpdates:for(let index=0;index<update.chain.length;index++){const next=update.chain[index],before=previous[index];for(const [param,value] of Object.entries({wet:next.wet,...next.params})){if(!current())break parameterUpdates;if(value!==(param==='wet'?before.wet:before.params[param]))await core('live.param.set',{target:update.target,slotId:next.id,param,value,rampMs:10});}}
      if(current())liveRackChain=clone(update.chain);
    }catch(error){if(current()){pendingRackUpdate=null;rackPanel.load({chain:currentLiveRack(update.target)?.chain||previous});updateRackModeUI();}throw error;}
  }})().finally(()=>{rackUpdatePromise=null;});return rackUpdatePromise;
}
async function getProjectSnapshot(trackId){const project=await engine.execute(trackId?'project.saveTrack':'project.save',trackId?{trackId}:{});const live=liveAudio?.getSettings();if(live&&trackId)live.racks=Object.fromEntries(Object.entries(live.racks).filter(([id])=>id==='master'||id===trackId));project.settings={...project.settings,ui:portableSettings(),...(live?{live}: {})};return project;}
async function refreshLiveProject(){if(liveRefreshPending)return;liveRefreshPending=true;try{state=engine.getState();audioById.clear();await refreshAudio();renderSession();scheduleRecovery();}finally{liveRefreshPending=false;}}
async function exportRecording(params){macroPanel?.assertInteractive();if(window.showSaveFilePicker){const handle=await window.showSaveFilePicker({suggestedName:`${filename(params.recordingId)}.wav`,types:[{description:'WAV / RF64 audio',accept:{'audio/wav':['.wav']}}]});macroPanel?.assertInteractive();liveAudio.setExportDestination(handle);}const result=await core('recordings.export',params);if(result?.bytes)download(result.bytes,`${filename(params.recordingId)}.${result.ext||'wav'}`,result.mime||'audio/wav');return result;}
function interactive(operation){macroPanel?.assertInteractive();return operation();}
const batchNavigationActions=new Set(['commands','macros','performance','options','settings','help','api','panel.midi','panel.projects','panel.keys','panel.metadata','track.settings','panel.edit','shortcuts','view.zoomIn','view.zoomOut','view.fit','view.zoomSelection','view.selection','view.spectrum','view.scope']);
function gateBatchUI(event){if(!macroPanel?.isBatchRunning())return;const target=event.target;if(event.type==='keydown'&&(['Tab','Escape'].includes(event.key)||(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'))return;if(target.closest?.('a[href],[data-view-close],[data-view-back],[data-macro-stop],[data-batch-cancel],[data-batch-progress],#modal-close,#command-search,[data-command-id],#help-search,#view-scroll'))return;const action=target.closest?.('[data-action]')?.dataset.action;if(action&&batchNavigationActions.has(action))return;if(!target.closest?.('button,input,select,textarea,canvas,[tabindex],[draggable]')&&event.type!=='keydown'&&event.type!=='drop')return;event.preventDefault();event.stopImmediatePropagation();if(['click','keydown','beforeinput','change','drop'].includes(event.type))status('A batch is using this session. Stop the batch or wait for restoration before making changes.',true);}
function setBatchActivity(active){$('#batch-ownership-banner').hidden=!active;document.body.dataset.batchBusy=String(active);if(active){clearTimeout(recoveryTimer);rackPanel.cancelGesture();for(const canvas of $$('.track-waveform'))canvas.dispatchEvent(new Event('pointercancel'));pendingRackUpdate=null;liveRackRevision++;stopRecordingStream();creative.stop();discardPreview();}else{persistSettings();scheduleRecovery();}}
function registerWorkbenchCommand(method,label,schema,handler,{recordable=true,category='Workbench',replace=false}={}){commandRuntime.register({method,id:method,label,description:label,category,schema,recordable,capabilities:['browser'],undoable:false},handler,{replace});}
function initializeWorkbench(){
  routes=new WorkbenchRoutes({onError:error=>safe(()=>Promise.reject(error))});
  commandRuntime=new CommandRuntime({coreExecute:coreRaw,coreCommands:registry,getState:()=>state});
  liveAudio=new LiveAudioRuntime({engine,playback});liveAudio.setMidiPanic(()=>creative.sampler.stop());creative.sampler.setAudioRoute(liveAudio.midiRoute());
  companion=new CompanionBridge({live:liveAudio});
  const liveCapabilities=liveAudio.capabilities();
  for(const descriptor of LIVE_COMMANDS)commandRuntime.register({...descriptor,available:descriptor.capabilities.every(key=>liveCapabilities[key]!==false)},async(params,context)=>{const result=await liveAudio.execute(descriptor.method,params,context);if(/^(loop\.(capture\.(stop|toggle)|track\.remove)|recordings\.importRange)$/.test(descriptor.method))await refreshLiveProject();if(descriptor.method==='transport.set'){state=engine.getState();$('#tempo').value=state.bpm;$('#playback-rate').value=String(liveAudio.getState().transport.rate);updateClock();drawWaveforms();scheduleRecovery();}return result;});
  for(const descriptor of COMPANION_COMMANDS)commandRuntime.register(descriptor,(params,context)=>companion.execute(descriptor.method,params,context));
  fileIO=new BrowserFileIO({getState:()=>state,getProject:getProjectSnapshot,executeCore:coreRaw,executeLive:(method,params,context)=>commandRuntime.execute(method,params,{...context,origin:'internal',record:false}),importOne,download});fileIO.register(commandRuntime);
  macroPanel=new MacroPanel({runtime:commandRuntime,routes,fileIO,getState:()=>state,getProject:getProjectSnapshot,restoreProject:loadProject,executeCore:coreRaw,persist:()=>persistSettings(),download,safe,isReservedShortcut:key=>[...actions.values()].some(action=>shortcutFor(action)===key),onBatchState:setBatchActivity,teardown:async()=>{await liveAudio.resetProject();await companion.disconnect();}});macroPanel.register();
  creative.isBatchRunning=()=>macroPanel.isBatchRunning();
  for(const event of ['pointerdown','click','beforeinput','input','change','keydown','drop'])document.addEventListener(event,gateBatchUI,true);$('#batch-ownership-banner [data-batch-cancel]').onclick=()=>macroPanel.cancel();$('#batch-ownership-banner [data-batch-progress]').onclick=()=>macroPanel.open('batch');
  creative.execute=(method,params={},context={})=>commandRuntime.execute(method,params,{origin:'ui',...context});creative.runMacro=(id,context)=>macroPanel.runSaved(id,context);creative.getCommands=()=>commandRuntime.commands();creative.getMacros=()=>macroPanel.settings.macros;creative.openMidiRoute=()=>optionsPanel.open('midi');
  exportPanel=new ExportPanel({getState:()=>state,execute:core,openModal,closeModal,editMetadata:()=>creative.openMetadata(),status,safe});
  const companionPanel=new CompanionPanel({bridge:companion,execute:core,safe});
  optionsPanel=new OptionsPanel({routes,creative,getState:()=>state,getLiveState:()=>liveAudio.getState(),subscribeLive:callback=>liveAudio.subscribe(callback),execute:core,safe,getTheme:()=>settings.theme||'studio',getPreferences:()=>settings.workbench||normalizeWorkbenchPreferences(),updatePreferences:value=>{settings.workbench=normalizeWorkbenchPreferences(value);guidance.setEnabled(settings.workbench.tooltips);persistSettings();},getActions:()=>[...actions.values()].map(action=>({...action,shortcut:shortcutFor(action)})),saveShortcuts:value=>{const prepared=validateSettings({...portableSettings(),shortcuts:value});for(const macro of macroPanel.settings.macros)if(macro.shortcut&&Object.values(prepared.nextShortcuts).includes(macro.shortcut))throw new Error('A shortcut is already assigned to a macro.');settings.shortcuts=prepared.nextShortcuts;persistSettings();},saveSettings:()=>download(portableSettings(),'websoundedit-settings.json'),loadSettings:()=>$('#settings-input').click(),clearRecovery:()=>core('ui.recovery.clear'),renderStreaming:container=>companionPanel.render(container)});
  helpPanel=new HelpUI({routes,getCommands:()=>commandRuntime.commands()});
  performancePanel=new PerformancePanel({routes,getState:()=>state,getLiveState:()=>liveAudio.getState(),subscribeLive:callback=>liveAudio.subscribe(callback),execute:core,safe,exportRecording});
  const empty={type:'object',additionalProperties:false},object=properties=>({type:'object',properties,additionalProperties:false});
  for(const action of actions.values())registerWorkbenchCommand(`ui.${action.id}`,action.label,empty,()=>action.run(),{recordable:false,category:'Navigation'});
  registerWorkbenchCommand('ui.options','Open Options',object({page:{type:'string',maxLength:40}}),params=>optionsPanel.open(params.page||'general'),{recordable:false,replace:true});
  registerWorkbenchCommand('ui.macros','Open macro editor',object({page:{type:'string',maxLength:40}}),params=>macroPanel.open(params.page||'editor'),{recordable:false,replace:true});
  registerWorkbenchCommand('ui.performance','Open live performance',object({page:{type:'string',maxLength:40}}),params=>performancePanel.open(params.page||'loops'),{recordable:false,replace:true});
  registerWorkbenchCommand('ui.help','Open the workbench guide',object({chapter:{type:'string',maxLength:40}}),params=>helpPanel.open(params.chapter||'navigation'),{recordable:false,replace:true});
  registerWorkbenchCommand('ui.file.export','Open export options',object({scope:{enum:['mix','track','clip','selection','stems']},trackId:{type:'string'},format:{type:'string'}}),params=>exportPanel.open(params),{recordable:false,replace:true});
  registerWorkbenchCommand('ui.play','Audition the requested scope with its current preview',object({scope:{enum:['mix','clip','selection']}}),params=>play(params.scope||'mix'),{recordable:false});
  registerWorkbenchCommand('ui.recovery.clear','Clear the local editor recovery snapshot',empty,async()=>{clearTimeout(recoveryTimer);await clearRecovery();return {cleared:true};},{recordable:false});
  registerWorkbenchCommand('ui.effect','Choose a selection effect',object({effect:{enum:Object.keys(EFFECT_UI)}}),params=>showEffect(params.effect),{recordable:false});
  registerWorkbenchCommand('view.zoomSelection','Zoom to the selected region without changing it',empty,()=>{zoom(1,true);return clone(view);});
  registerWorkbenchCommand('view.zoom','Zoom around the cursor',object({factor:{type:'number',minimum:.01,maximum:100}}),params=>{zoom(params.factor||1);return clone(view);});
  registerWorkbenchCommand('view.fit','Fit the project in the waveform view',empty,()=>{fitView();return clone(view);});
  registerWorkbenchCommand('ui.theme.set','Change the workbench theme',object({theme:{enum:Object.keys(THEMES)}}),params=>{settings.theme=applyTheme(params.theme);persistSettings();renderSession();const select=$('#options-theme');if(select)select.value=settings.theme;return {theme:settings.theme};});
  registerWorkbenchCommand('ui.tooltips.set','Enable or disable feature guidance',object({enabled:{type:'boolean'}}),params=>{settings.workbench={...normalizeWorkbenchPreferences(settings.workbench),tooltips:params.enabled!==false};guidance.setEnabled(settings.workbench.tooltips);persistSettings();return {enabled:settings.workbench.tooltips};});
  registerWorkbenchCommand('ui.importLayout.set','Declare the speaker layout for manual file imports',object({layout:{enum:['auto','5.1','7.1']}}),params=>{settings.workbench=normalizeWorkbenchPreferences({...settings.workbench,import:{layout:params.layout||'auto'}});persistSettings();const select=$('#options-import-layout');if(select)select.value=settings.workbench.import.layout;return clone(settings.workbench.import);},{recordable:false});
  registerWorkbenchCommand('ui.processing.set','Choose selection or live rack control',object({mode:{enum:['selection','live']}}),params=>setProcessingMode(params.mode),{recordable:false});
  registerWorkbenchCommand('ui.liveTarget.set','Choose the live rack target',object({target:{type:'string',maxLength:240}}),params=>setLiveTarget(params.target),{recordable:false});
  registerWorkbenchCommand('midi.connect','Connect MIDI devices',empty,()=>creative.midi.connect(),{recordable:false,category:'MIDI'});
  registerWorkbenchCommand('midi.disconnect','Disconnect MIDI devices',empty,()=>{creative.stop();creative.midi.disconnect();creative.learnTarget=null;return creative.midi.ports();},{recordable:false,category:'MIDI'});
  registerWorkbenchCommand('midi.panic','Stop MIDI notes and cancel capture',empty,async()=>{creative.stop();await liveAudio.execute('loop.capture.cancel',{});return {stopped:true};},{category:'MIDI'});
  const saveDescriptor=commandRuntime.commands().find(item=>item.method==='project.save');commandRuntime.register(saveDescriptor,()=>getProjectSnapshot(),{replace:true});
  const loadDescriptor=commandRuntime.commands().find(item=>item.method==='project.load');commandRuntime.register(loadDescriptor,params=>loadProject(params.project),{replace:true});
  guidance=new GuidanceUI({enabled:settings.workbench?.tooltips!==false,getCommand:method=>commandRuntime.commands().find(item=>item.method===method||item.method===`ui.${method}`)});
  liveAudio.subscribe(event=>{const live=liveAudio.getState();if(event.type==='error')status(event.message||event.error?.message||'Live audio reported an error.',true);if(event.type==='capture'&&event.trackId)void safe(refreshLiveProject);if(event.type==='state'&&live.transport){if(/^transport\./.test(event.method||'')){cursor=live.transport.position;loop=live.transport.loop;metronome=live.transport.metronome;$('#loop-button').setAttribute('aria-pressed',String(loop));$('#metronome-button').setAttribute('aria-pressed',String(metronome));updateClock();drawPlayhead();}$('#play-button').textContent=live.transport.playing?'Ⅱ':'▶';$('#play-button').classList.toggle('playing',live.transport.playing);}});
}

const api={version:'1.0.0-beta.1',ready:null,
  execute:async(method,params={})=>{await api.ready;return commandRuntime.execute(method,params,{origin:'api'});},
  commands:()=>({core:clone(registry),ui:[...actions.values()].map(({id,label})=>({method:`ui.${id}`,description:label,shortcut:shortcutFor(actions.get(id))})),all:commandRuntime?.commands()||[]}),
  commandCatalog:()=>commandRuntime?.commands()||[],

  getState:()=>state?clone(state):null,
  importFile:async(file,options={})=>{await api.ready;const [input]=fileIO.supply([file],{append:true});const result=await commandRuntime.execute('file.import',{...options,input:input.id},{origin:'api'});demo=false;fitView();renderSession();return result;},
  exportAudio:async(options={})=>{await api.ready;return exportAudio(options);},
  saveProject:async({download:save=true}={})=>{await api.ready;return commandRuntime.execute(save?'ui.project.save':'project.save',{},{origin:'api'});},
  loadProject:async(project)=>{await api.ready;return commandRuntime.execute('project.load',{project},{origin:'api'});},
  saveSettings:()=>portableSettings(),loadSettings:value=>interactive(()=>loadSettings(value)),
  play:async({scope='mix'}={})=>{await api.ready;return commandRuntime.execute('ui.play',{scope},{origin:'api'});},pause:()=>core('transport.pause'),stop:()=>core('transport.stop'),
  setMetronome:enabled=>{macroPanel?.assertInteractive();metronome=Boolean(enabled);$('#metronome-button').setAttribute('aria-pressed',String(metronome));playback.setMetronome(metronome);},
  setLoop:enabled=>{macroPanel?.assertInteractive();loop=Boolean(enabled);$('#loop-button').setAttribute('aria-pressed',String(loop));playback.setLoop(loop);},
  setPlaybackRate:rate=>{macroPanel?.assertInteractive();if(!Number.isFinite(rate)||rate<.5||rate>2)throw new Error('Playback rate must be between 0.5 and 2.');let option=[...$('#playback-rate').options].find(o=>+o.value===rate);if(!option){option=new Option(`${rate}×`,String(rate));$('#playback-rate').add(option);}$('#playback-rate').value=String(rate);playback.setRate(rate);},
  startRecording:()=>core('ui.record'),stopRecording:()=>interactive(stopRecording),
  loadCodecs,codecCapabilities,previewEffect:(effect,params)=>{macroPanel?.assertInteractive();if(!Object.hasOwn(EFFECT_UI,effect))throw new Error('Unknown effect.');effectPanel.load({[effect]:{...effectPanel.values[effect],...params}});showEffect(effect);},
  rack:{get:()=>rackPanel.save(),load:value=>{macroPanel?.assertInteractive();rackPanel.load(value);activePanel='effects';updateTabs();if(processingMode==='live')void safe(()=>updateLiveRack(rackPanel.params().chain));else queuePreview();persistSettings();},add:effect=>interactive(()=>rackPanel.add(effect)),move:(id,index)=>interactive(()=>rackPanel.move(id,index)),setParameter:(id,key,value)=>interactive(()=>rackPanel.setParameter(id,key,value))},
  midi:{importFile:file=>api.importFile(file),export:options=>interactive(()=>creative.exportMidi(options)),connect:()=>core('midi.connect'),disconnect:()=>interactive(()=>{creative.stop();creative.midi.disconnect();})},
  exportAudacity:(format='aup3',options={})=>core('file.export',{...options,format,scope:'mix'}),
  inputs:{supply:(files,options)=>fileIO.supply(files,options),list:()=>fileIO.aliases()},live:{getState:()=>liveAudio.getState()},macros:{get:()=>macroPanel.save(),run:(text,variables)=>commandRuntime.execute('macro.run',{text,variables:variables||{}},{origin:'api'}),cancel:()=>macroPanel.cancel()},
  clearRecovery:()=>core('ui.recovery.clear'),view:{fit:()=>core('view.fit'),zoomIn:()=>core('view.zoom',{factor:2}),zoomOut:()=>core('view.zoom',{factor:.5}),zoomSelection:()=>core('view.zoomSelection')}
};
window.websoundedit=api;
async function boot(){registry=await engine.commands();state=engine.getState();initializeWorkbench();drawMeter();let recovery=null;try{recovery=await loadRecovery();}catch{}if(recovery){try{await core('project.load',{project:recovery},{quiet:true});demo=false;fitView();status('Recovered your previous session from this browser. Save a project JSON for a portable copy.');if(state.settings?.ui)settings={...settings,...state.settings.ui};}catch(error){status(`Recovery could not be restored: ${error.message}`,true);await loadDemo();}}else await loadDemo();try{loadSettings(settings);}catch(error){settings={format:'websoundedit-ui-settings',version:1,effects:{},shortcuts:{},snap:false,grid:.25,theme:'studio',inspectorCollapsed:false};loadSettings(settings);status('Saved workbench preferences were invalid. Default preferences have been restored.',true);}initialising=false;renderSession();effectPanel.redraw();for(const button of $$('[data-action]')){const action=actions.get(button.dataset.action);if(action&&!button.title)button.title=`${action.label} · ${shortcutFor(action)}`;}await routes.render();return true;}
api.ready=boot().catch(error=>{status(`The editor could not start: ${error.message}`,true);console.error(error);throw error;});
