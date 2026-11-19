import { escapeHTML } from './ui-utils.js';
import { RACK_EFFECTS } from './rack-config.js';

const PARAMETER_TIPS = {
  timeMs: 'Set the spacing between repeats.', repeats: 'Choose how many echoes follow the original.', decay: 'Set how much level each following echo retains.',
  feedback: 'Return some of the effect output to its input; higher absolute values sustain the resonant repeats.',
  room: 'Increase the modeled room size and reverb duration.', damping: 'Absorb more high frequencies as the reverberation decays.', predelayMs: 'Leave a gap before the reverberation begins.',
  rate: 'Set how many modulation cycles occur each second.', depthMs: 'Set the delay sweep width.', delayMs: 'Set the base delay around which the chorus moves.', depth: 'Set how strongly the modulation changes the sound.',
  drive: 'Push the signal into saturation.', tone: 'Choose the high-frequency cutoff after distortion.', type: 'Choose low-pass, high-pass, band-pass or notch frequency shaping.',
  frequency: 'Choose the filter cutoff or center frequency.', q: 'Concentrate resonance around the cutoff or center frequency.', wow: 'Add slow tape-speed drift.', flutter: 'Add faster tape-speed movement.', warmth: 'Soften high frequencies for a warmer tape tone.',
  division: 'Divide one tempo beat into this many stutter slices.', gate: 'Set the audible fraction of each repeated slice.', fadeMs: 'Smooth slice edges to reduce abrupt clicks.', bits: 'Reduce amplitude resolution for quantization texture.', hold: 'Repeat each sampled value across this many frames.',
};

const FEATURES = {
  'preview.apply': ['Write the current effect into the selected samples. Other samples and channels stay intact. Undo restores the previous audio.', 'effects'],
  'preview.audition': ['Listen to the processed selection before applying it. This preview does not change the saved audio.', 'effects'],
  'preview.compare': ['Switch between original and processed audio so you can judge the effect at the same selection.', 'effects'],
  'view.inspector': ['Collapse Shape the sound to give the waveform more space. Your effects remain configured.', 'navigation'],
  'view.zoomSelection': ['Fit the current selected region in the waveform view without changing its sample boundaries.', 'tracks'],
  'view.selection': ['Fit the selected region in the waveform view. The selected samples stay the same.', 'tracks'],
  'selection.export': ['Export only the selected samples and selected channels as a new audio file.', 'export'],
  'record': ['Record a short microphone take into the editor. Use Live performance for long disk recordings.', 'recording'],
  'transport.play': ['Play or pause the project. Live effects stay active while you turn their controls.', 'navigation'],
  'transport.loop': ['Repeat the selected timeline range during playback, or repeat the full project when no range is selected.', 'looping'],
  'history.undo': ['Undo the last audio or project edit. Downloads and already captured audio are not rolled back.', 'editing'],
  'panel.midi': ['Connect a MIDI device, map continuous knobs or assign an edge-triggered pedal to a command or macro.', 'midi'],
  'panel.metadata': ['Edit text tags stored in the session and embedded in supported audio exports.', 'export'],
  'panel.projects': ['Save a portable session or exchange supported project content with Audacity and REAPER.', 'compatibility'],
};
const chapterFor = action => /^(file|project\.save|selection\.export)/.test(action) ? 'export' : /midi/i.test(action) ? 'midi' : /macro/i.test(action) ? 'macros' : /loop/i.test(action) ? 'looping' : /record/i.test(action) ? 'recording' : /^(effect|preview|panel\.effects)/.test(action) ? 'effects' : /^(view|track|selection|clip)/.test(action) ? 'tracks' : /key/i.test(action) ? 'keys' : 'navigation';

/** Delegated guidance covers newly rendered rows and controls without rebinding them. */
export class GuidanceUI {
  constructor({ enabled = true, getCommand = () => null } = {}) {
    this.enabled = enabled; this.getCommand = getCommand; this.target = null;
    this.tip = document.createElement('div'); this.tip.id = 'feature-guidance'; this.tip.className = 'feature-guidance'; this.tip.setAttribute('role', 'tooltip'); this.tip.setAttribute('popover', 'manual'); this.tip.hidden = true; document.body.append(this.tip);
    this.over = event => { const target = event.target.closest?.('button,input,select,textarea,summary,a[href],[tabindex="0"]'); if (target && !target.closest('#feature-guidance')) this.show(target); };
    this.out = event => { if (!event.relatedTarget?.closest?.('#feature-guidance') && !this.target?.contains(event.relatedTarget)) this.hide(); };
    this.key = event => { if (event.key === 'Escape' && this.target) { if (!this.target.closest('#command-palette')) { event.preventDefault(); event.stopPropagation(); } this.hide(); } };
    document.addEventListener('pointerover', this.over); document.addEventListener('focusin', this.over);
    document.addEventListener('pointerout', this.out); document.addEventListener('focusout', this.out); document.addEventListener('keydown', this.key, true);
    this.tip.addEventListener('pointerleave', () => this.hide());
    this.scan(document.body);
    this.observer = new MutationObserver(records => { for (const record of records) { if (record.type === 'attributes') this.scan(record.target); else for (const node of record.addedNodes) if (node.nodeType === 1 && node !== this.tip) this.scan(node); } });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
  }
  scan(root) { for (const element of [...(root.matches?.('[title]') ? [root] : []), ...root.querySelectorAll?.('[title]') || []]) { if (element.title) element.dataset.nativeTip = element.title; element.removeAttribute('title'); } }
  setEnabled(enabled) { this.enabled = Boolean(enabled); document.documentElement.dataset.tooltips = this.enabled ? 'on' : 'off'; if (!this.enabled) this.hide(); }
  description(target) {
    const action = target.dataset.action || target.dataset.command || '', descriptor = this.getCommand(action);
    let text = target.dataset.guide || FEATURES[action]?.[0] || descriptor?.description;
    const name = target.getAttribute('aria-label') || target.labels?.[0]?.textContent?.trim() || target.textContent.trim();
    if (!text && target.matches('[data-rack-wet],[data-rack-wet-number]')) text = 'Wet/dry blends this effect with its incoming signal: 0% is dry, 100% is fully processed. Each rack stage has its own blend.';
    if (!text && target.matches('[data-rack-param]')) { const effect=target.closest('[data-rack-effect]')?.dataset.rackEffect,field=RACK_EFFECTS[effect]?.fields.find(item=>item.key===target.dataset.rackParam); text = `${name || target.dataset.rackParam}${field?.unit ? ` (${field.unit})` : ''}. ${PARAMETER_TIPS[target.dataset.rackParam] || RACK_EFFECTS[effect]?.description || 'Adjust this effect.'} In Live mode, playback keeps running.`; }
    if (!text && target.matches('[data-rack-drag]')) text = 'Drag to reorder the effect. With keyboard focus, use Up/Down or Home/End. Audio passes through effects from top to bottom.';
    if (!text && target.matches('[data-track-close]')) text = 'Remove this track and release its active loop voice. Undo restores the track audio.';
    if (!text && target.matches('[data-track-export]')) text = 'Export or save this track, even when another track is selected.';
    if (!text && target.closest('#effect-controls')) text = `${name || 'Effect parameter'}. ${document.querySelector('#effect-description')?.textContent || 'Adjust the selected effect in the preview. Apply writes it into the selected samples and channels; Undo restores the previous audio.'}`;
    if (!text) text = target.dataset.nativeTip;
    if (!text) text = name ? `${name}.${target.matches('input[type="range"]') ? ' Use arrow keys for small changes; Home and End reach the limits.' : ''}` : 'Use this control to adjust the workbench.';
    if (target.min !== undefined && target.min !== '' && target.max !== '') text += ` Range ${target.min}–${target.max}${target.step && target.step !== 'any' ? `; step ${target.step}` : ''}.`;
    return { text, chapter: target.dataset.help || FEATURES[action]?.[1] || chapterFor(action) };
  }
  show(target) {
    if (!this.enabled || target.disabled || target === this.target) return;
    this.hide(); const { text, chapter } = this.description(target); this.target = target;
    this.tip.innerHTML = `<span>${escapeHTML(text)}</span><a href="#help/${escapeHTML(chapter)}">Read the ${escapeHTML(chapter)} guide ↗</a>`;
    this.tip.hidden = false; try { this.tip.showPopover?.(); } catch {}
    this.previousDescription = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', `${this.previousDescription || ''} feature-guidance`.trim());
    const rect = target.getBoundingClientRect(), bounds = this.tip.getBoundingClientRect();
    this.tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    this.tip.style.top = `${Math.max(8, rect.bottom + bounds.height + 12 < innerHeight ? rect.bottom + 8 : rect.top - bounds.height - 8)}px`;
  }
  hide() {
    if (this.target) { if (this.previousDescription) this.target.setAttribute('aria-describedby', this.previousDescription); else this.target.removeAttribute('aria-describedby'); }
    this.target = null; this.tip.hidden = true; try { this.tip.hidePopover?.(); } catch {}
  }
  dispose() { this.hide(); this.observer.disconnect(); for (const [name, callback] of [['pointerover', this.over], ['focusin', this.over], ['pointerout', this.out], ['focusout', this.out]]) document.removeEventListener(name, callback); document.removeEventListener('keydown', this.key, true); this.tip.remove(); }
}
