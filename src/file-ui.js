import { zipSync } from 'fflate';
import { encodeAudio, FORMATS } from './codecs.js';
import { metadataSupport } from './metadata.js';
import { FILE_COMMANDS } from './file-commands.js';
export { FILE_COMMANDS } from './file-commands.js';
import { escapeHTML, option, bytesLabel } from './ui-utils.js';

export const MAX_EXPORT_COLLECTION_BYTES = 128 * 1024 * 1024;
export function safeFilename(value, fallback = 'audio') {
  const clean = String(value || fallback).normalize('NFKC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 100).replace(/[\uD800-\uDBFF]$/, '');
  return !clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? fallback : clean;
}
export function uniqueFilename(value, extension, used) {
  const stem = safeFilename(value); let name = `${stem}.${extension}`, suffix = 2;
  while (used.has(name.toLocaleLowerCase('en-US'))) name = `${stem.slice(0, 90)} (${suffix++}).${extension}`;
  used.add(name.toLocaleLowerCase('en-US')); return name;
}
/** Browser file references stay outside scripts/project JSON. Scripts receive aliases only. */
export class BrowserFileIO {
  constructor(dependencies) { Object.assign(this, dependencies); this.inputs = new Map(); this.serial = 0; this.collection = null; this.accessGuards = new Set(); }
  addAccessGuard(guard) { if (typeof guard !== 'function') throw new TypeError('Provide a file-operation guard.'); this.accessGuards.add(guard); return () => this.accessGuards.delete(guard); }
  assertAccess(operation, context = {}) { for (const guard of this.accessGuards) guard({ operation, context }); }
  register(runtime) { for (const descriptor of FILE_COMMANDS) runtime.register(descriptor, (params, context) => this[descriptor.method === 'file.import' ? 'import' : descriptor.method === 'file.export' ? 'export' : 'exportStems'](params, context)); }
  supply(files, { append = false, ...context } = {}) {
    this.assertAccess('supply', context);
    if (!Array.isArray(files) || files.length > 128 || files.some(file => !file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string')) throw new Error('Supply up to 128 local files.');
    if (!append) this.inputs.clear();
    if (this.inputs.size + files.length > 128) throw new Error('Too many supplied input aliases. Start a new input batch.');
    return files.map(file => { const id = `input-${++this.serial}`, alias = { id, name: file.name, stem: safeFilename(file.name.replace(/\.[^.]+$/, '')), size: file.size }; this.inputs.set(id, { file, alias }); return { ...alias }; });
  }
  aliases() { return [...this.inputs.values()].map(({ alias }) => ({ ...alias })); }
  async import(params, context = {}) {
    this.assertAccess('import', context);
    const id = typeof params.input === 'string' ? params.input : params.input?.id;
    if (typeof id !== 'string' || !this.inputs.has(id)) throw new Error('This input alias is unavailable. Supply the local file in Import or Batch first.');
    context.signal?.throwIfAborted(); const { file } = this.inputs.get(id);
    const result = await this.importOne(file, params, context);
    return { ...result, input: id, filename: file.name, clipIds: result?.clipIds || (result?.id ? [result.id] : []), ...(result?.warnings ? { warnings: result.warnings } : {}) };
  }
  beginCollection({ limit = MAX_EXPORT_COLLECTION_BYTES, download = false, ...context } = {}) { this.assertAccess('collect', context); if (this.collection) throw new Error('An output collection is already active.'); this.collection = { limit: Math.min(limit, MAX_EXPORT_COLLECTION_BYTES), total: 0, files: [], used: new Set(), download }; }
  finishCollection(context = {}) { this.assertAccess('collect', context); const value = this.collection; this.collection = null; return value ? { files: value.files, total: value.total } : { files: [], total: 0 }; }
  emit(result, name, download = true, context = {}) {
    this.assertAccess('export', context);
    if (this.collection) {
      if (this.collection.total + result.bytes.byteLength > this.collection.limit) throw new Error(`Collected outputs exceed ${bytesLabel(this.collection.limit)}. Use individual downloads or a smaller batch.`);
      const unique = uniqueFilename(name, result.ext, this.collection.used); this.collection.total += result.bytes.byteLength; this.collection.files.push({ name: unique, ...result });
      if (this.collection.download) this.download(result.bytes, unique, result.mime);
    } else if (download) this.download(result.bytes, `${safeFilename(name)}.${result.ext}`, result.mime);
    return result;
  }
  async export(params = {}, context = {}) {
    this.assertAccess('export', context);
    context.signal?.throwIfAborted(); const state = this.getState(), scope = params.scope || 'mix', format = params.format || 'wav';
    const trackId = params.trackId || (scope === 'track' ? state.selectedTrackId : undefined);
    if (scope === 'track' && !state.tracks.some(track => track.id === trackId)) throw new Error('Choose an available track to export.');
    const name = params.name || (scope === 'track' ? state.tracks.find(track => track.id === trackId)?.name : state.name);
    let result;
    if (['session', 'aup3', 'aup', 'reaper'].includes(format)) {
      if (!['mix', 'track'].includes(scope)) throw new Error('Editable project export supports a full session or one track. Use audio export for a clip or selection.');
      if (params.live) throw new Error('Live effects are rendered audio. Apply them first before saving an editable project.');
      const project = await this.getProject(scope === 'track' ? trackId : undefined);
      if (format === 'session') result = { bytes: new TextEncoder().encode(JSON.stringify(project)), mime: 'application/json', ext: 'websoundedit.json', warnings: [] };
      else if (format === 'reaper') { const { exportReaper } = await import('./reaper.js'); result = await exportReaper(project, { format: 'zip' }); }
      else { const { exportAudacity } = await import('./audacity.js'); result = await exportAudacity(project, { format, multichannel: params.multichannel || 'reject' }); }
    } else {
      const render = { scope, ...(trackId ? { trackId } : {}), ...(params.clipId ? { clipId: params.clipId } : {}) };
      for (const key of ['raw', 'outputLayout', 'respectMute', 'respectSolo', 'start', 'end']) if (params[key] !== undefined) render[key] = params[key];
      if (params.live && params.raw) throw new Error('Choose either raw source audio or a live-effects render.');
      const audio = await (params.live ? this.executeLive('live.render', render, context) : this.executeCore('audio.render', render));
      context.signal?.throwIfAborted(); result = await encodeAudio(audio, { ...params, metadata: state.metadata || {} });
    }
    context.signal?.throwIfAborted(); return this.emit(result, scope === 'selection' ? `${name}-selection` : name, params.download !== false, context);
  }
  async exportStems(params = {}, context = {}) {
    this.assertAccess('exportStems', context);
    const state = this.getState(), ids = params.trackIds || state.tracks.filter(track => track.clips.length).map(track => track.id);
    if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !state.tracks.some(track => track.id === id))) throw new Error('Choose one to 64 unique available tracks for stems.');
    if (['session', 'aup3', 'aup', 'reaper'].includes(params.format)) throw new Error('Stems contain rendered audio. Save a session separately to preserve editable structure.');
    const files = Object.create(null), used = new Set(), warnings = []; let total = 0;
    // Do not feed each internal stem into an outer batch output collection.
    const collection = this.collection; this.collection = null;
    try {
      for (const trackId of ids) {
        context.signal?.throwIfAborted(); const track = state.tracks.find(item => item.id === trackId);
        const result = await this.export({ ...params, scope: 'track', trackId, download: false, respectMute: params.respectMute === true, respectSolo: params.respectSolo === true, start: 0, ...(params.align !== false ? { end: state.duration } : {}) }, context);
        total += result.bytes.byteLength; if (total > MAX_EXPORT_COLLECTION_BYTES) throw new Error(`Stem ZIP exceeds ${bytesLabel(MAX_EXPORT_COLLECTION_BYTES)}. Export fewer tracks or individual files.`);
        files[uniqueFilename(track.name, result.ext, used)] = result.bytes; warnings.push(...result.warnings || []);
      }
    } finally { this.collection = collection; }
    context.signal?.throwIfAborted(); const bytes = zipSync(files, { level: 0 });
    if (bytes.length > MAX_EXPORT_COLLECTION_BYTES) throw new Error('The stem archive exceeds its output size limit. Export fewer tracks.');
    return this.emit({ bytes, ext: 'zip', mime: 'application/zip', warnings, tracks: ids.length }, params.name || `${state.name}-stems`, params.download !== false, context);
  }
}

export class ExportPanel {
  constructor(dependencies) { Object.assign(this, dependencies); }
  open({ scope = 'mix', trackId, format = 'wav' } = {}) {
    const state = this.getState(); if (scope === 'selection' && !state.selection) throw new Error('Select a waveform region first.');
    const chosenTrack = state.tracks.find(track => track.id === (trackId || state.selectedTrackId));
    this.openModal('Save and export', `<p>Choose editable session data or rendered sound. A track export always uses the track selected below.</p><div class="form-grid"><label>Export scope<select id="export-scope">${[['mix', 'Full project mix / session'], ['track', 'One track'], ['clip', 'Selected clip'], ['selection', 'Selected region'], ['stems', 'All tracks as a stem ZIP']].map(([value, label]) => option(value, label, scope)).join('')}</select></label><label>Track<select id="export-track">${state.tracks.map(track => option(track.id, track.name, chosenTrack?.id)).join('')}</select></label><label>File format<select id="export-format">${[...FORMATS.map(item => [item.id, item.name]), ['session', 'WebSoundEdit editable JSON'], ['aup3', 'Audacity native .aup3'], ['aup', 'Audacity legacy ZIP'], ['reaper', 'REAPER .rpp + media ZIP']].map(([value, label]) => option(value, label, format)).join('')}</select></label><label>Filename<input id="export-name" value="${escapeHTML(scope === 'track' ? chosenTrack?.name : state.name)}" maxlength="200"></label><label>Sound source<select id="export-source"><option value="committed">Committed audio + mix controls</option><option value="live">Render current live effects</option><option value="raw">Raw / committed PCM without mix controls</option></select></label><label>Output layout<select id="export-layout">${[['project', `Project (${state.outputLayout || 'stereo'})`], ['mono', 'Mono'], ['stereo', 'Stereo'], ['5.1', '5.1 surround'], ['7.1', '7.1 surround']].map(([value, label]) => option(value, label, 'project')).join('')}</select></label><label>Sample rate<select id="export-rate">${[16000, 22050, 32000, 44100, 48000, 88200, 96000].map(rate => option(rate, `${rate / 1000} kHz`, state.sampleRate)).join('')}</select></label><label>PCM depth<select id="export-depth"><option value="16">16-bit PCM</option><option value="24" selected>24-bit PCM</option><option value="32">32-bit float WAV</option></select></label><label>Lossy bitrate<select id="export-bitrate">${[64, 96, 128, 192, 256, 320].map(rate => option(rate, `${rate} kb/s`, 192)).join('')}</select></label><label>Audacity surround policy<select id="export-surround"><option value="reject">Reject surround project</option><option value="split-mono">Split into labeled mono channel tracks</option></select></label></div><div class="export-flags"><label class="checkbox-field"><input type="checkbox" id="export-honor-mute"> Honor track mute for independent track/stem export</label><label class="checkbox-field"><input type="checkbox" id="export-align" checked> Align stem starts and ends to project length</label></div><p class="info-note" id="export-note">Live renders start with empty effect history at the requested range start. Automation retains timeline time; tails are not appended. Use Recorder to capture actual running feedback.</p><p id="export-metadata-note" class="field-hint"></p><button id="export-edit-metadata">Edit metadata</button><p id="export-progress" role="status"></p><div class="modal-actions"><button id="export-cancel">Close</button><button class="primary" id="export-go">Export ↗</button></div>`, container => {
      const $ = selector => container.querySelector(selector), refresh = () => {
        const scopeValue = $('#export-scope').value, formatValue = $('#export-format').value, project = ['session', 'aup3', 'aup', 'reaper'].includes(formatValue);
        $('#export-track').disabled = scopeValue !== 'track'; $('#export-align').disabled = scopeValue !== 'stems'; $('#export-honor-mute').disabled = !['track', 'stems'].includes(scopeValue);
        for (const id of ['source', 'layout', 'rate', 'depth', 'bitrate']) $(`#export-${id}`).disabled = project;
        $('#export-surround').disabled = !['aup3', 'aup'].includes(formatValue);
        $('#export-metadata-note').textContent = `${Object.keys(state.metadata || {}).length} metadata fields. ${project ? 'Supported project metadata is retained. Live draft effects must be committed before editable interchange.' : metadataSupport(formatValue).note}`;
      };
      $('#export-scope').onchange = refresh; $('#export-format').onchange = refresh; refresh();
      $('#export-cancel').onclick = this.closeModal; $('#export-edit-metadata').onclick = this.editMetadata;
      $('#export-go').onclick = () => this.safe(async () => {
        const button = $('#export-go'); button.disabled = true;
        try {
          const value = $('#export-scope').value, params = { scope: value === 'stems' ? 'track' : value, format: $('#export-format').value, name: $('#export-name').value, sampleRate: +$('#export-rate').value, bitDepth: +$('#export-depth').value, bitrate: +$('#export-bitrate').value, multichannel: $('#export-surround').value };
          if (value === 'track') params.trackId = $('#export-track').value;
          if (!['session', 'aup3', 'aup', 'reaper'].includes(params.format)) { params.live = $('#export-source').value === 'live'; params.raw = $('#export-source').value === 'raw'; if ($('#export-layout').value !== 'project') params.outputLayout = $('#export-layout').value; }
          if (['track', 'stems'].includes(value)) { params.respectMute = $('#export-honor-mute').checked; params.respectSolo = false; }
          if (value === 'stems') params.align = $('#export-align').checked;
          const result = await this.execute(value === 'stems' ? 'file.exportStems' : 'file.export', params);
          $('#export-progress').textContent = `Saved ${result.ext.toUpperCase()} · ${bytesLabel(result.bytes.length)}${result.warnings?.length ? ' · ' + result.warnings.join(' ') : ''}`;
          this.status('Export complete.');
        } finally { if (button.isConnected) button.disabled = false; }
      });
    });
  }
}
