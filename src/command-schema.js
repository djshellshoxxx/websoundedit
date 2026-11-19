/** JSON-data command contracts shared by macros, worker, browser adapters and HTTP.
 * Schemas describe static input constraints. State-dependent checks remain atomic
 * in the owning engine/runtime (for example, whether a selected clip exists).
 */
import { RACK_EFFECTS, normalizeRackChain } from './rack-config.js';

export class CommandValidationError extends TypeError {
  constructor(message, path = 'params') { super(path + ': ' + message); this.name = 'CommandValidationError'; this.code = 'INVALID_ARGUMENT'; this.path = path; }
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const forbidden = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const typedPrototype=Object.getPrototypeOf(Float32Array.prototype);
const typedByteLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength').get;
const typedReserved=Reflect.ownKeys(typedPrototype);
export const STATIC_UNKNOWN = Symbol('statically unknown macro value');
export const schema = Object.freeze({
  number: (minimum, maximum) => ({ type: 'number', minimum, maximum }),
  integer: (minimum, maximum) => ({ type: 'integer', minimum, maximum }),
  string: (maxLength = 200, minLength = 0) => ({ type: 'string', minLength, maxLength }),
  enum: (...values) => ({ enum: values }),
  boolean: { type: 'boolean' },
  object: (properties = {}, required = [], additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties }),
  array: (items, maxItems = 10000, minItems = 0) => ({ type: 'array', items, minItems, maxItems }),
});
const S = schema, n = S.number, i = S.integer, b = S.boolean, str = S.string;
const nullable = value => ({ anyOf: [value, { type: 'null' }] });
const id = nullable(str(200, 1)), layout = S.enum('mono', 'stereo', '5.1', '7.1');
const channel = { anyOf: [S.enum('all', 'left', 'right'), S.array(i(0, 7), 8, 1)] };
const range = { trackId: id, clipId: id, start: n(0, 600), end: n(0, 600), channels: channel };
const target = nullable(S.object(range));
const selection = { ...range, target };
const generic = { type: 'object', additionalProperties: true };
const pcm = S.object({ sampleRate: i(8000, 192000), layout, channels: S.array({ anyOf: [{ type: 'typed-array' }, S.array(n(-1e6, 1e6), 67108864)] }, 8, 1) }, ['sampleRate', 'channels']);
const eqBand = S.object({ type: S.enum('peaking', 'lowpass', 'highpass', 'bandpass', 'notch', 'lowshelf', 'highshelf'), frequency: n(5, 96000), gainDb: n(-36, 36), q: n(.1, 30), enabled: b });
const effects = {
  gain: { db: n(-96, 36) }, fadeIn: { duration: n(0, 600) }, fadeOut: { duration: n(0, 600) },
  normalize: { targetDb: n(-60, 0) }, reverse: {}, invert: {}, phase: { delayMs: n(-50, 50), channel: S.enum('left','right','both') },
  pan: { pan: n(-1, 1) }, mono: {}, swap: {}, silence: {}, dcRemove: {},
  eq: { bands: S.array(eqBand, 12) },
  compressor: { thresholdDb: n(-80, 0), ratio: n(1, 100), attackMs: n(0, 500), releaseMs: n(1, 5000), kneeDb: n(0, 40), makeupDb: n(-24, 36) },
  limiter: { ceilingDb: n(-24, 0), lookaheadMs: n(0, 50), releaseMs: n(1, 5000) },
  stretch: { ratio: n(.5, 2), preservePitch: b }, pitch: { semitones: n(-12, 12), preserveDuration: b }, speed: { rate: n(.5, 2) },
  removeSilence: { thresholdDb: n(-100, 0), minDuration: n(.005, 60), padding: n(0, 5) },
  trimSilence: { thresholdDb: n(-120, 0), minDuration: n(0, 600), padding: n(0, 10) },
  duck: { source: S.enum('tempo','track'), mode: S.enum('volume','compressor'), depth: n(0, 1), rate: n(.0625, 16), attack: n(0,1), hold: n(0,1), release: n(0,1), curve: n(.1,10), sourceTrackId: id, points: S.array(S.object({ x:n(0,1),y:n(0,1) },['x','y']),64,2), attackMs:n(0,500),releaseMs:n(1,5000),thresholdDb:n(-80,0),ratio:n(1,100),kneeDb:n(0,40),makeupDb:n(-24,36) },
  loop: { repeats: i(1,64), crossfadeMs: n(0,500) },
  beatRepeat: { division: i(1,16), pattern: S.array(i(-1, 4095), 4096, 1) },
  granular: { grainMs: n(5,500), density:n(1,12), spread:n(0,1), seed:i(0,4294967295),mix:n(0,1),freeze:b,position:n(0,1) },
  rack: { chain: S.array(generic,12) },
};
for (const [name, definition] of Object.entries(RACK_EFFECTS)) effects[name] = {
  wet:n(0,1),
  ...Object.fromEntries(definition.fields.map(field => [field.key, field.type === 'select' ? S.enum(...field.options) : (field.integer ? i : n)(field.min,field.max)])),
};
export const EFFECT_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries(effects).map(([name, fields]) => [name, S.object({ ...fields, bpm:n(20,400) }, name==='eq'?['bands']:[])])));
const render = { scope:S.enum('mix','track','clip','selection'), ...selection, end:nullable(n(0,600)), raw:b, respectMute:b, respectSolo:b, outputLayout:layout };
const projectFields = { name:str(200,1),sampleRate:i(8000,192000),bpm:n(20,400),outputLayout:layout };
const recipeSteps=S.array(S.object({method:str(160,1),params:generic},['method']),256,1);
const recipeObject=S.object({commands:recipeSteps,steps:recipeSteps});
const commandSchemas = {
  'project.new':S.object(projectFields),
  'project.update':S.object({name:projectFields.name,bpm:projectFields.bpm,beatsPerBar:i(1,16),beatOffset:n(-600,600),outputLayout:layout}),
  'project.select':S.object({trackId:id,clipId:id}),
  'project.load':S.object({project:{anyOf:[generic,str(384*1024*1024,2)]}},['project']),
  'project.saveTrack':S.object({trackId:id}),
  'metadata.update':S.object({metadata:generic},['metadata']),
  'settings.load':S.object({settings:generic},['settings']),
  'track.add':S.object({name:str(200,1)}),
  'track.update':S.object({trackId:id,name:str(200,1),gainDb:n(-96,24),pan:n(-1,1),mute:b,solo:b}),
  'track.remove':S.object({trackId:id}),
  'clip.add':S.object({trackId:id,trackName:str(200,1),name:str(200,1),start:n(0,600),audio:pcm},['audio']),
  'clip.update':S.object({trackId:id,clipId:id,destinationTrackId:id,name:str(200,1),start:n(0,600)}),
  'clip.remove':S.object({trackId:id,clipId:id}),
  'clip.getAudio':S.object({trackId:id,clipId:id}),
  'clip.duplicate':S.object({trackId:id,clipId:id,newTrack:b,start:n(0,600)}),
  'clip.split':S.object({trackId:id,clipId:id,at:n(0,600)}),
  'clip.key':S.object({clipId:id,tonic:nullable(i(0,11)),mode:S.enum('major','minor')},['tonic']),
  'selection.set':S.object(range),
  'edit.copy':S.object(selection), 'edit.cut':S.object(selection),'edit.delete':S.object(selection),
  'edit.trim':S.object({...selection,keepTimelinePosition:b}),
  'edit.paste':S.object({trackId:id,clipId:id,at:n(0,600),newTrack:b,name:str(200,1),start:n(0,600)}),
  'effect.apply':S.object({...selection,effect:S.enum(...Object.keys(effects)),params:generic},['effect']),
  'effect.preview':S.object({...selection,effect:S.enum(...Object.keys(effects)),params:generic},['effect']),
  'analysis.key':S.object({clipId:id}),
  'analysis.bpm':S.object({...selection,minBpm:n(30,300),maxBpm:n(30,400)}),
  'analysis.silence':S.object({...selection,...effects.removeSilence}),
  'analysis.stats':S.object(selection),
  'audio.generate':S.object({type:S.enum('tone','noise','sweep','drums'),name:str(200,1),trackId:id,start:n(0,600),duration:n(1/192000,600),frequency:n(1,94080),endFrequency:n(1,94080),amplitude:n(0,1),seed:i(0,4294967295),bpm:n(20,400),sampleRate:i(8000,192000),channels:S.enum(1,2,6,8),layout,wave:S.enum('sine','square','sawtooth','triangle')}),
  'audio.render':S.object(render),
  'audio.playbackPlan':S.object({...render,excludeTrackIds:S.array(str(200,1),64)}),
  'audio.renderPreview':S.object({...selection,effect:S.enum(...Object.keys(effects)),params:generic,scope:render.scope},['effect']),
  'markers.add':S.object({name:str(200,1),time:n(0,600)}),
  'markers.remove':S.object({markerId:str(200,1)},['markerId']),
  'loop.create':S.object({...selection,...effects.loop,newTrack:b,name:str(200,1),start:n(0,600)}),
  'recipe.run':{...S.object({commands:recipeSteps,steps:recipeSteps,recipe:{anyOf:[recipeSteps,recipeObject]}}),anyOf:[{required:['commands']},{required:['steps']},{required:['recipe']}]},
};
for (const [name, effectSchema] of Object.entries(EFFECT_SCHEMAS)) commandSchemas['effect.'+name] = S.object({...effectSchema.properties,target,params:effectSchema},[]);
const noRecord = new Set(['commands.list','project.state','project.save','project.saveTrack','project.load','settings.save','settings.load','clip.add','clip.getAudio','effect.preview','audio.render','audio.playbackPlan','audio.renderPreview']);
export function coreCommandDescriptors(commands) {
  return commands.map(command => ({
    ...command, schema:commandSchemas[command.method] || S.object({}),
    returns:{description:command.description}, capabilities:['core'],
    recordable:!noRecord.has(command.method),
  }));
}
function dataShape(value, state, path='params', depth=0) {
  if(state.partial && value===STATIC_UNKNOWN)return;
  if (++state.nodes > 1000000 || depth > 64) throw new CommandValidationError('data is too deeply nested or has too many values',path);
  if((state.bytes+=16)>768*1024*1024)throw new CommandValidationError('aggregate command data exceeds 768 MiB',path);
  if (value===null || value===undefined || typeof value==='boolean') return;
  if (typeof value==='number') { if (!Number.isFinite(value)) throw new CommandValidationError('numbers must be finite',path); return; }
  if (typeof value==='string') { if((state.bytes+=value.length*2)>768*1024*1024)throw new CommandValidationError('aggregate text exceeds the data limit',path);return; }
  if (ArrayBuffer.isView(value)) {
    if (!(value instanceof Float32Array || value instanceof Uint8Array || value instanceof Int16Array || value instanceof Float64Array)) throw new CommandValidationError('unsupported binary value',path);
    if(![Float32Array.prototype,Uint8Array.prototype,Int16Array.prototype,Float64Array.prototype].includes(Object.getPrototypeOf(value)))throw new CommandValidationError('binary data must use its standard typed-array prototype',path);
    for(const key of typedReserved)if(own(value,key))throw new CommandValidationError('binary data cannot override typed-array operations',path);
    const byteLength=typedByteLength.call(value);
    if (byteLength>256*1024*1024) throw new CommandValidationError('binary value exceeds 256 MiB',path);
    if((state.binaryBytes+=byteLength)>256*1024*1024 || (state.bytes+=byteLength)>768*1024*1024)throw new CommandValidationError('aggregate binary data exceeds 256 MiB',path);
    return; // PCM sample validation belongs to the audio boundary, without boxing it.
  }
  if (!value || typeof value!=='object' || (!Array.isArray(value) && ![null,Object.prototype].includes(Object.getPrototypeOf(value)))) throw new CommandValidationError('only plain data is accepted',path);
  if(Array.isArray(value)&&value.length>1000000-state.nodes)throw new CommandValidationError('array exceeds the data node limit',path);
  if (state.active.has(value)) throw new CommandValidationError('cyclic data is not accepted',path);
  state.active.add(value);
  for(const key of Reflect.ownKeys(value)) {
    if(typeof key!=='string'||forbidden.has(key))throw new CommandValidationError('forbidden data property',path);
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor || !own(descriptor,'value'))throw new CommandValidationError('accessors are not accepted',path);
    dataShape(descriptor.value,state,path+'.'+key,depth+1);
  }
  state.active.delete(value);
}
function typeIs(value, type) {
  if(type==='null')return value===null;
  if(type==='array')return Array.isArray(value);
  if(type==='typed-array')return value instanceof Float32Array;
  if(type==='integer')return Number.isSafeInteger(value);
  if(type==='object')return !!value&&typeof value==='object'&&!Array.isArray(value)&&![ArrayBuffer.isView(value)].includes(true);
  return typeof value===type;
}
function validate(value, contract, path, depth=0, partial=false) {
  if(partial&&value===STATIC_UNKNOWN)return;
  if(contract===true || !contract)return;
  if(contract===false)throw new CommandValidationError('value is not allowed',path);
  if(depth>64)throw new CommandValidationError('schema depth exceeded',path);
  if(contract.anyOf || contract.oneOf) {
    let matches=0;const failures=[];
    for(const branch of contract.anyOf||contract.oneOf){try{validate(value,branch,path,depth+1,partial);matches++;}catch(error){failures.push(error.message);}}
    if(!matches || contract.oneOf&&matches!==1)throw new CommandValidationError('does not match the allowed alternatives ('+failures.slice(0,3).join('; ')+')',path);
  }
  if(contract.const!==undefined && value!==contract.const)throw new CommandValidationError('must equal '+JSON.stringify(contract.const),path);
  if(contract.enum && !contract.enum.some(entry=>Object.is(value,entry)))throw new CommandValidationError('must be one of '+contract.enum.map(x=>JSON.stringify(x)).join(', '),path);
  if(contract.type && !(Array.isArray(contract.type)?contract.type:[contract.type]).some(type=>typeIs(value,type)))throw new CommandValidationError('expected '+[].concat(contract.type).join(' or '),path);
  if(typeof value==='number') {
    if(!Number.isFinite(value))throw new CommandValidationError('must be finite',path);
    if(contract.minimum!==undefined&&value<contract.minimum || contract.maximum!==undefined&&value>contract.maximum || contract.exclusiveMinimum!==undefined&&value<=contract.exclusiveMinimum || contract.exclusiveMaximum!==undefined&&value>=contract.exclusiveMaximum)throw new CommandValidationError('outside the supported range',path);
  }
  if(typeof value==='string') {
    if(contract.minLength!==undefined&&value.length<contract.minLength || contract.maxLength!==undefined&&value.length>contract.maxLength)throw new CommandValidationError('invalid text length',path);
    // Only trusted, application-authored schemas may supply a regular expression.
    if(contract.pattern&&!new RegExp(contract.pattern).test(value))throw new CommandValidationError('invalid text format',path);
  }
  if(Array.isArray(value)) {
    if(contract.minItems!==undefined&&value.length<contract.minItems || contract.maxItems!==undefined&&value.length>contract.maxItems)throw new CommandValidationError('invalid number of items',path);
    if(contract.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)throw new CommandValidationError('items must be unique',path);
    if(contract.items)for(let index=0;index<value.length;index++)validate(value[index],contract.items,path+'['+index+']',depth+1,partial);
  } else if(value&&typeof value==='object'&&!ArrayBuffer.isView(value)) {
    for(const key of contract.required||[])if(!own(value,key)||value[key]===undefined)throw new CommandValidationError('missing required property '+key,path);
    for(const [key,item] of Object.entries(value)) {
      if(item===undefined)continue;
      const child=own(contract.properties||{},key)?contract.properties[key]:contract.additionalProperties;
      if(child===false)throw new CommandValidationError('unknown property '+key,path);
      if(child && typeof child==='object')validate(item,child,path+'.'+key,depth+1,partial);
    }
  }
}
export function validateStaticCommandParams(params,descriptor){return validateCommandParams(params,descriptor,{partial:true});}
function fullyKnown(value){if(value===STATIC_UNKNOWN)return false;if(Array.isArray(value))return value.every(fullyKnown);if(value&&typeof value==='object'&&!ArrayBuffer.isView(value))return Object.values(value).every(fullyKnown);return true;}
export function validateCommandParams(params,descriptor,{partial=false}={}) {
  if(partial&&params===STATIC_UNKNOWN)return params;
  if(!params||typeof params!=='object'||Array.isArray(params)||ArrayBuffer.isView(params))throw new CommandValidationError('must be an object');
  dataShape(params,{nodes:0,bytes:0,binaryBytes:0,active:new Set(),partial});
  validate(params,descriptor?.schema || descriptor?.inputSchema || generic,'params',0,partial);
  const method=descriptor?.method || descriptor?.id || '';
  const effect = method==='effect.apply'||method==='effect.preview'||method==='audio.renderPreview'?params.effect:method.startsWith('effect.')?method.slice(7):null;
  if(effect && EFFECT_SCHEMAS[effect]) {
    const wrapper=['effect.apply','effect.preview','audio.renderPreview'].includes(method);
    const options=params.params ?? (wrapper?{}:Object.fromEntries(Object.entries(params).filter(([key])=>key!=='target')));
    validate(options,EFFECT_SCHEMAS[effect],'params'+(params.params?'.params':''),0,partial);
    if(effect==='rack'&&fullyKnown(options))normalizeRackChain(options.chain);
    if(effect==='duck'&&options!==STATIC_UNKNOWN){
      if([options.attack,options.hold,options.release].every(fullyKnown)&&(options.attack??.01)+(options.hold??.05)+(options.release??.8)>1+1e-9)throw new CommandValidationError('attack, hold and release must fit within one cycle');
      if(options.points&&fullyKnown(options.points))for(let k=1;k<options.points.length;k++)if(options.points[k].x<=options.points[k-1].x)throw new CommandValidationError('envelope times must increase');
    }
  }
  if(method==='analysis.bpm' && fullyKnown(params.maxBpm)&&fullyKnown(params.minBpm)&&params.maxBpm!==undefined&&params.maxBpm<(params.minBpm??60))throw new CommandValidationError('maximum BPM must be at least minimum BPM');
  if(method==='wait' && (params.seconds===undefined)===(params.beats===undefined))throw new CommandValidationError('wait requires exactly one of seconds or beats');
  return params;
}
