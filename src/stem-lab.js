import './stem-lab.css';
import { decodeWav, encodeWav } from './wav.js';
import { StemSeparationClient } from './stems/client.js';
import { STEM_MODEL } from './stems/model.js';

const $ = selector => document.querySelector(selector);
const MAX_WAV_BYTES = 24 * 1024 * 1024;
const OUTPUTS = [
  ['vocals', 'Vocals', 'Model prediction of singing and vocal content.'],
  ['instrumental', 'Instrumental', 'Drums + bass + other model predictions.'],
  ['drums', 'Drums', 'Model prediction of drums and percussion.'],
  ['bass', 'Bass', 'Model prediction of bass instruments.'],
  ['other', 'Other instruments', 'Remaining instrument prediction; may include vocal bleed.'],
];
const nodes = {
  model: $('#stem-model-file'), audio: $('#stem-audio-file'), load: $('#stem-load-model'),
  separate: $('#stem-separate'), cancel: $('#stem-cancel'), release: $('#stem-release'),
  modelStatus: $('#model-status'), sourceStatus: $('#source-status'), status: $('#stem-status'),
  error: $('#stem-error'), progress: $('#stem-progress'), results: $('#stem-results'),
  resultList: $('#stem-result-list'), summary: $('#stem-result-summary'),
  original: $('#original-preview'), originalPlayer: $('#original-player'),
};
let modelFile = null, source = null, sourceName = '', originalURL = null;
let resultURLs = [], busy = '', epoch = 0, disposed = false;

const client = new StemSeparationClient({ onProgress(progress) {
  if (!busy || disposed) return;
  nodes.status.textContent = progress.message || 'Processing…';
  if (progress.total > 0 && Number.isFinite(progress.completed)) {
    nodes.progress.max = progress.total;
    nodes.progress.value = Math.min(progress.total, Math.max(0, progress.completed));
  } else nodes.progress.removeAttribute('value');
} });

$('#model-filename').textContent = STEM_MODEL.filename;
$('#model-size').textContent = `${(STEM_MODEL.byteLength / 1e6).toFixed(1)} MB`;
$('#model-card').href = STEM_MODEL.modelCardUrl;

function setStatus(message) { nodes.status.textContent = message; }
function clearError() { nodes.error.hidden = true; nodes.error.textContent = ''; }
function showError(error) {
  nodes.error.textContent = error?.message || String(error);
  nodes.error.hidden = false;
}
function updateControls() {
  const active = Boolean(busy);
  nodes.model.disabled = active;
  nodes.audio.disabled = active;
  nodes.load.disabled = active || !modelFile || client.isReady;
  nodes.separate.disabled = active || !client.isReady || !source;
  nodes.cancel.disabled = !active;
  nodes.release.disabled = active || !client.isReady;
  document.body.setAttribute('aria-busy', String(active));
}
function clearResults() {
  for (const player of nodes.resultList.querySelectorAll('audio')) {
    player.pause(); player.removeAttribute('src'); player.load();
  }
  nodes.resultList.replaceChildren();
  for (const url of resultURLs) URL.revokeObjectURL(url);
  resultURLs = [];
  nodes.results.hidden = true;
  nodes.summary.textContent = '';
}
function clearSource() {
  source = null; sourceName = '';
  nodes.originalPlayer.pause(); nodes.originalPlayer.removeAttribute('src'); nodes.originalPlayer.load();
  if (originalURL) URL.revokeObjectURL(originalURL);
  originalURL = null;
  nodes.original.hidden = true;
}
function clearModelStatus() {
  nodes.modelStatus.textContent = modelFile
    ? `${modelFile.name} selected. Load it to verify and initialize the model.`
    : 'No model selected.';
}
function cancel(message = 'Cancelled. Load the model again to retry.') {
  epoch++;
  client.cancel();
  const preparingAudio = busy === 'audio';
  busy = '';
  if (preparingAudio) { clearSource(); nodes.sourceStatus.textContent = 'Source preparation cancelled. Choose the WAV again.'; nodes.audio.value = ''; }
  clearModelStatus();
  clearError();
  nodes.progress.max = 1; nodes.progress.value = 0;
  setStatus(message);
  updateControls();
}
async function run(phase, operation) {
  if (busy || disposed) return;
  const token = ++epoch;
  busy = phase; clearError(); nodes.progress.removeAttribute('value'); updateControls();
  try { await operation(token); }
  catch (error) {
    if (token !== epoch || disposed) return;
    if (error?.name === 'AbortError') setStatus('Cancelled. Load the model again to retry.');
    else { showError(error); setStatus('The operation stopped. Review the message below.'); }
    if (phase === 'audio') nodes.sourceStatus.textContent = 'Source not loaded. Choose a supported short WAV to retry.';
    if (!client.isReady) clearModelStatus();
  } finally {
    if (token === epoch && !disposed) { busy = ''; nodes.progress.max = 1; nodes.progress.value = 0; updateControls(); }
  }
}

nodes.model.addEventListener('change', () => {
  if (busy) cancel('Model changed. Load the selected model to continue.');
  else { epoch++; client.cancel(); }
  modelFile = nodes.model.files?.[0] || null;
  clearResults(); clearError(); clearModelStatus();
  if (modelFile && modelFile.size !== STEM_MODEL.byteLength) {
    showError(new RangeError(`This prototype requires ${STEM_MODEL.filename} (${STEM_MODEL.byteLength.toLocaleString('en-US')} bytes). The selected file has a different size.`));
    modelFile = null;
    nodes.modelStatus.textContent = 'Unsupported model file. Select the exact file linked in the prototype notes.';
  }
  setStatus(client.isReady && source ? 'Ready to separate.' : 'Choose the supported model and source WAV, then load the model.');
  updateControls();
});

nodes.load.addEventListener('click', () => run('model', async token => {
  if (!modelFile) throw new Error('Choose the supported ONNX model first.');
  const file = modelFile;
  nodes.modelStatus.textContent = 'Verifying the local model and preparing inference…';
  setStatus('Loading the local model. This may take a while.');
  await client.loadModel(file);
  if (token !== epoch || disposed) return;
  nodes.modelStatus.textContent = `${file.name} verified and ready. Inference uses the local CPU.`;
  setStatus(source ? 'Ready. Select Separate stems to process the source.' : 'Model ready. Choose a source WAV next.');
}));

function validateSource(audio) {
  if (audio.channels.length < 1 || audio.channels.length > 2) throw new RangeError('Choose a mono or stereo WAV. This prototype does not downmix surround audio.');
  const frames = audio.channels[0].length;
  if (!frames || frames > audio.sampleRate * STEM_MODEL.maxSeconds) throw new RangeError(`Choose a non-empty WAV no longer than ${STEM_MODEL.maxSeconds} seconds. Export a shorter region from WebSoundEdit.`);
  for (const channel of audio.channels) for (const value of channel) {
    if (!Number.isFinite(value)) throw new RangeError('The WAV contains non-finite audio samples.');
    if (Math.abs(value) > 1) throw new RangeError('Audio peaks exceed full scale. Normalize to -1 dBFS in WebSoundEdit and export the source again. Resampling can also create peaks.');
  }
}

async function prepareSource(file, token) {
  if (!file.size || file.size > MAX_WAV_BYTES) throw new RangeError('Choose a non-empty WAV up to 24 MiB. Export a short region from WebSoundEdit.');
  const bytes = await file.arrayBuffer();
  if (token !== epoch || disposed) return null;
  let audio = decodeWav(bytes, { maxDurationSeconds: STEM_MODEL.maxSeconds, maxChannels: 2 });
  validateSource(audio);
  const originalRate = audio.sampleRate;
  if (originalRate !== STEM_MODEL.sampleRate) {
    setStatus(`Resampling ${originalRate.toLocaleString('en-US')} Hz audio to 44.1 kHz…`);
    const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error('This browser cannot resample audio. Export a 44.1 kHz WAV from WebSoundEdit.');
    const frames = Math.max(1, Math.round(audio.channels[0].length * STEM_MODEL.sampleRate / originalRate));
    const context = new OfflineContext(audio.channels.length, frames, STEM_MODEL.sampleRate);
    const buffer = context.createBuffer(audio.channels.length, audio.channels[0].length, originalRate);
    audio.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
    const input = context.createBufferSource();
    input.buffer = buffer; input.connect(context.destination); input.start();
    const rendered = await context.startRendering();
    input.disconnect();
    if (token !== epoch || disposed) return null;
    if (rendered.sampleRate !== STEM_MODEL.sampleRate) throw new Error('This browser returned an unsupported resampling rate. Export a 44.1 kHz WAV from WebSoundEdit.');
    audio = { sampleRate: STEM_MODEL.sampleRate, channels: Array.from({ length: rendered.numberOfChannels }, (_, index) => rendered.getChannelData(index).slice()) };
    validateSource(audio);
  }
  return { audio, originalRate };
}

nodes.audio.addEventListener('change', () => {
  const file = nodes.audio.files?.[0];
  if (busy) cancel('Source changed. Preparing the selected WAV.');
  clearResults(); clearSource(); clearError();
  if (!file) { nodes.sourceStatus.textContent = 'No source selected.'; updateControls(); return; }
  void run('audio', async token => {
    nodes.sourceStatus.textContent = `Preparing ${file.name}…`; setStatus('Reading the local WAV…');
    const prepared = await prepareSource(file, token);
    if (!prepared || token !== epoch || disposed) return;
    const { audio, originalRate } = prepared;
    source = audio; sourceName = file.name;
    const seconds = audio.channels[0].length / audio.sampleRate;
    originalURL = URL.createObjectURL(new Blob([encodeWav(audio, { bitDepth: 16 })], { type: 'audio/wav' }));
    nodes.originalPlayer.src = originalURL; nodes.original.hidden = false;
    nodes.sourceStatus.textContent = `${file.name} · ${seconds.toFixed(3)} s · ${audio.channels.length === 1 ? 'mono (duplicated for inference)' : 'stereo'} · ${originalRate === STEM_MODEL.sampleRate ? '44.1 kHz' : `${originalRate.toLocaleString('en-US')} Hz resampled to 44.1 kHz`}`;
    setStatus(client.isReady ? 'Ready. Select Separate stems to process the source.' : 'Source ready. Load the supported model to continue.');
  });
});

function pausePlayers() {
  for (const player of document.querySelectorAll('audio')) player.pause();
}
function safeBaseName(name) { return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'audio'; }
function renderResults(result, milliseconds) {
  // Create all URLs before publishing a result; errors cannot leave partial downloads.
  const urls = [], fragment = document.createDocumentFragment();
  try {
    for (const [id, title, description] of OUTPUTS) {
      const audio = result.stems[id];
      if (!audio) throw new Error(`The model result is missing ${id}.`);
      const downloadURL = URL.createObjectURL(new Blob([encodeWav(audio, { bitDepth: 32, float: true })], { type: 'audio/wav' }));
      urls.push(downloadURL);
      const previewURL = URL.createObjectURL(new Blob([encodeWav(audio, { bitDepth: 16 })], { type: 'audio/wav' }));
      urls.push(previewURL);
      const card = document.createElement('article'); card.className = 'stem-card'; card.dataset.stem = id;
      const heading = document.createElement('h3'); heading.textContent = title;
      const text = document.createElement('p'); text.textContent = description;
      const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = previewURL; player.setAttribute('aria-label', `${title} preview`);
      const link = document.createElement('a'); link.href = downloadURL; link.download = `${safeBaseName(sourceName)}-${id}.wav`; link.textContent = `Download ${title.toLowerCase()} · float WAV`;
      card.append(heading, text, player, link); fragment.append(card);
    }
    resultURLs = urls; nodes.resultList.replaceChildren(fragment);
    const seconds = result.stems.vocals.channels[0].length / STEM_MODEL.sampleRate;
    nodes.summary.textContent = `${seconds.toFixed(3)} s · stereo · 44.1 kHz · separation took ${(milliseconds / 1000).toFixed(1)} s on this device`;
    nodes.results.hidden = false;
  } catch (error) { for (const url of urls) URL.revokeObjectURL(url); throw error; }
}

nodes.separate.addEventListener('click', () => run('separate', async token => {
  if (!client.isReady || !source) throw new Error('Load a supported model and a source WAV first.');
  clearResults(); pausePlayers();
  setStatus('Separating the source with the local neural model…');
  const started = performance.now();
  const result = await client.separate(source);
  if (token !== epoch || disposed) return;
  renderResults(result, performance.now() - started);
  setStatus('Separation complete. Listen to the stems or download float WAV files.');
}));

nodes.cancel.addEventListener('click', () => cancel());
nodes.release.addEventListener('click', () => cancel('Model released. Existing source and downloads remain available.'));
// Play one stream at a time so comparisons never accidentally mix the stems.
document.addEventListener('play', event => {
  if (!(event.target instanceof HTMLMediaElement)) return;
  for (const player of document.querySelectorAll('audio')) if (player !== event.target) player.pause();
}, true);
window.addEventListener('pagehide', event => {
  pausePlayers();
  if (event.persisted) cancel('Model released while away. Load it again to continue.');
  else { epoch++; busy = ''; client.dispose(); disposed = true; clearSource(); clearResults(); }
});
updateControls();
