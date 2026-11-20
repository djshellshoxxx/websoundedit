import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {RealtimeRackDSP,estimateRackBytes,LIVE_LIMITS} from '../src/realtime-dsp.js';
import {RACK_EFFECTS,MAX_RACK_EFFECTS} from '../src/rack-config.js';
const rows=[];
const catalogue=Object.keys(RACK_EFFECTS),scenarios=[{name:'three-effects',effects:['filter','delay','reverb']}];
// Exercise every processor in full admitted racks, even as the catalogue grows.
// The rack length is a resource limit, not the number of available effect types.
for(let start=0;start<catalogue.length;start+=MAX_RACK_EFFECTS)scenarios.push({name:`max-rack-${scenarios.length}`,effects:Array.from({length:Math.min(MAX_RACK_EFFECTS,catalogue.length)},(_,index)=>catalogue[(start+index)%catalogue.length])});
for(const channels of [2,6,8])for(const {name:scenario,effects} of scenarios){
  const chain=effects.map((effect,i)=>({id:`stage-${i}`,effect,wet:.35,params:{}})),sampleRate=48000,frames=48000;
  const dsp=new RealtimeRackDSP({sampleRate,channels,chain}),input=Array.from({length:channels},(_,c)=>Float32Array.from({length:128},(_,i)=>Math.sin((i+c)*.1)*.1)),output=input.map(()=>new Float32Array(128));
  for(let i=0;i<32;i++)dsp.process(input,output);const start=performance.now();for(let frame=0;frame<frames;frame+=128)dsp.process(input,output);const cpuMs=performance.now()-start;if(output.some(channel=>channel.some(value=>!Number.isFinite(value))))throw new Error('Non-finite benchmark output');rows.push({channels,scenario,effects,sampleRate,blockFrames:128,audioSeconds:frames/sampleRate,wallMs:Number(cpuMs.toFixed(3)),wallToAudioRatio:Number((cpuMs/1000).toFixed(4)),estimatedStateBytes:estimateRackBytes(chain,sampleRate,channels)});
}
const report={runtime:process.version,platform:process.platform,limits:LIVE_LIMITS,kind:'synthetic CPU throughput; no device latency or multi-hour hardware claim',rows};console.log(JSON.stringify(report,null,2));const out=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6);if(out)await writeFile(out,JSON.stringify(report,null,2)+'\n');
