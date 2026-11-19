/** Canonical speaker orders. Matrices are output rows by input columns.
 * Monitoring/downmix excludes LFE unless includeLfe is explicitly true.
 */
const layout = (labels, mask) => Object.freeze({ channels: Object.freeze(labels), count: labels.length, mask });
export const CHANNEL_LAYOUTS = Object.freeze({
  mono: layout(['M'], 0x4), stereo: layout(['FL', 'FR'], 0x3),
  '5.1': layout(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], 0x3f),
  '7.1': layout(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'], 0x63f),
});
export function layoutForChannels(count) {
  const result = Object.keys(CHANNEL_LAYOUTS).find(key => CHANNEL_LAYOUTS[key].count === count);
  if (!result) throw new RangeError('Supported channel counts are 1, 2, 6 and 8.');
  return result;
}
export function normalizeLayout(value, count) {
  const result = typeof value === 'number' ? layoutForChannels(value) : value;
  if (typeof result !== 'string' || !Object.hasOwn(CHANNEL_LAYOUTS, result)) throw new RangeError('Choose mono, stereo, 5.1 or 7.1.');
  if (count !== undefined && CHANNEL_LAYOUTS[result].count !== count) throw new RangeError('Channel count does not match its declared layout.');
  return result;
}
export function audioLayout(audio) {
  const count = audio?.channels?.length;
  if (audio?.layout !== undefined) return normalizeLayout(audio.layout, count);
  if (count > 2) throw new RangeError('Surround audio requires an explicit 5.1 or 7.1 layout.');
  return layoutForChannels(count);
}
export function channelIndices(scope, count) {
  if (scope === undefined || scope === 'all') return Array.from({ length: count }, (_, i) => i);
  const indices = scope === 'left' ? [0] : scope === 'right' ? [1] : scope;
  if (!Array.isArray(indices) || !indices.length || indices.length > count || indices.some(i => !Number.isInteger(i) || i < 0 || i >= count) || new Set(indices).size !== indices.length) throw new RangeError('Choose unique available channel indices.');
  return [...indices];
}
export function conversionMatrix(from, to, { includeLfe = false } = {}) {
  from = normalizeLayout(from); to = normalizeLayout(to);
  const input = CHANNEL_LAYOUTS[from].channels, output = CHANNEL_LAYOUTS[to].channels;
  const matrix = output.map(() => input.map(() => 0));
  const set = (dest, src, gain) => { const d = output.indexOf(dest), s = input.indexOf(src); if (d >= 0 && s >= 0) matrix[d][s] += gain; };
  if (from === to) { for (let i = 0; i < input.length; i++) matrix[i][i] = 1; return matrix; }
  if (from === 'mono') {
    set('FL', 'M', Math.SQRT1_2); set('FR', 'M', Math.SQRT1_2); return matrix;
  }
  if (to === 'mono') {
    const stereo = conversionMatrix(from, 'stereo', { includeLfe });
    return [input.map((_, i) => (stereo[0][i] + stereo[1][i]) * .5)];
  }
  for (const speaker of input) set(speaker, speaker, 1);
  if (to === 'stereo') {
    set('FL', 'FC', Math.SQRT1_2); set('FR', 'FC', Math.SQRT1_2);
    for (const speaker of ['BL', 'SL']) set('FL', speaker, Math.SQRT1_2);
    for (const speaker of ['BR', 'SR']) set('FR', speaker, Math.SQRT1_2);
    if (includeLfe) { set('FL', 'LFE', .5); set('FR', 'LFE', .5); }
  } else if (to === '5.1' && from === '7.1') { set('BL', 'SL', Math.SQRT1_2); set('BR', 'SR', Math.SQRT1_2); }
  return matrix;
}
export function trackMixMatrix(from, to, { pan = 0, gainDb = 0 } = {}) {
  if (!Number.isFinite(pan) || pan < -1 || pan > 1 || !Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) throw new RangeError('Invalid track pan or gain.');
  const matrix = conversionMatrix(from, to), gain = 10 ** (gainDb / 20);
  if (from === 'mono' && to !== 'mono') {
    const labels = CHANNEL_LAYOUTS[to].channels;
    matrix[labels.indexOf('FL')][0] = Math.cos((pan + 1) * Math.PI / 4);
    matrix[labels.indexOf('FR')][0] = Math.sin((pan + 1) * Math.PI / 4);
  }
  for (const row of matrix) for (let i = 0; i < row.length; i++) {
    const balance = from === 'mono' ? 1 : i === 0 && pan > 0 ? Math.cos(pan * Math.PI / 2) : i === 1 && pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1;
    row[i] *= gain * balance;
  }
  return matrix;
}
export function convertLayout(audio, targetLayout, options = {}) {
  const source = audioLayout(audio), target = normalizeLayout(targetLayout), frames = audio.channels[0].length;
  if (frames * CHANNEL_LAYOUTS[target].count * 4 > 256 * 1024 * 1024) throw new RangeError('Layout conversion exceeds the 256 MiB PCM limit.');
  if (audio.channels.some(c => !(c instanceof Float32Array) || c.length !== frames)) throw new TypeError('PCM channels must have equal lengths.');
  const matrix = conversionMatrix(source, target, options);
  const channels = matrix.map(row => { const out = new Float32Array(frames); for (let c = 0; c < row.length; c++) if (row[c]) for (let i = 0; i < frames; i++) out[i] += audio.channels[c][i] * row[c]; return out; });
  return { sampleRate: audio.sampleRate, layout: target, channels };
}
export function layoutMetadata(audio, count = audio.channels.length) {
  return [1, 2, 6, 8].includes(count) && (audio.layout !== undefined || count > 2) ? { layout: layoutForChannels(count) } : {};
}
