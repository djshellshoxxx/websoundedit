/** Run from the repository: node examples/direct-engine.mjs input.wav output.wav */
import { readFile, writeFile } from 'node:fs/promises';
import { AudioEditor } from '../src/engine.js';
import { decodeAudioBytes, encodeAudioBytes } from '../scripts/node-codecs.mjs';
const [input, output = 'edited.wav'] = process.argv.slice(2);
if (!input) throw new Error('Usage: node examples/direct-engine.mjs input.wav output.wav');
const editor = new AudioEditor({ sampleRate: 48000 });
await editor.execute('clip.add', { name: 'Source', audio: await decodeAudioBytes(new Uint8Array(await readFile(input))) });
await editor.execute('effect.normalize', { targetDb: -1 });
const tempo = await editor.execute('analysis.bpm');
console.log('Tempo estimate:', tempo);
await editor.execute('project.update', { bpm: 120 }); // Explicit override, independent of the estimate.
const rendered = await editor.execute('audio.render', { scope: 'mix' });
const format = output.split('.').pop().toLowerCase();
await writeFile(output, await encodeAudioBytes(rendered, { format, bitDepth: 24 }));
await writeFile(`${output}.project.json`, JSON.stringify(await editor.execute('project.save')));
console.log(`Saved ${output} and its portable project.`);
