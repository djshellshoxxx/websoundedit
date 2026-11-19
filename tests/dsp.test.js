import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudio, analyzeAudio, generateAudio, detectBpm, detectSilence, sliceAudio, concatAudio, resampleAudio, validateAudio, duckEnvelope, eqCoefficients } from '../src/dsp.js';
const SR = 48000;
const tone = (frequency = 440, seconds = 1, amplitude = 0.5) => ({sampleRate: SR, channels: [Float32Array.from({length: Math.round(SR * seconds)}, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / SR))]});
const constant = (value = 1, seconds = 1, channels = 1) => ({sampleRate: SR, channels: Array.from({length: channels}, () => new Float32Array(Math.round(SR * seconds)).fill(value))});
const peak = (channel) => channel.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
const rms = (channel) => Math.sqrt(channel.reduce((sum, x) => sum + x * x, 0) / channel.length);
function frequencyOf(channel) {
  const crossings = [];
  for (let i = Math.round(channel.length * .2) + 1; i < channel.length * .8; i++) if (channel[i-1] <= 0 && channel[i] > 0) crossings.push(i - 1 - channel[i-1] / (channel[i] - channel[i-1]));
  const periods = crossings.slice(1).map((x, i) => x - crossings[i]).sort((a,b) => a-b);
  return SR / periods[Math.floor(periods.length / 2)];
}

test('validation rejects invalid rates, channel topology, nonfinite samples and allocation limits', () => {
  assert.throws(() => validateAudio({channels:[new Float32Array(1)]}), /sample rate/);
  assert.throws(() => validateAudio({sampleRate:SR,channels:[Float32Array.of(NaN)]}), /non-finite/);
  assert.throws(() => validateAudio({sampleRate:SR,channels:[new Float32Array(1),new Float32Array(2)]}), /equal-length/);
  assert.throws(() => generateAudio({duration:601}), /duration/);
});
test('all simple transforms own output and preserve the source', async () => {
  const source = {sampleRate:SR, channels:[Float32Array.of(.1,.2,.3,.4)]};
  const reversed = await processAudio(source,'reverse');
  assert.deepEqual([...reversed.channels[0]],[...source.channels[0]].reverse());
  assert.deepEqual(await processAudio(await processAudio(source,'invert'),'invert'),source);
  const silence = await processAudio(source,'silence'); assert.equal(peak(silence.channels[0]),0);
  assert.deepEqual([...source.channels[0]],[...Float32Array.of(.1,.2,.3,.4)]);
  assert.notStrictEqual((await processAudio(source,'pitch',{semitones:0})).channels[0],source.channels[0]);
});
test('gain, normalization, fades and DC removal produce measured levels', async () => {
  const audio = tone(480,.2,.25);
  const boosted = await processAudio(audio,'gain',{db:6.020599913});
  assert.ok(Math.abs(peak(boosted.channels[0])-.5)<1e-5);
  const normalized = await processAudio(audio,'normalize',{targetDb:-1});
  assert.ok(Math.abs(analyzeAudio(normalized).peakDb+1)<1e-5);
  const faded = await processAudio(constant(.6,.1),'fadeOut',{duration:.05});
  assert.equal(faded.channels[0].at(-1),0); assert.ok(faded.channels[0][0]>.59);
  assert.deepEqual(await processAudio(audio,'fadeIn',{duration:0}),audio);
  assert.equal(peak((await processAudio(constant(.2,.1),'dcRemove')).channels[0]),0);
  assert.equal(peak((await processAudio(constant(0,.1),'normalize')).channels[0]),0);
});
test('phase delay, panning, mono and stereo swap have explicit channel semantics', async () => {
  const impulse=constant(0,.01); impulse.channels[0][10]=1;
  const delayed=await processAudio(impulse,'phase',{delayMs:1000/SR});
  assert.equal(delayed.channels[0][11],1); assert.equal(delayed.channels[0][10],0);
  const left=await processAudio(tone(),'pan',{pan:-1}); assert.equal(peak(left.channels[1]),0);
  const center=await processAudio(constant(1,.01),'pan',{pan:0});
  assert.ok(Math.abs(center.channels[0][0]**2+center.channels[1][0]**2-1)<1e-6);
  const stereo={sampleRate:SR,channels:[Float32Array.of(.5,-.5),Float32Array.of(-.5,.5)]};
  assert.equal(peak((await processAudio(stereo,'mono')).channels[0]),0);
  assert.deepEqual((await processAudio(stereo,'swap')).channels[0],stereo.channels[1]);
  assert.equal(analyzeAudio(stereo).correlation,-1);
});
test('EQ actually changes frequency-selective content and has a finite response', async () => {
  const low=tone(100,1),high=tone(6000,1);
  const params={bands:[{type:'lowpass',frequency:800,q:.707,gainDb:0}]};
  const lowOut=await processAudio(low,'eq',params), highOut=await processAudio(high,'eq',params);
  assert.ok(rms(lowOut.channels[0].subarray(2000))/rms(low.channels[0].subarray(2000))>.95);
  assert.ok(rms(highOut.channels[0].subarray(2000))/rms(high.channels[0].subarray(2000))<.03);
  const bell=await processAudio(tone(1000),'eq',{bands:[{type:'peaking',frequency:1000,q:1,gainDb:6}]});
  assert.ok(Math.abs(20*Math.log10(rms(bell.channels[0].subarray(5000))/rms(tone(1000).channels[0].subarray(5000)))-6)<.02);
  for(const type of ['peaking','lowpass','highpass','lowshelf','highshelf']) assert.ok(Object.values(eqCoefficients({type,frequency:1000,q:.7,gainDb:6},SR)).every(Number.isFinite));
});
test('compressor reduces steady signal by the configured ratio with linked stereo gain', async () => {
  const audio=constant(1,.5,2); audio.channels[1].fill(.25);
  const out=await processAudio(audio,'compressor',{thresholdDb:-20,ratio:4,attackMs:0,kneeDb:0,releaseMs:50});
  const measured=20*Math.log10(out.channels[0][100]);
  assert.ok(Math.abs(measured+15)<.001);
  for(let i=0;i<out.channels[0].length;i+=101) assert.ok(Math.abs(out.channels[1][i]*4-out.channels[0][i])<1e-7);
});
test('lookahead limiter enforces sample peak ceiling even on descending peaks and transients', async () => {
  const audio=constant(0,.25,2);
  for(let i=0;i<audio.channels[0].length;i++) {audio.channels[0][i]=(i%2?-1:1)*(2-i/audio.channels[0].length);audio.channels[1][i]=audio.channels[0][i]*.5;}
  for(const lookaheadMs of [0,1,5,50]) {
    const out=await processAudio(audio,'limiter',{ceilingDb:-3,releaseMs:1,lookaheadMs});
    assert.ok(analyzeAudio(out).peakDb<=-3+1e-5,`ceiling ${lookaheadMs}`);
    for(let i=0;i<out.channels[0].length;i+=79) assert.ok(Math.abs(out.channels[1][i]*2-out.channels[0][i])<1e-6);
  }
  const impulse=constant(0,.1); impulse.channels[0][2000]=12;
  const out=await processAudio(impulse,'limiter',{ceilingDb:-1}); assert.ok(analyzeAudio(out).peakDb<=-1+1e-5);
});
test('pitch and stretch are independent, varispeed changes both, stereo coherence survives', async () => {
  const input=tone(440,1);input.channels.push(Float32Array.from(input.channels[0],x=>-.4*x));
  for(const [effect,params,freq,length] of [['pitch',{semitones:12},880,SR],['pitch',{semitones:-12},220,SR],['stretch',{ratio:1.5},440,SR*1.5],['stretch',{ratio:.5},440,SR*.5],['speed',{rate:2},880,SR*.5]]) {
    const out=await processAudio(input,effect,params);
    assert.equal(out.channels[0].length,length);
    assert.ok(Math.abs(frequencyOf(out.channels[0])-freq)/freq<.015,`${effect}: ${frequencyOf(out.channels[0])}`);
    for(let i=0;i<out.channels[0].length;i+=53) assert.ok(Math.abs(out.channels[1][i]+.4*out.channels[0][i])<1e-5);
  }
});
test('small time/pitch selections preserve boundaries and do not emit NaN', async () => {
  for(const length of [1,32,128,4800]) {
    const audio={sampleRate:SR,channels:[new Float32Array(length)]};audio.channels[0][0]=.4;audio.channels[0][length-1]=.7;
    for(const ratio of [.5,2]) {
      const out=await processAudio(audio,'stretch',{ratio});
      assert.equal(out.channels[0].length,Math.max(1,Math.round(length*ratio)));
      assert.ok(out.channels[0].every(Number.isFinite));
      assert.ok(peak(out.channels[0].subarray(Math.max(0,out.channels[0].length-64)))>.02);
    }
  }
});
test('resampling is band-limited and preserves duration and channel relationships', () => {
  const audio=tone(18000,1);audio.channels.push(Float32Array.from(audio.channels[0],x=>-.5*x));
  const out=resampleAudio(audio,16000);assert.equal(out.channels[0].length,16000);
  assert.ok(rms(out.channels[0].subarray(1000,15000))<.005);
  for(let i=0;i<out.channels[0].length;i+=43) assert.ok(Math.abs(out.channels[1][i]+.5*out.channels[0][i])<1e-8);
});
test('silence detection does not cancel antiphase audio and removal retains exact selected portions', async () => {
  const silent=constant(0,.5), sound=tone(440,.5);
  const audio=concatAudio([silent,sound,silent]);audio.channels.push(Float32Array.from(audio.channels[0],x=>-x));
  const ranges=detectSilence(audio,{thresholdDb:-50,minDuration:.2,padding:0});
  assert.deepEqual(ranges,[{start:0,end:.5},{start:1,end:1.5}]);
  const trimmed=await processAudio(audio,'removeSilence',{thresholdDb:-50,minDuration:.2,padding:0});
  assert.equal(trimmed.channels[0].length,SR*.5);assert.deepEqual(trimmed.channels[0],sound.channels[0]);
  assert.equal((await processAudio(silent,'removeSilence',{padding:0})).channels[0].length,0);
  const padded=detectSilence(audio,{thresholdDb:-50,minDuration:.2,padding:.05});
  assert.ok(Math.abs(padded[0].end-.45)<1e-10);assert.ok(Math.abs(padded[1].start-1.05)<1e-10);
});
test('tempo detection identifies click/drum BPM and reports insufficient rhythmic evidence', () => {
  for(const bpm of [75,90,120,140,175]) {
    const audio=constant(0,8);
    for(let start=0;start<audio.channels[0].length;start+=SR*60/bpm) for(let j=0;j<500&&Math.round(start)+j<audio.channels[0].length;j++) audio.channels[0][Math.round(start)+j]=Math.sin(j*.4)*Math.exp(-j/100);
    const result=detectBpm(audio);
    assert.ok(Math.abs(result.bpm-bpm)<1,`${bpm} detected ${result.bpm}`);
    assert.ok(result.confidence>.35);
  }
  assert.equal(detectBpm(constant(0,4)).bpm,null);
  assert.equal(detectBpm(tone(440,4)).bpm,null);
  assert.equal(detectBpm(tone(440,.1)).bpm,null);
  assert.ok(Math.abs(detectBpm(generateAudio({type:'drums',bpm:120,duration:8})).bpm-120)<1);
});
test('tempo ducking follows drawn gain points and depth; full-depth custom envelope creates a gate', async () => {
  const input=constant(.5,1);
  const points=[{x:0,y:0},{x:.49,y:0},{x:.5,y:1},{x:.99,y:1},{x:1,y:0}];
  const gated=await processAudio(input,'duck',{source:'tempo',mode:'volume',depth:1,rate:1,points},{bpm:120,beatOffset:0});
  assert.equal(gated.channels[0][1000],0); assert.equal(gated.channels[0][18000],.5); assert.equal(gated.channels[0][25000],0);
  const half=await processAudio(input,'duck',{depth:.5,points},{bpm:120}); assert.equal(half.channels[0][1000],.25);
  const offset=await processAudio(input,'duck',{depth:1,points},{bpm:120,beatOffset:-.25}); assert.equal(offset.channels[0][1000],.5);
  assert.equal(duckEnvelope(.25,{points}),0); assert.equal(duckEnvelope(.75,{points}),1);
});
test('true audio sidechain drives volume and compressor ducking; absent source rejects', async () => {
  const input=constant(.5,1),trigger=constant(0,1);trigger.channels[0].fill(1,SR*.2,SR*.4);
  for(const mode of ['volume','compressor']) {
    const out=await processAudio(input,'duck',{source:'track',mode,depth:1,attackMs:0,releaseMs:10,thresholdDb:-20,ratio:10,kneeDb:0},{sidechain:trigger});
    assert.equal(out.channels[0][1000],.5); assert.ok(out.channels[0][SR*.3]<.1); assert.ok(out.channels[0][SR*.8]>.49);
  }
  await assert.rejects(processAudio(input,'duck',{source:'track'}),/source track/);
});
test('loop rendering, beat reordering and granular texture are deterministic and measurable', async () => {
  const audio=concatAudio([constant(.1,.25),constant(.2,.25),constant(.3,.25),constant(.4,.25)]);
  const loop=await processAudio(audio,'loop',{repeats:3,crossfadeMs:10});assert.equal(loop.channels[0].length,SR*3-960);
  const exact=await processAudio(audio,'loop',{repeats:2,crossfadeMs:0});assert.equal(exact.channels[0].length,SR*2);
  const pattern=await processAudio(audio,'beatRepeat',{division:2,pattern:[3,0,2,1],bpm:120});assert.ok(Math.abs(pattern.channels[0][1000]-.4)<1e-6);assert.ok(Math.abs(pattern.channels[0][SR*.25+1000]-.1)<1e-6);
  const grainA=await processAudio(audio,'granular',{seed:12,spread:.8,mix:1}),grainB=await processAudio(audio,'granular',{seed:12,spread:.8,mix:1});
  assert.deepEqual(grainA,grainB);assert.notDeepEqual(grainA,audio);assert.equal(grainA.channels[0].length,audio.channels[0].length);
  assert.ok(grainA.channels[0].every(Number.isFinite));
  assert.deepEqual(await processAudio(audio,'granular',{mix:0}),audio);
});
test('generators are repeatable; invalid DSP parameters reject instead of corrupting PCM', async () => {
  const a=generateAudio({type:'noise',duration:.1,seed:5});assert.deepEqual(a,generateAudio({type:'noise',duration:.1,seed:5}));
  assert.notDeepEqual(a,generateAudio({type:'noise',duration:.1,seed:6}));
  assert.ok(generateAudio({type:'sweep',duration:.2}).channels[0].every(Number.isFinite));
  for(const [effect,params] of [['gain',{db:Infinity}],['pitch',{semitones:13}],['eq',{bands:[{frequency:NaN}]}],['duck',{attack:.8,hold:.5}],['duck',{points:[{x:.5,y:0},{x:.1,y:1}]}],['beatRepeat',{pattern:[999999]}],['unknown',{}]]) await assert.rejects(processAudio(tone(440,.1),effect,params));
});
