import { STEM_MODEL } from './model.js';
import { assertModelIdentity, separateStemAudio } from './pipeline.js';

let ort = null, session = null, running = false;
const progress = (id, message) => self.postMessage({ id, type: 'progress', progress: message });

async function releaseSession() {
  const previous = session;
  session = null;
  if (previous) await previous.release();
}

async function loadModel(file, runtimeURL, id) {
  await releaseSession();
  if (!(file instanceof Blob) || file.size !== STEM_MODEL.byteLength) throw new RangeError(`Choose the supported ${STEM_MODEL.filename} model (${STEM_MODEL.byteLength} bytes).`);
  if (!globalThis.crypto?.subtle) throw new Error('Model verification requires HTTPS or localhost and Web Crypto support.');
  progress(id, { phase: 'validating', completed: 0, total: 1, message: 'Verifying the local model SHA-256…' });
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== STEM_MODEL.byteLength) throw new RangeError('The local model file is incomplete.');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  assertModelIdentity({ byteLength: bytes.byteLength, sha256 });
  const assetURL = new URL(runtimeURL);
  if (assetURL.origin !== self.location.origin || !assetURL.pathname.endsWith('/stems-runtime/') || assetURL.search || assetURL.hash) throw new Error('Stem runtime assets must be served from this site.');
  progress(id, { phase: 'loading', completed: 0, total: 1, message: 'Loading the verified neural model into memory…' });
  ort ||= await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = assetURL.href;
  // Optimizing this large graph can transiently expand it beyond device memory.
  session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled' });
  if (session.inputNames.length !== 1 || session.inputNames[0] !== STEM_MODEL.inputName || !session.outputNames.includes(STEM_MODEL.outputName)) throw new Error('The verified model exposes an unsupported input/output contract.');
  progress(id, { phase: 'complete', completed: 1, total: 1, message: 'Neural model ready. Audio stays on this device.' });
  return { ready: true, modelId: STEM_MODEL.id };
}

async function infer(input) {
  const tensor = new ort.Tensor('float32', input, [1, 2, STEM_MODEL.segmentFrames]);
  let outputs;
  const release = () => {
    tensor.dispose();
    if (outputs) for (const value of Object.values(outputs)) value.dispose();
  };
  try {
    outputs = await session.run({ [STEM_MODEL.inputName]: tensor });
    const prediction = outputs[STEM_MODEL.outputName];
    return { data: prediction?.data, dims: prediction?.dims, release };
  } catch (error) {
    release();
    throw error;
  }
}

self.onmessage = async ({ data }) => {
  const id = data?.id;
  if (!Number.isSafeInteger(id) || id < 1) return;
  if (running) {
    self.postMessage({ id, type: 'error', error: { message: 'A stem operation is already running.', name: 'Error' } });
    return;
  }
  running = true;
  try {
    let result;
    if (data.method === 'loadModel') result = await loadModel(data.file, data.runtimeURL, id);
    else if (data.method === 'separate') {
      if (!session) throw new Error('Load the supported local model before separating audio.');
      result = await separateStemAudio(data.audio, { runChunk: infer, onProgress: value => progress(id, value) });
      result.metrics.runtime = 'onnxruntime-web/wasm';
      result.metrics.threads = 1;
      progress(id, { phase: 'complete', completed: result.metrics.chunks, total: result.metrics.chunks, message: 'Neural separation complete. Audition the stems before using them.' });
    } else throw new RangeError('Unknown stem operation.');
    const transfer = result.stems ? Object.values(result.stems).flatMap(stem => stem.channels.map(channel => channel.buffer)) : [];
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (error) {
    try { await releaseSession(); } catch { /* The client also terminates a failed worker. */ }
    self.postMessage({ id, type: 'error', error: { message: error?.message || String(error), name: error?.name || 'Error' } });
  } finally {
    running = false;
  }
};
