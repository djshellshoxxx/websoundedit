import { zipSync } from 'fflate';
import { MacroRunner, parseMacro, validateMacro, stepsToMacro, macroToSteps, formatMacro } from './macro.js';
import { escapeHTML, clone, option, bytesLabel } from './ui-utils.js';
import { safeFilename, MAX_EXPORT_COLLECTION_BYTES } from './file-ui.js';

const DEFAULT_SCRIPT = '// WebSoundEdit Macro 1\neffect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});\neffect.normalize({targetDb: -1});';
const BATCH_READ_COMMANDS = new Set(['commands.list','project.state','project.save','project.saveTrack','settings.save','clip.getAudio','analysis.stats','analysis.bpm','analysis.silence','audio.render','audio.playbackPlan','audio.renderPreview','effect.preview','audio.capabilities','audio.devices.list','loop.track.list','recordings.list','stream.status','macro.status']);
const BATCH_NAVIGATION_COMMANDS = new Set(['ui.options','ui.help','ui.macros','ui.performance','ui.file.export','ui.commands','ui.api','ui.panel.midi','ui.panel.projects','ui.panel.keys','ui.panel.metadata','ui.track.settings','ui.panel.edit','ui.shortcuts','ui.settings','view.zoom','view.fit','view.zoomSelection','ui.view.zoomIn','ui.view.zoomOut','ui.view.fit','ui.view.zoomSelection','ui.view.selection','ui.view.spectrum','ui.view.scope']);
const batchBusy = () => Object.assign(new Error('A batch is using this project and its exports. Wait for restoration or stop the batch before making changes.'), { code: 'BUSY' });
function batchUICommands(ast) { const pending=[ast],methods=new Set();while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;if(node.type==='CallExpression'&&node.method.startsWith('ui.')&&!BATCH_NAVIGATION_COMMANDS.has(node.method))methods.add(node.method);for(const value of Object.values(node))if(value&&typeof value==='object')pending.push(...(Array.isArray(value)?value:[value]));}return [...methods]; }
const projectContext = state => state ? { name:state.name,sampleRate:state.sampleRate,bpm:state.bpm,beatsPerBar:state.beatsPerBar,beatOffset:state.beatOffset,duration:state.duration,outputLayout:state.outputLayout,selectedTrackId:state.selectedTrackId,selectedClipId:state.selectedClipId,selection:state.selection,metadata:state.metadata,tracks:state.tracks.map(track=>({id:track.id,name:track.name,clips:track.clips.map(clip=>({id:clip.id,name:clip.name,start:clip.start,duration:clip.duration,channels:clip.channels}))})) } : null;
export function normalizeMacroSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Macro settings must be an object.');
  const macros = value.macros || []; if (!Array.isArray(macros) || macros.length > 32) throw new Error('Save up to 32 macros.');
  const ids = new Set(), shortcuts = new Set(); let bytes = 0;
  const clean = macros.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || item.name.length > 120 || typeof item.text !== 'string' || item.text.length > 131072) throw new Error('Invalid saved macro definition.');
    ids.add(item.id); bytes += item.text.length;
    const shortcut = typeof item.shortcut === 'string' ? item.shortcut.trim().toLowerCase().replace(/\s+/g, ' ') : '';
    if (shortcut && (!/^[a-z0-9 +,./;\[\]\\'=\-]{1,60}$/.test(shortcut) || shortcuts.has(shortcut))) throw new Error('Macro shortcuts must be valid and unique.');
    if (shortcut) shortcuts.add(shortcut); return { id: item.id, name: item.name, text: item.text, shortcut };
  });
  const draft = typeof value.draft === 'string' ? value.draft : DEFAULT_SCRIPT;
  if (draft.length > 131072 || bytes + draft.length > 524288) throw new Error('Saved macro text exceeds the 512 KiB settings limit.');
  return { macros: clean, draft, selectedId: ids.has(value.selectedId) ? value.selectedId : '', onImportId: ids.has(value.onImportId) ? value.onImportId : '' };
}
function containsCommand(ast, method) {
  const pending = [ast]; while (pending.length) { const node = pending.pop(); if (!node || typeof node !== 'object') continue; if (node.type === 'CallExpression' && node.method === method) return true; for (const value of Object.values(node)) if (value && typeof value === 'object') pending.push(...(Array.isArray(value) ? value : [value])); }
  return false;
}
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
export const MACRO_UI_COMMANDS = [
  { method: 'macro.status', label: 'Read macro and batch status', description: 'Read execution, action-recorder, batch result and collected-output status without changing the project.', schema: schema({}) },
  { method: 'macro.run', label: 'Run a macro', description: 'Run a saved or supplied text macro with bounded interpretation and cancellation.', schema: schema({ id: { type: 'string' }, text: { type: 'string', maxLength: 131072 }, variables: { type: 'object' } }) },
  { method: 'macro.cancel', label: 'Stop macro execution', description: 'Cancel a macro or batch after its current atomic command.', schema: schema({}) },
  { method: 'macro.record.start', label: 'Record actions', description: 'Start recording successful semantic actions, optionally preserving elapsed timing.', schema: schema({ timing: { type: 'boolean' } }) },
  { method: 'macro.record.stop', label: 'Finish action recording', description: 'Stop action recording and create canonical macro text.', schema: schema({}) },
  { method: 'macro.batch', label: 'Run a batch of supplied inputs', description: 'Process supplied file aliases sequentially, restoring the open project afterward.', schema: schema({ macroId: { type: 'string' }, inputIds: { type: 'array', items: { type: 'string' }, maxItems: 128 }, continueOnError: { type: 'boolean' }, download: { type: 'boolean' } }) },
].map(item => ({ id: item.method, category: 'Macros', recordable: false, undoable: false, capabilities: ['browser.macros'], ...item }));

export class MacroPanel {
  #batchOwner = null;
  constructor(dependencies) {
    Object.assign(this, dependencies); this.settings = normalizeMacroSettings(); this.onImportArmed = false; this.shortcutsArmed = true; this.running = false; this.batchInputs = []; this.lastOutputs = []; this.progress = 'Ready to record or run actions.';
    this.runner = this.createRunner();
    this.routes.register('macros', 'Macros & batch', (container, page) => this.render(container, page));
    this.unsubscribe = this.runtime.subscribe(() => this.updateStatus());
  }
  createRunner(owner) { return new MacroRunner({ execute: (method, params, context = {}) => this.runtime.execute(method, params, { ...context, ...(owner ? { owner } : {}), origin: 'macro', record: false }), getCommands: () => this.runtime.commands(), getContext: () => ({ project: projectContext(this.getState()), selection: this.getState()?.selection, inputs: this.fileIO.aliases() }) }); }
  isBatchRunning() { return this.#batchOwner !== null; }
  assertInteractive(context = {}) { if (this.#batchOwner && context.owner !== this.#batchOwner) throw batchBusy(); }
  register() {
    const handlers = {
      'macro.status': () => ({running:this.running,batch:this.isBatchRunning(),progress:this.progress,recorder:this.runtime.recorder.getState(),results:clone(this.batchResults||[]),outputs:{count:this.lastOutputs.length,bytes:this.lastOutputs.reduce((total,file)=>total+file.bytes.byteLength,0)}}),
      'macro.run': (params, context) => { if (params.id && !this.find(params.id)) throw new Error('This saved macro no longer exists.'); return this.run(params.text ?? this.find(params.id)?.text ?? this.settings.draft, params.variables || {}, context); },
      'macro.cancel': () => this.cancel(),
      'macro.record.start': params => this.startRecording(params),
      'macro.record.stop': () => this.stopRecording(),
      'macro.batch': (params, context) => this.batch(params, context),
    };
    for (const descriptor of MACRO_UI_COMMANDS) this.runtime.register(descriptor, handlers[descriptor.method]);
  }
  load(value) { this.settings = normalizeMacroSettings(value); this.onImportArmed = false; this.shortcutsArmed = false; this.updateStatus(); }
  save() { return clone(this.settings); }
  find(id) { return this.settings.macros.find(item => item.id === id); }
  disarm() { this.onImportArmed = false; this.shortcutsArmed = false; this.updateStatus(); }
  open(page = 'editor') { return this.routes.open(`macros/${page}`); }
  setDraft(text) { if (text.length > 131072) throw new Error('Macro text exceeds 128 KiB.'); this.settings.draft = text; }
  validate(text = this.settings.draft) { const ast = parseMacro(text); const result = validateMacro(ast, this.runtime.commands()); if (!result.valid) throw new Error(result.errors.map(error => typeof error === 'string' ? error : error.message || JSON.stringify(error)).join('\n')); return ast; }
  async run(text, variables = {}, context = {}) {
    if (this.running) throw new Error('A macro or batch is already running. Stop it before starting another.');
    this.validate(text); this.running = true; this.abort = new AbortController();
    const onAbort = () => this.abort?.abort(context.signal?.reason); context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    try { return await this.runner.run(text, { variables, signal: this.abort.signal, onEvent: event => this.onProgress(event) }); }
    finally { context.signal?.removeEventListener('abort', onAbort); this.running = false; this.abort = null; this.updateStatus(); }
  }
  onProgress(event) { this.progress = event.type === 'step' ? `${event.completedSteps} completed · ${event.method}` : event.type === 'complete' ? `Complete · ${event.completedSteps} commands` : event.type === 'error' ? `Stopped after ${event.completedSteps || 0} commands · ${event.error?.message || event.message || 'Execution error'}` : 'Running macro…'; this.updateStatus(); }
  cancel() { this.abort?.abort(new Error('Stopped by the user.')); this.runner.cancel(); this.batchRunner?.cancel(); this.progress = 'Stop requested. Completed atomic commands and downloads remain.'; this.updateStatus(); return { cancelled: true }; }
  startRecording({ timing = false } = {}) { this.runtime.recorder.start({ timing, portable: true }); this.progress = timing ? 'Recording actions with timing. Use the editor, then finish here.' : 'Recording ordered actions. Thinking time is omitted.'; this.updateStatus(); return this.runtime.recorder.getState(); }
  stopRecording() { const result = this.runtime.recorder.stop(); this.settings.draft = result.text; this.settings.selectedId = ''; this.persist(); this.progress = `Captured ${result.steps.length} actions. Review and validate before running.`; this.updateStatus(); if (this.routes.active.startsWith('macros/')) void this.routes.refresh(); return result; }
  async runSaved(id, context = {}) { const macro = this.find(id); if (!macro) throw new Error('This saved macro no longer exists.'); return this.run(macro.text, {}, context); }
  async afterManualImport(result, origin = 'ui') { if (!this.onImportArmed || origin !== 'ui' || this.running || !this.settings.onImportId) return; await this.runSavedWithVariables(this.settings.onImportId, { imported: result, inputs: this.fileIO.aliases() }); }
  async runSavedWithVariables(id, variables) { const macro = this.find(id); if (!macro) throw new Error('Choose an available on-import macro.'); return this.run(macro.text, variables); }
  shortcutMatches(sequence) { return this.shortcutsArmed ? this.settings.macros.filter(item => item.shortcut && (item.shortcut === sequence || item.shortcut.startsWith(sequence + ' '))) : []; }
  async batch({ macroId, inputIds, continueOnError = false, download = false } = {}, context = {}) {
    if (this.running) throw new Error('A macro or batch is already running.');
    const text = (macroId ? this.find(macroId)?.text : this.settings.draft); if (typeof text !== 'string') throw new Error('Choose an available macro.');
    const ast = this.validate(text), aliases = this.fileIO.aliases(), inputs = (inputIds || this.batchInputs.map(input => input.id)).map(id => aliases.find(input => input.id === id));
    if (!inputs.length || inputs.length > 128 || inputs.some(input => !input) || new Set(inputs.map(input => input.id)).size !== inputs.length) throw new Error('Supply one to 128 unique input files before running a batch.');
    const wrappers=batchUICommands(ast);if(wrappers.length)throw new Error(`Batch scripts use semantic commands instead of UI action wrappers: ${wrappers.join(', ')}. For example, use effect.gain or file.export.`);
    if(this.runtime.inFlight > (context.runtime === this.runtime ? 1 : 0))throw Object.assign(new Error('Finish the current command before starting a batch.'),{code:'BUSY'});
    // Validate the entire known program before replacing the current project.
    const owner=Object.freeze({});this.#batchOwner=owner;this.batchRunner=this.createRunner(owner);
    const releaseCommands=this.runtime.addExecutionGuard(({method,options})=>{if(options.owner!==owner&&method!=='macro.cancel'&&!BATCH_READ_COMMANDS.has(method)&&!BATCH_NAVIGATION_COMMANDS.has(method))throw batchBusy();});
    const releaseFiles=this.fileIO.addAccessGuard(({context:operation})=>{if(operation.owner!==owner)throw batchBusy();});
    this.running = true; this.abort = new AbortController(); this.batchResults = []; this.lastOutputs = []; this.progress = 'Preparing batch session snapshot…'; this.updateStatus();
    const onAbort = () => this.abort?.abort(context.signal?.reason); context.signal?.addEventListener('abort', onAbort, { once: true }); if (context.signal?.aborted) onAbort();
    let saved = null, collecting = false;
    try {
      this.onBatchState?.(true);
      saved = await this.getProject(); this.abort.signal.throwIfAborted(); this.disarm();
      this.fileIO.beginCollection({ download, owner }); collecting = true;
      for (const input of inputs) {
        this.abort.signal.throwIfAborted();
        try {
          await this.runtime.execute('project.new', { name: input.stem, sampleRate: saved.sampleRate }, { owner, origin:'batch', record:false, signal:this.abort.signal });
          if (!containsCommand(ast, 'file.import')) await this.runtime.execute('file.import', { input: input.id }, { owner, origin: 'batch', record: false, signal: this.abort.signal });
          await this.batchRunner.run(text, { variables: { input, file: input, inputs: [input] }, signal: this.abort.signal, onEvent: event => this.onProgress(event) });
          this.batchResults.push({ name: input.name, success: true });
        } catch (error) { this.batchResults.push({ name: input.name, success: false, error: error.message }); if (!continueOnError || this.abort.signal.aborted) throw error; }
        this.updateBatchResults();
      }
      this.progress = `Batch complete: ${this.batchResults.filter(result => result.success).length}/${inputs.length} succeeded.`;
      return { results: clone(this.batchResults), outputCount: this.fileIO.collection.files.length, outputBytes: this.fileIO.collection.total };
    } finally {
      if (collecting) this.lastOutputs = this.fileIO.finishCollection({owner}).files;
      try { if (saved) { try { await this.teardown?.({owner}); } finally { await this.restoreProject(saved,{owner}); } } } finally { context.signal?.removeEventListener('abort', onAbort);releaseFiles();releaseCommands();this.#batchOwner=null;this.batchRunner=null;this.running = false; this.abort = null;this.onBatchState?.(false); this.updateStatus(); this.updateBatchResults(); }
    }
  }
  updateStatus() {
    const recorder = this.runtime.recorder.getState();
    if (recorder.error) this.progress = `Action recording stopped: ${recorder.error}`;
    for (const output of document.querySelectorAll('[data-macro-progress]')) output.textContent = this.progress;
    for (const output of document.querySelectorAll('[data-macro-recording-status]')) output.textContent = recorder.recording ? `Recording ${recorder.count} actions${recorder.timing ? ' + timing' : ''}` : 'Action recorder idle';
    const badge = document.querySelector('#macro-recording-badge'); if (badge) { badge.hidden = !recorder.recording; badge.textContent = `● ${recorder.count} actions`; }
    for (const button of document.querySelectorAll('[data-macro-run]')) button.disabled = this.running;
    for (const button of document.querySelectorAll('[data-macro-stop]')) button.disabled = !this.running;
  }
  updateBatchResults() {
    const list = document.querySelector('#macro-batch-results'); if (list) list.innerHTML = (this.batchResults || []).map(result => `<li class="${result.success ? 'result-success' : 'result-error'}"><strong>${escapeHTML(result.name)}</strong> — ${result.success ? 'Complete' : escapeHTML(result.error)}</li>`).join('');
    const download = document.querySelector('#macro-batch-download'); if (download) download.disabled = !this.lastOutputs.length || this.running;
  }
  render(container, page = 'editor') {
    container.innerHTML = `<div class="workspace-split"><nav class="workspace-nav" aria-label="Macro sections">${[['editor', 'Edit & run'], ['record', 'Record actions'], ['batch', 'Batch files'], ['triggers', 'Shortcuts & imports']].map(([id, label]) => `<a href="#macros/${id}"${page === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="#help/macros">Macro language guide ↗</a></nav><section class="workspace-page"><div class="macro-status-strip"><output data-macro-recording-status></output><output data-macro-progress role="status"></output><button data-macro-stop>Stop macro</button></div><div id="macro-page"></div></section></div>`;
    container.querySelector('[data-macro-stop]').onclick = () => this.cancel();
    const body = container.querySelector('#macro-page');
    if (page === 'record') this.renderRecorder(body); else if (page === 'batch') this.renderBatch(body); else if (page === 'triggers') this.renderTriggers(body); else this.renderEditor(body);
    this.updateStatus();
  }
  renderRecorder(body) {
    const recorder = this.runtime.recorder.getState();
    body.innerHTML = `<h3>Record actions, then repeat them.</h3><p>Successful operations become the same text commands you can type in the editor. Open the waveform editor while recording, perform your edits, then return here to finish.</p><label class="checkbox-field"><input id="macro-record-timing" type="checkbox"${recorder.timing ? ' checked' : ''}${recorder.recording ? ' disabled' : ''}> Record timing between actions</label><p class="field-hint">Off records ordered edits without thinking time. On adds explicit waits. Use automation lanes for smooth repeatable musical sweeps.</p><div class="inline-buttons"><button id="macro-record-start" class="primary"${recorder.recording ? ' disabled' : ''}>Record actions</button><button id="macro-record-stop"${recorder.recording ? '' : ' disabled'}>Finish recording</button><button id="macro-return-editor">Return to waveform</button></div><pre id="macro-recorded-text"><code>${escapeHTML(recorder.text || '// Recorded actions will appear here.')}</code></pre>`;
    body.querySelector('#macro-record-start').onclick = () => this.safe(async () => { await this.runtime.execute('macro.record.start', { timing: body.querySelector('#macro-record-timing').checked }); this.renderRecorder(body); });
    body.querySelector('#macro-record-stop').onclick = () => this.safe(async () => { await this.runtime.execute('macro.record.stop'); await this.open('editor'); });
    body.querySelector('#macro-return-editor').onclick = () => this.routes.close();
  }
  renderEditor(body) {
    body.innerHTML = `<h3>One script. Every workbench action.</h3><div class="form-grid"><label>Saved macro<select id="macro-library">${option('', 'Unsaved draft', this.settings.selectedId)}${this.settings.macros.map(item => option(item.id, item.name, this.settings.selectedId)).join('')}</select></label><label>Name<input id="macro-name" maxlength="120" value="${escapeHTML(this.find(this.settings.selectedId)?.name || 'My macro')}"></label></div><div class="inline-buttons"><button id="macro-save">Save macro</button><button id="macro-new">New draft</button><button id="macro-delete">Delete saved macro</button><button id="macro-load">Import .wsemacro</button><button id="macro-download">Download .wsemacro</button><input type="file" id="macro-file" accept=".wsemacro,text/plain" hidden></div><div class="visual-tabs macro-view-tabs" role="group" aria-label="Macro editing mode"><button id="macro-script-tab" aria-pressed="true">Script</button><button id="macro-visual-tab" aria-pressed="false">Visual steps</button></div><div id="macro-script-area"><label class="sr-only" for="macro-source">Macro source code</label><textarea id="macro-source" class="code-editor" spellcheck="false" maxlength="131072">${escapeHTML(this.settings.draft)}</textarea></div><div id="macro-visual-area" hidden></div><p id="macro-validation" role="status"></p><div class="modal-actions"><button id="macro-format">Format script</button><button id="macro-validate">Validate</button><button data-macro-run id="macro-run" class="primary">Run macro</button></div><p class="field-hint">Programs with variables, conditions or loops stay in Script mode. Visual editing never flattens structured logic.</p>`;
    const $ = selector => body.querySelector(selector), source = $('#macro-source');
    const sync = () => { this.setDraft(source.value); this.persist(); };
    source.addEventListener('input', () => { this.setDraft(source.value); }); source.addEventListener('change', sync);
    $('#macro-library').onchange = () => { const item = this.find($('#macro-library').value); if (item) { this.settings.selectedId = item.id; this.settings.draft = item.text; this.persist(); this.renderEditor(body); } };
    $('#macro-new').onclick = () => { this.settings.selectedId = ''; this.settings.draft = '// WebSoundEdit Macro 1\n'; this.persist(); this.renderEditor(body); };
    $('#macro-save').onclick = () => this.safe(() => { sync(); const name = $('#macro-name').value.trim(); if (!name) throw new Error('Give this macro a name.'); let item = this.find(this.settings.selectedId); if (!item) { if (this.settings.macros.length >= 32) throw new Error('The macro library is full. Remove a saved macro first.'); item = { id: `macro-${crypto.randomUUID()}`, name, text: this.settings.draft, shortcut: '' }; this.settings.macros.push(item); this.settings.selectedId = item.id; } else { item.name = name; item.text = this.settings.draft; } this.settings = normalizeMacroSettings(this.settings); this.persist(); this.renderEditor(body); this.progress = 'Macro saved. Triggers remain locally controlled.'; this.updateStatus(); });
    $('#macro-delete').onclick = () => { const id = this.settings.selectedId; this.settings.macros = this.settings.macros.filter(item => item.id !== id); if (this.settings.onImportId === id) { this.settings.onImportId = ''; this.onImportArmed = false; } this.settings.selectedId = ''; this.persist(); this.renderEditor(body); };
    $('#macro-load').onclick = () => $('#macro-file').click(); $('#macro-file').onchange = () => this.safe(async () => { const file = $('#macro-file').files[0]; if (!file) return; this.assertInteractive(); if (file.size > 131072) throw new Error('Macro file exceeds 128 KiB.'); const text = await file.text(); this.assertInteractive(); this.settings.draft = text; this.settings.selectedId = ''; this.disarm(); this.persist(); this.renderEditor(body); });
    $('#macro-download').onclick = () => { sync(); this.download(source.value, `${safeFilename($('#macro-name').value)}.wsemacro`, 'text/plain;charset=utf-8'); };
    $('#macro-validate').onclick = () => this.safe(() => { sync(); this.validate(); $('#macro-validation').textContent = 'Valid syntax, commands and known arguments. Dynamic values are validated when each command runs.'; });
    $('#macro-format').onclick = () => this.safe(() => { source.value = formatMacro(parseMacro(source.value)); sync(); });
    $('#macro-run').onclick = () => this.safe(async () => { sync(); await this.runtime.execute('macro.run', { text: source.value, variables: { inputs: this.fileIO.aliases(), ...(this.fileIO.aliases()[0] ? { input: this.fileIO.aliases()[0] } : {}) } }); });
    $('#macro-script-tab').onclick = () => { $('#macro-script-area').hidden = false; $('#macro-visual-area').hidden = true; $('#macro-script-tab').setAttribute('aria-pressed', 'true'); $('#macro-visual-tab').setAttribute('aria-pressed', 'false'); };
    $('#macro-visual-tab').onclick = () => this.safe(() => { sync(); const steps = macroToSteps(source.value); if (!steps) { $('#macro-validation').textContent = 'This program contains structured logic. Continue in Script mode; no commands have been changed.'; return; } $('#macro-script-area').hidden = true; $('#macro-visual-area').hidden = false; $('#macro-script-tab').setAttribute('aria-pressed', 'false'); $('#macro-visual-tab').setAttribute('aria-pressed', 'true'); this.renderSteps($('#macro-visual-area'), steps, text => { source.value = text; sync(); }); });
  }
  renderSteps(container, steps, onChange) {
    const catalog = this.runtime.commands().filter(item => item.recordable && !item.method.startsWith('macro.'));
    container.innerHTML = `<ol class="macro-step-list">${steps.map((step, index) => `<li data-macro-step="${index}" draggable="true"><div class="macro-step-heading"><strong>${index + 1}. <code>${escapeHTML(step.method)}</code></strong><div><button data-step-move="${index}" data-direction="-1"${index ? '' : ' disabled'} aria-label="Move step ${index + 1} up">↑</button><button data-step-move="${index}" data-direction="1"${index < steps.length - 1 ? '' : ' disabled'} aria-label="Move step ${index + 1} down">↓</button><button data-step-remove="${index}" aria-label="Remove step ${index + 1}">Remove</button></div></div><label>Command arguments<textarea data-step-params="${index}" class="code-editor compact" spellcheck="false">${escapeHTML(step.paramsSource ?? JSON.stringify(step.params || {}, null, 2))}</textarea></label></li>`).join('')}</ol><div class="midi-learn-row"><label>Add command<select id="macro-add-command">${catalog.map(item => option(item.method, `${item.method} — ${item.label || item.description}`, '')).join('')}</select></label><button id="macro-add-step">Add step</button></div>`;
    const commit = () => { const text = stepsToMacro(steps); parseMacro(text); onChange(text); };
    container.querySelectorAll('[data-step-params]').forEach(input => input.onchange = () => this.safe(() => { const index = +input.dataset.stepParams, old = steps[index]; steps[index] = { method: old.method, paramsSource: input.value }; try { commit(); } catch (error) { steps[index] = old; input.value = old.paramsSource ?? JSON.stringify(old.params || {}); throw error; } }));
    const move = (from, to) => { if (from === to || to < 0 || to >= steps.length) return; const [step] = steps.splice(from, 1); steps.splice(to, 0, step); commit(); this.renderSteps(container, steps, onChange); };
    container.querySelectorAll('[data-step-move]').forEach(button => button.onclick = () => this.safe(() => move(+button.dataset.stepMove, +button.dataset.stepMove + +button.dataset.direction)));
    container.querySelectorAll('[data-step-remove]').forEach(button => button.onclick = () => { steps.splice(+button.dataset.stepRemove, 1); commit(); this.renderSteps(container, steps, onChange); });
    let dragged = null; container.querySelectorAll('[data-macro-step]').forEach(row => { row.ondragstart = event => { if (event.target.closest('textarea,input,button')) { event.preventDefault(); return; } dragged = +row.dataset.macroStep; event.dataTransfer.setData('text/plain', String(dragged)); }; row.ondragover = event => { if (dragged !== null) event.preventDefault(); }; row.ondrop = event => { event.preventDefault(); if (dragged !== null) move(dragged, +row.dataset.macroStep); dragged = null; }; row.ondragend = () => { dragged = null; }; });
    container.querySelector('#macro-add-step').onclick = () => { steps.push({ method: container.querySelector('#macro-add-command').value, params: {} }); commit(); this.renderSteps(container, steps, onChange); };
  }
  renderTriggers(body) {
    body.innerHTML = `<h3>Local triggers</h3><p>Definitions can be saved in a project. Imported definitions never arm themselves. Enable the controls here after reviewing the scripts.</p><label class="checkbox-field"><input id="macro-shortcuts-armed" type="checkbox"${this.shortcutsArmed ? ' checked' : ''}> Enable saved macro shortcuts on this device now</label><div class="shortcuts-list">${this.settings.macros.map(item => `<label class="shortcut-row"><span>${escapeHTML(item.name)}</span><input data-macro-shortcut="${item.id}" value="${escapeHTML(item.shortcut)}" placeholder="e.g. ctrl+shift+1" aria-label="Shortcut for macro ${escapeHTML(item.name)}"></label>`).join('') || '<p>Save a macro in Edit & run first.</p>'}</div><button id="macro-save-shortcuts">Save macro shortcuts</button><h4>After manual import</h4><label>Macro<select id="macro-on-import">${option('', 'No import trigger', this.settings.onImportId)}${this.settings.macros.map(item => option(item.id, item.name, this.settings.onImportId)).join('')}</select></label><label class="checkbox-field"><input id="macro-import-armed" type="checkbox"${this.onImportArmed ? ' checked' : ''}> Arm after-import macro for this session</label><p class="field-hint">Runs once after a successful manual import batch. Imports made by a macro or batch do not trigger it again. Opening a project or importing script definitions disarms it.</p>`;
    body.querySelector('#macro-shortcuts-armed').onchange = event => { this.shortcutsArmed = event.target.checked; };
    body.querySelector('#macro-save-shortcuts').onclick = () => this.safe(() => { const proposed = clone(this.settings); for (const input of body.querySelectorAll('[data-macro-shortcut]')) proposed.macros.find(item => item.id === input.dataset.macroShortcut).shortcut = input.value.trim(); const next = normalizeMacroSettings(proposed); for (const item of next.macros) if (item.shortcut && this.isReservedShortcut?.(item.shortcut)) throw new Error(`Shortcut ${item.shortcut} is already used by a workbench action.`); this.settings = next; this.persist(); this.progress = 'Macro shortcut definitions saved.'; this.updateStatus(); });
    body.querySelector('#macro-on-import').onchange = event => { this.settings.onImportId = event.target.value; this.onImportArmed = false; body.querySelector('#macro-import-armed').checked = false; this.persist(); };
    body.querySelector('#macro-import-armed').onchange = event => this.safe(() => { if (event.target.checked && !this.find(this.settings.onImportId)) { event.target.checked = false; throw new Error('Choose an on-import macro first.'); } if (event.target.checked) this.validate(this.find(this.settings.onImportId).text); this.onImportArmed = event.target.checked; });
  }
  renderBatch(body) {
    body.innerHTML = `<h3>Process files in order</h3><p>Each input starts in a cleared project. If your macro has no file.import command, the file is imported first. The current session is restored when the batch ends; completed downloads remain. While the batch owns this session, use progress, help and Stop; editing, MIDI controls and outside file operations resume after restoration. Ordinary Run macros remain interactive.</p><div class="form-grid"><label>Macro<select id="batch-macro">${option('', 'Current draft', '')}${this.settings.macros.map(item => option(item.id, item.name, this.settings.selectedId)).join('')}</select></label><label>Input files<input id="batch-files" type="file" accept="audio/*,.mid,.midi,.json,.aup3,.zip,.rpp" multiple></label></div><p id="batch-input-count">${this.batchInputs.length} files supplied</p><label class="checkbox-field"><input id="batch-continue" type="checkbox"> Continue to the next file after an error</label><label class="checkbox-field"><input id="batch-auto-download" type="checkbox"> Download each output as it completes</label><p class="field-hint">Collected outputs are bounded at ${bytesLabel(MAX_EXPORT_COLLECTION_BYTES)}. Use smaller batches for large audio. No arbitrary paths are read by a script.</p><div class="inline-buttons"><button id="batch-run" data-macro-run class="primary">Run batch</button><button id="macro-batch-download" disabled>Download collected outputs ZIP</button></div><ol id="macro-batch-results" class="batch-results"></ol>`;
    body.querySelector('#batch-files').onchange = event => this.safe(() => { this.batchInputs = this.fileIO.supply([...event.target.files]); body.querySelector('#batch-input-count').textContent = `${this.batchInputs.length} files supplied`; });
    body.querySelector('#batch-run').onclick = () => this.safe(() => this.runtime.execute('macro.batch', { ...(body.querySelector('#batch-macro').value ? { macroId: body.querySelector('#batch-macro').value } : {}), inputIds: this.batchInputs.map(input => input.id), continueOnError: body.querySelector('#batch-continue').checked, download: body.querySelector('#batch-auto-download').checked }));
    body.querySelector('#macro-batch-download').onclick = () => this.safe(() => { const files = Object.fromEntries(this.lastOutputs.map(output => [output.name, output.bytes])); const bytes = zipSync(files, { level: 0 }); if (bytes.length > MAX_EXPORT_COLLECTION_BYTES + 1024 * 1024) throw new Error('Batch ZIP exceeds its output bound.'); this.download(bytes, 'websoundedit-batch.zip', 'application/zip'); });
    this.updateBatchResults();
  }
  dispose() { this.cancel(); this.unsubscribe?.(); }
}
