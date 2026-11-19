import './rack-ui.css';
import {
  MAX_RACK_EFFECTS, RACK_EFFECTS, createRackEffect, normalizeRackSettings,
  rackTargets, valueFromPosition, positionFromValue,
} from './rack-config.js';

const clone = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const format = value => Number(value.toFixed(4)).toString();
const token = target => target ? `${target.id}:${target.key}` : '';
const filterNames = { lowpass: 'Low-pass', highpass: 'High-pass', bandpass: 'Band-pass', notch: 'Notch' };

/** An ordered effect editor. Audio rendering remains in the engine worker. */
export class RackPanel {
  constructor(container, { onChange = () => {}, getBpm = () => 120, onMessage = () => {} } = {}) {
    if (!container) throw new Error('The effects rack needs a container.');
    this.el = container;
    this.onChange = onChange;
    this.getBpm = getBpm;
    this.onMessage = onMessage;
    this.chain = [];
    this.xy = { x: null, y: null };
    this.expanded = new Set();
    this.dragId = null;
    this.pointer = null;
    this.addChoice = 'echo';
    this.el.addEventListener('click', event => this.click(event));
    this.el.addEventListener('input', event => this.input(event));
    this.el.addEventListener('change', event => this.change(event));
    this.el.addEventListener('keydown', event => this.keydown(event));
    this.el.addEventListener('pointerdown', event => this.pointerDown(event));
    this.el.addEventListener('pointermove', event => this.pointerMove(event));
    this.el.addEventListener('pointerup', event => this.pointerEnd(event));
    this.el.addEventListener('pointercancel', event => this.pointerEnd(event, true));
    this.el.addEventListener('dragstart', event => this.dragStart(event));
    this.el.addEventListener('dragover', event => this.dragOver(event));
    this.el.addEventListener('drop', event => this.drop(event));
    this.el.addEventListener('dragend', () => this.clearDrag());
    this.el.addEventListener('toggle', event => {
      const card = event.target.closest?.('[data-rack-id]');
      if (card && event.target.matches('details')) {
        if (event.target.open) this.expanded.add(card.dataset.rackId);
        else this.expanded.delete(card.dataset.rackId);
      }
    }, true);
    this.render();
  }

  params() { return { chain: clone(this.chain) }; }
  save() { return { version: 1, chain: clone(this.chain), xy: clone(this.xy) }; }
  targets() { return rackTargets(this.chain); }

  load(value, { notify = false } = {}) {
    const next = normalizeRackSettings(value);
    this.chain = next.chain;
    this.xy = next.xy;
    this.expanded = new Set(this.chain.slice(0, 1).map(stage => stage.id));
    this.render();
    if (notify) this.changed();
  }

  getParameter(id, key) {
    const stage = this.chain.find(candidate => candidate.id === id);
    if (!stage) throw new Error('The rack stage no longer exists.');
    if (key === 'wet') return stage.wet;
    if (!Object.hasOwn(stage.params, key)) throw new Error('Unknown rack parameter.');
    return stage.params[key];
  }

  setParameter(id, key, value, { notify = true } = {}) {
    const stage = this.chain.find(candidate => candidate.id === id);
    if (!stage) throw new Error('The rack stage no longer exists.');
    const definition = key === 'wet' ? { min: 0, max: 1 } : RACK_EFFECTS[stage.effect].fields.find(field => field.key === key);
    if (!definition) throw new Error('Unknown rack parameter.');
    if (definition.type === 'select') {
      if (!definition.options.includes(value)) throw new Error('Unknown filter type.');
    } else {
      if (!Number.isFinite(value) || value < definition.min || value > definition.max) throw new Error('Rack parameter is outside its supported range.');
      if (definition.integer) value = Math.round(value);
    }
    if (key === 'wet') stage.wet = value;
    else stage.params[key] = value;
    this.refreshValues();
    if (notify) this.changed();
    return value;
  }

  setXY(x, y, { notify = true } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('XY positions must be finite.');
    for (const [axis, position] of [['x', x], ['y', y]]) {
      const target = this.target(axis);
      if (target) this.setParameter(target.id, target.key, valueFromPosition(target, position), { notify: false });
    }
    this.refreshValues();
    if (notify) this.changed();
  }

  add(effectName) {
    if (this.chain.length >= MAX_RACK_EFFECTS) throw new Error(`The rack is full. Remove a stage to add another (${MAX_RACK_EFFECTS} maximum).`);
    const stage = createRackEffect(effectName);
    this.chain.push(stage);
    this.expanded.add(stage.id);
    const targets = this.targets();
    if (!this.xy.x) this.xy.x = { id: targets[0].id, key: targets[0].key };
    if (!this.xy.y) {
      const second = targets.find(target => target.id === stage.id && token(target) !== token(this.xy.x));
      if (second) this.xy.y = { id: second.id, key: second.key };
    }
    this.render();
    this.changed();
    this.announce(`${RACK_EFFECTS[effectName].title} added at position ${this.chain.length}.`);
    return stage.id;
  }

  remove(id) {
    const index = this.chain.findIndex(stage => stage.id === id);
    if (index < 0) return;
    const [stage] = this.chain.splice(index, 1);
    this.expanded.delete(id);
    for (const axis of ['x', 'y']) if (this.xy[axis]?.id === id) this.xy[axis] = null;
    this.render();
    this.changed();
    this.announce(`${RACK_EFFECTS[stage.effect].title} removed.`);
    this.el.querySelector('[data-rack-add]')?.focus({ preventScroll: true });
  }

  move(id, nextIndex) {
    const index = this.chain.findIndex(stage => stage.id === id);
    if (index < 0) return;
    const destination = clamp(nextIndex, 0, this.chain.length - 1);
    if (index === destination) return;
    const [stage] = this.chain.splice(index, 1);
    this.chain.splice(destination, 0, stage);
    this.render();
    this.changed();
    this.announce(`${RACK_EFFECTS[stage.effect].title} moved to position ${destination + 1}.`);
    this.card(id)?.querySelector('[data-rack-drag]')?.focus({ preventScroll: true });
  }

  changed() { this.onChange('rack', this.params()); }
  announce(message) { const output = this.el.querySelector('[data-rack-status]'); if (output) output.textContent = message; }
  report(message) { this.announce(message); this.onMessage(message); }
  card(id) { return [...this.el.querySelectorAll('[data-rack-id]')].find(card => card.dataset.rackId === id); }
  target(axis) { const binding = this.xy[axis]; return binding && this.targets().find(target => target.id === binding.id && target.key === binding.key); }
  position(axis) { const target = this.target(axis); return target ? positionFromValue(target, target.value) : 0.5; }

  parameterHTML(stage, field) {
    const value = stage.params[field.key];
    const label = `${RACK_EFFECTS[stage.effect].title} ${field.label}`;
    if (field.type === 'select') return `<label class="rack-parameter"><span>${escape(field.label)}</span><select data-rack-param="${field.key}" aria-label="${escape(label)}">${field.options.map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${filterNames[option] || option}</option>`).join('')}</select></label>`;
    return `<div class="rack-parameter"><label for="rack-${stage.id}-${field.key}"><span>${escape(field.label)} <small>${escape(field.unit)}</small></span><input id="rack-${stage.id}-${field.key}" type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${format(value)}" data-rack-param="${field.key}" aria-label="${escape(label)}"></label><input type="range" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}" data-rack-param="${field.key}" aria-label="${escape(label)} slider"></div>`;
  }

  stageHTML(stage, index) {
    const definition = RACK_EFFECTS[stage.effect];
    const label = `${index + 1}. ${definition.title}`;
    const wet = Math.round(stage.wet * 100);
    return `<li class="rack-stage ${stage.enabled ? '' : 'is-bypassed'}" data-rack-id="${stage.id}" data-rack-effect="${stage.effect}">
      <div class="rack-stage-heading">
        <button type="button" class="rack-drag" data-rack-drag draggable="true" aria-label="Move ${escape(label)}" title="Drag to reorder; use arrow keys when focused">⠿</button>
        <div class="rack-stage-title"><span class="rack-step">${String(index + 1).padStart(2, '0')}</span><h3>${escape(definition.title)}</h3><button type="button" class="rack-enable" data-rack-enable aria-label="Enable ${escape(label)}" aria-pressed="${stage.enabled}">${stage.enabled ? 'ON' : 'BYPASS'}</button></div>
        <div class="rack-wet-control"><div class="rack-knob" role="slider" tabindex="0" data-rack-wet data-rack-interactive aria-label="${escape(label)} wet / dry" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${wet}" aria-valuetext="${wet}% wet" title="Drag up/down; arrow keys adjust wet/dry"><span class="rack-knob-indicator" style="--knob-angle:${-135 + 270 * stage.wet}deg"></span></div><label><span>WET / DRY</span><input type="number" min="0" max="100" step="1" value="${wet}" data-rack-wet-number aria-label="${escape(label)} wet percent"><span>%</span></label></div>
      </div>
      <details class="rack-stage-details" ${this.expanded.has(stage.id) ? 'open' : ''}><summary>Parameters <span>${stage.effect === 'stutter' ? `${format(Number(this.getBpm()) || 120)} BPM` : definition.fields.length + ' controls'}</span></summary><p>${escape(definition.description)}</p>${definition.fields.map(field => this.parameterHTML(stage, field)).join('')}</details>
      <div class="rack-stage-actions"><button type="button" data-rack-up aria-label="Move ${escape(label)} up" ${index === 0 ? 'disabled' : ''}>↑ Up</button><button type="button" data-rack-down aria-label="Move ${escape(label)} down" ${index === this.chain.length - 1 ? 'disabled' : ''}>↓ Down</button><button type="button" data-rack-remove aria-label="Remove ${escape(label)}">Remove</button></div>
    </li>`;
  }

  render() {
    const targets = this.targets();
    const axisSelector = axis => `<label class="rack-axis-target"><span>${axis.toUpperCase()} AXIS</span><select data-rack-axis="${axis}" aria-label="${axis.toUpperCase()} axis parameter"><option value="">Choose a parameter…</option>${targets.map(target => `<option value="${token(target)}" ${token(this.xy[axis]) === token(target) ? 'selected' : ''}>${escape(target.label)}</option>`).join('')}</select></label>`;
    this.el.innerHTML = `<div class="rack-intro"><div><span class="eyebrow">SERIAL EFFECTS</span><span class="rack-count">${this.chain.length} / ${MAX_RACK_EFFECTS}</span></div><p>Sound flows from top to bottom. Drag the handles to change the order.</p></div>
      <div class="rack-add-row"><label for="rack-effect-choice" class="rack-sr-only">Effect to add</label><select id="rack-effect-choice" data-rack-choice aria-label="Effect to add">${Object.entries(RACK_EFFECTS).map(([name, definition]) => `<option value="${name}" ${name === this.addChoice ? 'selected' : ''}>${escape(definition.title)}</option>`).join('')}</select><button type="button" data-rack-add ${this.chain.length >= MAX_RACK_EFFECTS ? 'disabled' : ''}>＋ Add</button></div>
      <ol class="rack-stages" data-rack-list aria-label="Effects processing order">${this.chain.map((stage, index) => this.stageHTML(stage, index)).join('')}</ol>
      ${this.chain.length ? '' : '<div class="rack-empty"><span aria-hidden="true">≋</span><h3>Build your sound.</h3><p>Add an effect, set its wet/dry mix, then audition your selected audio. Stack effects in any order.</p><div><button type="button" data-rack-quick="reverb">＋ Reverb</button><button type="button" data-rack-quick="tape">＋ Tape</button><button type="button" data-rack-quick="stutter">＋ Stutter</button></div></div>'}
      <p class="rack-tail-note">Effects stay inside the selected audio. Include trailing silence to give echoes and reverb room to decay.</p>
      <section class="rack-xy" aria-label="XY effect controller"><div class="rack-xy-heading"><h3>XY controller</h3><span>TWO PARAMETERS · ONE GESTURE</span></div>${axisSelector('x')}${axisSelector('y')}
        <div class="rack-xy-pad" tabindex="0" role="group" aria-label="XY controller pad" aria-describedby="rack-xy-help" data-rack-xy data-rack-interactive><span class="rack-xy-grid" aria-hidden="true"></span><span class="rack-xy-crosshair" aria-hidden="true"></span><span class="rack-xy-dot" aria-hidden="true"></span><span class="rack-xy-x" aria-hidden="true">X</span><span class="rack-xy-y" aria-hidden="true">Y</span></div>
        <p id="rack-xy-help" class="rack-xy-help">Drag the pad, use arrow keys, or adjust the sliders. Changes render a preview; Apply keeps the result.</p>
        ${['x', 'y'].map(axis => `<label class="rack-axis-range"><span>${axis.toUpperCase()}<output data-rack-axis-value="${axis}">Unassigned</output></span><input type="range" min="0" max="1000" step="1" data-rack-axis-range="${axis}" aria-label="${axis.toUpperCase()} axis position" value="500" ${this.xy[axis] ? '' : 'disabled'}></label>`).join('')}
      </section><p class="rack-sr-only" data-rack-status role="status" aria-live="polite"></p>`;
    this.refreshValues();
  }

  refreshValues() {
    for (const stage of this.chain) {
      const card = this.card(stage.id);
      if (!card) continue;
      const wet = Math.round(stage.wet * 100);
      const knob = card.querySelector('[data-rack-wet]');
      knob.setAttribute('aria-valuenow', String(wet));
      knob.setAttribute('aria-valuetext', `${wet}% wet`);
      knob.querySelector('.rack-knob-indicator').style.setProperty('--knob-angle', `${-135 + 270 * stage.wet}deg`);
      const wetInput = card.querySelector('[data-rack-wet-number]');
      if (document.activeElement !== wetInput) wetInput.value = String(wet);
      card.querySelectorAll('[data-rack-param]').forEach(input => {
        if (document.activeElement !== input) input.value = typeof stage.params[input.dataset.rackParam] === 'number' ? format(stage.params[input.dataset.rackParam]) : stage.params[input.dataset.rackParam];
      });
    }
    const x = this.position('x'), y = this.position('y');
    const pad = this.el.querySelector('[data-rack-xy]');
    pad?.style.setProperty('--xy-x', `${x * 100}%`);
    pad?.style.setProperty('--xy-y', `${(1 - y) * 100}%`);
    pad?.classList.toggle('is-unassigned', !this.xy.x && !this.xy.y);
    for (const axis of ['x', 'y']) {
      const target = this.target(axis);
      const input = this.el.querySelector(`[data-rack-axis-range="${axis}"]`);
      if (input) { input.disabled = !target; input.value = String(Math.round(this.position(axis) * 1000)); }
      const output = this.el.querySelector(`[data-rack-axis-value="${axis}"]`);
      if (output) output.textContent = target ? `${target.key === 'wet' ? `${Math.round(target.value * 100)}% wet` : `${format(target.value)}${target.unit ? ' ' + target.unit : ''}`}` : 'Unassigned';
    }
  }

  click(event) {
    const button = event.target.closest('button');
    if (!button || !this.el.contains(button)) return;
    const card = button.closest('[data-rack-id]');
    const id = card?.dataset.rackId;
    const index = this.chain.findIndex(stage => stage.id === id);
    try {
      if (button.hasAttribute('data-rack-add')) this.add(this.addChoice);
      else if (button.dataset.rackQuick) this.add(button.dataset.rackQuick);
      else if (button.hasAttribute('data-rack-remove')) this.remove(id);
      else if (button.hasAttribute('data-rack-up')) this.move(id, index - 1);
      else if (button.hasAttribute('data-rack-down')) this.move(id, index + 1);
      else if (button.hasAttribute('data-rack-enable') && index >= 0) {
        this.chain[index].enabled = !this.chain[index].enabled;
        button.setAttribute('aria-pressed', String(this.chain[index].enabled));
        button.textContent = this.chain[index].enabled ? 'ON' : 'BYPASS';
        card.classList.toggle('is-bypassed', !this.chain[index].enabled);
        this.changed();
      }
    } catch (error) { this.report(error.message); }
  }

  input(event) {
    const input = event.target;
    if (input.tagName !== 'INPUT') return;
    const id = input.closest('[data-rack-id]')?.dataset.rackId;
    if (input.value === '' || !Number.isFinite(+input.value)) {
      input.setCustomValidity('Enter a finite number.');
      return;
    }
    try {
      if (input.hasAttribute('data-rack-param')) {
        const stage = this.chain.find(candidate => candidate.id === id);
        const definition = RACK_EFFECTS[stage.effect].fields.find(field => field.key === input.dataset.rackParam);
        if (definition.integer && !Number.isInteger(+input.value)) throw new Error(`${definition.label} must be a whole number.`);
        this.setParameter(id, input.dataset.rackParam, +input.value);
      }
      else if (input.hasAttribute('data-rack-wet-number')) this.setParameter(id, 'wet', +input.value / 100);
      else if (input.dataset.rackAxisRange) {
        const axis = input.dataset.rackAxisRange;
        this.setXY(axis === 'x' ? +input.value / 1000 : this.position('x'), axis === 'y' ? +input.value / 1000 : this.position('y'));
      }
      input.setCustomValidity('');
    } catch (error) { input.setCustomValidity(error.message); }
  }

  change(event) {
    const input = event.target;
    if (input.matches('[data-rack-choice]')) { this.addChoice = input.value; return; }
    if (input.matches('select[data-rack-param]')) {
      try { this.setParameter(input.closest('[data-rack-id]').dataset.rackId, input.dataset.rackParam, input.value); }
      catch (error) { this.report(error.message); }
    }
    if (input.dataset.rackAxis) {
      const axis = input.dataset.rackAxis;
      const target = this.targets().find(candidate => token(candidate) === input.value);
      this.xy[axis] = target ? { id: target.id, key: target.key } : null;
      const other = axis === 'x' ? 'y' : 'x';
      if (target && token(this.xy[other]) === token(target)) {
        this.xy[other] = null;
        this.el.querySelector(`[data-rack-axis="${other}"]`).value = '';
      }
      this.refreshValues();
      this.changed();
    }
    if (input.matches('input[data-rack-param],input[data-rack-wet-number]') && (input.validity.customError || input.validity.rangeOverflow || input.validity.rangeUnderflow)) {
      const message = input.validationMessage;
      const id = input.closest('[data-rack-id]').dataset.rackId;
      input.value = input.hasAttribute('data-rack-wet-number') ? String(Math.round(this.getParameter(id, 'wet') * 100)) : format(this.getParameter(id, input.dataset.rackParam));
      input.setCustomValidity('');
      this.report(`${message} The last valid value was restored.`);
    }
  }

  keydown(event) {
    const target = event.target;
    const handle = target.closest('[data-rack-drag]');
    const knob = target.closest('[data-rack-wet]');
    const pad = target.closest('[data-rack-xy]');
    if (!handle && !knob && !pad) return;
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (handle) {
      const id = handle.closest('[data-rack-id]').dataset.rackId;
      const index = this.chain.findIndex(stage => stage.id === id);
      const step = ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1;
      this.move(id, event.key === 'Home' ? 0 : event.key === 'End' ? this.chain.length - 1 : index + step);
    } else if (knob) {
      const id = knob.closest('[data-rack-id]').dataset.rackId;
      const step = (event.shiftKey || event.key.startsWith('Page') ? 0.1 : 0.01) * (['ArrowDown', 'ArrowLeft', 'PageDown'].includes(event.key) ? -1 : 1);
      this.setParameter(id, 'wet', event.key === 'Home' ? 0 : event.key === 'End' ? 1 : clamp(this.getParameter(id, 'wet') + step, 0, 1));
    } else {
      let x = this.position('x'), y = this.position('y');
      const step = event.shiftKey || event.key.startsWith('Page') ? 0.1 : 0.01;
      if (event.key === 'ArrowLeft') x -= step;
      if (event.key === 'ArrowRight') x += step;
      if (event.key === 'ArrowDown' || event.key === 'PageDown') y -= step;
      if (event.key === 'ArrowUp' || event.key === 'PageUp') y += step;
      if (event.key === 'Home') x = y = 0;
      if (event.key === 'End') x = y = 1;
      this.setXY(clamp(x, 0, 1), clamp(y, 0, 1));
    }
  }

  pointerDown(event) {
    if (event.button !== 0) return;
    const knob = event.target.closest('[data-rack-wet]');
    const pad = event.target.closest('[data-rack-xy]');
    const handle = event.target.closest('[data-rack-drag]');
    if (!knob && !pad && (!handle || event.pointerType === 'mouse')) return;
    const element = knob || pad || handle;
    event.preventDefault();
    element.focus({ preventScroll: true });
    element.setPointerCapture(event.pointerId);
    const id = element.closest('[data-rack-id]')?.dataset.rackId;
    this.pointer = { pointerId: event.pointerId, kind: knob ? 'wet' : pad ? 'xy' : 'reorder', element, id, startY: event.clientY, startValue: knob ? this.getParameter(id, 'wet') : 0 };
    if (pad) this.applyPad(event);
    if (handle) { this.dragId = id; this.card(id)?.classList.add('is-dragging'); }
  }

  pointerMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    event.preventDefault();
    if (this.pointer.kind === 'wet') this.setParameter(this.pointer.id, 'wet', clamp(this.pointer.startValue + (this.pointer.startY - event.clientY) / 140, 0, 1));
    else if (this.pointer.kind === 'xy') this.applyPad(event);
    else this.markDrop(event.clientX, event.clientY);
  }

  pointerEnd(event, cancelled = false) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer.element.hasPointerCapture(event.pointerId)) pointer.element.releasePointerCapture(event.pointerId);
    if (pointer.kind === 'reorder') {
      if (!cancelled) this.completeDrop();
      this.clearDrag();
    }
  }

  cancelGesture() {
    if (this.pointer) this.pointerEnd({ pointerId: this.pointer.pointerId }, true);
    this.clearDrag();
  }

  applyPad(event) {
    const rect = this.el.querySelector('[data-rack-xy]').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.setXY(clamp((event.clientX - rect.left) / rect.width, 0, 1), clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1));
  }

  dragStart(event) {
    const handle = event.target.closest('[data-rack-drag]');
    if (!handle) return;
    this.dragId = handle.closest('[data-rack-id]').dataset.rackId;
    event.dataTransfer.setData('application/x-websoundedit-rack', this.dragId);
    event.dataTransfer.setData('text/plain', this.dragId);
    event.dataTransfer.effectAllowed = 'move';
    this.card(this.dragId)?.classList.add('is-dragging');
    event.stopPropagation();
  }

  dragOver(event) {
    if (!this.dragId || !event.dataTransfer.types.includes('application/x-websoundedit-rack')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    this.markDrop(event.clientX, event.clientY);
  }

  markDrop(x, y) {
    this.el.querySelectorAll('.drop-before,.drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
    const cards = [...this.el.querySelectorAll('[data-rack-id]')];
    const card = cards.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    this.dropTarget = null;
    if (card) {
      const rect = card.getBoundingClientRect();
      const after = y > rect.top + rect.height / 2;
      this.dropTarget = { id: card.dataset.rackId, after };
      card.classList.add(after ? 'drop-after' : 'drop-before');
    } else if (cards.length) {
      const last = cards.at(-1), rect = last.getBoundingClientRect();
      if (y > rect.bottom && y < rect.bottom + 60 && x >= rect.left && x <= rect.right) {
        this.dropTarget = { id: last.dataset.rackId, after: true };
        last.classList.add('drop-after');
      }
    }
  }

  completeDrop() {
    if (!this.dragId || !this.dropTarget || this.dragId === this.dropTarget.id) return;
    const source = this.chain.findIndex(stage => stage.id === this.dragId);
    let destination = this.chain.findIndex(stage => stage.id === this.dropTarget.id) + (this.dropTarget.after ? 1 : 0);
    if (source < destination) destination--;
    this.move(this.dragId, destination);
  }

  drop(event) {
    if (!this.dragId || !event.dataTransfer.types.includes('application/x-websoundedit-rack')) return;
    event.preventDefault();
    event.stopPropagation();
    this.markDrop(event.clientX, event.clientY);
    this.completeDrop();
    this.clearDrag();
  }

  clearDrag() {
    this.dragId = null;
    this.dropTarget = null;
    this.el.querySelectorAll('.is-dragging,.drop-before,.drop-after').forEach(card => card.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  }
}
