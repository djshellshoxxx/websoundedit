import { METADATA_FIELDS, normalizeMetadata } from './metadata.js';
import { NOTE_NAMES } from './key-detection.js';
import { MidiController, MidiSampler, midiValue, normalizeMidiMappings, parseMidiFile, renderMidiSequence, encodeMidiFile } from './midi.js';

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
    this.sampler = new MidiSampler(() => this.getAudio());
    this.midi = new MidiController({
      onMessage: message => this.safe(() => this.handleMidi(message)),
      onState: () => { this.sampler.stop(); this.refreshMidiPorts(); }
    });
  }
  load(value = {}) { this.mappings = normalizeMidiMappings(value.mappings || []); this.learnTarget = null; }
  save() { return { mappings: this.mappings.map(m => ({ ...m })) }; }
  stop() { this.sampler.stop(); this.midi.panic(); }
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
    this.openModal('Projects & Audacity', `<p>Choose a project format for your next step.</p>
      <div class="project-format-options">
        <article><h3>WebSoundEdit session</h3><p>Embedded audio, tracks, selection, labels, metadata, effects rack, MIDI notes and interface settings.</p><button id="project-native-save">Save WebSoundEdit JSON</button></article>
        <article><h3>Audacity .aup3</h3><p>Native SQLite project with editable PCM clips, track positions and mix, labels and metadata. Realtime plugin chains and this editor’s draft rack settings are not transferred. Apply effects first.</p><button id="project-aup3-save">Save Audacity .aup3</button></article>
        <article><h3>Legacy Audacity .aup</h3><p>Downloads a ZIP with an .aup project and its _data folder. Extract both together, then open the .aup in Audacity.</p><p>In Audacity 3.4.2, first set the blank project's sample rate to ${this.getState().sampleRate.toLocaleString()} Hz to preserve clip positions. AUP3 avoids this legacy import issue.</p><button id="project-aup-save">Save legacy Audacity ZIP</button></article>
      </div>
      <p class="info-note">Import supports this editor’s JSON, supported .aup3 projects, and legacy .aup with its data. Projects with unsupported sound-changing features are rejected with an explanation. Save open work before replacing a session.</p>
      <div class="modal-actions"><button id="project-import-folder">Open legacy project folder</button><button id="project-import-file" class="primary">Open project file</button></div><p id="project-progress" role="status"></p>`, () => {
      $('#project-native-save').onclick = () => this.safe(() => this.saveProject());
      $('#project-import-file').onclick = () => $('#project-input').click();
      $('#project-import-folder').onclick = () => $('#legacy-project-input').click();
      for (const format of ['aup3','aup']) $(`#project-${format}-save`).onclick = () => this.safe(async () => {
        const button = $(`#project-${format}-save`); button.disabled = true;
        $('#project-progress').textContent = 'Building the Audacity project on this device…';
        try {
          const result = await this.exportAudacity(format);
          $('#project-progress').textContent = `Saved ${result.ext.toUpperCase()} project.${result.warnings?.length ? ' ' + result.warnings.join(' ') : ''}`;
        } finally { if (button.isConnected) button.disabled = false; }
      });
    });
  }
  async exportAudacity(format = 'aup3', options = {}) {
    const { exportAudacity } = await import('./audacity.js');
    const project = await this.getProject(), result = await exportAudacity(project, { format });
    if (options.download !== false) this.download(result.bytes, `${this.filename(project.name)}.${result.ext}`, result.mime);
    return result;
  }

  midiTargets() {
    return [{ id: 'xy:x', label: 'XY controller · X axis', min: 0, max: 1, step: .001 }, { id: 'xy:y', label: 'XY controller · Y axis', min: 0, max: 1, step: .001 },
      ...this.rack.targets().map(target => ({ ...target, id: `${target.id}:${target.key}`, stageId: target.id }))];
  }
  async handleMidi(message) {
    const readout = $('#midi-message'); if (readout) readout.textContent = message.type === 'cc' ? `CH ${message.channel + 1} · CC ${message.controller} · ${message.value}` : `${message.type}${message.note === undefined ? '' : ' · note ' + message.note}`;
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
  }
  refreshMappings() {
    if (!$('#midi-mappings')) return;
    const targets = this.midiTargets();
    $('#midi-mappings').innerHTML = this.mappings.map((m, i) => `<div class="midi-mapping"><span>CH ${m.channel + 1} · CC ${m.controller}</span><span>${escape(targets.find(t => t.id === m.target)?.label || 'Unavailable effect — add or remap')}</span><button data-midi-remove="${i}" aria-label="Remove MIDI mapping ${i + 1}">Remove</button></div>`).join('') || '<p>No mappings. Choose a target, click Learn, then move a hardware knob.</p>';
    document.querySelectorAll('[data-midi-remove]').forEach(button => { button.onclick = () => { this.mappings.splice(+button.dataset.midiRemove, 1); this.persist(); this.refreshMappings(); }; });
  }
  openMidi() {
    this.openModal('MIDI studio', `<p>Use a controller to trigger the selected sample, map hardware knobs to the effects rack, or import a MIDI song as synthesized audio.</p>
      <div class="inline-buttons"><button id="midi-connect" class="primary">Connect MIDI</button><button id="midi-disconnect">Disconnect</button><button id="midi-panic">Stop all notes</button></div><p id="midi-status" role="status"></p>
      <div class="form-grid"><label>Input device<select id="midi-input" aria-label="MIDI input"></select></label><label>Output device<select id="midi-output" aria-label="MIDI output"></select></label></div>
      <div class="inline-buttons midi-output-actions"><button id="midi-test-note">Send test note</button><button id="midi-start-out">Send Start</button><button id="midi-stop-out">Send Stop</button></div>
      <h3>Map a hardware knob</h3><div class="midi-learn-row"><label>Parameter<select id="midi-target" aria-label="MIDI mapping target">${this.midiTargets().map(t => `<option value="${escape(t.id)}">${escape(t.label)}</option>`).join('')}</select></label><button id="midi-learn">Learn next CC</button></div><output id="midi-message" aria-live="polite">Waiting for MIDI input</output><div id="midi-mappings"></div>
      <h3>MIDI files</h3><p>Import .mid/.midi format 0 or 1. Notes become a simple sine-instrument track. Export retains note timing and velocity, not later audio edits or the original instrument sounds.</p>
      <div class="inline-buttons"><button id="midi-import">Import MIDI file</button><button id="midi-export">Export selected MIDI source</button></div>`, () => {
      this.refreshMidiPorts(); this.refreshMappings();
      $('#midi-connect').onclick = () => this.safe(async () => { await this.midi.connect(); this.refreshMidiPorts(); });
      $('#midi-disconnect').onclick = () => { this.stop(); this.midi.disconnect(); this.learnTarget = null; };
      $('#midi-panic').onclick = () => { this.stop(); this.transport('stop'); };
      $('#midi-input').onchange = event => { this.sampler.stop(); this.midi.selectInput(event.target.value); };
      $('#midi-output').onchange = event => this.midi.selectOutput(event.target.value);
      $('#midi-test-note').onclick = () => this.safe(() => this.midi.testNote());
      $('#midi-start-out').onclick = () => this.safe(() => this.midi.send([0xfa]));
      $('#midi-stop-out').onclick = () => this.safe(() => { this.midi.send([0xfc]); this.midi.panic(); });
      $('#midi-learn').onclick = () => { this.learnTarget = $('#midi-target').value; $('#midi-learn').textContent = 'Move a MIDI knob…'; };
      $('#midi-import').onclick = () => $('#midi-file-input').click();
      $('#midi-export').onclick = () => this.safe(() => this.exportMidi());
    });
  }
  async importMidi(file) {
    if (file.size > 4 * 1024 * 1024) throw new Error('MIDI file exceeds 4 MiB.');
    const sequence = parseMidiFile(await file.arrayBuffer()), state = this.getState();
    const audio = renderMidiSequence(sequence, state.sampleRate);
    const clip = await this.core('clip.add', { name: `${file.name.replace(/\.[^.]+$/, '')} · MIDI synth`, audio });
    const current = this.getState();
    try {
      await this.core('settings.load', { settings: { ...current.settings, midiSequences: { ...current.settings.midiSequences, [clip.id]: sequence } } });
    } catch (error) { await this.core('history.undo'); throw error; }
    this.afterImport(); this.status(`Imported ${sequence.notes.length} MIDI notes as a sine-instrument track. Original note timing is retained for MIDI export.`); this.closeModal(); return clip;
  }
  exportMidi(options = {}) {
    const state = this.getState(), clipId = options.clipId || state.selectedClipId, sequence = state.settings.midiSequences?.[clipId];
    if (!sequence) throw new Error('Select a track imported from MIDI first. Audio-to-MIDI transcription is not supported.');
    const bytes = encodeMidiFile(sequence);
    if (options.download !== false) this.download(bytes, `${this.filename(state.name)}-notes.mid`, 'audio/midi'); return bytes;
  }
}
