import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioDevices} from '../src/audio-devices.js';
import {mediaTrack,mediaStream} from './audio-test-support.js';
test('device listing never prompts and late microphone grants close every track after cancellation',async()=>{
  let requested=0,grant;const track=mediaTrack(2),media={enumerateDevices:async()=>[{deviceId:'x',kind:'audioinput',label:''}],getUserMedia:()=>{requested++;return new Promise(resolve=>{grant=resolve;});}};const devices=new AudioDevices({navigator:{mediaDevices:media}});assert.equal((await devices.list()).permission,'unknown');assert.equal(requested,0);
  const pending=devices.start({channels:[0,1]});devices.stop();grant(mediaStream([track]));await assert.rejects(pending,e=>e.code==='ABORTED');assert.equal(track.stopped,true);assert.equal(devices.getState().status,'idle');
});
test('display capture with no audio closes video and reports unavailable system audio',async()=>{
  const video={...mediaTrack(),video:true};const devices=new AudioDevices({navigator:{mediaDevices:{getDisplayMedia:async()=>mediaStream([video])}}});await assert.rejects(devices.start({source:'display'}),e=>e.code==='SYSTEM_AUDIO_UNAVAILABLE');assert.equal(video.stopped,true);assert.equal(devices.state.status,'error');
});
test('input routing validates actual channels and processing changes commit only after native acceptance',async()=>{
  const track=mediaTrack(8),devices=new AudioDevices({navigator:{mediaDevices:{getUserMedia:async()=>mediaStream([track])}}});await devices.start({channels:[0,1,2,3,4,5,6,7],gainDb:-6,echoCancellation:false});assert.equal(devices.state.layout,'7.1');assert.equal(devices.state.availableChannels,8);await devices.set({gainDb:2,noiseSuppression:true});assert.equal(devices.state.gainDb,2);assert.equal(track.constraints.noiseSuppression,true);
  track.applyConstraints=async()=>{throw new Error('Constraint refused');};await assert.rejects(devices.set({gainDb:3,autoGainControl:true}),/refused/);assert.equal(devices.state.gainDb,2);track.listeners.get('ended')();assert.equal(devices.state.status,'ended');assert.equal(track.stopped,true);
});
