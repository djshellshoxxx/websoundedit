/** Records successful semantic commands into portable, editable Macro 1 text. */
import { parseMacro, formatMacro, stepsToMacro, macroToSteps, MACRO_LIMITS } from './macro.js';
const copy = value => JSON.parse(JSON.stringify(value));
const own = (object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const HEADER='// WebSoundEdit Macro 1\n';
export class ActionRecorder {
  constructor(){this.recording=false;this.steps=[];this.text=HEADER;this.error=null;this.timing=false;this.portable=true;this.lastCompleted=null;}
  start({timing=false,portable=true}={}){
    if(typeof timing!=='boolean'||typeof portable!=='boolean')throw new TypeError('Recorder timing and portability must be boolean.');
    if(this.recording)throw new Error('Action recording is already running.');
    this.steps=[];this.text=HEADER;this.error=null;this.lastCompleted=null;this.recording=true;this.timing=timing;this.portable=portable;return this.getState();
  }
  stop(){this.recording=false;return {text:this.text,steps:copy(this.steps),error:this.error};}
  clear(){if(this.recording)throw new Error('Stop recording actions before clearing them.');this.steps=[];this.text=HEADER;this.error=null;this.lastCompleted=null;return this.getState();}
  getState(){return {recording:this.recording,timing:this.timing,portable:this.portable,count:this.steps.length,text:this.text,error:this.error};}
  capture(event){
    if(!this.recording||event.record===false||event.descriptor?.recordable===false||['macro','batch','internal','preview'].includes(event.origin)||event.method.startsWith('macro.'))return;
    try {
      let nodes=0;
      const safe=(value,depth=0)=>{
        if(++nodes>10000||depth>32)throw new Error('This action is too large to record. Use an explicit input alias.');
        if(value===null||typeof value==='boolean'||typeof value==='number')return value;
        if(typeof value==='string'){if(value.length>32768)throw new Error('This action contains too much text to record.');return value;}
        if(Array.isArray(value))return value.map(item=>safe(item,depth+1));
        if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('Binary input is recorded through file aliases only.');
        const result=Object.create(null);
        for(const [key,item] of Object.entries(value)){if(item===undefined)continue;if(['token','authorization','password','secret'].includes(key.toLowerCase()))throw new Error('Credential-bearing actions cannot be recorded.');result[key]=safe(item,depth+1);}
        return result;
      };
      const params=safe(event.params??{});
      if(this.portable) {
        const context=event.context?.state||event.context||{};
        const strip=object=>{
          if(!object||typeof object!=='object'||Array.isArray(object))return;
          if(object.trackId===context.selectedTrackId)delete object.trackId;
          if(object.clipId===context.selectedClipId)delete object.clipId;
        };
        // A selected target is portable; a different explicitly clicked track
        // retains its ID. Required live-loop IDs cannot be replaced by defaults.
        if(!event.descriptor?.schema?.required?.includes('trackId')&&!['project.saveTrack','file.exportStems','loop.track.remove','loop.track.mute','loop.track.stop','loop.track.play'].includes(event.method)){strip(params);strip(params.target);}
      }
      const ast=parseMacro(event.method+'('+JSON.stringify(params)+');');
      if(this.portable&&event.method==='file.import'){
        const property=ast.body[0].expression.argument.properties.find(item=>item.key==='input');
        if(property)property.value={type:'Identifier',name:'input'};
      }
      const step=macroToSteps(ast)[0], candidate=[];
      if(this.timing&&this.lastCompleted!==null){const seconds=Math.max(0,(event.startedAt-this.lastCompleted)/1000);if(seconds>=.02)candidate.push({method:'wait',params:{seconds:Math.round(seconds*1000)/1000}});}
      candidate.push(step);
      const addition=stepsToMacro(candidate).replace(/^\/\/ WebSoundEdit Macro 1\n/,'');
      if(this.steps.length+candidate.length>MACRO_LIMITS.commands||new TextEncoder().encode(this.text+addition).length>MACRO_LIMITS.sourceBytes)throw new Error('Action recording reached the 128 KiB macro limit. Save it and start another recording.');
      this.steps.push(...candidate);this.text+=addition;this.lastCompleted=event.completedAt;
    } catch(error){this.recording=false;this.error=error.message;}
  }
}
