import { drawEQ, drawDuck } from './visuals.js';
import { duckEnvelope } from './dsp.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const field=(key,label,min,max,step,unit='',extra={})=>({key,label,min,max,step,unit,...extra});
export const EFFECT_UI = {
  gain:{title:'Gain',category:'shape',description:'Adjust the amplitude of the selected channel or region. Float audio retains headroom until export.',defaults:{db:0},fields:[field('db','Gain',-36,24,0.1,'dB')]},
  pitch:{title:'Pitch shift',category:'shape',description:'Transpose notes without changing duration. The spectrum reveals frequency movement even when the overall waveform envelope stays similar.',defaults:{semitones:0,preserveDuration:true},fields:[field('semitones','Transpose',-12,12,0.1,'st')]},
  stretch:{title:'Time stretch',category:'shape',description:'Change duration while preserving pitch. 1.5× makes the selection 50% longer. Adjacent clips stay in place.',defaults:{ratio:1,preservePitch:true},fields:[field('ratio','Duration multiplier',0.5,2,0.01,'×')]},
  speed:{title:'Speed / varispeed',category:'shape',description:'Change speed and pitch together, like changing tape speed. For independent duration control choose Time stretch.',defaults:{rate:1},fields:[field('rate','Speed',0.5,2,0.01,'×')]},
  fadeIn:{title:'Fade in',category:'shape',description:'Smooth the beginning of the selected region. The rest of the clip stays intact.',defaults:{duration:0.1},fields:[field('duration','Fade length',0,5,0.01,'s')]},
  fadeOut:{title:'Fade out',category:'shape',description:'Smooth the end of the selected region. Use a short fade to tame an abrupt edit.',defaults:{duration:0.1},fields:[field('duration','Fade length',0,5,0.01,'s')]},
  reverse:{title:'Reverse',category:'shape',description:'Reverse samples only inside the selected region. Duration and clip placement are preserved.',defaults:{},fields:[]},
  phase:{title:'Phase / sample alignment',category:'shape',description:'Shift samples within the selection. Choose Left or Right to align stereo channels. A time delay produces a frequency-dependent phase shift.',defaults:{delayMs:0},fields:[field('delayMs','Delay / advance',-50,50,0.01,'ms')]},
  invert:{title:'Invert polarity',category:'shape',description:'Flip positive and negative sample values. Choose one channel for polarity correction; use Phase for time alignment.',defaults:{},fields:[]},
  pan:{title:'Render panning',category:'shape',description:'Bake stereo placement into the selected audio. Track pan faders remain available for reversible mix placement.',defaults:{pan:0},fields:[field('pan','Pan',-1,1,0.01,'L ↔ R')]},
  eq:{title:'Parametric EQ',category:'eq',description:'Four independently adjustable filters. Drag a node for frequency and gain, or type precise values below.',defaults:{bands:[{type:'highpass',frequency:30,gainDb:0,q:0.707,enabled:false},{type:'peaking',frequency:250,gainDb:0,q:1,enabled:true},{type:'peaking',frequency:2000,gainDb:0,q:1,enabled:true},{type:'highshelf',frequency:8000,gainDb:0,q:0.707,enabled:true}]},fields:[]},
  compressor:{title:'Compressor',category:'dynamics',description:'Control dynamics with a stereo-linked detector, a soft knee, and independent attack and release.',defaults:{thresholdDb:-18,ratio:4,attackMs:10,releaseMs:120,kneeDb:6,makeupDb:0},fields:[field('thresholdDb','Threshold',-60,0,0.5,'dB'),field('ratio','Ratio',1,20,0.1,':1'),field('attackMs','Attack',0,200,1,'ms'),field('releaseMs','Release',5,1000,5,'ms'),field('kneeDb','Knee',0,24,0.5,'dB'),field('makeupDb','Makeup',-12,24,0.5,'dB')]},
  limiter:{title:'Peak limiter',category:'dynamics',description:'Lookahead limiting controls sample peaks. This is a sample-peak limiter, not a true-peak loudness meter.',defaults:{ceilingDb:-1,releaseMs:60,lookaheadMs:5},fields:[field('ceilingDb','Ceiling',-24,0,0.1,'dBFS'),field('releaseMs','Release',1,500,1,'ms'),field('lookaheadMs','Lookahead',0,20,0.5,'ms')]},
  normalize:{title:'Peak normalize',category:'dynamics',description:'Set the highest sample peak to a target while preserving dynamics. Linked channels keep their balance. This does not target LUFS.',defaults:{targetDb:-1},fields:[field('targetDb','Target peak',-36,0,0.1,'dBFS')]},
  duck:{title:'Sidechain / rhythmic gate',category:'rhythm',description:'Draw your gain envelope, from gentle pumping to a hard gate. Choose an audio track for signal-triggered sidechain detection.',defaults:{source:'tempo',mode:'volume',depth:0.8,rate:1,attack:0.01,hold:0.1,release:0.75,curve:2,thresholdDb:-24,ratio:6,attackMs:2,releaseMs:150},fields:[field('depth','Depth',0,1,0.01),field('rate','Beats per cycle',0.125,8,0.125),field('attack','Envelope attack',0,0.4,0.01,'cycle'),field('hold','Envelope hold',0,0.8,0.01,'cycle'),field('release','Envelope release',0.01,1,0.01,'cycle'),field('curve','Curve',0.2,6,0.1)]},
  loop:{title:'Loop repeat',category:'rhythm',description:'Repeat the selected region in place. For a new loop track use Loop studio. Overlap crossfades shorten each join; use 0 ms for beat-exact repeats.',defaults:{repeats:4,crossfadeMs:0},fields:[field('repeats','Repetitions',1,32,1),field('crossfadeMs','Join crossfade',0,100,1,'ms')]},
  beatRepeat:{title:'Beat rearranger',category:'rhythm',description:'Slice the selected audio into beat subdivisions and play them in your chosen order. Slice indexes start at 0; every index must exist in the selection.',defaults:{division:4,pattern:[0,1,2,3,0,0,2,3]},fields:[field('division','Slices per beat',1,16,1),{key:'pattern',label:'Slice pattern (zero-based)',type:'pattern'}]},
  removeSilence:{title:'Remove silence',category:'tools',description:'Find quiet regions across all channels, then close the gaps. Padding preserves material around each cut. Detect first to inspect the regions.',defaults:{thresholdDb:-45,minDuration:0.25,padding:0.02},fields:[field('thresholdDb','Silence threshold',-90,-6,1,'dB'),field('minDuration','Minimum quiet time',0.01,3,0.01,'s'),field('padding','Retained edge padding',0,0.25,0.005,'s')]},
  silence:{title:'Silence selection',category:'tools',description:'Replace selected samples with zero without moving the remaining audio.',defaults:{},fields:[]},
  dcRemove:{title:'Remove DC offset',category:'tools',description:'Center the selected samples around zero. This can recover headroom before normalization.',defaults:{},fields:[]},
  mono:{title:'Convert to mono',category:'tools',description:'Average the left and right channels. Select the whole clip and Both channels to change the channel layout.',defaults:{},fields:[]},
  swap:{title:'Swap left / right',category:'tools',description:'Exchange stereo channels. Use Both channels for this channel-layout operation.',defaults:{},fields:[]},
  granular:{title:'Granular texture',category:'tools',description:'Scatter overlapping grains into a new texture. The seed makes every result repeatable; freeze holds grains near one position.',defaults:{grainMs:80,density:6,spread:0.35,seed:42,mix:0.65,freeze:false,position:0.5},fields:[field('grainMs','Grain size',5,300,1,'ms'),field('density','Grain overlap',1,12,1),field('spread','Scatter',0,1,0.01),field('mix','Wet / dry',0,1,0.01),field('seed','Seed',0,99999,1),field('position','Freeze position',0,1,0.01)]}
};
export class EffectPanel {
  constructor(container,{onChange,getTracks,getSampleRate}) {this.el=container;this.onChange=onChange;this.getTracks=getTracks;this.getSampleRate=getSampleRate;this.effect='pitch';this.values=Object.fromEntries(Object.entries(EFFECT_UI).map(([id,e])=>[id,clone(e.defaults)]));this.eqBand=1;this.drawState=null;this.render();}
  params(){return clone(this.values[this.effect]);}
  choose(effect,{notify=true}={}){if(!Object.hasOwn(EFFECT_UI,effect))throw new Error('Unknown effect.');this.effect=effect;this.render();if(notify)this.onChange(this.effect,this.params());return EFFECT_UI[effect].category;}
  selectCategory(category){this.choose(Object.keys(EFFECT_UI).find(id=>EFFECT_UI[id].category===category));}
  load(values,{validateOnly=false}={}){
    if(values!==undefined&&(!values||typeof values!=='object'||Array.isArray(values)))throw new Error('Effect settings must be an object.');
    const next=clone(this.values);
    for(const [id,value] of Object.entries(values||{})){
      if(!Object.hasOwn(EFFECT_UI,id))continue;
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid ${id} settings.`);
      const base=clone(EFFECT_UI[id].defaults);
      for(const [key,v] of Object.entries(value)){
        if(key==='points'&&id==='duck'){
          if(!Array.isArray(v)||v.length<2||v.length>32||v.some((p,i)=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1||(i&&p.x<=v[i-1].x)))throw new Error('Invalid ducking curve points.');
          base.points=v.map(p=>({x:p.x,y:p.y}));continue;
        }
        if(key==='sourceTrackId'&&id==='duck'){
          if(v!==null&&(typeof v!=='string'||v.length>100))throw new Error('Invalid sidechain track.');base[key]=v;continue;
        }
        if(!Object.hasOwn(base,key))continue;
        if(key==='bands'){
          if(!Array.isArray(v)||v.length!==4)throw new Error('EQ settings need four bands.');
          base.bands=v.map(b=>{
            if(!b||!['peaking','highpass','lowpass','lowshelf','highshelf'].includes(b.type)||typeof b.enabled!=='boolean'||!Number.isFinite(b.frequency)||b.frequency<20||b.frequency>20000||!Number.isFinite(b.gainDb)||Math.abs(b.gainDb)>18||!Number.isFinite(b.q)||b.q<.1||b.q>12)throw new Error('Invalid EQ band settings.');
            return {type:b.type,enabled:b.enabled,frequency:b.frequency,gainDb:b.gainDb,q:b.q};
          });continue;
        }
        if(key==='pattern'){
          if(!Array.isArray(v)||!v.length||v.length>512||v.some(n=>!Number.isInteger(n)||n<0||n>100000))throw new Error('Invalid beat pattern.');base.pattern=[...v];continue;
        }
        const kind=typeof base[key];
        if(typeof v!==kind||kind==='number'&&!Number.isFinite(v))throw new Error(`Invalid ${id}.${key} setting.`);
        const f=EFFECT_UI[id].fields.find(f=>f.key===key);
        if(f&&kind==='number'&&(v<f.min||v>f.max))throw new Error(`${id}.${key} is outside its supported range.`);
        if(key==='source'&&!['tempo','track'].includes(v)||key==='mode'&&!['volume','compressor'].includes(v))throw new Error('Invalid ducking mode.');
        base[key]=v;
      }
      next[id]=base;
    }
    if(validateOnly)return next;
    this.values=next;this.render();
  }
  changed(){this.redraw();this.onChange(this.effect,this.params());}
  fieldHTML(f,values,prefix=''){const value=values[f.key];if(f.type==='pattern')return `<label class="control"><span class="control-heading">${f.label}</span><input type="text" data-key="${prefix}${f.key}" data-type="pattern" value="${(value||[]).join(', ')}" aria-label="${f.label}"></label>`;return `<div class="control"><label class="control-heading" for="effect-${prefix}${f.key}"><span>${f.label}<small>${f.unit||''}</small></span><input id="effect-${prefix}${f.key}" type="number" data-key="${prefix}${f.key}" value="${value}" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${f.label}"></label><input type="range" data-key="${prefix}${f.key}" value="${value}" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${f.label} slider"><div class="control-ticks"><span>${f.min}${f.unit?' '+f.unit:''}</span><span>${f.max}${f.unit?' '+f.unit:''}</span></div></div>`;}
  render(){const current=EFFECT_UI[this.effect],values=this.values[this.effect];
    this.el.innerHTML=`<label class="effect-selector">PROCESSOR<select id="effect-select" aria-label="Effect">${Object.entries(EFFECT_UI).filter(([,e])=>e.category===current.category).map(([id,e])=>`<option value="${id}" ${id===this.effect?'selected':''}>${e.title}</option>`).join('')}</select></label><p class="effect-note">${current.description}</p>${this.effect==='eq'?this.eqHTML():this.effect==='duck'?this.duckHTML():''}<div class="effect-fields">${current.fields.map(f=>this.fieldHTML(f,values)).join('')}</div>${this.effect==='granular'?`<label class="control checkbox-field"><input type="checkbox" data-key="freeze" ${values.freeze?'checked':''}> Freeze grains at position</label>`:''}${this.effect==='stretch'?'<div class="inline-buttons"><button data-action="tempo.match">Match selection to project BPM</button></div>':''}${this.effect==='removeSilence'?'<div class="inline-buttons"><button data-action="analysis.silence">Detect regions first</button></div>':''}`;
    this.el.querySelector('#effect-select').addEventListener('change',e=>this.choose(e.target.value));
    this.el.querySelectorAll('[data-key]').forEach(input=>{input.addEventListener(input.tagName==='SELECT'||input.type==='checkbox'?'change':'input',e=>{const key=input.dataset.key;let value;if(input.type==='checkbox')value=input.checked;else if(input.dataset.type==='pattern'){value=input.value.split(/[,\s]+/).filter(Boolean).map(Number);if(value.some(v=>!Number.isInteger(v)))return;}else if(input.tagName==='SELECT')value=input.value;else {value=+input.value;if(input.value===''||!Number.isFinite(value))return;if(input.min!==''&&value<+input.min||input.max!==''&&value>+input.max)return;}if(key.startsWith('band.'))this.values.eq.bands[this.eqBand][key.slice(5)]=value;else this.values[this.effect][key]=value;for(const other of this.el.querySelectorAll('[data-key]'))if(other!==input&&other.dataset.key===key){if(other.type==='checkbox')other.checked=value;else other.value=Array.isArray(value)?value.join(', '):value;}if(this.effect==='duck'&&['attack','hold','release','curve'].includes(key))delete this.values.duck.points;this.changed();});});
    this.el.querySelectorAll('input[data-key]').forEach(input=>input.addEventListener('change',()=>{if(input.type==='checkbox')return;const key=input.dataset.key,value=key.startsWith('band.')?this.values.eq.bands[this.eqBand][key.slice(5)]:this.values[this.effect][key];input.value=Array.isArray(value)?value.join(', '):String(value);}));
    this.el.querySelectorAll('[data-band]').forEach(b=>b.addEventListener('click',()=>{this.eqBand=+b.dataset.band;this.render();}));
    this.el.querySelectorAll('[data-duck-preset]').forEach(b=>b.addEventListener('click',()=>{const p=b.dataset.duckPreset,v=this.values.duck;v.source='tempo';v.mode='volume';v.depth=p==='gate'?1:0.85;v.points=p==='gate'?[{x:0,y:0},{x:.47,y:0},{x:.48,y:1},{x:.97,y:1},{x:.98,y:0},{x:1,y:0}]:p==='trance'?[{x:0,y:1},{x:.23,y:1},{x:.24,y:0},{x:.49,y:0},{x:.5,y:1},{x:.73,y:1},{x:.74,y:0},{x:1,y:0}]:p==='swell'?[{x:0,y:0},{x:.3,y:.1},{x:.65,y:.45},{x:1,y:1}]:[{x:0,y:0},{x:.12,y:0},{x:.45,y:.5},{x:.8,y:1},{x:1,y:1}];this.render();this.changed();}));
    this.el.querySelectorAll('[data-duck-node]').forEach(input=>input.addEventListener('input',()=>{const value=+input.value;if(input.value===''||!Number.isFinite(value)||value<0||value>1)return;this.curvePoints()[+input.dataset.duckNode].y=value;this.changed();}));
    this.el.querySelectorAll('[data-duck-position]').forEach(input=>input.addEventListener('input',()=>{const value=+input.value,points=this.curvePoints(),index=+input.dataset.duckPosition;if(input.value===''||!Number.isFinite(value)||value<0||value>1||(index>0&&value<=points[index-1].x)||(index<points.length-1&&value>=points[index+1].x))return;points[index].x=value;this.changed();}));
    this.el.querySelectorAll('[data-duck-remove]').forEach(button=>button.addEventListener('click',()=>{const points=this.curvePoints();if(points.length<=2)return;points.splice(+button.dataset.duckRemove,1);this.refreshCurveEditor();}));
    this.el.querySelector('[data-duck-add]')?.addEventListener('click',()=>{const points=this.curvePoints();if(points.length>=32)return;let gap=0,index=0;for(let i=0;i<points.length-1;i++){const width=points[i+1].x-points[i].x;if(width>gap){gap=width;index=i;}}const a=points[index],b=points[index+1];points.splice(index+1,0,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});this.refreshCurveEditor();});
    this.el.querySelector('[data-reset-curve]')?.addEventListener('click',()=>{delete this.values.duck.points;this.render();this.changed();});
    this.attachCanvas();requestAnimationFrame(()=>this.redraw());
  }
  curvePoints(){const v=this.values.duck;if(!v.points)v.points=Array.from({length:8},(_,i)=>({x:i/7,y:duckEnvelope(i/7,v)}));return v.points;}
  refreshCurveEditor(){this.render();const details=this.el.querySelector('[data-curve-editor]');if(details)details.open=true;this.changed();}
  eqHTML(){const b=this.values.eq.bands[this.eqBand];return `<canvas class="effect-visual" id="eq-visual" aria-label="Parametric EQ curve; drag a band node or use the controls below"></canvas><div class="eq-bands">${this.values.eq.bands.map((_,i)=>`<button data-band="${i}" aria-pressed="${i===this.eqBand}">BAND ${i+1}</button>`).join('')}</div><label class="control checkbox-field"><input type="checkbox" data-key="band.enabled" ${b.enabled?'checked':''}> Enable this band</label><label class="control"><span class="control-heading">Filter type</span><select data-key="band.type" aria-label="EQ filter type">${['peaking','highpass','lowpass','lowshelf','highshelf'].map(x=>`<option ${x===b.type?'selected':''}>${x}</option>`).join('')}</select></label>${[field('frequency','Frequency',20,20000,1,'Hz'),field('gainDb','Gain',-18,18,0.1,'dB'),field('q','Q / resonance',0.1,12,0.05)].map(f=>this.fieldHTML(f,b,'band.')).join('')}`;}
  duckHTML(){const v=this.values.duck,points=v.points||Array.from({length:8},(_,i)=>({x:i/7,y:duckEnvelope(i/7,v)}));return `<canvas class="effect-visual" id="duck-visual" aria-label="Ducking gain envelope. Drag points or edit node levels below."></canvas><div class="inline-buttons">${['pump','gate','trance','swell'].map(p=>`<button data-duck-preset="${p}">${p[0].toUpperCase()+p.slice(1)}</button>`).join('')}</div><label class="control"><span class="control-heading">Trigger source</span><select data-key="source" aria-label="Sidechain source"><option value="tempo" ${v.source==='tempo'?'selected':''}>Tempo grid / drawn envelope</option><option value="track" ${v.source==='track'?'selected':''}>Audio track detector</option></select></label><label class="control"><span class="control-heading">Ducking mode</span><select data-key="mode" aria-label="Ducking mode"><option value="volume" ${v.mode==='volume'?'selected':''}>Volume / gate</option><option value="compressor" ${v.mode==='compressor'?'selected':''}>Compression</option></select></label><label class="control"><span class="control-heading">Sidechain audio track</span><select data-key="sourceTrackId" aria-label="Sidechain audio track"><option value="">Choose a track…</option>${this.getTracks().map(t=>{const option=document.createElement('option');option.value=t.id;option.textContent=t.name;if(v.sourceTrackId===t.id)option.setAttribute('selected','');return option.outerHTML;}).join('')}</select></label><details data-curve-editor><summary class="field-hint">Keyboard envelope points</summary><p class="field-hint">Position and gain use 0–1. Positions must remain in order.</p><div class="duck-points">${points.map((p,i)=>`<div class="duck-node-row"><span>${i+1}</span><label>POSITION<input type="number" data-duck-position="${i}" min="0" max="1" step="0.001" value="${Number(p.x.toFixed(6))}" aria-label="Envelope point ${i+1} position"></label><label>GAIN<input type="number" data-duck-node="${i}" min="0" max="1" step="0.01" value="${Number(p.y.toFixed(6))}" aria-label="Envelope point ${i+1} gain"></label><button data-duck-remove="${i}" aria-label="Remove envelope point ${i+1}" ${points.length<=2?'disabled':''}>×</button></div>`).join('')}</div><div class="inline-buttons"><button data-duck-add ${points.length>=32?'disabled':''}>Add envelope point</button></div><button class="text-button" data-reset-curve>Reset to attack / hold / release</button></details><details><summary class="field-hint">Detector & compression settings</summary>${[field('thresholdDb','Detector threshold',-60,0,0.5,'dB'),field('ratio','Sidechain ratio',1,20,0.5,':1'),field('attackMs','Detector attack',0,100,1,'ms'),field('releaseMs','Detector release',1,1000,5,'ms')].map(f=>this.fieldHTML(f,v)).join('')}</details>`;}
  redraw(){if(this.effect==='eq'){const c=this.el.querySelector('#eq-visual');if(c)this.drawState=drawEQ(c,this.values.eq.bands,this.getSampleRate());}else if(this.effect==='duck'){const c=this.el.querySelector('#duck-visual');if(c)this.drawState=drawDuck(c,this.values.duck);}}
  attachCanvas(){
    const canvas=this.el.querySelector('.effect-visual');if(!canvas)return;let drag=null;
    const position=e=>{const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0||!this.drawState)return;
      const p=position(e),s=this.drawState,nodes=s.nodes||[];let nearest=-1,dist=22;
      nodes.forEach((n,i)=>{const d=Math.hypot(n.x-p.x,n.y-p.y);if(d<dist){dist=d;nearest=i;}});
      if(this.effect==='duck'){
        if(this.values.duck.source==='track')return;
        const points=this.curvePoints(),x=Math.max(0,Math.min(1,(p.x-s.x)/s.width)),y=Math.max(0,Math.min(1,1-(p.y-s.y)/s.height));
        // A click above an existing point moves that point rather than creating
        // a duplicate time position that the DSP cannot interpolate.
        if(nearest<0)nearest=points.findIndex(n=>Math.abs(n.x-x)<=Math.max(.001,4/s.width));
        if(nearest<0&&points.length<32){const point={x,y};points.push(point);points.sort((a,b)=>a.x-b.x);nearest=points.indexOf(point);}
        if(nearest>=0){points[nearest].y=y;this.changed();}drag=nearest;
      }else if(nearest>=0){drag=nodes[nearest].index??nearest;this.eqBand=drag;}
      if(drag!==null&&drag>=0){canvas.setPointerCapture(e.pointerId);e.preventDefault();}
    });
    canvas.addEventListener('pointermove',e=>{
      if(drag===null||drag<0||!this.drawState)return;
      const p=position(e),s=this.drawState,x=Math.max(0,Math.min(1,(p.x-s.x)/s.width)),y=Math.max(0,Math.min(1,1-(p.y-s.y)/s.height));
      if(this.effect==='duck'){
        const points=this.curvePoints(),left=drag?points[drag-1].x:0,right=drag<points.length-1?points[drag+1].x:1;
        const margin=Math.min(.001,(right-left)/4);
        points[drag].y=y;points[drag].x=Math.max(drag?left+margin:0,Math.min(drag<points.length-1?right-margin:1,x));
      }else{const b=this.values.eq.bands[drag];b.enabled=true;b.frequency=Math.round(s.minHz*(s.maxHz/s.minHz)**x);b.gainDb=Math.round((y*36-18)*10)/10;}
      this.changed();
    });
    canvas.addEventListener('pointerup',()=>{if(drag!==null){drag=null;this.render();}});
    canvas.addEventListener('pointercancel',()=>{drag=null;});
  }
}
