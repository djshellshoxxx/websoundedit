import './preset-ui.css';
import { AUDIO_PRESETS, PRESET_CATEGORIES, DEFAULT_PRESET_ID, getAudioPreset } from './presets.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const label = value => ({ eq: 'Equalizer', dcRemove: 'Remove DC offset', noiseGate: 'Noise gate', deEsser: 'De-esser', repairClipping: 'Clipped-peak repair', stereoCenter: 'Stereo center processing', autoLimiter: 'Automatic limiter' }[value] || String(value || 'Processing').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase()));

/** A shared preset catalog feeding the existing worker preview and undo path. */
export class PresetPanel {
  constructor(container, { onChange = () => {}, getContext = () => ({}), assertInteractive = () => {}, safe = operation => operation() } = {}) {
    this.el = container; this.onChange = onChange; this.getContext = getContext;
    this.assertInteractive = assertInteractive; this.safe = safe;
    this.selectedId = DEFAULT_PRESET_ID; this.query = ''; this.category = 'all';
    this.el.innerHTML = `<div class="preset-intro"><h3>Start with a sound goal.</h3><p>Choose a preset, audition the preview, then Apply. One Undo restores the original audio.</p></div>
      <div class="preset-filters"><label>Find a preset<input id="preset-search" type="search" placeholder="Vocal, limiter, mastering…" autocomplete="off"></label><label>Category<select id="preset-category"><option value="all">All categories</option>${PRESET_CATEGORIES.map(category => `<option value="${escape(category)}">${escape(category)}</option>`).join('')}</select></label></div>
      <p id="preset-results" class="preset-count" role="status" aria-live="polite"></p><div id="preset-list" class="preset-list" role="group" aria-label="Audio presets"></div>
      <section id="preset-detail" class="preset-detail" aria-label="Selected preset"></section>`;
    this.el.querySelector('#preset-search').addEventListener('input', event => { this.query = event.target.value; this.renderList(); });
    this.el.querySelector('#preset-category').addEventListener('change', event => { this.category = event.target.value; this.renderList(); });
    this.el.querySelector('#preset-list').addEventListener('click', event => {
      const button = event.target.closest('[data-preset-id]');
      if (button) this.safe(() => { this.assertInteractive(); this.choose(button.dataset.presetId); });
    });
    this.renderList(); this.renderDetail();
  }

  params() { return { presetId: this.selectedId }; }
  get preset() { return getAudioPreset(this.selectedId); }
  choose(id, { notify = true } = {}) {
    this.selectedId = AUDIO_PRESETS.some(preset => preset.id === id) ? id : DEFAULT_PRESET_ID;
    for (const button of this.el.querySelectorAll('[data-preset-id]')) button.setAttribute('aria-pressed', String(button.dataset.presetId === this.selectedId));
    this.renderDetail();
    if (notify) this.onChange('preset', this.params());
  }

  renderList() {
    const words = this.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const presets = AUDIO_PRESETS.filter(preset => {
      const text = `${preset.title} ${preset.category} ${preset.description} ${preset.id}`.toLocaleLowerCase();
      return (this.category === 'all' || preset.category === this.category) && words.every(word => text.includes(word));
    });
    this.el.querySelector('#preset-results').textContent = `${presets.length} of ${AUDIO_PRESETS.length} presets`;
    this.el.querySelector('#preset-list').innerHTML = presets.map(preset => `<button data-preset-id="${escape(preset.id)}" class="preset-choice" aria-pressed="${preset.id === this.selectedId}"><strong>${escape(preset.title)}</strong><span>${escape(preset.category)}${preset.stereoOnly ? ' · Stereo' : ''}</span></button>`).join('') || '<p class="preset-empty">No matching preset. Try a shorter search or another category.</p>';
  }

  renderDetail() {
    const preset = this.preset;
    const limitations = Array.isArray(preset.limitations) ? preset.limitations.join(' ') : preset.limitations;
    this.el.querySelector('#preset-detail').innerHTML = `<span class="eyebrow">SELECTED PRESET</span><h3>${escape(preset.title)}</h3><p>${escape(preset.description)}</p>
      <ol class="preset-steps" aria-label="Processing order">${preset.steps.map(step => `<li>${escape(step.label || label(step.effect || step.type))}</li>`).join('')}</ol>
      ${limitations ? `<p class="preset-limits">${escape(limitations)}</p>` : ''}<p id="preset-source-note" class="preset-source-note"></p>`;
    this.refreshContext();
  }

  refreshContext() {
    const note = this.el.querySelector('#preset-source-note'); if (!note) return;
    const { clip, selection } = this.getContext(), preset = this.preset;
    const allChannels = !selection || ['all', 'both'].includes(selection.channels) || Array.isArray(selection.channels) && selection.channels.length === 2 && selection.channels.includes(0) && selection.channels.includes(1);
    const incompatible = preset.stereoOnly && clip && (clip.channels !== 2 || !allChannels);
    note.classList.toggle('preset-incompatible', Boolean(incompatible));
    note.textContent = !clip ? 'Import audio or choose a clip to preview this preset.' : incompatible ? 'This preset needs a stereo clip with both channels selected. Choose All channels before previewing.' : `${selection ? 'Selected region' : 'Whole selected clip'} · ${clip.channels} channel${clip.channels === 1 ? '' : 's'} · sample length preserved`;
  }
}
