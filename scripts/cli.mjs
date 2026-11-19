#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AudioEditor, COMMANDS } from '../src/engine.js';
import { decodeAudioBytes, encodeAudioBytes, nativeCapabilities } from './node-codecs.mjs';

const help = `WebSoundEdit · Circuit Drift Labs\n\nUsage:\n  node scripts/cli.mjs --input recording.wav --recipe examples/cleanup.json --output result.wav\n  node scripts/cli.mjs --project session.json --recipe recipe.json --output mix.flac\n  node scripts/cli.mjs --input input.mp3 --output output.opus --format opus\n  node scripts/cli.mjs --input input.wav --recipe recipe.json --save-project edited.json\n\nOptions:\n  --input FILE        Import an audio file (repeat for multiple tracks)\n  --project FILE      Load a portable WebSoundEdit JSON project first\n  --recipe FILE       JSON array of {method,params}, or {commands:[...]}\n  --output FILE       Render the mix; WAV works without native FFmpeg\n  --format FORMAT     wav, mp3, flac, ogg, opus, aac, m4a, alac, aiff, wma\n  --scope SCOPE       mix (default), track, clip or selection\n  --bit-depth N       16, 24 or 32; default 16\n  --float             Store 32-bit float WAV\n  --bitrate N         Compressed bitrate in kbps; default 192\n  --sample-rate N     Project sample rate for new sessions; default 48000\n  --save-project FILE Save a portable JSON project with embedded PCM\n  --commands          Print all API methods and parameter examples\n  --capabilities      Report installed native FFmpeg encoder availability\n  --help              Show this help\n\nAll processing happens on this computer. GitHub Pages hosts the UI and SDK,\nnot an HTTP processing service. See docs/API.md for the loopback JSON API.\n`;
export async function main(argv = process.argv.slice(2)) {
  const options = { input: [] }; const flags = new Set(['help', 'commands', 'capabilities', 'float']);
  const values = new Set(['input', 'project', 'recipe', 'output', 'format', 'scope', 'bit-depth', 'bitrate', 'sample-rate', 'save-project']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2); if (flags.has(key)) options[key] = true;
    else if (values.has(key)) { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`); if (key === 'input') options.input.push(value); else options[key] = value; }
    else throw new Error(`Unknown option: --${key}`);
  }
  if (options.help || !argv.length) { console.log(help); return; }
  if (options.commands) { console.log(JSON.stringify(COMMANDS, null, 2)); return; }
  if (options.capabilities) { console.log(JSON.stringify(await nativeCapabilities(), null, 2)); return; }
  if (!options.output && !options['save-project']) throw new Error('Provide --output and/or --save-project.');
  const conversionOnly = options.input.length === 1 && !options.project && !options.recipe && !options.scope;
  const conversionAudio = conversionOnly ? await decodeAudioBytes(new Uint8Array(await readFile(options.input[0]))) : null;
  const editor = new AudioEditor({ sampleRate: options['sample-rate'] ? Number(options['sample-rate']) : conversionAudio?.sampleRate ?? 48000 });
  if (options.project) await editor.execute('project.load', { project: JSON.parse(await readFile(options.project, 'utf8')) });
  for (const path of options.input) await editor.execute('clip.add', { name: basename(path), audio: conversionAudio || await decodeAudioBytes(new Uint8Array(await readFile(path)), { sampleRate: editor.getState().sampleRate }) });
  if (options.recipe) {
    const recipe = JSON.parse(await readFile(options.recipe, 'utf8'));
    await editor.execute('recipe.run', { commands: Array.isArray(recipe) ? recipe : recipe.commands || recipe.steps });
  }
  if (options.output) {
    const format = options.format || extname(options.output).slice(1).toLowerCase() || 'wav';
    const audio = await editor.execute('audio.render', conversionOnly ? { scope: 'clip', raw: true } : { scope: options.scope || 'mix' });
    const bytes = await encodeAudioBytes(audio, { format, bitDepth: options['bit-depth'] ? Number(options['bit-depth']) : 16, float: !!options.float, bitrate: options.bitrate ? Number(options.bitrate) : 192 });
    await writeFile(options.output, bytes); console.log(`Saved ${options.output} (${bytes.byteLength.toLocaleString()} bytes).`);
  }
  if (options['save-project']) { await writeFile(options['save-project'], JSON.stringify(await editor.execute('project.save'))); console.log(`Saved ${options['save-project']}.`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`WebSoundEdit: ${error.message}`); process.exitCode = 1; });
