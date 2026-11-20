// Optional real inference check. The user supplies the exact research model.
// This executes the WASM engine in Node; it is not a browser qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { STEM_MODEL } from '../src/stems/model.js';
import { assertModelIdentity, separateStemAudio } from '../src/stems/pipeline.js';
import { stemFixture } from '../tests/stem-fixture.js';
import { encodeWav, decodeWav } from '../src/wav.js';

const modelPath = process.argv[2];
if (!modelPath) throw new Error('Usage: node scripts/verify-stem-model.mjs /path/to/htdemucs_fp16weights.onnx');
const metadata = await stat(modelPath);
assert.equal(metadata.size, STEM_MODEL.byteLength, 'Model size does not match the pinned research artifact.');
const model = await readFile(modelPath);
assertModelIdentity({ byteLength: model.byteLength, sha256: createHash('sha256').update(model).digest('hex') });
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = `${resolve('node_modules/onnxruntime-web/dist')}/`;
console.log(`Loading verified ${STEM_MODEL.id} with ONNX Runtime Web ${ort.env.versions.web} (Node WASM).`);
const loadStart = performance.now();
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false });
const loadMs = performance.now() - loadStart;
try {
  assert.deepEqual(session.inputNames, [STEM_MODEL.inputName]);
  assert.ok(session.outputNames.includes(STEM_MODEL.outputName));
  const source = stemFixture(), original = source.channels[0].slice();
  const result = await separateStemAudio(source, {
    onProgress: ({ message }) => console.log(message),
    runChunk: async input => {
      const tensor = new ort.Tensor('float32', input, [1, 2, STEM_MODEL.segmentFrames]);
      let outputs;
      const release = () => { tensor.dispose(); if (outputs) for (const output of Object.values(outputs)) output.dispose(); };
      try {
        outputs = await session.run({ mix: tensor });
        return { data: outputs.stems.data, dims: outputs.stems.dims, release };
      } catch (error) { release(); throw error; }
    },
  });
  assert.deepEqual(source.channels[0], original, 'Inference must preserve the original PCM.');
  assert.equal(result.metrics.chunks, 2, 'Nine seconds must exercise overlapping inference.');
  const stats = {};
  for (const [name, audio] of Object.entries(result.stems)) {
    assert.equal(audio.sampleRate, 44100);
    assert.equal(audio.channels.length, 2);
    assert.equal(audio.channels[0].length, original.length);
    let squares = 0, peak = 0;
    for (const channel of audio.channels) for (const sample of channel) {
      assert.ok(Number.isFinite(sample), `${name} has a non-finite output.`);
      squares += sample * sample; peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(squares / (original.length * 2));
    const roundTrip = decodeWav(encodeWav(audio, { bitDepth: 32, float: true }));
    assert.deepEqual(roundTrip.channels, audio.channels, `${name} float export must preserve all predicted samples.`);
    stats[name] = { rms, peak, frames: original.length, channels: 2 };
  }
  assert.ok(stats.instrumental.rms > 1e-8, 'The combined accompaniment must contain sound for this instrumental fixture.');
  assert.notDeepEqual(result.stems.vocals.channels[0], original, 'The vocal output must be an inference result, not an input passthrough.');
  assert.notDeepEqual(result.stems.bass.channels[0], result.stems.drums.channels[0], 'Predicted sources must not all contain the same center channel.');
  const evidence = {
    checkedAt: new Date().toISOString(), modelId: STEM_MODEL.id, sha256: STEM_MODEL.sha256,
    runtime: ort.env.versions.web, execution: 'ONNX Runtime Web WASM in Node; not a browser test',
    fixture: '9-second deterministic centered synthetic bass/lead/percussion; not a perceptual quality benchmark',
    loadMs, ...result.metrics, outputs: stats,
    checks: ['real pinned weights', 'two overlapping inference chunks', 'mono input retained', 'finite distinct sources and nonzero accompaniment', 'all five stereo outputs retain frame count', 'sample-exact float WAV round trips'],
    limits: ['No singing or real recording used.', 'No SDR, perceptual quality, device-memory or browser compatibility qualification.'],
  };
  const outputPath = fileURLToPath(new URL('../test-results/stem-model-node.json', import.meta.url));
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally { await session.release(); }
