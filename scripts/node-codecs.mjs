/** Node codecs use native FFmpeg when needed; browser ffmpeg.wasm is not Node compatible.
 * Reference: https://ffmpegwasm.netlify.app/docs/faq/
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, decodeWav } from '../src/wav.js';

export const AUDIO_FORMATS = Object.freeze({
  wav: { extension: 'wav', mime: 'audio/wav', codec: 'pcm_s16le' },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame' },
  flac: { extension: 'flac', mime: 'audio/flac', codec: 'flac' },
  ogg: { extension: 'ogg', mime: 'audio/ogg', codec: 'libvorbis' },
  opus: { extension: 'opus', mime: 'audio/ogg', codec: 'libopus' },
  aac: { extension: 'aac', mime: 'audio/aac', codec: 'aac' },
  m4a: { extension: 'm4a', mime: 'audio/mp4', codec: 'aac' },
  alac: { extension: 'm4a', mime: 'audio/mp4', codec: 'alac' },
  aiff: { extension: 'aiff', mime: 'audio/aiff', codec: 'pcm_s16be' },
  wma: { extension: 'wma', mime: 'audio/x-ms-wma', codec: 'wmav2' }
});
const maxBytes = 256 * 1024 * 1024;
function runFFmpeg(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill('SIGKILL'); }, timeout); timer.unref();
    process.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk.toString(); });
    process.once('error', error => { clearTimeout(timer); reject(new Error(error.code === 'ENOENT' ? 'Native ffmpeg is required for this format. Install ffmpeg and make it available on PATH.' : error.message)); });
    process.once('close', code => { clearTimeout(timer); if (timedOut) reject(new Error('Audio conversion exceeded the two-minute limit.')); else if (code !== 0) reject(new Error(`FFmpeg conversion failed: ${stderr.trim() || `exit ${code}`}`)); else resolve(); });
  });
}
export async function nativeCapabilities() {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve({ nativeFFmpeg: false, formats: ['wav'] }); }, 5000); timer.unref();
    child.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ nativeFFmpeg: false, formats: ['wav'] }); });
    child.on('close', code => { clearTimeout(timer); resolve({ nativeFFmpeg: code === 0, formats: Object.entries(AUDIO_FORMATS).filter(([format, value]) => format === 'wav' || new RegExp(`\\b${value.codec}\\b`).test(output)).map(([format]) => format) }); });
  });
}
export async function decodeAudioBytes(bytes, { sampleRate } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (!bytes.length || bytes.byteLength > maxBytes) throw new Error('Audio input must contain 1 byte to 256 MiB.');
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE') {
    try { return decodeWav(bytes); } catch (error) { if (!/unsupported|format|encoding/i.test(error.message)) throw error; }
  }
  const folder = await mkdtemp(join(tmpdir(), 'websoundedit-'));
  try {
    const input = join(folder, 'input.bin'), output = join(folder, 'decoded.wav'); await writeFile(input, bytes);
    // Force local-file input; disallow network protocols inside untrusted containers/playlists.
    await runFFmpeg(['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,aac,mov,aiff,asf,matroska,webm', '-i', input, '-map', '0:a:0', '-vn', ...(sampleRate ? ['-ar', String(sampleRate)] : []), '-c:a', 'pcm_f32le', '-t', '600', '-fs', String(maxBytes), output]);
    const decodedBytes = new Uint8Array(await readFile(output));
    const audio = decodeWav(decodedBytes);
    if (decodedBytes.length >= maxBytes - 65536 || audio.channels[0].length / audio.sampleRate >= 599.99) throw new Error('Input exceeds the audio duration or decoded memory limit; import a shorter file.');
    return audio;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export async function encodeAudioBytes(audio, options = {}) {
  const format = String(options.format || 'wav').toLowerCase(); const info = AUDIO_FORMATS[format];
  if (!info) throw new Error(`Unsupported output format: ${format}`);
  const bitDepth = options.bitDepth ?? 16;
  if (![16, 24, 32].includes(bitDepth)) throw new Error('WAV bit depth must be 16, 24 or 32.');
  if (format === 'wav' && !options.sampleRate && !options.channels) return encodeWav(audio, { bitDepth, float: options.float === true });
  if (options.sampleRate !== undefined && ![8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000].includes(options.sampleRate)) throw new Error('Unsupported output sample rate.');
  if (options.channels !== undefined && ![1, 2].includes(options.channels)) throw new Error('Output channels must be 1 or 2.');
  const bitrate = options.bitrate ?? 192;
  if (typeof bitrate !== 'number' || !Number.isFinite(bitrate) || bitrate < 16 || bitrate > 512) throw new Error('Bitrate must be between 16 and 512 kbps.');
  const folder = await mkdtemp(join(tmpdir(), 'websoundedit-'));
  try {
    const input = join(folder, 'source.wav'), output = join(folder, `result.${info.extension}`);
    await writeFile(input, encodeWav(audio, { bitDepth: 32, float: true }));
    const codec = format === 'wav' ? options.float ? 'pcm_f32le' : `pcm_s${bitDepth}le` : format === 'aiff' && bitDepth === 24 ? 'pcm_s24be' : info.codec;
    const args = ['-i', input, '-map', '0:a:0', '-c:a', codec];
    if (['mp3', 'ogg', 'opus', 'aac', 'm4a', 'wma'].includes(format)) args.push('-b:a', `${bitrate}k`);
    if (options.sampleRate) args.push('-ar', String(options.sampleRate));
    if (options.channels) args.push('-ac', String(options.channels));
    if (format === 'flac' && bitDepth === 24) args.push('-sample_fmt', 's32');
    args.push(output); await runFFmpeg(args); return new Uint8Array(await readFile(output));
  } finally { await rm(folder, { recursive: true, force: true }); }
}
