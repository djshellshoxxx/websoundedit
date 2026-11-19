import { THEMES } from './creative-ui.js';
import { CHANNEL_LAYOUTS } from './channel-layout.js';
import { escapeHTML, option, bytesLabel } from './ui-utils.js';

export function normalizeWorkbenchPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workbench options must be an object.');
  const input = value.input || {}, output = value.output || {};
  const device = id => typeof id === 'string' && id.length <= 200 ? id : 'default';
  const channels = input.channels ?? [0];
  if (!Array.isArray(channels) || !channels.length || channels.length > 8 || channels.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 31) || new Set(channels).size !== channels.length) throw new Error('Choose unique input channel indices from 0 to 31.');
  if (input.gainDb !== undefined && (!Number.isFinite(input.gainDb) || input.gainDb < -96 || input.gainDb > 24)) throw new Error('Input gain must be −96 to 24 dB.');
  return { tooltips: value.tooltips !== false, input: { source: input.source === 'display' ? 'display' : 'microphone', deviceId: device(input.deviceId), channels: [...channels], gainDb: input.gainDb ?? 0, echoCancellation: input.echoCancellation === true, noiseSuppression: input.noiseSuppression === true, autoGainControl: input.autoGainControl === true }, output: { deviceId: device(output.deviceId), monitorLayout: Object.hasOwn(CHANNEL_LAYOUTS, output.monitorLayout) ? output.monitorLayout : 'stereo' } };
}
const SECTIONS = [['general', 'General & theme'], ['input', 'Audio input'], ['output', 'Audio output'], ['layout', 'Channel layout'], ['midi', 'MIDI & pedals'], ['shortcuts', 'Keyboard shortcuts'], ['macros', 'Macros & import triggers'], ['storage', 'Recording & storage'], ['streaming', 'Streaming companion'], ['help', 'Help & recovery']];

export class OptionsPanel {
  constructor(dependencies) { Object.assign(this, dependencies); this.routes.register('options', 'Options', (container, page) => this.render(container, page || 'general')); }
  open(page = 'general') { return this.routes.open(`options/${page}`); }
  async render(container, page) {
    if (!SECTIONS.some(([id]) => id === page)) page = 'general';
    container.innerHTML = `<div class="workspace-split"><nav class="workspace-nav" aria-label="Options sections">${SECTIONS.map(([id, label]) => `<a href="#options/${id}"${page === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav><section class="workspace-page" id="options-page"><h3>${escapeHTML(SECTIONS.find(([id]) => id === page)[1])}</h3><div id="options-content"></div><p id="options-message" role="status"></p></section></div>`;
    const body = container.querySelector('#options-content');
    if (page === 'general') this.general(body);
    else if (page === 'input' || page === 'output') return this.audio(body, page);
    else if (page === 'layout') this.layout(body);
    else if (page === 'midi') return this.creative.renderMidi(body);
    else if (page === 'shortcuts') this.shortcuts(body);
    else if (page === 'macros') this.macros(body);
    else if (page === 'storage') return this.storage(body);
    else if (page === 'streaming') return this.streaming(body);
    else this.help(body);
  }
  message(text) { const node = document.querySelector('#options-message'); if (node) node.textContent = text; }
  general(body) {
    const preferences = this.getPreferences();
    body.innerHTML = `<p>These preferences change the workbench without replacing the open project.</p><div class="form-grid"><label>Theme<select id="options-theme">${Object.entries(THEMES).map(([id, title]) => option(id, title, this.getTheme())).join('')}</select></label><label class="checkbox-field"><input id="options-tooltips" type="checkbox"${preferences.tooltips ? ' checked' : ''}> Show guidance on hover and keyboard focus</label></div><p class="field-hint">Turning tips off preserves accessible names, form labels and the full guide. Device access and active connections are never restored from settings.</p><div class="inline-buttons"><button id="options-save">Save settings JSON</button><button id="options-load">Load settings JSON</button><a class="button-link" href="#help/navigation">Open the illustrated guide ↗</a></div>`;
    body.querySelector('#options-theme').onchange = event => this.safe(() => this.execute('ui.theme.set', { theme: event.target.value }));
    body.querySelector('#options-tooltips').onchange = event => this.safe(() => this.execute('ui.tooltips.set', { enabled: event.target.checked }));
    body.querySelector('#options-save').onclick = this.saveSettings; body.querySelector('#options-load').onclick = this.loadSettings;
  }
  async audio(body, page) {
    const preferences = this.getPreferences(), live = this.getLiveState();
    body.innerHTML = '<p role="status">Reading available device names without requesting capture…</p>';
    let devices = { inputs: [], outputs: [], permission: 'unknown' }, problem = '';
    try { devices = await this.execute('audio.devices.list', {}); } catch (error) { problem = error.message; }
    if (!body.isConnected) return;
    const latest = this.getLiveState();
    if (page === 'input') {
      body.innerHTML = `<p>Choose a microphone/interface or display audio. Start input requests permission; merely opening Options does not.</p><div class="form-grid"><label>Source<select id="input-source">${option('microphone', 'Microphone / audio interface', preferences.input.source)}${option('display', 'System / tab audio (browser picker)', preferences.input.source)}</select></label><label>Input device<select id="input-device">${option('default', 'System default', preferences.input.deviceId)}${(devices.inputs || []).filter(device => device.deviceId !== 'default').map(device => option(device.deviceId, device.label || 'Unnamed input (permission not granted)', preferences.input.deviceId)).join('')}</select></label><label>Input channel indices<input id="input-channels" value="${preferences.input.channels.join(', ')}" placeholder="0, 1" data-guide="Zero-based physical input channel indices, separated by commas. Availability is checked after acquisition." data-help="surround"></label><label>Input gain (dB)<input id="input-gain" type="number" min="-96" max="24" step="0.1" value="${preferences.input.gainDb}"></label></div><div class="input-processing"><label class="checkbox-field"><input type="checkbox" id="input-echo"${preferences.input.echoCancellation ? ' checked' : ''}> Request echo cancellation</label><label class="checkbox-field"><input type="checkbox" id="input-noise"${preferences.input.noiseSuppression ? ' checked' : ''}> Request noise suppression</label><label class="checkbox-field"><input type="checkbox" id="input-auto"${preferences.input.autoGainControl ? ' checked' : ''}> Request automatic gain control</label></div><p class="field-hint">Capture processing depends on the browser/device. Off is the default for music. System audio is available only when the browser picker supplies an audio track.</p><div class="inline-buttons"><button id="input-start" class="primary">Start input</button><button id="input-stop">Stop input</button><button id="input-apply">Apply gain / processing</button></div><div class="monitor-controls"><label class="checkbox-field"><input id="input-monitor" type="checkbox"${latest.input?.monitor ? ' checked' : ''}> Enable input monitoring</label><label>Monitor gain (dB)<input id="monitor-gain" type="number" min="-96" max="12" step="0.1" value="0"></label></div><p class="info-note">Monitoring defaults off. The project channel layout and selected input channels do not prove that your output device supports surround.</p><output id="device-state" class="device-state" role="status"></output>`;
      const read = () => {
        const raw = body.querySelector('#input-channels').value.split(',').map(value => value.trim()); if (raw.some(value => !/^\d+$/.test(value))) throw new Error('Enter channel indices separated by commas, such as 0, 1.');
        return normalizeWorkbenchPreferences({ ...preferences, input: { source: body.querySelector('#input-source').value, deviceId: body.querySelector('#input-device').value, channels: raw.map(Number), gainDb: +body.querySelector('#input-gain').value, echoCancellation: body.querySelector('#input-echo').checked, noiseSuppression: body.querySelector('#input-noise').checked, autoGainControl: body.querySelector('#input-auto').checked } }).input;
      };
      body.querySelector('#input-start').onclick = () => this.safe(async () => { const input = read(); const button = body.querySelector('#input-start'); button.disabled = true; try { await this.execute('audio.input.start', { ...input, monitor: false }); this.updatePreferences({ ...this.getPreferences(), input }); } finally { if (button.isConnected) button.disabled = false; } });
      body.querySelector('#input-stop').onclick = () => this.safe(() => this.execute('audio.input.stop', {}));
      body.querySelector('#input-apply').onclick = () => this.safe(async () => { const input = read(); if (this.getLiveState().input?.status === 'active') { const { gainDb, echoCancellation, noiseSuppression, autoGainControl } = input; await this.execute('audio.input.set', { gainDb, echoCancellation, noiseSuppression, autoGainControl }); } this.updatePreferences({ ...this.getPreferences(), input }); this.message('Input preferences saved. Channel/device changes require Start input.'); });
      const monitor = () => this.safe(async () => { const control = body.querySelector('#input-monitor'); try { await this.execute('audio.monitor.set', { enabled: control.checked, gainDb: +body.querySelector('#monitor-gain').value }); } catch (error) { control.checked = Boolean(this.getLiveState().input?.monitor); throw error; } });
      body.querySelector('#input-monitor').onchange = monitor; body.querySelector('#monitor-gain').onchange = monitor;
    } else {
      body.innerHTML = `<p>Choose a destination and an explicit monitoring layout. The actual hardware capability is reported below.</p><div class="form-grid"><label>Output device<select id="output-device"${latest.capabilities?.outputSelection ? '' : ' disabled'}>${option('default', 'System default', preferences.output.deviceId)}${(devices.outputs || []).filter(device => device.deviceId !== 'default').map(device => option(device.deviceId, device.label || 'Unnamed output', preferences.output.deviceId)).join('')}</select></label><label>Monitoring layout<select id="output-layout">${Object.keys(CHANNEL_LAYOUTS).map(layout => option(layout, layout.toUpperCase(), preferences.output.monitorLayout)).join('')}</select></label></div><p class="field-hint">${latest.capabilities?.outputSelection ? 'Output selection is supported by this browser.' : 'This browser does not expose output-device selection. Use the system default output.'} Monitoring downmix excludes LFE by default.</p><button id="output-apply" class="primary">Apply output routing</button><output id="device-state" class="device-state" role="status"></output>`;
      body.querySelector('#output-apply').onclick = () => this.safe(async () => { const output = { deviceId: body.querySelector('#output-device').value, monitorLayout: body.querySelector('#output-layout').value }; await this.execute('audio.output.set', output); this.updatePreferences({ ...this.getPreferences(), output }); });
    }
    if (problem) this.message(problem);
    const refresh = () => {
      if (!body.isConnected) return; const state = this.getLiveState(), input = state.input || {}, output = state.output || {};
      body.querySelector('#device-state').textContent = page === 'input' ? `Input: ${input.status || 'idle'} · ${input.source || 'no source'} · channels ${(input.channels || []).join(', ') || 'not acquired'} · ${input.layout || 'layout not acquired'}${input.error ? ' · ' + input.error : ''}` : `Output: ${output.deviceId || 'default'} · actual maximum ${output.maxChannels ?? 'unknown'} channels · monitoring ${output.monitorLayout || 'stereo'}${output.fallback ? ' · explicit fallback' : ''}${output.message ? ' · ' + output.message : ''}`;
      const monitor = body.querySelector('#input-monitor'); if (monitor) monitor.checked = Boolean(input.monitor);
      const stop = body.querySelector('#input-stop'); if (stop) stop.disabled = !['active', 'requesting'].includes(input.status);
    }; refresh(); return this.subscribeLive(refresh);
  }
  layout(body) {
    const state = this.getState(), live = this.getLiveState();
    body.innerHTML = `<p>Project layout controls rendering. Input channels and actual monitoring hardware are shown separately.</p><label>Project output layout<select id="project-output-layout">${Object.entries(CHANNEL_LAYOUTS).map(([layout, info]) => option(layout, `${layout.toUpperCase()} — ${info.channels.join(', ')}`, state.outputLayout || 'stereo')).join('')}</select></label><div class="channel-layout-cards">${Object.entries(CHANNEL_LAYOUTS).map(([layout, info]) => `<article><h4>${layout.toUpperCase()}</h4><p>${info.channels.map((name, index) => `${index}: ${name}`).join(' · ')}</p><code>WAVE mask 0x${info.mask.toString(16)}</code></article>`).join('')}</div><p class="info-note">Actual destination: up to ${live.output?.maxChannels ?? 'unknown'} channels. Choosing 5.1 or 7.1 does not add speakers to a stereo device. Configure a monitoring downmix in Audio output.</p><a class="button-link" href="#help/surround">Channel order & routing guide ↗</a>`;
    body.querySelector('#project-output-layout').onchange = event => this.safe(async () => { try { await this.execute('project.update', { outputLayout: event.target.value }); this.message('Project render layout updated.'); } catch (error) { event.target.value = this.getState().outputLayout; throw error; } });
  }
  shortcuts(body) {
    const actions = this.getActions();
    body.innerHTML = `<p>Use Ctrl/⌘ plus a key or sequential letters. Keyboard actions pause while typing. Saved macro shortcuts have their own locally enabled controls.</p><label>Find a feature<input id="options-key-search" type="search" placeholder="Pitch, selection, metronome…"></label><div class="shortcuts-list">${actions.map(action => `<label class="shortcut-row" data-shortcut-row="${escapeHTML((action.label + ' ' + action.id).toLowerCase())}"><span>${escapeHTML(action.label)}<code>${escapeHTML(action.id)}</code></span><input data-shortcut-id="${escapeHTML(action.id)}" aria-label="Shortcut for ${escapeHTML(action.label)}" value="${escapeHTML(action.shortcut)}"></label>`).join('')}</div><div class="modal-actions"><button id="options-shortcuts-reset">Reset shortcuts</button><button id="options-shortcuts-save" class="primary">Save shortcuts</button></div>`;
    body.querySelector('#options-key-search').oninput = event => body.querySelectorAll('[data-shortcut-row]').forEach(row => { row.hidden = !row.dataset.shortcutRow.includes(event.target.value.toLowerCase()); });
    body.querySelector('#options-shortcuts-reset').onclick = () => this.safe(async () => { await this.saveShortcuts({}); this.shortcuts(body); this.message('Default workbench shortcuts restored.'); });
    body.querySelector('#options-shortcuts-save').onclick = () => this.safe(async () => { await this.saveShortcuts(Object.fromEntries([...body.querySelectorAll('[data-shortcut-id]')].map(input => [input.dataset.shortcutId, input.value]))); this.message('Keyboard shortcuts saved.'); });
  }
  macros(body) { body.innerHTML = '<p>Record editing actions or write repeatable scripts. Enable local shortcut and after-import triggers only after reviewing their programs.</p><div class="options-link-grid"><a href="#macros/editor">Edit or run a macro ↗</a><a href="#macros/record">Record actions ↗</a><a href="#macros/batch">Batch supplied files ↗</a><a href="#macros/triggers">Macro shortcuts & import triggers ↗</a></div><p class="info-note">Imported scripts and projects supply definitions only. They cannot arm capture, networking or macro triggers.</p>'; }
  storage(body) {
    body.innerHTML = '<p>Long recordings are stored separately from the ten-minute waveform editor. Export important work before clearing browser site data.</p><output id="options-storage-state" class="device-state" role="status"></output><div class="inline-buttons"><button id="options-storage-refresh">Refresh storage / archive</button><a class="button-link" href="#performance/recordings">Open recording archive ↗</a><a class="button-link" href="#performance/recorder">Long recorder ↗</a></div>';
    const refresh = () => { if (!body.isConnected) return; const state = this.getLiveState(), storage = state.storage || {}; body.querySelector('#options-storage-state').textContent = `Archive: ${storage.available ? 'available' : 'unavailable or not initialized'} · used ${bytesLabel(storage.usage)} · estimated remaining ${storage.remainingBytes == null ? 'unknown' : bytesLabel(storage.remainingBytes)} · recorder ${state.recorder?.status || 'idle'}${storage.error ? ' · ' + storage.error : ''}`; };
    body.querySelector('#options-storage-refresh').onclick = () => this.safe(async () => { await this.execute('recordings.list', {}); refresh(); }); refresh(); return this.subscribeLive(refresh);
  }
  streaming(body) { if (this.renderStreaming) return this.renderStreaming(body); body.innerHTML = '<p>Streaming uses the explicitly connected local companion. Connection status and advertised profiles will appear when the companion adapter is initialized.</p><a class="button-link" href="#help/streaming">Companion setup guide ↗</a>'; }
  help(body) {
    body.innerHTML = '<p>The guide covers editing, effects, MIDI, surround, live looping, recording recovery, scripts and project exchange.</p><div class="options-link-grid"><a href="#help/navigation">Open the illustrated guide ↗</a><a href="#help/recovery">Recovery & limits ↗</a><a href="#help/compatibility">Audacity & REAPER compatibility ↗</a></div><h4>Local session recovery</h4><p>Clear the browser recovery copy while keeping the current project open. Save a portable project JSON for a durable copy.</p><button id="options-clear-recovery">Clear recovery copy</button>';
    body.querySelector('#options-clear-recovery').onclick = () => this.safe(async () => { await this.clearRecovery(); this.message('Recovery copy cleared. The open project remains available.'); });
  }
}
