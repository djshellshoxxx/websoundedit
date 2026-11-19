// Canvas views render the real PCM and the same coefficient/envelope functions as
// the audio engine. They have no timers: the UI decides when a view needs repaint.
import { eqCoefficients, duckEnvelope } from './dsp.js';

const COLORS = {
  background: '#11151c', grid: '#26303b', strongGrid: '#394653',
  text: '#dce5eb', muted: '#93a3b2', original: '#8999a7',
  teal: '#4fb6c4', orange: '#e8532a', red: '#ff746c',
};
const PALETTE = ['#4fb6c4', '#e99c6a', '#92bd79', '#b2a1d6', '#deb95c', '#e28da4'];
const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';
const peakCache = new WeakMap();
const spectrumCache = new WeakMap();
const PEAK_BLOCK = 64;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const durationOf = audio => audio?.channels?.[0]?.length / audio?.sampleRate || 0;

function setup(canvas, background) {
  if (typeof globalThis.getComputedStyle === 'function' && canvas?.nodeType) {
    const style = getComputedStyle(canvas);
    for (const [key, token] of Object.entries({background:'--wave-bg',grid:'--wave-grid',strongGrid:'--edge',text:'--text',muted:'--muted',original:'--muted',teal:'--teal',orange:'--accent',red:'--red'})) {
      const value = style.getPropertyValue(token).trim(); if (value) COLORS[key] = value;
    }
  }
  background ??= COLORS.background;
  if (!canvas?.getContext) return null;
  const rect = canvas.getBoundingClientRect?.();
  const dpr = Math.max(1, finite(globalThis.devicePixelRatio, 1));
  const width = Math.max(1, rect?.width || canvas.clientWidth || canvas.width / dpr || 300);
  const height = Math.max(1, rect?.height || canvas.clientHeight || canvas.height / dpr || 150);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.font = `9px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  return { ctx, width, height, dpr };
}

function text(ctx, value, x, y, color = COLORS.muted, align = 'left') {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(String(value), x, y);
}

function line(ctx, x1, y1, x2, y2, color = COLORS.grid) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function fill(ctx, color, alpha, x, y, width, height) {
  if (width <= 0 || height <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

function clippedText(ctx, value, x, y, maxWidth, color) {
  if (maxWidth < 18) return;
  let label = String(value);
  while (label.length > 1 && ctx.measureText(label).width > maxWidth) label = label.slice(0, -2);
  if (label !== String(value)) label += '…';
  text(ctx, label, x, y, color);
}

function trackColor(track) {
  if (typeof track?.color === 'string' && track.color) return track.color;
  let hash = 0;
  for (const c of String(track?.id || track?.name || 'track')) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** Immutable PCM arrays are cached by identity. Only min/max aggregates are kept. */
function pyramid(channel) {
  let cached = peakCache.get(channel);
  if (cached) return cached;
  const blocks = Math.ceil(channel.length / PEAK_BLOCK);
  const mins = new Float32Array(blocks), maxs = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let min = Infinity, max = -Infinity;
    const end = Math.min(channel.length, (b + 1) * PEAK_BLOCK);
    for (let i = b * PEAK_BLOCK; i < end; i++) {
      const v = Number.isFinite(channel[i]) ? channel[i] : 0;
      min = Math.min(min, v); max = Math.max(max, v);
    }
    mins[b] = min; maxs[b] = max;
  }
  cached = [{ mins, maxs }];
  while (cached[cached.length - 1].mins.length > 1) {
    const previous = cached[cached.length - 1], n = Math.ceil(previous.mins.length / 2);
    const nextMin = new Float32Array(n), nextMax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 2;
      nextMin[i] = Math.min(previous.mins[j], previous.mins[j + 1] ?? previous.mins[j]);
      nextMax[i] = Math.max(previous.maxs[j], previous.maxs[j + 1] ?? previous.maxs[j]);
    }
    cached.push({ mins: nextMin, maxs: nextMax });
  }
  peakCache.set(channel, cached);
  return cached;
}

/** Exact range peaks: coarse cached nodes plus exact boundary samples. */
export function channelPeaks(channel, start, end) {
  if (!channel?.length) return { min: 0, max: 0 };
  start = clamp(Math.floor(finite(start)), 0, channel.length);
  end = clamp(Math.ceil(finite(end)), start, channel.length);
  if (end <= start) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  const add = value => { const v = Number.isFinite(value) ? value : 0; min = Math.min(min, v); max = Math.max(max, v); };
  if (end - start < PEAK_BLOCK * 2) {
    for (let i = start; i < end; i++) add(channel[i]);
  } else {
    const levels = pyramid(channel);
    const first = Math.ceil(start / PEAK_BLOCK), last = Math.floor(end / PEAK_BLOCK);
    for (let i = start; i < first * PEAK_BLOCK; i++) add(channel[i]);
    for (let i = last * PEAK_BLOCK; i < end; i++) add(channel[i]);
    let block = first;
    while (block < last) {
      const remainingLevel = Math.floor(Math.log2(last - block));
      // A node can only be used at its aligned block boundary.
      let level = Math.min(remainingLevel, levels.length - 1);
      while (level > 0 && block % (2 ** level) !== 0) level--;
      const index = Math.floor(block / (2 ** level));
      min = Math.min(min, levels[level].mins[index]);
      max = Math.max(max, levels[level].maxs[index]);
      block += 2 ** level;
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

function beatGrid(ctx, width, height, view, bpm, beatOffset, beatsPerBar) {
  if (!(bpm > 0) || !(view.duration > 0)) return;
  const beat = 60 / bpm, bar = Math.max(1, Math.round(beatsPerBar || 4));
  const pixelsPerBeat = width * beat / view.duration;
  let stride = pixelsPerBeat >= 14 ? 1 : bar;
  while (pixelsPerBeat * stride < 14) stride *= 2;
  const first = Math.floor((view.start - beatOffset) / beat / stride) * stride;
  for (let i = first, count = 0; count < width / 8 + 4; i += stride, count++) {
    const x = (beatOffset + i * beat - view.start) / view.duration * width;
    if (x > width) break;
    if (x < 0) continue;
    line(ctx, Math.round(x) + 0.5, 0, Math.round(x) + 0.5, height, i % bar === 0 ? COLORS.strongGrid : COLORS.grid);
  }
}

// Mirrors AudioEditor._renderTracks: mono equal-power pan, stereo balance.
export function mixerGains(track = {}, channelCount = 2) {
  const gain = 10 ** (clamp(finite(track.gainDb), -96, 24) / 20);
  const pan = clamp(finite(track.pan), -1, 1);
  return channelCount > 1
    ? [gain * (pan > 0 ? Math.cos(pan * Math.PI / 2) : 1), gain * (pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1)]
    : [gain * Math.cos((pan + 1) * Math.PI / 4), gain * Math.sin((pan + 1) * Math.PI / 4)];
}

function waveform(ctx, channel, sampleRate, clipStart, view, plot, color, gain = 1, alpha = 1) {
  if (!channel?.length || !(sampleRate > 0)) return;
  const { width, top, height } = plot;
  const x0 = Math.max(0, (clipStart - view.start) / view.duration * width);
  const x1 = Math.min(width, (clipStart + channel.length / sampleRate - view.start) / view.duration * width);
  if (x1 <= x0) return;
  const mid = top + height / 2, scale = Math.max(1, height / 2 - 3);
  const samplesPerPixel = sampleRate * view.duration / width;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, top, x1 - x0, height); ctx.clip();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (samplesPerPixel < 1.5) {
    const first = Math.max(0, Math.floor((view.start - clipStart) * sampleRate));
    const last = Math.min(channel.length, Math.ceil((view.start + view.duration - clipStart) * sampleRate) + 1);
    for (let i = first; i < last; i++) {
      const x = (clipStart + i / sampleRate - view.start) / view.duration * width;
      const y = mid - clamp(channel[i] * gain, -1.1, 1.1) * scale;
      if (i === first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const from = Math.max(0, Math.floor((view.start + x / width * view.duration - clipStart) * sampleRate));
      const to = Math.min(channel.length, Math.ceil((view.start + (x + 1) / width * view.duration - clipStart) * sampleRate));
      const peaks = channelPeaks(channel, from, to);
      const y1 = mid - clamp(peaks.max * gain, -1.08, 1.08) * scale;
      const y2 = mid - clamp(peaks.min * gain, -1.08, 1.08) * scale;
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, Math.abs(y2 - y1) < 0.6 ? y1 + 0.6 : y2);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function channelTint(color) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) return color;
  const value = parseInt(color.slice(1),16), rgb = [(value>>16)&255,(value>>8)&255,value&255];
  // A related second-channel hue differentiates stereo without altering PCM geometry.
  const mixed = rgb.map((n,i) => Math.round(n*.72 + [220,172,238][i]*.28));
  return `rgb(${mixed.join(',')})`;
}

/** Draws post-fader L/R lanes. Mono is duplicated with the engine's pan gains. */
export function drawTrack(canvas, options = {}) {
  const surface = setup(canvas);
  if (!surface) return null;
  const { ctx, width, height } = surface;
  const { track = {}, audioById = new Map(), preview, selection, markers = [], compareOriginal = false } = options;
  const view = { start: finite(options.view?.start), duration: Math.max(0.001, finite(options.view?.duration, 8)) };
  const baseColor = trackColor(track), top = 25, laneHeight = Math.max(1, (height - top - 8) / 2);
  const lanes = [{ top, height: laneHeight }, { top: top + laneHeight, height: laneHeight }];
  beatGrid(ctx, width, height, view, finite(options.bpm, 120), finite(options.beatOffset), finite(options.beatsPerBar, 4));
  lanes.forEach(lane => line(ctx, 0, lane.top + lane.height / 2 + 0.5, width, lane.top + lane.height / 2 + 0.5, '#34414b'));
  const clips = [];
  for (const clip of track.clips || []) {
    const color = /^#[a-f0-9]{6}$/i.test(clip.keyAnalysis?.color || '') ? clip.keyAnalysis.color : baseColor;
    const original = audioById instanceof Map ? audioById.get(clip.id) : audioById[clip.id];
    const wet = preview?.clipId === clip.id && preview.audio?.channels?.length ? preview.audio : null;
    const audio = wet || original;
    const clipDuration = Math.max(durationOf(audio), durationOf(original), finite(clip.duration));
    const start = finite(clip.start);
    const x = (start - view.start) / view.duration * width;
    const clipWidth = clipDuration / view.duration * width;
    if (x + clipWidth <= 0 || x >= width) continue;
    const visibleStart = Math.max(0, x), visibleEnd = Math.min(width, x + clipWidth);
    clips.push({ id: clip.id, x, width: clipWidth, start, duration: durationOf(audio) || clipDuration });
    fill(ctx, color, track.mute ? 0.025 : 0.055, visibleStart, 3, visibleEnd - visibleStart, height - 6);
    fill(ctx, color, track.mute ? 0.09 : 0.16, visibleStart, 3, visibleEnd - visibleStart, 17);
    line(ctx, visibleStart + 0.5, 3, visibleStart + 0.5, height - 4, '#586a7455');
    line(ctx, visibleEnd - 0.5, 3, visibleEnd - 0.5, height - 4, '#586a7455');
    ctx.font = `8px ${MONO}`;
    const suffix = `${clip.keyAnalysis?.key ? '  · ' + clip.keyAnalysis.key : ''}${wet ? '  / PREVIEW' : ''}`;
    clippedText(ctx, `${clip.name || 'Audio'}${suffix}`, visibleStart + 7, 12, visibleEnd - visibleStart - 14, color);
    if (!audio?.channels?.length) {
      if (visibleEnd - visibleStart > 90) text(ctx, 'Loading waveform…', visibleStart + 8, height / 2);
      continue;
    }
    const alpha = track.mute ? 0.32 : 1;
    if (wet && original) {
      const dryGain = mixerGains(track, original.channels.length);
      for (let c = 0; c < 2; c++) waveform(ctx, original.channels[c] || original.channels[0], original.sampleRate, start, view,
        { ...lanes[c], width }, COLORS.original, dryGain[c], alpha * (compareOriginal ? 0.95 : 0.5));
    }
    const wetGain = mixerGains(track, audio.channels.length);
    for (let c = 0; c < 2; c++) waveform(ctx, audio.channels[c] || audio.channels[0], audio.sampleRate, start, view,
      { ...lanes[c], width }, c === 0 ? color : channelTint(color), wetGain[c], alpha * (wet && compareOriginal ? 0.25 : 0.95));
  }

  let selectedGeometry = null;
  if (selection?.trackId === track.id) {
    const clip = (track.clips || []).find(item => item.id === selection.clipId);
    if (clip) {
      const from = (finite(clip.start) + finite(selection.start) - view.start) / view.duration * width;
      const to = (finite(clip.start) + finite(selection.end) - view.start) / view.duration * width;
      const selectedLanes = selection.channels === 'left' ? [0] : selection.channels === 'right' ? [1] : [0, 1];
      const y = lanes[selectedLanes[0]].top, h = laneHeight * selectedLanes.length;
      selectedGeometry = { x: from, y, width: to - from, height: h };
      const left = clamp(from, 0, width), right = clamp(to, 0, width);
      fill(ctx, COLORS.teal, 0.16, left, y, right - left, h);
      for (const edge of [from, to]) if (edge >= 0 && edge <= width) {
        line(ctx, edge + 0.5, y, edge + 0.5, y + h, '#8bdee9');
        fill(ctx, '#8bdee9', 1, edge - 2, y, 4, 9);
        fill(ctx, '#8bdee9', 1, edge - 2, y + h - 9, 4, 9);
      }
    }
  }
  ctx.font = `8px ${MONO}`;
  text(ctx, 'L', 5, lanes[0].top + 8, '#9dabb8');
  text(ctx, 'R', 5, lanes[1].top + 8, '#9dabb8');
  if (width > 150) text(ctx, '0 dBFS', width - 7, lanes[0].top + 7, '#71818e', 'right');
  for (const marker of markers) {
    const time = finite(marker.time ?? marker.position, -1), x = (time - view.start) / view.duration * width;
    if (x >= 0 && x <= width) {
      ctx.save(); ctx.setLineDash([2, 4]); line(ctx, x + 0.5, 21, x + 0.5, height, '#d9b65b66'); ctx.restore();
    }
  }
  if (Number.isFinite(options.playhead)) {
    const x = (options.playhead - view.start) / view.duration * width;
    if (x >= 0 && x <= width) line(ctx, x + 0.5, 0, x + 0.5, height, '#f0f7fc');
  }
  return { width, height, clips, selection: selectedGeometry, lanes };
}

function niceInterval(raw) {
  const scale = 10 ** Math.floor(Math.log10(Math.max(0.000001, raw)));
  const f = raw / scale;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * scale;
}

function secondsLabel(seconds, step) {
  if (step < 1) return `${seconds.toFixed(step < 0.1 ? 2 : 1)}s`;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function drawRuler(canvas, inputView = {}, bpm = 120, beatOffset = 0, beatsPerBar = 4, markers = []) {
  const surface = setup(canvas, '#151922');
  if (!surface) return null;
  const { ctx, width, height } = surface;
  const view = { start: finite(inputView.start), duration: Math.max(0.001, finite(inputView.duration, 8)) };
  ctx.font = `8px ${MONO}`;
  const interval = niceInterval(view.duration / Math.max(1, width / 70));
  const first = Math.ceil(view.start / interval) * interval;
  for (let time = first, i = 0; i < width / 15 + 2 && time <= view.start + view.duration; time += interval, i++) {
    const x = (time - view.start) / view.duration * width;
    line(ctx, x + 0.5, height - 7, x + 0.5, height, COLORS.strongGrid);
    text(ctx, secondsLabel(time, interval), x + 4, height - 11, '#7d8d9d');
  }
  if (bpm > 0) {
    const beat = 60 / bpm, bar = Math.max(1, Math.round(beatsPerBar));
    const pixelsPerBeat = width * beat / view.duration;
    let stride = pixelsPerBeat >= 34 ? 1 : bar;
    while (pixelsPerBeat * stride < 34) stride *= 2;
    const beatFirst = Math.ceil((view.start - beatOffset) / beat / stride) * stride;
    for (let n = beatFirst, i = 0; i < width / 20 + 2; n += stride, i++) {
      const x = (beatOffset + n * beat - view.start) / view.duration * width;
      if (x > width) break;
      if (x < 0) continue;
      const isBar = n % bar === 0;
      line(ctx, x + 0.5, 0, x + 0.5, isBar ? 8 : 5, isBar ? '#7c939f' : COLORS.strongGrid);
      const label = isBar ? `${Math.floor(n / bar) + 1}` : `${Math.floor(n / bar) + 1}.${((n % bar) + bar) % bar + 1}`;
      text(ctx, label, x + 4, 10, isBar ? '#cfdae2' : '#7d8d9d');
    }
  }
  for (const marker of markers || []) {
    const x = (finite(marker.time ?? marker.position, -1) - view.start) / view.duration * width;
    if (x < 0 || x > width) continue;
    ctx.fillStyle = '#deb95c';
    ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x + 5, 20); ctx.lineTo(x, 24); ctx.closePath(); ctx.fill();
    clippedText(ctx, marker.name || marker.label || 'Marker', x + 8, 20, Math.min(120, width - x - 8), '#deb95c');
  }
  return { width, height };
}

function fft(real, imaginary) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = -2 * Math.PI / length, wrStep = Math.cos(angle), wiStep = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const even = start + j, odd = even + length / 2;
        const tr = wr * real[odd] - wi * imaginary[odd], ti = wr * imaginary[odd] + wi * real[odd];
        real[odd] = real[even] - tr; imaginary[odd] = imaginary[even] - ti;
        real[even] += tr; imaginary[even] += ti;
        const next = wr * wrStep - wi * wiStep;
        wi = wr * wiStep + wi * wrStep; wr = next;
      }
    }
  }
}

/** Center-window Hann FFT. Stereo power is averaged; opposite phase cannot cancel. */
export function spectrumData(audio) {
  if (!audio?.channels?.[0]?.length || !(audio.sampleRate > 0)) return null;
  const old = spectrumCache.get(audio);
  if (old) return old;
  const length = audio.channels[0].length;
  const size = Math.min(8192, Math.max(32, 2 ** Math.floor(Math.log2(length))));
  const start = Math.max(0, Math.floor((length - size) / 2));
  const power = new Float64Array(size / 2 + 1);
  let windowSum = 0;
  const window = Float64Array.from({ length: size }, (_, i) => {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)); windowSum += weight; return weight;
  });
  for (const channel of audio.channels) {
    const real = new Float64Array(size), imaginary = new Float64Array(size);
    for (let i = 0; i < size; i++) real[i] = (channel[start + i] || 0) * window[i];
    fft(real, imaginary);
    for (let i = 0; i < power.length; i++) power[i] += (real[i] ** 2 + imaginary[i] ** 2) / audio.channels.length;
  }
  const db = Float32Array.from(power, (p, i) => 20 * Math.log10(Math.max(1e-7, Math.sqrt(p) * (i === 0 ? 1 : 2) / windowSum)));
  let peakIndex = 1;
  for (let i = 2; i < db.length; i++) if (db[i] > db[peakIndex]) peakIndex = i;
  const result = { db, size, sampleRate: audio.sampleRate, binHz: audio.sampleRate / size,
    peakHz: peakIndex * audio.sampleRate / size, peakDb: db[peakIndex], start: start / audio.sampleRate, duration: size / audio.sampleRate };
  spectrumCache.set(audio, result);
  return result;
}

function frequencyLabel(hz) { return hz >= 1000 ? `${hz / 1000}k` : String(hz); }

function frequencyGrid(ctx, plot, minHz, maxHz, minDb, maxDb, dbTicks) {
  const logSpan = Math.log(maxHz / minHz);
  ctx.font = `8px ${MONO}`;
  for (const hz of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (hz < minHz || hz > maxHz) continue;
    const x = plot.x + Math.log(hz / minHz) / logSpan * plot.width;
    line(ctx, x + 0.5, plot.y, x + 0.5, plot.y + plot.height, COLORS.grid);
    if (plot.width > 330 || [20, 100, 1000, 10000].includes(hz)) text(ctx, frequencyLabel(hz), x, plot.y + plot.height + 12, COLORS.muted, 'center');
  }
  for (const db of dbTicks) {
    const y = plot.y + (maxDb - db) / (maxDb - minDb) * plot.height;
    line(ctx, plot.x, y + 0.5, plot.x + plot.width, y + 0.5, db === 0 ? COLORS.strongGrid : COLORS.grid);
    text(ctx, `${db > 0 ? '+' : ''}${db}`, plot.x - 6, y, COLORS.muted, 'right');
  }
}

function spectrumPath(ctx, data, plot, color, alpha, fillArea = false) {
  if (!data) return;
  const minHz = 20, maxHz = Math.min(20000, data.sampleRate / 2);
  if (maxHz <= minHz) return;
  const steps = Math.max(2, Math.floor(plot.width));
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const hz = minHz * (maxHz / minHz) ** (i / steps);
    const nextHz = minHz * (maxHz / minHz) ** (Math.min(steps, i + 1) / steps);
    const a = clamp(Math.floor(hz / data.binHz), 0, data.db.length - 1);
    const b = clamp(Math.ceil(nextHz / data.binHz), a + 1, data.db.length);
    let level = -140;
    for (let bin = a; bin < b; bin++) level = Math.max(level, data.db[bin]);
    const x = plot.x + i / steps * plot.width, y = plot.y + (1 - (clamp(level, -96, 0) + 96) / 96) * plot.height;
    if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
  if (fillArea) {
    ctx.lineTo(plot.x + plot.width, plot.y + plot.height); ctx.lineTo(plot.x, plot.y + plot.height); ctx.closePath();
    ctx.globalAlpha *= 0.14; ctx.fillStyle = color; ctx.fill();
  }
  ctx.restore();
}

export function drawDetail(canvas, audio, original = null, options = {}) {
  const surface = setup(canvas);
  if (!surface) return null;
  const { ctx, width, height } = surface;
  if (!audio?.channels?.[0]?.length) {
    text(ctx, 'Select audio to inspect its signal.', width / 2, height / 2, COLORS.muted, 'center');
    return { width, height };
  }
  const plot = { x: 34, y: 12, width: Math.max(1, width - 46), height: Math.max(1, height - 34) };
  const compared = original?.channels?.[0]?.length && original !== audio;
  if (options.mode === 'scope') {
    const count = audio.channels.length, laneHeight = plot.height / count;
    const seconds = Math.min(durationOf(audio), Math.max(0.0005, finite(options.windowMs, 12) / 1000));
    const center = clamp(finite(options.center, 0.5), 0, 1);
    const start = Math.max(0, Math.min(durationOf(audio) - seconds, center * durationOf(audio) - seconds / 2));
    for (let c = 0; c < count; c++) {
      const y = plot.y + c * laneHeight, middle = y + laneHeight / 2;
      line(ctx, plot.x, middle + 0.5, plot.x + plot.width, middle + 0.5, COLORS.strongGrid);
      text(ctx, count === 1 ? 'M' : c === 0 ? 'L' : 'R', 4, middle, COLORS.muted);
      for (const level of [-1, 1]) {
        const gy = middle - level * (laneHeight / 2 - 3);
        line(ctx, plot.x, gy + 0.5, plot.x + plot.width, gy + 0.5, COLORS.grid);
      }
      ctx.save(); ctx.translate(plot.x, 0);
      if (compared) {
        const sourceDuration = durationOf(original);
        const originalStart = Math.max(0, Math.min(sourceDuration - seconds, sourceDuration * center - seconds / 2));
        waveform(ctx, original.channels[c] || original.channels[0], original.sampleRate, 0,
          { start: originalStart, duration: seconds }, { top: y, height: laneHeight, width: plot.width }, COLORS.original, 1, options.compareOriginal ? 1 : 0.5);
      }
      waveform(ctx, audio.channels[c], audio.sampleRate, 0, { start, duration: seconds },
        { top: y, height: laneHeight, width: plot.width }, c === 0 ? COLORS.teal : '#deb95c', 1, options.compareOriginal && compared ? 0.3 : 0.95);
      ctx.restore();
    }
    ctx.font = `8px ${MONO}`;
    for (let i = 0; i <= 4; i++) {
      const x = plot.x + i / 4 * plot.width;
      line(ctx, x + 0.5, plot.y, x + 0.5, plot.y + plot.height, '#29354199');
      text(ctx, `${(i / 4 * seconds * 1000).toFixed(seconds < 0.005 ? 1 : 0)}ms`, x, plot.y + plot.height + 12, COLORS.muted, 'center');
    }
    return { ...plot, mode: 'scope', start, duration: seconds };
  }
  const data = spectrumData(audio), before = compared ? spectrumData(original) : null;
  frequencyGrid(ctx, plot, 20, Math.min(20000, audio.sampleRate / 2), -96, 0, [0, -24, -48, -72, -96]);
  if (before) spectrumPath(ctx, before, plot, COLORS.original, options.compareOriginal ? 1 : 0.6);
  spectrumPath(ctx, data, plot, COLORS.teal, options.compareOriginal && before ? 0.3 : 1, true);
  ctx.font = `8px ${MONO}`;
  const label = data.peakDb > -100 ? `${Math.round(data.peakHz)} Hz · ${data.peakDb.toFixed(1)} dBFS` : 'Silence';
  text(ctx, label, plot.x + plot.width - 4, plot.y + 5, COLORS.text, 'right');
  return { ...plot, mode: 'spectrum', spectrum: data };
}

function responseDb(coefficients, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const { b0, b1, b2, a1, a2 } = coefficients;
  const numerator = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
  const denominator = (1 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
  return 10 * Math.log10(Math.max(1e-20, numerator / Math.max(1e-20, denominator)));
}

/** Nodes and plot returned in CSS pixels. EQ axes: 20–20k Hz and -18…+18 dB. */
export function drawEQ(canvas, bands = [], sampleRate = 48000) {
  const surface = setup(canvas);
  if (!surface) return null;
  const { ctx, width, height } = surface;
  const plot = { x: 26, y: 10, width: Math.max(1, width - 38), height: Math.max(1, height - 32) };
  const rate = Math.max(8000, finite(sampleRate, 48000)), maxHz = Math.min(20000, rate * 0.499);
  frequencyGrid(ctx, plot, 20, maxHz, -18, 18, [-18, 0, 18]);
  const filters = [];
  for (const band of bands || []) if (band.enabled !== false) {
    try { filters.push(eqCoefficients(band, rate)); } catch { /* Invalid intermediate input is shown by the form. */ }
  }
  const steps = Math.max(2, Math.floor(plot.width));
  ctx.save(); ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.width, plot.height); ctx.clip();
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const frequency = 20 * (maxHz / 20) ** (i / steps);
    const db = filters.reduce((sum, filter) => sum + responseDb(filter, frequency, rate), 0);
    const x = plot.x + i / steps * plot.width, y = plot.y + (18 - clamp(db, -24, 24)) / 36 * plot.height;
    if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS.orange; ctx.lineWidth = 1.8; ctx.stroke(); ctx.restore();
  const nodes = [];
  for (let index = 0; index < (bands || []).length; index++) {
    const band = bands[index];
    const frequency = clamp(finite(band.frequency, 1000), 20, maxHz);
    const gain = ['lowpass', 'highpass'].includes(band.type) ? 0 : clamp(finite(band.gainDb), -18, 18);
    const x = plot.x + Math.log(frequency / 20) / Math.log(maxHz / 20) * plot.width;
    const y = plot.y + (18 - gain) / 36 * plot.height;
    nodes.push({ x, y, index, frequency, gainDb: gain, enabled: band.enabled !== false });
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = band.enabled === false ? '#252e38' : COLORS.orange; ctx.fill();
    ctx.strokeStyle = band.enabled === false ? '#7b8794' : '#ffd1bd'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = `7px ${MONO}`;
    text(ctx, index + 1, x, Math.max(plot.y + 4, y - 10), band.enabled === false ? COLORS.muted : '#e7b3a0', 'center');
  }
  return { ...plot, nodes, minHz: 20, maxHz, minDb: -18, maxDb: 18 };
}

/** Raw shape nodes are separate from the depth-applied curve; y is linear gain. */
export function drawDuck(canvas, params = {}) {
  const surface = setup(canvas);
  if (!surface) return null;
  const { ctx, width, height } = surface;
  const plot = { x: 26, y: 17, width: Math.max(1, width - 38), height: Math.max(1, height - 39) };
  const depth = clamp(finite(params.depth, 0.8), 0, 1);
  ctx.font = `8px ${MONO}`;
  for (let i = 0; i <= 4; i++) {
    const x = plot.x + i / 4 * plot.width;
    line(ctx, x + 0.5, plot.y, x + 0.5, plot.y + plot.height, i === 0 || i === 4 ? COLORS.strongGrid : COLORS.grid);
    text(ctx, ['0', '¼', '½', '¾', '1'][i], x, plot.y + plot.height + 12, COLORS.muted, 'center');
  }
  for (const gain of [0, 0.5, 1]) {
    const y = plot.y + (1 - gain) * plot.height;
    line(ctx, plot.x, y + 0.5, plot.x + plot.width, y + 0.5, COLORS.grid);
    text(ctx, gain === 1 ? '1' : gain === 0 ? '0' : '.5', plot.x - 6, y, COLORS.muted, 'right');
  }
  const trackSource = params.source === 'track', compression = params.mode === 'compressor';
  const label = trackSource ? 'TRACK DETECTOR · PREVIEW BELOW' : compression ? 'TRIGGER SHAPE · SEE PCM PREVIEW' : 'GAIN SHAPE / DEPTH APPLIED';
  text(ctx, label, plot.x, 7, trackSource ? COLORS.muted : '#a7bdc8');
  const points = Array.isArray(params.points) ? params.points : [];
  const steps = Math.max(2, Math.floor(plot.width));
  const envelope = x => clamp(finite(duckEnvelope(x >= 1 ? 1 - 1e-9 : x, params), 1), 0, 1);
  const drawCurve = (applied, color, alpha) => {
    ctx.save(); ctx.globalAlpha *= alpha; ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const v = envelope(i / steps), gain = applied ? 1 - depth * (1 - v) : v;
      const x = plot.x + i / steps * plot.width, y = plot.y + (1 - gain) * plot.height;
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = applied ? 1.8 : 1; ctx.stroke();
    if (applied) {
      ctx.lineTo(plot.x + plot.width, plot.y + plot.height); ctx.lineTo(plot.x, plot.y + plot.height); ctx.closePath();
      ctx.globalAlpha *= 0.1; ctx.fillStyle = color; ctx.fill();
    }
    ctx.restore();
  };
  if (!trackSource) {
    drawCurve(false, COLORS.original, depth === 1 && !compression ? 0.25 : 0.65);
    // A compressor's actual reduction depends on its detector/envelope. Do not
    // present a tempo control curve as measured compressor gain reduction.
    if (!compression) drawCurve(true, COLORS.teal, 1);
  } else text(ctx, 'Audio source controls reduction', plot.x + plot.width / 2, plot.y + plot.height / 2, '#718491', 'center');
  const nodes = [];
  if (!trackSource) points.forEach((point, index) => {
    const x = plot.x + clamp(finite(point.x), 0, 1) * plot.width;
    const y = plot.y + (1 - clamp(finite(point.y, 1), 0, 1)) * plot.height;
    nodes.push({ x, y, index, point: { x: point.x, y: point.y } });
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#17242b'; ctx.fill();
    ctx.strokeStyle = '#b4dee3'; ctx.lineWidth = 1.3; ctx.stroke();
  });
  return { ...plot, nodes, source: trackSource ? 'track' : 'tempo', mode: compression ? 'compressor' : 'volume' };
}
