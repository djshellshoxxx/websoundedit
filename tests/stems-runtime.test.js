import test from 'node:test';
import assert from 'node:assert/strict';
import { STEM_MODEL } from '../src/stems/model.js';
import { assertModelIdentity, validateStemAudio, transitionWindow, separateStemAudio } from '../src/stems/pipeline.js';
import { StemSeparationClient } from '../src/stems/client.js';

const segment = STEM_MODEL.segmentFrames, dims = [1, 4, 2, segment];
const source = (channels = [Float32Array.of(.2, -.4, .8)]) => ({ sampleRate: 44100, channels });
function prediction(input, factors = [.1, .2, .3, .4], release) {
  const data = new Float32Array(8 * segment);
  for (let row = 0; row < 4; row++) for (let index = 0; index < input.length; index++) data[row * input.length + index] = input[index] * factors[row];
  return { data, dims, release };
}
const near = (actual, expected, tolerance = 2e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('only the exact supported model size and SHA-256 identity are accepted', () => {
  assert.doesNotThrow(() => assertModelIdentity(STEM_MODEL));
  assert.throws(() => assertModelIdentity({ ...STEM_MODEL, byteLength: STEM_MODEL.byteLength - 1 }), /supported/);
  assert.throws(() => assertModelIdentity({ ...STEM_MODEL, sha256: '0'.repeat(64) }), /SHA-256/);
});

test('stem input bounds reject wrong rate, layout, malformed samples and long excerpts', () => {
  assert.equal(validateStemAudio(source()), 3);
  for (const audio of [null, { ...source(), sampleRate: 48000 }, source([]),
    source([new Float32Array(1), new Float32Array(1), new Float32Array(1)]), source([new Float32Array(0)]),
    source([new Float32Array(44100 * 30 + 1)]), source([[0, 1]]), source([new Float32Array(2), new Float32Array(1)]),
    source([Float32Array.of(NaN)]), source([Float32Array.of(Infinity)])]) assert.throws(() => validateStemAudio(audio));
  assert.throws(() => validateStemAudio(source([Float32Array.of(1.01)])), /Normalize/);
  assert.equal(validateStemAudio(source([new Float32Array(44100 * 30)])), 44100 * 30);
});

test('overlap window never drops either endpoint', () => {
  assert.deepEqual([...transitionWindow(12, 3)], [.25, .5, .75, 1, 1, 1, 1, 1, 1, .75, .5, .25]);
  assert.deepEqual([...transitionWindow(1, 0)], [1]);
  assert.throws(() => transitionWindow(8, 5), /Invalid/);
});

test('raw mono is duplicated, right-padded and returned at exact length with distinct predicted stems', async () => {
  const audio = source(), original = [...audio.channels[0]];
  let released = 0, calls = 0;
  const result = await separateStemAudio(audio, { runChunk: async input => {
    calls++;
    assert.equal(input.length, 2 * segment);
    assert.deepEqual([...input.slice(0, 3)], original);
    assert.deepEqual([...input.slice(segment, segment + 3)], original);
    assert.equal(input[3], 0); assert.equal(input.at(-1), 0);
    return prediction(input, undefined, () => released++);
  } });
  assert.equal(calls, 1); assert.equal(released, 1);
  assert.equal(result.metrics.chunks, 1); assert.equal(result.metrics.inputChannels, 1);
  assert.deepEqual(Object.keys(result.stems), ['drums', 'bass', 'other', 'vocals', 'instrumental']);
  for (const [name, factor] of [['drums', .1], ['bass', .2], ['other', .3], ['vocals', .4], ['instrumental', .6]]) {
    const stem = result.stems[name];
    assert.equal(stem.sampleRate, 44100); assert.equal(stem.channels.length, 2);
    for (const channel of stem.channels) {
      assert.equal(channel.length, original.length);
      for (let index = 0; index < original.length; index++) near(channel[index], original[index] * factor);
    }
  }
  assert.deepEqual([...audio.channels[0]], original);
  assert.ok(result.metrics.mixtureRmse < 1e-7);
});

test('one full segment uses one inference and preserves independent stereo endpoints', async () => {
  const left = new Float32Array(segment), right = new Float32Array(segment);
  left[0] = .9; left[segment - 1] = -.5; right[0] = -.3; right[segment - 1] = .7;
  let calls = 0;
  const result = await separateStemAudio(source([left, right]), { runChunk: async input => { calls++; return prediction(input); } });
  assert.equal(calls, 1);
  for (const [index, input] of [[0, left], [1, right]]) {
    near(result.stems.vocals.channels[index][0], input[0] * .4);
    near(result.stems.vocals.channels[index].at(-1), input.at(-1) * .4);
  }
});

test('overlapping chunks preserve sample positions, independent stereo and the final tail', async () => {
  const frames = segment + 31, stride = segment - STEM_MODEL.overlapFrames;
  const left = Float32Array.from({ length: frames }, (_, index) => Math.sin(index * .02) * .5), right = Float32Array.from(left, value => -.4 * value);
  const events = []; let calls = 0;
  const result = await separateStemAudio(source([left, right]), { onProgress: value => events.push(value), runChunk: async input => {
    if (calls === 1) {
      assert.equal(input[0], left[stride]); assert.equal(input[frames - stride - 1], left.at(-1));
      assert.equal(input[frames - stride], 0); assert.equal(input[segment], right[stride]);
    }
    calls++; return prediction(input);
  } });
  assert.equal(calls, 2); assert.equal(result.metrics.chunks, 2);
  assert.equal(events.at(-1).completed, 2); assert.equal(events.at(-1).total, 2);
  for (const index of [0, stride - 1, stride, segment - 1, segment, frames - 1]) {
    near(result.stems.vocals.channels[0][index], left[index] * .4);
    near(result.stems.vocals.channels[1][index], right[index] * .4);
  }
});

test('invalid tensor dimensions and non-finite predictions release inference tensors', async () => {
  let released = 0;
  await assert.rejects(separateStemAudio(source(), { runChunk: async () => ({ data: new Float32Array(2), dims: [1, 2], release: () => released++ }) }), /unsupported stem tensor/);
  assert.equal(released, 1);
  const nonfinite = new Float32Array(8 * segment); nonfinite[nonfinite.length - 1] = NaN;
  await assert.rejects(separateStemAudio(source(), { runChunk: async () => ({ data: nonfinite, dims, release: () => released++ }) }), /non-finite/);
  assert.equal(released, 2);
  await assert.rejects(separateStemAudio(source(), { runChunk: async () => { throw new Error('inference failed'); } }), /inference failed/);
});

test('finite float stems retain headroom instead of being silently clipped', async () => {
  const result = await separateStemAudio(source([Float32Array.of(.8)]), { runChunk: async input => prediction(input, [1, 1, 1, 2]) });
  near(result.stems.vocals.channels[0][0], 1.6); near(result.stems.instrumental.channels[0][0], 2.4, 4e-7);
});

class MockWorker {
  constructor() { this.messages = []; }
  postMessage(message, transfer = []) { this.messages.push(structuredClone(message, { transfer })); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage?.({ data }); }
  get last() { return this.messages.at(-1); }
}
async function withWorker(task, WorkerClass = MockWorker) {
  const previous = globalThis.Worker; globalThis.Worker = WorkerClass;
  try { await task(); }
  finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
}
function modelStub() {
  // The fake transport needs no large allocation. The real worker independently
  // checks the actual bytes' length and digest before importing ONNX Runtime.
  const blob = new Blob(['model']); Object.defineProperty(blob, 'size', { value: STEM_MODEL.byteLength }); return blob;
}
async function ready(client) {
  const loading = client.loadModel(modelStub()), worker = client.worker;
  worker.reply({ id: worker.last.id, type: 'result', result: { ready: true } });
  await loading; return worker;
}

test('client loads lazily, refuses unsupported size and requires readiness', async () => withWorker(async () => {
  const client = new StemSeparationClient();
  assert.equal(client.worker, null);
  await assert.rejects(client.loadModel(new Blob(['wrong'])), /supported/); assert.equal(client.worker, null);
  await assert.rejects(client.separate(source()), /Load/);
  const worker = await ready(client);
  assert.equal(client.isReady, true); assert.ok(worker.last.runtimeURL.endsWith('/stems-runtime/'));
  client.dispose(); assert.equal(worker.terminated, true);
}));

test('client transfers copies, keeps source attached and allows only one job', async () => withWorker(async () => {
  const client = new StemSeparationClient(), worker = await ready(client), audio = source(), original = [...audio.channels[0]];
  const separating = client.separate(audio);
  assert.deepEqual([...audio.channels[0]], original);
  assert.notEqual(worker.last.audio.channels[0].buffer, audio.channels[0].buffer);
  assert.deepEqual([...worker.last.audio.channels[0]], original);
  await assert.rejects(client.separate(audio), /already running/);
  await assert.rejects(client.loadModel(modelStub()), /already running/);
  worker.reply({ id: worker.last.id, type: 'result', result: { stems: { vocals: audio } } });
  assert.ok((await separating).stems.vocals); assert.equal(client.isReady, true); client.dispose();
}));

test('cancel terminates the worker, rejects jobs and ignores stale results and failures', async () => withWorker(async () => {
  const events = [], client = new StemSeparationClient({ onProgress: value => events.push(value) });
  const loading = client.loadModel(modelStub()), worker = client.worker, id = worker.last.id;
  const rejected = assert.rejects(loading, { name: 'AbortError' }); client.cancel(); await rejected;
  assert.equal(worker.terminated, true); assert.equal(client.isReady, false);
  worker.reply({ id, type: 'progress', progress: { phase: 'complete' } });
  worker.reply({ id, type: 'result', result: { ready: true } });
  assert.equal(client.isReady, false); assert.equal(events.length, 0);
  const replacement = await ready(client);
  worker.onerror({ message: 'late old-worker error' });
  assert.equal(client.worker, replacement); assert.equal(client.isReady, true);
  const separating = client.separate(source()), aborted = assert.rejects(separating, { name: 'AbortError' });
  client.cancel(); await aborted; assert.equal(replacement.terminated, true); client.dispose();
}));

test('worker failures reject promptly and allow explicit model reload', async () => withWorker(async () => {
  const client = new StemSeparationClient(), worker = await ready(client), separating = client.separate(source());
  const failed = assert.rejects(separating, /worker failed/); worker.onerror({ message: 'worker failed' }); await failed;
  assert.equal(client.isReady, false); assert.equal(worker.terminated, true);
  const replacement = await ready(client), next = client.separate(source()), unreadable = assert.rejects(next, /unreadable/);
  replacement.reply({ id: replacement.last.id, type: 'mystery' }); await unreadable;
  assert.equal(client.isReady, false); client.dispose();
  await assert.rejects(client.loadModel(modelStub()), /disposed/);
}));

test('send failures release the worker; reporter exceptions cannot strand a job', async () => {
  await withWorker(async () => {
    const client = new StemSeparationClient();
    await assert.rejects(client.loadModel(modelStub()), /clone failed/);
    assert.equal(client.pending, null); assert.equal(client.worker, null); client.dispose();
  }, class extends MockWorker { postMessage() { throw new Error('clone failed'); } });
  await withWorker(async () => {
    const client = new StemSeparationClient({ onProgress: () => { throw new Error('bad reporter'); } });
    const loading = client.loadModel(modelStub()), worker = client.worker;
    worker.reply({ id: worker.last.id, type: 'progress', progress: { phase: 'loading' } });
    worker.reply({ id: worker.last.id, type: 'result', result: { ready: true } });
    await loading; assert.equal(client.isReady, true); client.dispose();
  });
});

async function withClock(task) {
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout;
  const timers = new Map(); let now = 0, nextId = 0;
  globalThis.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const clock = {
    get active() { return timers.size; },
    tick(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = end;
    },
  };
  try { await task(clock); }
  finally { globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; }
}

test('watchdog releases a model load after three inactive minutes without a worker error event', async () => withWorker(() => withClock(async clock => {
  const client = new StemSeparationClient(), loading = client.loadModel(modelStub()), worker = client.worker;
  const rejected = assert.rejects(loading, error => error.name === 'TimeoutError' && /memory or processing resources; reload/.test(error.message));
  clock.tick(179_999); assert.equal(client.worker, worker); assert.equal(clock.active, 1);
  // Unrelated replies must not extend a stuck operation.
  worker.reply({ id: worker.last.id + 1, type: 'progress', progress: { phase: 'loading' } });
  clock.tick(1); await rejected;
  assert.equal(worker.terminated, true); assert.equal(client.isReady, false);
  assert.equal(client.pending, null); assert.equal(clock.active, 0);
  await ready(client); assert.equal(client.isReady, true); assert.equal(clock.active, 0);
  client.dispose();
})));

test('watchdog renews on matching model progress rather than limiting total initialization time', async () => withWorker(() => withClock(async clock => {
  const client = new StemSeparationClient(), loading = client.loadModel(modelStub()), worker = client.worker;
  clock.tick(179_999);
  worker.reply({ id: worker.last.id, type: 'progress', progress: { phase: 'loading' } });
  clock.tick(179_999); assert.equal(client.worker, worker); assert.equal(clock.active, 1);
  worker.reply({ id: worker.last.id, type: 'result', result: { ready: true } });
  await loading; assert.equal(clock.active, 0);
  clock.tick(180_000); assert.equal(client.isReady, true); client.dispose();
})));

test('separation watchdog allows five minutes per progress interval then rejects and releases', async () => withWorker(() => withClock(async clock => {
  const client = new StemSeparationClient(), worker = await ready(client);
  assert.equal(clock.active, 0);
  const separating = client.separate(source());
  const rejected = assert.rejects(separating, error => error.name === 'TimeoutError' && /5 minutes/.test(error.message) && /shorter excerpt/.test(error.message));
  clock.tick(299_999); assert.equal(client.worker, worker);
  worker.reply({ id: worker.last.id, type: 'progress', progress: { phase: 'separating', completed: 1, total: 2 } });
  clock.tick(299_999); assert.equal(client.worker, worker); assert.equal(clock.active, 1);
  clock.tick(1); await rejected;
  assert.equal(worker.terminated, true); assert.equal(client.isReady, false); assert.equal(clock.active, 0);
  client.dispose();
})));

test('watchdog clears on completed jobs, worker errors, cancellation and disposal', async () => withWorker(() => withClock(async clock => {
  for (const outcome of ['complete', 'error', 'cancel', 'dispose']) {
    const client = new StemSeparationClient(), worker = await ready(client);
    const separating = client.separate(source()); assert.equal(clock.active, 1);
    if (outcome === 'complete') {
      worker.reply({ id: worker.last.id, type: 'result', result: { stems: {} } });
      await separating;
    } else {
      const rejected = assert.rejects(separating);
      if (outcome === 'error') worker.onerror({ message: 'device lost' });
      else client[outcome]();
      await rejected;
    }
    assert.equal(clock.active, 0, outcome);
    assert.equal(client.pending, null, outcome);
    clock.tick(300_000);
    assert.equal(client.isReady, outcome === 'complete', outcome);
    client.dispose();
  }
})));
