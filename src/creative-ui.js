import { METADATA_FIELDS, normalizeMetadata } from './metadata.js';
import { NOTE_NAMES } from './key-detection.js';
import { MidiController, MidiSampler, midiValue, normalizeMidiMappings, parseMidiFile, renderMidiSequence, encodeMidiFile } from './midi.js';
import { MidiActionEdges, normalizeMidiActions } from './midi-actions.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const THEMES = Object.freeze({ studio: 'Studio', daylight: 'Daylight', midnight: 'Midnight', terminal: 'Terminal' });

export function applyTheme(theme) {
  const selected = Object.hasOwn(THEMES, theme) ? theme : 'studio';
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected === 'daylight' ? 'light' : 'dark';
  const picker = $('#theme-select'); if (picker) picker.value = selected;
  return selected;
}

/** Secondary dialogs stay separate from timeline/rendering and the effects rack. */
export class CreativeTools {
  constructor(dependencies) {
    Object.assign(this, dependencies);
    this.mappings = []; this.learnTarget = null; this.xy = { x: .5, y: .5 };
    this.actionMappings = []; this.actionEdges = new MidiActionEdges(); this.actionsArmed = false;
    this.preferredInput = ''; this.preferredOutput = '';
    this.sampler = new MidiSampler(() => this.getAudio());
    this.midi = new MidiController({
      onMessage: message => this.safe(() => this.handleMidi(message)),
      onState: ports => { this.sampler.stop(); this.actionEdges.reset(); if (!ports.connected) this.actionsArmed = false; this.refreshMidiPorts(); }
    });
  }
  load(value = {}) { this.mappings = normalizeMidiMappings(value.mappings || []); this.actionMappings = normalizeMidiActions(value.actions || []); this.learnTarget = null; this.actionsArmed = false; this.actionEdges.reset(); this.preferredInput = typeof value.inputId === 'string' ? value.inputId.slice(0, 200) : ''; this.preferredOutput = typeof value.outputId === 'string' ? value.outputId.slice(0, 200) : ''; this.refreshMidiPorts(); this.refreshMappings(); this.refreshActionMappings(); }
  save() { return { mappings: this.mappings.map(m => ({ ...m })), actions: normalizeMidiActions(this.actionMappings), inputId: this.preferredInput, outputId: this.preferredOutput }; }
  stop() { this.sampler.stop(); this.midi.panic(); this.actionEdges.reset(); this.actionsArmed = false; const armed = $('#midi-actions-armed'); if (armed) armed.checked = false; }
  close() { this.stop(); this.midi.disconnect(); void this.sampler.close(); }

  openMetadata() {
    const tags = this.getState().metadata || {};
    this.openModal('Audio metadata', `<p>These tags are saved with the project and embedded when the output format supports them. Edit them here before exporting audio.</p>
      <div class="form-grid metadata-fields">${METADATA_FIELDS.map(f => `<label>${escape(f.label)}<input data-metadata="${f.key}" aria-label="Metadata ${escape(f.label)}" maxlength="${f.maxLength}" value="${escape(tags[f.key])}"></label>`).join('')}</div>
      <div class="modal-actions"><button id="metadata-cancel">Close</button><button id="metadata-save" class="primary">Save metadata</button></div>`, () => {
      $('#metadata-cancel').onclick = this.closeModal;
      $('#metadata-save').onclick = () => this.safe(async () => {
        const metadata = normalizeMetadata(Object.fromEntries([...document.querySelectorAll('[data-metadata]')].map(input => [input.dataset.metadata, input.value])));
        await this.core('metadata.update', { metadata }); this.closeModal(); this.status('Metadata saved. It will be included in compatible audio exports.');
      });
    });
  }

  async detectKeys(all = false) {
    const result = await this.core(all ? 'analysis.keyAll' : 'analysis.key');
    this.status(all ? `Analyzed ${result.length} samples. Open Sample keys to review estimates and set overrides.` : result.key ? `${result.key} · ${Math.round(result.confidence * 100)}% heuristic confidence. Use Sample keys to override.` : `Key uncertain: ${result.reason || 'not enough tonal evidence'}`);
    return result;
  }
  openKeys() {
    const state = this.getState(), clips = state.tracks.flatMap(t => t.clips);
    this.openModal('Sample keys & colors', `<p>Each estimate uses the whole sample. Color identifies the tonic; the label identifies major/minor. Confidence is a heuristic. Drums, noise and short or ambiguous samples may have no reliable key.</p>
      <div class="inline-buttons"><button id="keys-detect-selected">Detect selected sample</button><button id="keys-detect-all" class="primary">Detect every sample</button></div>
      <div class="sample-key-list">${clips.map(c => {
        const key = c.keyAnalysis;
        return `<article class="sample-key-row"><div><span class="key-dot" style="--key-color:${/^#[a-f0-9]{6}$/i.test(key?.color || '') ? key.color : '#7c8795'}"></span><strong>${escape(c.name)}</strong><span class="sample-key-value">${escape(key?.key || (key ? 'Uncertain' : 'Not analyzed'))}${key?.key ? ` · ${key.source === 'manual' ? 'manual' : Math.round(key.confidence * 100) + '%'}` : ''}</span></div><label>Manual key<select data-key-override="${escape(c.id)}" aria-label="Key for ${escape(c.name)}"><option value="">No override / clear</option>${NOTE_NAMES.flatMap((note, tonic) => ['major','minor'].map(mode => `<option value="${tonic}:${mode}" ${key?.tonic === tonic && key?.mode === mode ? 'selected' : ''}>${note} ${mode}</option>`)).join('')}</select></label></article>`;
      }).join('') || '<p>Import or generate a sample to analyze it.</p>'}</div>`, () => {
      $('#keys-detect-selected').onclick = () => this.safe(async () => { await this.detectKeys(); this.openKeys(); });
      $('#keys-detect-all').onclick = () => this.safe(async () => { await this.detectKeys(true); this.openKeys(); });
      document.querySelectorAll('[data-key-override]').forEach(select => { select.onchange = () => this.safe(async () => {
        const [tonic, mode] = select.value.split(':');
        await this.core('clip.key', { clipId: select.dataset.keyOverride, tonic: select.value ? +tonic : null, mode }); this.openKeys();
      }); });
    });
  }

  openProjects() {
    this.openModal('Projects, Audacity & REAPER', `<p>Choose an editable project format for your next step. Audio exports and stems are available in Export.</p>
      <div class="project-format-options">
        <article><h3>WebSoundEdit session</h3><p>Embedded audio, tracks, selection, labels, metadata, effects rack, MIDI notes and interface settings.</p><button id="project-native-save">Save WebSoundEdit JSON</button></article>
        <article><h3>Audacity .aup3</h3><p>Native SQLite project with editable PCM clips, track positions and mix, labels and metadata. Realtime plugin chains and this editor’s draft rack settings are not transferred. Apply effects first.</p><button id="project-aup3-save">Save Audacity .aup3</button></article>
        <article><h3>Legacy Audacity .aup</h3><p>Downloads a ZIP with an .aup project and its _data folder. Extract both together, then open the .aup in Audacity.</p><p>In Audacity 3.4.2, first set the blank project's sample rate to ${this.getState().sampleRate.toLocaleString()} Hz to preserve clip positions. AUP3 avoids this legacy import issue.</p><button id="project-aup-save">Save legacy Audacity ZIP</button></article>
        <article><h3>REAPER .rpp</h3><p>Genuine project text plus relative WAV media in a ZIP. Supported names, positions, trims, constant mix, markers, fixed tempo and canonical surround audio are retained. Active plugins, automation and unsupported routing/transforms require rendered stems.</p><button id="project-reaper-save">Save REAPER project ZIP</button></article>
      </div>
      <label class="modal-field">Audacity surround export<select id="project-multichannel"><option value="reject">Reject surround (default)</option><option value="split-mono">Split into speaker-labeled mono tracks</option></select></label><p class="field-hint">Split-mono preserves channel audio and identity. It does not make Audacity a native surround mixer. Live draft effects are not transferred; commit or render them first.</p>
      <p class="info-note">Import supports this editor’s JSON, supported .aup3 projects, legacy .aup with its data, and .rpp with explicitly supplied media. ZIP references are local and bounded. Unsupported sound-changing features are rejected with an explanation. Save open work before replacing a session.</p>
      <div class="modal-actions"><button id="project-import-folder">Open project folder</button><button id="project-import-reaper">Open RPP + media files</button><button id="project-import-file" class="primary">Open project file</button></div><p id="project-progress" role="status"></p>`, () => {
      $('#project-native-save').onclick = () => this.safe(() => this.saveProject());
      $('#project-import-file').onclick = () => $('#project-input').click();
      $('#project-import-folder').onclick = () => $('#legacy-project-input').click();
      $('#project-import-reaper').onclick = () => $('#reaper-project-input').click();
      $('#project-reaper-save').onclick = () => this.safe(async () => { const button = $('#project-reaper-save'); button.disabled = true; try { const result = await this.execute('file.export', { format: 'reaper', scope: 'mix' }); $('#project-progress').textContent = `REAPER project saved.${result.warnings?.length ? ' ' + result.warnings.join(' ') : ''}`; } finally { if (button.isConnected) button.disabled = false; } });
      for (const format of ['aup3','aup']) $(`#project-${format}-save`).onclick = () => this.safe(async () => {
        const button = $(`#project-${format}-save`); button.disabled = true;
        $('#project-progress').textContent = 'Building the Audacity project on this device…';
        try {
          const result = this.execute ? await this.execute('file.export', { format, scope: 'mix', multichannel: $('#project-multichannel').value }) : await this.exportAudacity(format, { multichannel: $('#project-multichannel').value });
          $('#project-progress').textContent = `Saved ${result.ext.toUpperCase()} project.${result.warnings?.length ? ' ' + result.warnings.join(' ') : ''}`;
        } finally { if (button.isConnected) button.disabled = false; }
      });
    });
  }
  async exportAudacity(format = 'aup3', options = {}) {
    const { exportAudacity } = await import('./audacity.js');
    const project = await this.getProject(), result = await exportAudacity(project, { format, multichannel: options.multichannel || 'reject' });
    if (options.download !== false) this.download(result.bytes, `${this.filename(project.name)}.${result.ext}`, result.mime);
    return result;
  }

  midiTargets() {
    return [{ id: 'xy:x', label: 'XY controller · X axis', min: 0, max: 1, step: .001 }, { id: 'xy:y', label: 'XY controller · Y axis', min: 0, max: 1, step: .001 },
      ...this.rack.targets().map(target => ({ ...target, id: `${target.id}:${target.key}`, stageId: target.id }))];
  }
  async handleMidi(message) {
    const readout = $('#midi-message'); if (readout) readout.textContent = message.type === 'cc' ? `CH ${message.channel + 1} · CC ${message.controller} · ${message.value}` : `${message.type}${message.note === undefined ? '' : ' · note ' + message.note}`;
    if (this.isBatchRunning?.()) { this.sampler.stop(); this.actionEdges.reset(); if (readout) readout.textContent = 'Batch running — MIDI controls resume after project restoration.'; return; }
    const actions = this.actionEdges.update(message, this.actionMappings, { armed: this.actionsArmed });
    for (const mapping of actions) {
      if (mapping.action.macroId) await this.runMacro(mapping.action.macroId, { origin: 'midi' });
      else await this.execute(mapping.action.method, mapping.action.params, { origin: 'midi' });
    }
    if (this.actionsArmed && this.actionEdges.matching(message, this.actionMappings).some(mapping => mapping.kind === 'note')) return;
    if (message.type === 'noteon') return this.sampler.noteOn(message.note, message.velocity, message.channel);
    if (message.type === 'noteoff') return this.sampler.noteOff(message.note, message.channel);
    if (message.type === 'stop') { this.stop(); this.transport('stop'); return; }
    if (message.type === 'start' || message.type === 'continue') return this.transport(message.type);
    if (message.type !== 'cc') return;
    if ([120, 123].includes(message.controller)) this.sampler.stop();
    if (this.learnTarget) {
      this.mappings = this.mappings.filter(m => m.channel !== message.channel || m.controller !== message.controller);
      this.mappings.push({ channel: message.channel, controller: message.controller, target: this.learnTarget });
      this.mappings = normalizeMidiMappings(this.mappings); this.learnTarget = null; this.persist();
      if ($('#midi-learn')) { $('#midi-learn').textContent = 'Learn next CC'; this.refreshMappings(); }
    }
    const mapping = this.mappings.find(m => m.channel === message.channel && m.controller === message.controller);
    const target = mapping && this.midiTargets().find(t => t.id === mapping.target); if (!target) return;
    const value = midiValue(message.value, target);
    if (target.id.startsWith('xy:')) {
      const axis = target.id.slice(3);
      this.rack.setXY(axis === 'x' ? value : this.rack.position('x'), axis === 'y' ? value : this.rack.position('y'));
    }
    else this.rack.setParameter(target.stageId, target.key, value);
  }

  refreshMidiPorts() {
    if (!$('#midi-input')) return;
    const ports = this.midi.ports();
    $('#midi-status').textContent = ports.connected ? `${ports.inputs.length} input(s) · ${ports.outputs.length} output(s). Note C4 / 60 plays the sample at original pitch.` : 'Disconnected. Connect to choose MIDI devices; MIDI files work without hardware.';
    $('#midi-input').innerHTML = `<option value="">All inputs</option>${ports.inputs.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}`;
    $('#midi-output').innerHTML = `<option value="">No output</option>${ports.outputs.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}`;
    $('#midi-input').value = this.midi.inputId; $('#midi-output').value = this.midi.outputId;
    $('#midi-connect').textContent = ports.connected ? 'Reconnect MIDI' : 'Connect MIDI';
    const armed = $('#midi-actions-armed'); if (armed) armed.checked = this.actionsArmed;
  }
  refreshMappings() {
    if (!$('#midi-mappings')) return;
    const targets = this.midiTargets();
    $('#midi-mappings').innerHTML = this.mappings.map((m, i) => `<div class="midi-mapping"><span>CH ${m.channel + 1} · CC ${m.controller}</span><span>${escape(targets.find(t => t.id === m.target)?.label || 'Unavailable effect — add or remap')}</span><button data-midi-remove="${i}" aria-label="Remove MIDI mapping ${i + 1}">Remove</button></div>`).join('') || '<p>No mappings. Choose a target, click Learn, then move a hardware knob.</p>';
    document.querySelectorAll('[data-midi-remove]').forEach(button => { button.onclick = () => { this.mappings.splice(+button.dataset.midiRemove, 1); this.persist(); this.refreshMappings(); }; });
  }
  midiMarkup() {
    return `<p>Trigger the selected sample, map a hardware knob, or use a pedal to run a command. Hardware is connected only when you choose Connect MIDI.</p>
      <div class="inline-buttons"><button id="midi-connect" class="primary">Connect MIDI</button><button id="midi-disconnect">Disconnect</button><button id="midi-panic">Stop all notes / capture</button></div><p id="midi-status" role="status"></p>
      <div class="form-grid"><label>Input device<select id="midi-input" aria-label="MIDI input"></select></label><label>Output device<select id="midi-output" aria-label="MIDI output"></select></label></div>
      <div class="inline-buttons midi-output-actions"><button id="midi-test-note">Send test note</button><button id="midi-start-out">Send Start</button><button id="midi-stop-out">Send Stop</button></div>
      <h3>Map a hardware knob</h3><div class="midi-learn-row"><label>Parameter<select id="midi-target" aria-label="MIDI mapping target">${this.midiTargets().map(t => `<option value="${escape(t.id)}">${escape(t.label)}</option>`).join('')}</select></label><button id="midi-learn">Learn next CC</button></div><output id="midi-message" aria-live="polite">Waiting for MIDI input</output><div id="midi-mappings"></div>
      <h3>Pedals & command actions</h3><p>Only the rising edge triggers. Release never retriggers; debounce suppresses switch chatter. Imported mappings start disarmed.</p>
      <label class="checkbox-field"><input id="midi-actions-armed" type="checkbox"${this.actionsArmed ? ' checked' : ''}> Arm MIDI command actions for this session</label>
      <div class="form-grid"><label>Message<select id="midi-action-kind"><option value="cc">CC pedal</option><option value="note">Note / pad</option></select></label><label>Channel<input id="midi-action-channel" type="number" min="1" max="16" value="1"></label><label>Controller / note number<input id="midi-action-number" type="number" min="0" max="127" value="64"></label><label>Press threshold<input id="midi-action-threshold" type="number" min="1" max="127" value="64"></label><label>Debounce (ms)<input id="midi-action-debounce" type="number" min="0" max="5000" value="250"></label><label>Action<select id="midi-action-target">${(this.getCommands?.() || []).map(command => `<option value="${escape(command.method)}">${escape(command.method + ' — ' + (command.label || command.description || ''))}</option>`).join('')}${(this.getMacros?.() || []).map(macro => `<option value="macro:${escape(macro.id)}">Macro — ${escape(macro.name)}</option>`).join('')}</select></label></div><label>Command arguments (JSON)<textarea id="midi-action-params" class="code-editor compact" spellcheck="false">{}</textarea></label><button id="midi-action-add">Add pedal mapping</button><div id="midi-action-list"></div>
      <h3>MIDI files</h3><p>Import .mid/.midi format 0 or 1. Notes become a simple sine-instrument track. Export retains note timing and velocity, not later audio edits or the original instrument sounds.</p>
      <div class="inline-buttons"><button id="midi-import">Import MIDI file</button><button id="midi-export">Export selected MIDI source</button></div>`;
  }
  openMidi() { if (this.openMidiRoute) return this.openMidiRoute(); this.openModal('MIDI studio', this.midiMarkup(), () => this.bindMidi()); }
  renderMidi(container) { container.innerHTML = this.midiMarkup(); this.bindMidi(); return () => { this.learnTarget = null; }; }
  refreshActionMappings() {
    const list = $('#midi-action-list'); if (!list) return;
    list.innerHTML = this.actionMappings.map((mapping, index) => `<div class="midi-action-row"><span>CH ${mapping.channel + 1} · ${mapping.kind.toUpperCase()} ${mapping.number}</span><code>${escape(mapping.action.method || 'Macro ' + mapping.action.macroId)}</code><button data-midi-action-remove="${index}" aria-label="Remove pedal mapping ${index + 1}">Remove</button></div>`).join('') || '<p class="field-hint">No pedal actions. Select loop.capture.toggle for a capture footswitch, or any command with explicit arguments.</p>';
    list.querySelectorAll('[data-midi-action-remove]').forEach(button => button.onclick = () => { this.actionMappings.splice(+button.dataset.midiActionRemove, 1); this.actionEdges.reset(); this.persist(); this.refreshActionMappings(); });
  }
  bindMidi() {
    this.refreshMidiPorts(); this.refreshMappings(); this.refreshActionMappings();
    const execute = (method, params = {}) => this.execute ? this.execute(method, params) : null;
    $('#midi-connect').onclick = () => this.safe(async () => { if (this.execute) await execute('midi.connect'); else await this.midi.connect(); const ports = this.midi.ports(); if (ports.inputs.some(port => port.id === this.preferredInput)) this.midi.selectInput(this.preferredInput); if (ports.outputs.some(port => port.id === this.preferredOutput)) this.midi.selectOutput(this.preferredOutput); this.refreshMidiPorts(); });
    $('#midi-disconnect').onclick = () => this.safe(async () => { if (this.execute) await execute('midi.disconnect'); else { this.stop(); this.midi.disconnect(); this.learnTarget = null; } });
    $('#midi-panic').onclick = () => this.safe(async () => { if (this.execute) await execute('midi.panic'); else { this.stop(); await this.transport('stop'); } });
    $('#midi-input').onchange = event => { this.sampler.stop(); this.actionEdges.reset(); this.preferredInput = event.target.value; this.midi.selectInput(event.target.value); this.persist(); };
    $('#midi-output').onchange = event => { this.preferredOutput = event.target.value; this.midi.selectOutput(event.target.value); this.persist(); };
    $('#midi-test-note').onclick = () => this.safe(() => this.midi.testNote());
    $('#midi-start-out').onclick = () => this.safe(() => this.midi.send([0xfa]));
    $('#midi-stop-out').onclick = () => this.safe(() => { this.midi.send([0xfc]); this.midi.panic(); });
    $('#midi-learn').onclick = () => { this.learnTarget = $('#midi-target').value; $('#midi-learn').textContent = 'Move a MIDI knob…'; };
    $('#midi-actions-armed').onchange = event => this.safe(() => { if (event.target.checked && !this.midi.ports().connected) { event.target.checked = false; throw new Error('Connect MIDI before arming command actions.'); } this.actionsArmed = event.target.checked; this.actionEdges.reset(); });
    const preferred = [...$('#midi-action-target').options].find(option => option.value === 'loop.capture.toggle'); if (preferred) $('#midi-action-target').value = preferred.value;
    $('#midi-action-add').onclick = () => this.safe(() => {
      const target = $('#midi-action-target').value, params = JSON.parse($('#midi-action-params').value);
      const mapping = { id: 'pedal-' + crypto.randomUUID(), kind: $('#midi-action-kind').value, channel: +$('#midi-action-channel').value - 1, number: +$('#midi-action-number').value, threshold: +$('#midi-action-threshold').value, debounceMs: +$('#midi-action-debounce').value, action: target.startsWith('macro:') ? { macroId: target.slice(6) } : { method: target, params } };
      this.actionMappings = normalizeMidiActions([...this.actionMappings, mapping]); this.actionEdges.reset(); this.persist(); this.refreshActionMappings();
    });
    $('#midi-import').onclick = () => $('#midi-file-input').click();
    $('#midi-export').onclick = () => this.safe(() => this.exportMidi());
  }
  async importMidi(file, options = {}) {
    const execute = options.execute || this.core;
    if (file.size > 4 * 1024 * 1024) throw new Error('MIDI file exceeds 4 MiB.');
    const sequence = parseMidiFile(await file.arrayBuffer()), state = this.getState();
    const audio = renderMidiSequence(sequence, state.sampleRate);
    if (options.replace && options.trackId) throw new Error('A replacement import cannot target an old track ID.');
    const add = { name: options.name || `${file.name.replace(/\.[^.]+$/, '')} · MIDI synth`, audio, ...(options.trackId ? {trackId: options.trackId} : {}), ...(options.start !== undefined ? {start: options.start} : {}) };
    const results = await execute('recipe.run', {commands: [...(options.replace ? [{method:'project.new',params:{name:file.name.replace(/\.[^.]+$/, ''),sampleRate:state.sampleRate}}] : []), {method:'clip.add',params:add}]});
    const clip = results[options.replace ? 1 : 0];
    const current = this.getState();
    try {
      await execute('settings.load', { settings: { ...current.settings, midiSequences: { ...current.settings.midiSequences, [clip.id]: sequence } } });
    } catch (error) { await execute('history.undo'); throw error; }
    this.afterImport(); this.status(`Imported ${sequence.notes.length} MIDI notes as a sine-instrument track. Original note timing is retained for MIDI export.`); this.closeModal(); return clip;
  }
  exportMidi(options = {}) {
    const state = this.getState(), clipId = options.clipId || state.selectedClipId, sequence = state.settings.midiSequences?.[clipId];
    if (!sequence) throw new Error('Select a track imported from MIDI first. Audio-to-MIDI transcription is not supported.');
    const bytes = encodeMidiFile(sequence);
    if (options.download !== false) this.download(bytes, `${this.filename(state.name)}-notes.mid`, 'audio/midi'); return bytes;
  }
}
