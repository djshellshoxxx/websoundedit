/** Action/pedal mappings are definitions only. Armed state is never serialized. */
export function normalizeMidiActions(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Save up to 64 MIDI action mappings.');
  const ids = new Set();
  return value.map((mapping, index) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid MIDI action mapping.');
    const id = mapping.id ?? `pedal-${index + 1}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error('MIDI action IDs must be unique.'); ids.add(id);
    if (!['note', 'cc'].includes(mapping.kind) || !Number.isInteger(mapping.channel) || mapping.channel < 0 || mapping.channel > 15 || !Number.isInteger(mapping.number) || mapping.number < 0 || mapping.number > 127) throw new Error('Choose a MIDI kind, channel 1–16 and number 0–127.');
    const threshold = mapping.threshold ?? 64, debounceMs = mapping.debounceMs ?? 250;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 127 || !Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 5000) throw new Error('Pedal threshold must be 1–127 and debounce 0–5000 ms.');
    if (mapping.inputId !== undefined && (typeof mapping.inputId !== 'string' || mapping.inputId.length > 200)) throw new Error('Invalid MIDI input preference.');
    const action = mapping.action;
    if (!action || typeof action !== 'object' || Array.isArray(action) || Boolean(action.method) === Boolean(action.macroId)) throw new Error('Choose exactly one command or saved macro for each MIDI action.');
    if (action.method && (typeof action.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(action.method))) throw new Error('Invalid MIDI command name.');
    if (action.macroId && (typeof action.macroId !== 'string' || action.macroId.length > 80)) throw new Error('Invalid saved macro ID.');
    const params = action.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('MIDI command parameters must be an object.');
    const serialized = JSON.stringify(params); if (serialized.length > 16384) throw new Error('MIDI command arguments exceed 16 KiB.');
    return { id, kind: mapping.kind, channel: mapping.channel, number: mapping.number, threshold, debounceMs, ...(mapping.inputId ? { inputId: mapping.inputId } : {}), action: action.method ? { method: action.method, params: JSON.parse(serialized) } : { macroId: action.macroId } };
  });
}

export class MidiActionEdges {
  constructor() { this.states = new Map(); }
  reset() { this.states.clear(); }
  matching(message, mappings) { return mappings.filter(mapping => mapping.channel === message.channel && (!mapping.inputId || mapping.inputId === message.inputId) && (mapping.kind === 'cc' ? message.type === 'cc' && mapping.number === message.controller : ['noteon', 'noteoff'].includes(message.type) && mapping.number === message.note)); }
  update(message, mappings, { armed = false, now = performance.now() } = {}) {
    const triggered = [];
    for (const mapping of this.matching(message, mappings)) {
      const key = `${mapping.id}:${message.inputId || ''}`, previous = this.states.get(key) || { high: false, firedAt: -Infinity };
      const value = message.type === 'noteoff' ? 0 : message.type === 'cc' ? message.value : message.velocity;
      const high = Number.isFinite(value) && value >= mapping.threshold;
      const fire = armed && high && !previous.high && now - previous.firedAt >= mapping.debounceMs;
      this.states.set(key, { high, firedAt: fire ? now : previous.firedAt }); if (fire) triggered.push(mapping);
    }
    return triggered;
  }
}
