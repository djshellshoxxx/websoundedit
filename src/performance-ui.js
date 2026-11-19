import { RACK_EFFECTS } from './rack-config.js';
import { escapeHTML, option, bytesLabel, secondsLabel } from './ui-utils.js';

export function sourceValue(value) { return value && typeof value === 'object' ? `track:${value.trackId}` : value || 'input'; }
export function parseSource(value) { return value.startsWith('track:') ? { trackId: value.slice(6) } : value; }
const targetValue = value => value && typeof value === 'object' ? `track:${value.trackId}` : 'master';
const sameTarget = (left, right) => targetValue(left) === targetValue(right);

export class PerformancePanel {
  constructor(dependencies) {
    Object.assign(this, dependencies); this.capturePreferences = { source: 'input', beats: 4, quantize: 'bar', name: 'Loop take' };
    this.routes.register('performance', 'Live performance', (container, page) => this.render(container, page || 'loops'));
  }
  open(page = 'loops') { return this.routes.open(`performance/${page}`); }
  sources(selected, { input = true } = {}) { return `${input ? option('input', 'Live input', selected) : ''}${option('master', 'Master program', selected)}${this.getState().tracks.map(track => option(`track:${track.id}`, `Track — ${track.name}`, selected)).join('')}`; }
  async render(container, page) {
    container.innerHTML = `<div class="workspace-split"><nav class="workspace-nav" aria-label="Live performance sections">${[['loops', 'Capture & loop layers'], ['recorder', 'Long recorder'], ['recordings', 'Recording archive'], ['automation', 'Effect automation']].map(([id, label]) => `<a href="#performance/${id}"${page === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="#options/input">Input & monitoring ↗</a><a href="#help/looping">Live performance guide ↗</a></nav><section class="workspace-page"><div class="performance-topline"><output id="performance-state" role="status"></output><button id="performance-panic">Stop notes & capture</button></div><div id="performance-content"></div></section></div>`;
    container.querySelector('#performance-panic').onclick = () => this.safe(() => this.execute('midi.panic', {}));
    const body = container.querySelector('#performance-content');
    if (page === 'recorder') this.recorder(body); else if (page === 'recordings') await this.archive(body); else if (page === 'automation') this.automation(body); else this.loops(body);
    const update = () => {
      if (!container.isConnected) return; const state = this.getLiveState();
      container.querySelector('#performance-state').textContent = `Input ${state.input?.status || 'idle'} · transport ${state.transport?.playing ? 'playing' : 'stopped'} · ${state.context?.sampleRate || this.getState().sampleRate} Hz · ${state.context?.projectLayout || this.getState().outputLayout || 'stereo'}`;
      this.updateLoops(body); this.updateRecorder(body);
    }; update(); return this.subscribeLive(update);
  }
  loops(body) {
    const value = this.capturePreferences;
    body.innerHTML = `<h3>Play. Capture. Add a layer.</h3><p>Connect the input first, then capture a beat-counted loop. Each completed take becomes a new editable track and one independent loop voice.</p><div class="form-grid"><label>Capture source<select id="loop-capture-source" data-help="looping" data-guide="Choose Live input for guitar or pedal loops. Input and track captures enter playback directly on the audio clock. Master program capture can have a brief initial playback delay while its loop phase stays aligned.">${this.sources(sourceValue(value.source))}</select></label><label>Length (beats)<input id="loop-capture-beats" type="number" min="1" max="256" step="1" value="${value.beats}"></label><label>Start boundary<select id="loop-capture-quantize">${[['off', 'Immediately'], ['beat', 'Next beat'], ['bar', 'Next bar']].map(([id, label]) => option(id, label, value.quantize)).join('')}</select></label><label>Layer name<input id="loop-capture-name" maxlength="120" value="${escapeHTML(value.name)}"></label></div><div class="inline-buttons"><button id="loop-capture-start" class="primary">Start capture</button><button id="loop-capture-commit">Stop & keep take</button><button id="loop-capture-cancel">Cancel capture</button></div><output id="loop-capture-state" class="device-state" role="status"></output><p class="field-hint">Quantization follows the audio clock. Capture ends at the requested beat length. A MIDI pedal can map to loop.capture.toggle; releasing it does not start another take.</p><h4>Loop layers</h4><div id="loop-layer-list"></div><a class="button-link" href="#options/midi">Set up a pedal ↗</a>`;
    const params = () => {
      const beats = +body.querySelector('#loop-capture-beats').value; if (!Number.isInteger(beats) || beats < 1 || beats > 256) throw new Error('Choose one to 256 whole beats.');
      this.capturePreferences = { source: parseSource(body.querySelector('#loop-capture-source').value), beats, quantize: body.querySelector('#loop-capture-quantize').value, name: body.querySelector('#loop-capture-name').value }; return this.capturePreferences;
    };
    body.querySelector('#loop-capture-start').onclick = () => this.safe(() => this.execute('loop.capture.start', params()));
    body.querySelector('#loop-capture-commit').onclick = () => this.safe(() => this.execute('loop.capture.stop', { commit: true }));
    body.querySelector('#loop-capture-cancel').onclick = () => this.safe(() => this.execute('loop.capture.cancel', {}));
    this.updateLoops(body);
  }
  updateLoops(body) {
    const output = body.querySelector('#loop-capture-state'); if (!output) return;
    const state = this.getLiveState(), capture = state.capture || {}, active = ['armed', 'recording', 'committing'].includes(capture.phase);
    output.textContent = `Capture: ${capture.phase || 'idle'}${capture.beats ? ` · ${capture.beats} beats` : ''}${capture.frames ? ` · ${capture.frames.toLocaleString()} frames` : ''}${capture.error ? ' · ' + capture.error : ''}`;
    body.querySelector('#loop-capture-start').disabled = active; body.querySelector('#loop-capture-commit').disabled = !active || capture.phase === 'committing'; body.querySelector('#loop-capture-cancel').disabled = !active;
    const layers = state.loops || [], key = JSON.stringify(layers), list = body.querySelector('#loop-layer-list'); if (list.dataset.state === key) return; list.dataset.state = key;
    list.innerHTML = layers.map(layer => `<article class="loop-layer" data-loop-layer="${escapeHTML(layer.trackId)}"><div><strong>${escapeHTML(layer.name)}</strong><span>${secondsLabel(layer.duration)} · ${layer.playing ? 'playing' : 'stopped'}${layer.muted ? ' · muted' : ''}</span></div><div class="inline-buttons"><button data-layer-action="play"${layer.playing ? ' disabled' : ''}>Play</button><button data-layer-action="stop"${layer.playing ? '' : ' disabled'}>Stop</button><button data-layer-action="mute" aria-pressed="${Boolean(layer.muted)}">${layer.muted ? 'Unmute' : 'Mute'}</button><button data-layer-action="remove">Delete layer</button></div></article>`).join('') || '<p class="empty-panel-note">No loop layers yet. A completed capture appears here.</p>';
    list.querySelectorAll('[data-layer-action]').forEach(button => button.onclick = () => this.safe(() => { const trackId = button.closest('[data-loop-layer]').dataset.loopLayer, layer = layers.find(item => item.trackId === trackId); return this.execute(`loop.track.${button.dataset.layerAction}`, { trackId, ...(button.dataset.layerAction === 'mute' ? { muted: !layer.muted } : {}) }); }));
  }
  recorder(body) {
    body.innerHTML = `<h3>A long set belongs on disk.</h3><p>The recorder writes bounded PCM chunks to the browser archive. It does not expand the ten-minute, 256 MiB waveform editor.</p><div class="form-grid"><label>Recording source<select id="recorder-source">${this.sources('master')}</select></label><label>Recording name<input id="recorder-name" maxlength="120" value="DJ set"></label><label>Optional byte limit (MiB)<input id="recorder-max-bytes" type="number" min="1" step="1" placeholder="Storage limit"></label><label>Optional time limit (minutes)<input id="recorder-max-minutes" type="number" min="0.01" step="1" placeholder="Until stopped"></label></div><div class="inline-buttons"><button id="recorder-start" class="primary">Start recording</button><button id="recorder-pause">Pause</button><button id="recorder-resume">Resume</button><button id="recorder-stop">Stop & retain archive</button></div><div class="recording-dashboard"><output id="recorder-elapsed">00:00:00</output><output id="recorder-status" role="status"></output><dl><div><dt>Written</dt><dd id="recorder-written">0 MiB</dd></div><div><dt>Queued</dt><dd id="recorder-queued">0 MiB</dd></div><div><dt>Estimated space</dt><dd id="recorder-space">Unknown</dd></div></dl></div><p class="info-note">Pause omits the elapsed gap. Stop retains the recording. Quota/backpressure errors leave committed audio recoverable. Browser storage estimates can change during a take.</p><a class="button-link" href="#performance/recordings">Open recording archive ↗</a>`;
    body.querySelector('#recorder-start').onclick = () => this.safe(() => {
      const bytes = body.querySelector('#recorder-max-bytes').value, minutes = body.querySelector('#recorder-max-minutes').value;
      if (bytes && (!Number.isFinite(+bytes) || +bytes < 1) || minutes && (!Number.isFinite(+minutes) || +minutes <= 0)) throw new Error('Recording limits must be positive finite numbers.');
      return this.execute('recorder.start', { source: parseSource(body.querySelector('#recorder-source').value), name: body.querySelector('#recorder-name').value, ...(bytes ? { maxBytes: Math.floor(+bytes * 1048576) } : {}), ...(minutes ? { maxSeconds: +minutes * 60 } : {}) });
    });
    for (const action of ['pause', 'resume', 'stop']) body.querySelector(`#recorder-${action}`).onclick = () => this.safe(() => this.execute(`recorder.${action}`, {}));
    this.updateRecorder(body);
  }
  updateRecorder(body) {
    if (!body.querySelector('#recorder-status')) return; const state = this.getLiveState(), recorder = state.recorder || {}, storage = state.storage || {};
    body.querySelector('#recorder-elapsed').textContent = secondsLabel(recorder.seconds);
    body.querySelector('#recorder-status').textContent = `${recorder.status || 'idle'}${recorder.name ? ' · ' + recorder.name : ''}${recorder.error ? ' · ' + recorder.error : ''}`;
    body.querySelector('#recorder-written').textContent = bytesLabel(recorder.bytesWritten); body.querySelector('#recorder-queued').textContent = bytesLabel(recorder.queuedBytes); body.querySelector('#recorder-space').textContent = storage.remainingBytes == null ? 'Unknown' : bytesLabel(storage.remainingBytes);
    const active = ['recording', 'paused', 'stopping'].includes(recorder.status); body.querySelector('#recorder-start').disabled = active || state.capabilities?.opfs === false; body.querySelector('#recorder-pause').disabled = recorder.status !== 'recording'; body.querySelector('#recorder-resume').disabled = recorder.status !== 'paused'; body.querySelector('#recorder-stop').disabled = !['recording', 'paused'].includes(recorder.status);
  }
  async archive(body) {
    body.innerHTML = '<h3>Recording archive</h3><p>Audition or import only a bounded range. Export long files to a chosen disk destination where the browser supports it. Delete permanently removes that archived take.</p><div class="inline-buttons"><button id="archive-refresh">Refresh archive</button><button id="archive-recover">Recover interrupted recordings</button></div><p id="archive-status" role="status"></p><div id="archive-list"></div>';
    const refresh = async () => {
      body.querySelector('#archive-status').textContent = 'Reading recording manifests…';
      const result = await this.execute('recordings.list', {}); if (!body.isConnected) return;
      const recordings = Array.isArray(result) ? result : result?.recordings || this.getLiveState().recordings || [];
      body.querySelector('#archive-status').textContent = `${recordings.length} archived recording${recordings.length === 1 ? '' : 's'}.`;
      body.querySelector('#archive-list').innerHTML = recordings.map(recording => `<article class="archive-recording" data-recording-id="${escapeHTML(recording.id)}"><header><h4>${escapeHTML(recording.name || recording.id)}</h4><span>${escapeHTML(recording.status)} · ${secondsLabel(recording.seconds)} · ${bytesLabel(recording.bytes)}</span></header><p>${recording.sampleRate} Hz · ${recording.channels} channels · ${escapeHTML(recording.layout)}</p><div class="form-grid"><label>Range start (seconds)<input data-archive-start type="number" min="0" max="${recording.seconds}" step="0.001" value="0"></label><label>Range end (seconds)<input data-archive-end type="number" min="0" max="${recording.seconds}" step="0.001" value="${Math.min(recording.seconds || 0, 30)}"></label></div><div class="inline-buttons"><button data-archive-action="auditionRange">Audition range</button><button data-archive-action="importRange">Import range as track</button><button data-archive-action="export">Export full recording</button><button data-archive-action="exportRange">Export range</button><button data-archive-action="delete" class="danger">Delete archive</button></div><div class="archive-delete-confirm" hidden><p>This removes the stored chunks for this recording. Imported project clips remain available.</p><button data-archive-confirm-delete>Delete this recording permanently</button><button data-archive-cancel-delete>Keep recording</button></div></article>`).join('') || '<p class="empty-panel-note">No recording manifests found. Start a recording to create one.</p>';
      body.querySelectorAll('[data-archive-action]').forEach(button => button.onclick = () => this.safe(async () => {
        const row = button.closest('[data-recording-id]'), recordingId = row.dataset.recordingId, action = button.dataset.archiveAction;
        if (action === 'delete') { row.querySelector('.archive-delete-confirm').hidden = false; return; }
        const start = +row.querySelector('[data-archive-start]').value, end = +row.querySelector('[data-archive-end]').value;
        if (action !== 'export' && (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)) throw new Error('Choose a nonempty archive range.');
        if (action === 'export' || action === 'exportRange') await this.exportRecording({ recordingId, ...(action === 'exportRange' ? { start, end } : {}) });
        else await this.execute(`recordings.${action}`, { recordingId, start, end });
        body.querySelector('#archive-status').textContent = action.startsWith('export') ? 'Recording export completed.' : action === 'importRange' ? 'Range imported into a new project track.' : 'Auditioning the selected archive range.';
      }));
      body.querySelectorAll('[data-archive-cancel-delete]').forEach(button => button.onclick = () => { button.closest('.archive-delete-confirm').hidden = true; });
      body.querySelectorAll('[data-archive-confirm-delete]').forEach(button => button.onclick = () => this.safe(async () => { await this.execute('recordings.delete', { recordingId: button.closest('[data-recording-id]').dataset.recordingId }); await refresh(); }));
    };
    body.querySelector('#archive-refresh').onclick = () => this.safe(refresh);
    body.querySelector('#archive-recover').onclick = () => this.safe(async () => { const result = await this.execute('recordings.list', {}); const recordings = Array.isArray(result) ? result : result.recordings || [], recorder = this.getLiveState().recorder; for (const recording of recordings) if (['recording','paused','error'].includes(recording.status) && !(recording.id === recorder?.recordingId && ['recording','paused','stopping'].includes(recorder.status))) await this.execute('recordings.recover', {recordingId: recording.id}); await refresh(); });
    await this.safe(refresh);
  }
  automation(body) {
    const state = this.getLiveState();
    body.innerHTML = `<h3>Schedule an effect on the audio clock</h3><p>Use time/value points for repeatable sweeps. Times stay relative to the project timeline, including when rendering a later range.</p><div class="form-grid"><label>Rack target<select id="automation-target">${this.sources('master', { input: false })}</select></label><label>Effect stage<select id="automation-stage"></select></label><label>Parameter<select id="automation-param"></select></label></div><p id="automation-range" class="field-hint"></p><label>Points (seconds, value, curve)<textarea id="automation-points" class="code-editor" spellcheck="false">[{"time":0,"value":0,"curve":"linear"},{"time":4,"value":1,"curve":"linear"}]</textarea></label><label class="checkbox-field"><input id="automation-enabled" type="checkbox" checked> Enable automation lane</label><div class="inline-buttons"><button id="automation-apply" class="primary">Set lane</button><button id="automation-clear">Clear target automation</button></div><p id="automation-state" role="status"></p><details><summary>Example macro for the selected lane</summary><pre><code id="automation-example"></code></pre></details>`;
    const $ = selector => body.querySelector(selector);
    const rack = () => (this.getLiveState().racks || []).find(item => sameTarget(item.target, parseSource($('#automation-target').value)));
    const refreshParams = () => { const stage = rack()?.chain.find(item => item.id === $('#automation-stage').value); const fields = stage ? [{ key: 'wet', label: 'Wet / dry', min: 0, max: 1 }, ...RACK_EFFECTS[stage.effect].fields.filter(field => field.type !== 'select')] : []; $('#automation-param').innerHTML = fields.map(field => option(field.key, field.label, 'wet')).join(''); refreshRange(); };
    const refreshStages = () => { $('#automation-stage').innerHTML = (rack()?.chain || []).map((stage, index) => option(stage.id, `${index + 1}. ${RACK_EFFECTS[stage.effect].title}`, '')).join(''); refreshParams(); };
    const refreshRange = () => { const stage = rack()?.chain.find(item => item.id === $('#automation-stage').value), key = $('#automation-param').value, field = key === 'wet' ? { min: 0, max: 1, label: 'Wet/dry' } : RACK_EFFECTS[stage?.effect]?.fields.find(item => item.key === key); $('#automation-range').textContent = field ? `${field.label}: ${field.min}–${field.max}${field.unit ? ' ' + field.unit : ''}. Curves: step or linear. Up to the runtime’s advertised event bound.` : 'Add a live effect to this target first. The selection-preview rack is separate.'; $('#automation-apply').disabled = !stage || !field; };
    $('#automation-target').onchange = refreshStages; $('#automation-stage').onchange = refreshParams; $('#automation-param').onchange = refreshRange;
    const read = () => { const points = JSON.parse($('#automation-points').value); if (!Array.isArray(points) || !points.length || points.length > 8192) throw new Error('Provide a nonempty bounded array of automation points.'); return { target: parseSource($('#automation-target').value), lanes: [{ slotId: $('#automation-stage').value, param: $('#automation-param').value, points }], enabled: $('#automation-enabled').checked }; };
    $('#automation-apply').onclick = () => this.safe(async () => { const params = read(); await this.execute('automation.set', params); $('#automation-state').textContent = 'Automation lane set. Playback follows the audio clock.'; $('#automation-example').textContent = `// WebSoundEdit Macro 1\nautomation.set(${JSON.stringify(params, null, 2)});\ntransport.play({});`; });
    $('#automation-clear').onclick = () => this.safe(async () => { await this.execute('automation.clear', { target: parseSource($('#automation-target').value) }); $('#automation-state').textContent = 'Automation cleared for this target.'; });
    refreshStages(); if (!state.racks?.length) $('#automation-state').textContent = 'Open the Effects rack and switch to Live mode to configure a target.';
  }
}
