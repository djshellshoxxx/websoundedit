import { FILE_COMMANDS } from './file-commands.js';

const projectFormats = new Set(['session', 'aup3', 'aup', 'reaper']);
export const BATCH_AUDIO_FORMATS = Object.freeze(FILE_COMMANDS.find(command => command.method === 'file.export').schema.properties.format.enum.filter(id => !projectFormats.has(id)));

/** Generate ordinary, inspectable Macro 1 source; no draft or project mutation. */
export function batchConversionScript({ format = 'wav', presetId = '', normalize = false } = {}) {
  if (!BATCH_AUDIO_FORMATS.includes(format)) throw new Error('Choose a supported audio export format.');
  if (typeof presetId !== 'string' || presetId.length > 80 || presetId && !/^[a-zA-Z0-9_-]+$/.test(presetId)) throw new Error('Choose a valid audio preset.');
  if (typeof normalize !== 'boolean') throw new Error('Normalize must be enabled or disabled.');
  const lines = ['// WebSoundEdit Macro 1', '// The batch imports each supplied file before this program.'];
  if (presetId) lines.push(`effect.preset({presetId: ${JSON.stringify(presetId)}});`);
  if (normalize) lines.push('effect.normalize({targetDb: -1});');
  lines.push(`file.export({format: ${JSON.stringify(format)}, scope: "clip", raw: true, name: input.stem});`);
  return lines.join('\n') + '\n';
}

export const MACRO_EXAMPLES = Object.freeze([
  {
    id: 'batch-wav', title: 'Batch: normalize to WAV',
    description: 'Use in Batch files. Imports each supplied file, peak-normalizes to −1 dBFS and collects WAV output. The batch restores the open session.',
    text: batchConversionScript({ format: 'wav', normalize: true }),
  },
  {
    id: 'batch-multiformat', title: 'Batch: WAV, FLAC and MP3 copies',
    description: 'Use in Batch files. A loop exports three formats for every supplied file; downloads are collected in one ZIP.',
    text: '// WebSoundEdit Macro 1\nlet formats = ["wav", "flac", "mp3"];\nfor (format of formats) {\n  file.export({format: format, scope: "clip", raw: true, name: input.stem + "-" + format});\n}\n',
  },
  {
    id: 'seeded-variations', title: 'Six repeatable sample variations',
    description: 'Select a clip. Nested loops create six pitch/gain variations and export WAVs, undoing their own edits after each result. A stopped run leaves completed edits available to Undo.',
    text: '// WebSoundEdit Macro 1\nrandom.seed({seed: "sample-variations"});\nlet takes = array.range({start: 1, end: 3});\nfor (semitones of [-2, 0, 2]) {\n  for (take of takes) {\n    let gain = random.float({min: -4, max: -1});\n    effect.pitch({semitones: semitones});\n    effect.gain({db: gain});\n    let label = text.join({values: ["variation", semitones, take], separator: "-"});\n    file.export({format: "wav", scope: "clip", raw: true, name: label});\n    history.undo({});\n    history.undo({});\n  }\n}\n',
  },
  {
    id: 'nested-sound-bank', title: 'Seeded nested-loop sound bank',
    description: 'Creates a new demo project with six short tones. Number ranges, nested loops, random values and text tools label each generated sample.',
    text: '// WebSoundEdit Macro 1\nproject.new({name: "Seeded sound bank", sampleRate: 8000});\nrandom.seed({seed: 2026});\nlet frequencies = [110, 165, 220];\nlet takes = array.range({start: 1, end: 3});\nfor (frequency of frequencies) {\n  for (take of takes) {\n    let amplitude = random.float({min: 0.2, max: 0.5});\n    audio.generate({duration: 0.12, frequency: frequency, amplitude: amplitude});\n    track.update({name: text.join({values: [frequency, "Hz", take], separator: " "})});\n  }\n}\n',
  },
  {
    id: 'conditional-cleanup', title: 'Measure, clean and normalize',
    description: 'Processes the selected audio. Removes DC offset, skips peak normalization for digital silence and uses an explicit limiter ceiling.',
    text: '// WebSoundEdit Macro 1\neffect.dcRemove({});\nlet measured = analysis.stats({});\nif (measured.peakDb !== null) {\n  effect.normalize({targetDb: -2});\n  effect.limiter({ceilingDb: -1, lookaheadMs: 5, releaseMs: 100});\n}\n',
  },
  {
    id: 'array-workbench', title: 'Arrays, shuffle and nested iteration',
    description: 'Computes and returns data without editing audio. Inspect the returned variables through macro.run to reuse the pattern in your own scripts.',
    text: '// WebSoundEdit Macro 1\nrandom.seed({seed: "arrangement"});\nlet gains = array.range({start: -12, end: 1, step: 3});\ngains = array.append({values: gains, value: -1});\nlet shuffled = array.shuffle({values: gains});\nlet rows = [];\nfor (gain of shuffled) {\n  let row = [];\n  for (pan of [-1, 0, 1]) {\n    row = array.append({values: row, value: {gainDb: gain, pan: pan, linear: math.dbToGain({db: gain})}});\n  }\n  rows = array.append({values: rows, value: row});\n}\nlet count = array.length({values: rows});\nlet averageGain = array.mean({values: gains});\n',
  },
].map(Object.freeze));
