import { layoutForChannels } from './channel-layout.js';
const failure=(message,code)=>Object.assign(new Error(message),{code});
const stopped=stream=>{for(const track of stream?.getTracks?.()||[])track.stop();};
const validGain=value=>{if(!Number.isFinite(value)||value< -96||value>24)throw new RangeError('Input gain must be between -96 and 24 dB.');return value;};
export class AudioDevices extends EventTarget {
  constructor({navigator:nav=globalThis.navigator,onChange=()=>{}}={}){super();this.navigator=nav;this.onChange=onChange;this.stream=null;this.generation=0;this.state={status:'idle',source:null,deviceId:'default',channels:[0],layout:'mono',monitor:false,gainDb:0,error:null,processing:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}};this.changed=()=>this.onChange();nav?.mediaDevices?.addEventListener?.('devicechange',this.changed);}
  capabilities(){const media=this.navigator?.mediaDevices;return {mediaInput:!!media?.getUserMedia,displayInput:!!media?.getDisplayMedia};}
  async list(){const devices=await this.navigator?.mediaDevices?.enumerateDevices?.()||[];const clean=d=>({deviceId:d.deviceId,label:d.label||`${d.kind==='audioinput'?'Input':'Output'} ${d.deviceId==='default'?'(default)':''}`.trim(),groupId:d.groupId||'',kind:d.kind});return{inputs:devices.filter(d=>d.kind==='audioinput').map(clean),outputs:devices.filter(d=>d.kind==='audiooutput').map(clean),permission:devices.some(d=>d.kind==='audioinput'&&d.label)?'granted':'unknown'};}
  _emit(){this.onChange(this.getState());this.dispatchEvent(new Event('change'));}
  getState(){return structuredClone(this.state);}
  async start({source='microphone',deviceId='default',channels=[0],monitor=false,gainDb=0,echoCancellation=false,noiseSuppression=false,autoGainControl=false}={}, {signal}={}){
    if(!['microphone','display'].includes(source))throw new RangeError('Choose microphone or display audio.');
    if(typeof deviceId!=='string'||deviceId.length>512||typeof monitor!=='boolean')throw new TypeError('Invalid input device settings.');
    if(!Array.isArray(channels)||![1,2,6,8].includes(channels.length)||new Set(channels).size!==channels.length||channels.some(c=>!Number.isInteger(c)||c<0||c>31))throw new RangeError('Select 1, 2, 6 or 8 unique input channels.');
    for(const value of [echoCancellation,noiseSuppression,autoGainControl])if(typeof value!=='boolean')throw new TypeError('Input processing controls must be boolean.');
    validGain(gainDb);if(signal?.aborted)throw failure('Input request cancelled.','ABORTED');
    this.stop();const generation=++this.generation,media=this.navigator?.mediaDevices,method=source==='display'?'getDisplayMedia':'getUserMedia';
    if(!media?.[method])throw failure(`${source==='display'?'System':'Microphone'} audio capture is unavailable.`,'UNSUPPORTED');
    this.state={...this.state,status:'requesting',source,deviceId,channels:[...channels],layout:layoutForChannels(channels.length),monitor,gainDb,error:null,processing:{echoCancellation,noiseSuppression,autoGainControl}};this._emit();
    const abort=()=>{if(generation===this.generation)this.stop();};signal?.addEventListener('abort',abort,{once:true});
    try{
      const constraints=source==='display'?{audio:true,video:true}:{audio:{deviceId:deviceId==='default'?undefined:{exact:deviceId},channelCount:{ideal:Math.max(...channels)+1},echoCancellation,noiseSuppression,autoGainControl},video:false};
      const stream=await media[method](constraints);
      if(generation!==this.generation||signal?.aborted){stopped(stream);throw failure('Input request cancelled.','ABORTED');}
      const track=stream.getAudioTracks()[0];if(!track){stopped(stream);throw failure('The chosen display source did not supply audio. Select a tab or source with audio enabled.','SYSTEM_AUDIO_UNAVAILABLE');}
      const settings=track.getSettings?.()||{},available=settings.channelCount||1;
      if(channels.some(channel=>channel>=available)){stopped(stream);throw failure(`This input exposes ${available} channels; choose available indices.`,'CHANNEL_UNAVAILABLE');}
      this.stream=stream;this.state={...this.state,status:'active',deviceId:settings.deviceId||deviceId,availableChannels:available,actualSampleRate:settings.sampleRate||null,actualProcessing:{echoCancellation:settings.echoCancellation??null,noiseSuppression:settings.noiseSuppression??null,autoGainControl:settings.autoGainControl??null}};
      track.addEventListener?.('ended',()=>{if(this.stream===stream){this.stop();this.state.status='ended';this.state.error='The input device or shared source disconnected.';this._emit();}},{once:true});
      this._emit();return stream;
    }catch(error){if(generation===this.generation){this.state.status=error.code==='ABORTED'?'idle':'error';this.state.error=error.message;this._emit();}throw error;}finally{signal?.removeEventListener('abort',abort);}
  }
  async set(params={}){
    if(!this.stream||this.state.status!=='active')throw failure('Start an input first.','NO_INPUT');
    const next={...this.state.processing};if(params.gainDb!==undefined)validGain(params.gainDb);
    for(const key of ['echoCancellation','noiseSuppression','autoGainControl'])if(params[key]!==undefined){if(typeof params[key]!=='boolean')throw new TypeError(`${key} must be boolean.`);next[key]=params[key];}
    const track=this.stream.getAudioTracks()[0];if(Object.keys(params).some(key=>key!=='gainDb'))await track.applyConstraints(next);
    this.state.processing=next;if(params.gainDb!==undefined)this.state.gainDb=params.gainDb;this.state.actualProcessing=track.getSettings?.()||{};this._emit();return this.getState();
  }
  stop({error}={}){this.generation++;const stream=this.stream;this.stream=null;stopped(stream);const failed=error&&error.code!=='ABORTED';this.state={...this.state,status:failed?'error':'idle',monitor:false,error:failed?error.message:null};this._emit();}
  dispose(){this.stop();this.navigator?.mediaDevices?.removeEventListener?.('devicechange',this.changed);}
}
