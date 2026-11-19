/** Shared, DOM-free settings for the creative effects rack. */
const field = (key, label, min, max, step, unit = '', extra = {}) => ({ key, label, min, max, step, unit, ...extra });
const effect = (title, description, defaults, fields, wet = 0.5) => Object.freeze({ title, description, defaults: Object.freeze(defaults), fields: Object.freeze(fields.map(Object.freeze)), wet });

export const MAX_RACK_EFFECTS = 12;
export const RACK_EFFECTS = Object.freeze({
  echo: effect('Echo', 'Distinct repeats that fade after each bounce.', { timeMs: 250, repeats: 3, decay: 0.45 }, [
    field('timeMs', 'Time', 10, 1500, 1, 'ms'), field('repeats', 'Repeats', 1, 8, 1, '', { integer: true }), field('decay', 'Decay', 0, 0.9, 0.01),
  ]),
  delay: effect('Delay', 'A delayed signal with adjustable feedback.', { timeMs: 350, feedback: 0.4 }, [
    field('timeMs', 'Time', 1, 2000, 1, 'ms'), field('feedback', 'Feedback', 0, 0.95, 0.01),
  ]),
  reverb: effect('Reverb', 'A diffuse room with damping and pre-delay.', { room: 0.6, damping: 0.4, predelayMs: 20 }, [
    field('room', 'Room size', 0, 1, 0.01), field('damping', 'Damping', 0, 1, 0.01), field('predelayMs', 'Pre-delay', 0, 200, 1, 'ms'),
  ]),
  chorus: effect('Chorus', 'A moving, delayed voice adds width and motion.', { rate: 1.2, depthMs: 5, delayMs: 18 }, [
    field('rate', 'Rate', 0.05, 10, 0.05, 'Hz'), field('depthMs', 'Depth', 0, 20, 0.1, 'ms'), field('delayMs', 'Base delay', 1, 40, 0.1, 'ms'),
  ]),
  flanger: effect('Flanger', 'A short swept delay creates moving comb filters.', { rate: 0.35, depthMs: 3, feedback: 0.35 }, [
    field('rate', 'Rate', 0.05, 10, 0.05, 'Hz'), field('depthMs', 'Depth', 0, 10, 0.1, 'ms'), field('feedback', 'Feedback', -0.9, 0.9, 0.01),
  ]),
  phaser: effect('Phaser', 'Sweeping all-pass stages shift phase across the spectrum.', { rate: 0.5, depth: 0.7, feedback: 0.25 }, [
    field('rate', 'Rate', 0.05, 10, 0.05, 'Hz'), field('depth', 'Depth', 0, 1, 0.01), field('feedback', 'Feedback', -0.9, 0.9, 0.01),
  ]),
  distortion: effect('Distortion', 'Saturate peaks and soften the high-frequency edge.', { drive: 3, tone: 8000 }, [
    field('drive', 'Drive', 1, 30, 0.1, '×'), field('tone', 'Tone', 100, 20000, 1, 'Hz', { scale: 'log' }),
  ], 1),
  tremolo: effect('Tremolo', 'Cycle the signal level for a pulsing rhythm.', { rate: 4, depth: 0.7 }, [
    field('rate', 'Rate', 0.05, 30, 0.05, 'Hz'), field('depth', 'Depth', 0, 1, 0.01),
  ]),
  filter: effect('Filter', 'Shape frequencies with a resonant filter.', { type: 'lowpass', frequency: 1200, q: 0.707 }, [
    { key: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'] },
    field('frequency', 'Cutoff', 20, 20000, 1, 'Hz', { scale: 'log' }), field('q', 'Resonance', 0.1, 20, 0.001, 'Q'),
  ], 1),
  tape: effect('Tape', 'Saturation, warmth and subtle wow/flutter motion.', { drive: 1.5, wow: 0.3, flutter: 0.15, warmth: 0.4 }, [
    field('drive', 'Drive', 1, 10, 0.1, '×'), field('wow', 'Wow', 0, 1, 0.01), field('flutter', 'Flutter', 0, 1, 0.01), field('warmth', 'Warmth', 0, 1, 0.01),
  ], 1),
  stutter: effect('Stutter', 'Repeat the first tempo-sized slice across your selection.', { division: 4, gate: 0.85, fadeMs: 3 }, [
    field('division', 'Slices per beat', 1, 32, 1, '', { integer: true }), field('gate', 'Gate length', 0.05, 1, 0.01), field('fadeMs', 'Edge fade', 0, 20, 0.1, 'ms'),
  ], 1),
  bitcrusher: effect('Bitcrusher', 'Reduce bit depth and hold samples for digital grit.', { bits: 8, hold: 4 }, [
    field('bits', 'Bit depth', 2, 16, 1, 'bits', { integer: true }), field('hold', 'Sample hold', 1, 64, 1, 'samples', { integer: true }),
  ]),
});

const clone = value => JSON.parse(JSON.stringify(value));
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
let nextId = 0;

export function createRackEffect(name, { id } = {}) {
  if (!Object.hasOwn(RACK_EFFECTS, name)) throw new Error(`Unknown rack effect: ${name}`);
  const definition = RACK_EFFECTS[name];
  return {
    id: id || `fx-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++nextId}`}`,
    effect: name, enabled: true, wet: definition.wet, params: clone(definition.defaults),
  };
}

export function normalizeRackChain(input = []) {
  if (!Array.isArray(input) || input.length > MAX_RACK_EFFECTS) throw new Error(`An effects rack supports up to ${MAX_RACK_EFFECTS} stages.`);
  const ids = new Set();
  return input.map((stage, index) => {
    if (!object(stage) || !Object.hasOwn(RACK_EFFECTS, stage.effect)) throw new Error('Unknown rack effect.');
    const definition = RACK_EFFECTS[stage.effect];
    const id = stage.id === undefined ? `stage-${index + 1}` : stage.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || ids.has(id)) throw new Error('Rack stages need unique, valid IDs.');
    ids.add(id);
    const enabled = stage.enabled === undefined ? true : stage.enabled;
    const wet = stage.wet === undefined ? definition.wet : stage.wet;
    if (typeof enabled !== 'boolean' || !Number.isFinite(wet) || wet < 0 || wet > 1) throw new Error('Invalid rack bypass or wet/dry amount.');
    if (stage.params !== undefined && !object(stage.params)) throw new Error(`Invalid ${definition.title} parameters.`);
    const params = clone(definition.defaults);
    for (const [key, value] of Object.entries(stage.params || {})) {
      const setting = definition.fields.find(candidate => candidate.key === key);
      if (!setting) throw new Error(`Unknown ${definition.title} parameter: ${key}`);
      if (setting.type === 'select') {
        if (!setting.options.includes(value)) throw new Error(`Invalid ${definition.title} ${setting.label}.`);
      } else if (!Number.isFinite(value) || value < setting.min || value > setting.max || setting.integer && !Number.isInteger(value)) {
        throw new Error(`${definition.title} ${setting.label} is outside its supported range.`);
      }
      params[key] = value;
    }
    return { id, effect: stage.effect, enabled, wet, params };
  });
}

export function rackTargets(chain) {
  return chain.flatMap((stage, index) => {
    const definition = RACK_EFFECTS[stage.effect];
    const label = `${index + 1}. ${definition.title}`;
    return [
      { id: stage.id, key: 'wet', label: `${label} · Wet / dry`, min: 0, max: 1, step: 0.01, value: stage.wet, unit: '' },
      ...definition.fields.filter(setting => setting.type !== 'select').map(setting => ({ ...setting, id: stage.id, label: `${label} · ${setting.label}`, value: stage.params[setting.key] })),
    ];
  });
}

export function normalizeRackSettings(input) {
  if (input === undefined) return { version: 1, chain: [], xy: { x: null, y: null } };
  if (!object(input) || input.version !== 1) throw new Error('Unsupported effects rack settings.');
  const chain = normalizeRackChain(input.chain);
  if (input.xy !== undefined && !object(input.xy)) throw new Error('Invalid XY controller settings.');
  const targets = rackTargets(chain);
  const xy = {};
  for (const axis of ['x', 'y']) {
    const target = input.xy?.[axis];
    if (target === undefined || target === null) { xy[axis] = null; continue; }
    if (!object(target) || !targets.some(candidate => candidate.id === target.id && candidate.key === target.key)) throw new Error(`Unknown XY ${axis.toUpperCase()} target.`);
    xy[axis] = { id: target.id, key: target.key };
  }
  if (xy.x && xy.y && xy.x.id === xy.y.id && xy.x.key === xy.y.key) throw new Error('Choose different parameters for the X and Y axes.');
  return { version: 1, chain, xy };
}

export function valueFromPosition(setting, position) {
  if (!Number.isFinite(position)) throw new Error('Controller position must be finite.');
  const fraction = Math.max(0, Math.min(1, position));
  const value = setting.scale === 'log'
    ? setting.min * (setting.max / setting.min) ** fraction
    : setting.min + (setting.max - setting.min) * fraction;
  const quantized = setting.integer ? Math.round(value) : value;
  return Math.max(setting.min, Math.min(setting.max, quantized));
}

export function positionFromValue(setting, value) {
  if (!Number.isFinite(value)) return 0;
  const position = setting.scale === 'log'
    ? Math.log(Math.max(setting.min, value) / setting.min) / Math.log(setting.max / setting.min)
    : (value - setting.min) / (setting.max - setting.min);
  return Math.max(0, Math.min(1, position));
}
