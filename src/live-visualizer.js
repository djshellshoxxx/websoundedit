/** A bounded, read-only view of an existing Web Audio signal. */
export const VISUALIZER_LIMITS = Object.freeze({ fftSize: 2048, bands: 192, frames: 240, fps: 30, channels: 8, minDb: -96, maxDb: 0, width: 2048, height: 720 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const disconnect = (node, target) => { try { target ? node?.disconnect(target) : node?.disconnect(); } catch {} };

/** Average channel powers, not signed samples, so antiphase stereo stays visible. */
export function linkedSpectrum(spectra, output) {
  if (!Array.isArray(spectra) || !spectra.length || spectra.length > VISUALIZER_LIMITS.channels || !(output instanceof Float32Array) || !output.length || output.length > VISUALIZER_LIMITS.fftSize / 2 || spectra.some(values => !(values instanceof Float32Array) || values.length !== output.length)) throw new RangeError('Provide matching bounded channel spectra.');
  for (let bin = 0; bin < output.length; bin++) {
    let power = 0;
    for (let channel = 0; channel < spectra.length; channel++) {
      const db = spectra[channel][bin];
      if (Number.isFinite(db)) power += 10 ** (Math.min(24, db) / 10);
    }
    output[bin] = power > 0 ? Math.max(-120, 10 * Math.log10(power / spectra.length)) : -120;
  }
  return output;
}

/** Fixed storage for log-frequency levels and their actual audio-clock times. */
export class SpectrumHistory {
  constructor(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Unsupported visualization sample rate.');
    this.sampleRate = sampleRate;
    this.minHz = 20; this.maxHz = Math.min(20000, sampleRate / 2);
    this.data = new Uint8Array(VISUALIZER_LIMITS.frames * VISUALIZER_LIMITS.bands);
    this.times = new Float64Array(VISUALIZER_LIMITS.frames);
    this.starts = new Uint16Array(VISUALIZER_LIMITS.bands);
    this.ends = new Uint16Array(VISUALIZER_LIMITS.bands);
    const hzPerBin = sampleRate / VISUALIZER_LIMITS.fftSize;
    for (let band = 0; band < VISUALIZER_LIMITS.bands; band++) {
      this.starts[band] = clamp(Math.floor(this.frequencyAt(band / VISUALIZER_LIMITS.bands) / hzPerBin), 1, VISUALIZER_LIMITS.fftSize / 2 - 1);
      this.ends[band] = clamp(Math.ceil(this.frequencyAt((band + 1) / VISUALIZER_LIMITS.bands) / hzPerBin), this.starts[band] + 1, VISUALIZER_LIMITS.fftSize / 2);
    }
    this.reset();
  }
  frequencyAt(fraction) { return this.minHz * (this.maxHz / this.minHz) ** fraction; }
  reset() { this.data.fill(0); this.times.fill(0); this.next = 0; this.count = 0; this.total = 0; }
  push(spectrum, time) {
    if (!(spectrum instanceof Float32Array) || spectrum.length !== VISUALIZER_LIMITS.fftSize / 2 || !Number.isFinite(time)) throw new RangeError('Provide one finite-time FFT frame.');
    const column = this.next, offset = column * VISUALIZER_LIMITS.bands;
    for (let band = 0; band < VISUALIZER_LIMITS.bands; band++) {
      let db = VISUALIZER_LIMITS.minDb;
      for (let bin = this.starts[band]; bin < this.ends[band]; bin++) if (Number.isFinite(spectrum[bin])) db = Math.max(db, spectrum[bin]);
      this.data[offset + band] = Math.round(clamp((db - VISUALIZER_LIMITS.minDb) / -VISUALIZER_LIMITS.minDb, 0, 1) * 255);
    }
    this.times[column] = time;
    this.next = (column + 1) % VISUALIZER_LIMITS.frames;
    this.count = Math.min(this.count + 1, VISUALIZER_LIMITS.frames); this.total++;
    return column;
  }
  column(age = 0) { return !Number.isInteger(age) || age < 0 || age >= this.count ? -1 : (this.next - 1 - age + VISUALIZER_LIMITS.frames) % VISUALIZER_LIMITS.frames; }
  get capturedSeconds() { return this.count > 1 ? Math.max(0, this.times[this.column()] - this.times[this.column(this.count - 1)]) : 0; }
  get windowSeconds() {
    if (this.count < 2) return VISUALIZER_LIMITS.frames / VISUALIZER_LIMITS.fps;
    const elapsed = this.capturedSeconds;
    return elapsed > 0 ? elapsed * VISUALIZER_LIMITS.frames / (this.count - 1) : VISUALIZER_LIMITS.frames / VISUALIZER_LIMITS.fps;
  }
}

/** Only this zero-gain branch is connected/disconnected; the program path is untouched. */
export class LiveAnalysisTap {
  constructor(source) {
    const { context, node, channels } = source || {};
    if (!context || !node || !Number.isInteger(channels) || channels < 1 || channels > VISUALIZER_LIMITS.channels) throw new RangeError('Provide an existing mono-to-eight-channel source.');
    this.source = source; this.analysers = []; this.waves = []; this.spectra = []; this.bytes = [];
    this.spectrum = new Float32Array(VISUALIZER_LIMITS.fftSize / 2); this.peak = 0;
    try {
      this.splitter = context.createChannelSplitter(channels);
      this.sink = context.createGain(); this.sink.gain.value = 0;
      this.sink.connect(context.destination);
      for (let channel = 0; channel < channels; channel++) {
        const analyser = context.createAnalyser();
        analyser.fftSize = VISUALIZER_LIMITS.fftSize; analyser.smoothingTimeConstant = .45;
        analyser.minDecibels = VISUALIZER_LIMITS.minDb; analyser.maxDecibels = VISUALIZER_LIMITS.maxDb;
        this.analysers.push(analyser);
        this.waves.push(new Float32Array(VISUALIZER_LIMITS.fftSize));
        this.spectra.push(new Float32Array(VISUALIZER_LIMITS.fftSize / 2));
        this.bytes.push(new Uint8Array(VISUALIZER_LIMITS.fftSize));
        this.splitter.connect(analyser, channel, 0); analyser.connect(this.sink);
      }
      node.connect(this.splitter);
    } catch (error) { this.dispose(); throw error; }
  }
  read() {
    this.peak = 0;
    for (let channel = 0; channel < this.analysers.length; channel++) {
      const analyser = this.analysers[channel], wave = this.waves[channel], spectrum = this.spectra[channel], bytes = this.bytes[channel];
      if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(wave);
      else { analyser.getByteTimeDomainData(bytes); for (let i = 0; i < wave.length; i++) wave[i] = (bytes[i] - 128) / 128; }
      if (analyser.getFloatFrequencyData) analyser.getFloatFrequencyData(spectrum);
      else { analyser.getByteFrequencyData(bytes); for (let i = 0; i < spectrum.length; i++) spectrum[i] = VISUALIZER_LIMITS.minDb + bytes[i] / 255 * -VISUALIZER_LIMITS.minDb; }
      for (let i = 0; i < wave.length; i++) if (Number.isFinite(wave[i])) this.peak = Math.max(this.peak, Math.abs(wave[i])); else wave[i] = 0;
    }
    return linkedSpectrum(this.spectra, this.spectrum);
  }
  dispose() {
    if (this.splitter) disconnect(this.source?.node, this.splitter);
    for (const analyser of this.analysers) disconnect(analyser);
    disconnect(this.splitter); disconnect(this.sink);
    this.analysers.length = 0;
  }
}

const STOPS = [[0, 5, 9, 20], [.2, 43, 45, 135], [.4, 0, 169, 213], [.6, 35, 220, 142], [.8, 250, 218, 58], [1, 255, 75, 115]];
const PALETTE = Array.from({ length: 256 }, (_, index) => {
  const fraction = index / 255, upper = Math.min(STOPS.length - 1, Math.floor(fraction * (STOPS.length - 1)) + 1), a = STOPS[upper - 1], b = STOPS[upper], mix = (fraction - a[0]) / (b[0] - a[0]);
  const rgb = [1, 2, 3].map(channel => Math.round(a[channel] + (b[channel] - a[channel]) * mix));
  return { rgb, css: `rgb(${rgb.join(',')})` };
});
const hzLabel = hz => hz >= 1000 ? `${Math.round(hz / 1000)}k` : String(Math.round(hz));
const MODES = { waveform: 'Waveform', waterfall: 'Waterfall', spectrogram: 'Spectrogram' };

export class LiveVisualizer {
  constructor(root, { getSource, subscribe = () => () => {} } = {}) {
    if (!root || typeof getSource !== 'function') throw new TypeError('Provide a visualizer element and existing-source getter.');
    this.root = root; this.getSource = getSource; this.source = 'master'; this.mode = 'waveform'; this.inView = !globalThis.IntersectionObserver;
    this.motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'); this.paused = Boolean(this.motion?.matches); this.disposed = false; this.pageSuspended = false;
    this.frame = null; this.lastFrame = -Infinity; this.history = null; this.tap = null; this.lastSource = null; this.latestWaveforms = null;
    root.classList.add('live-visualizer');
    root.innerHTML = `<div class="live-visualizer-heading"><div><span class="eyebrow"><i aria-hidden="true"></i> LIVE SIGNAL</span><h2>See what you hear.</h2></div><div class="live-visualizer-controls"><label>Source<select data-live-source aria-label="Live visualizer source"><option value="master">Program output</option><option value="input">Active audio input</option></select></label><label>Display<select data-live-mode aria-label="Live visualizer display"><option value="waveform" selected>Waveform</option><option value="waterfall">Waterfall</option><option value="spectrogram">Spectrogram</option></select></label><button data-live-freeze aria-pressed="${this.paused}" aria-label="${this.paused ? 'Resume' : 'Freeze'} live visualization">${this.paused ? 'Resume' : 'Freeze'}</button></div></div><div class="live-visualizer-plot"><canvas data-live-canvas role="img" aria-describedby="live-visualizer-description"></canvas></div><div class="live-visualizer-footer"><p data-live-status role="status">Play audio to view the program signal.</p><output data-live-level aria-live="off">No signal</output><div class="live-color-key" data-live-color-key aria-label="Spectral level from minus96 to0 decibels"><span>−96</span><i aria-hidden="true"></i><span>0 dB</span></div></div><p id="live-visualizer-description" class="live-visualizer-description">Live program audio after effects. Frequency views link channel power; waveform keeps channels separate. This display does not change your audio.</p>`;
    this.canvas = root.querySelector('[data-live-canvas]'); this.context = this.canvas.getContext('2d');
    this.status = root.querySelector('[data-live-status]'); this.level = root.querySelector('[data-live-level]');
    this.sourceControl = root.querySelector('[data-live-source]'); this.modeControl = root.querySelector('[data-live-mode]'); this.freezeControl = root.querySelector('[data-live-freeze]'); this.colorKey = root.querySelector('[data-live-color-key]');
    this.historyCanvas = document.createElement('canvas'); this.historyCanvas.width = VISUALIZER_LIMITS.frames; this.historyCanvas.height = VISUALIZER_LIMITS.bands;
    this.historyContext = this.historyCanvas.getContext('2d');
    this.columnImage = this.historyContext?.createImageData(1, VISUALIZER_LIMITS.bands);
    this.onSource = () => { this.source = this.sourceControl.value; this._clear(); this.refresh(); };
    this.onMode = () => { this.mode = this.modeControl.value; this._description(); this.draw(); };
    this.onFreeze = () => { this.paused = !this.paused; if (!this.paused) this._clear(); this.refresh(); };
    // A suspended interval must not be compressed into adjacent history columns.
    // An explicitly frozen display stays intact until the user resumes it.
    this.onVisibility = () => { if (!document.hidden && !this.paused) this._clear(); this.refresh(); };
    this.onMotion = event => { if (event.matches) { this.paused = true; this.refresh(); } };
    this.onResize = () => { this.resize(); this.draw(); };
    this.sourceControl.addEventListener('change', this.onSource); this.modeControl.addEventListener('change', this.onMode); this.freezeControl.addEventListener('click', this.onFreeze);
    document.addEventListener('visibilitychange', this.onVisibility); this.motion?.addEventListener?.('change', this.onMotion);
    this.unsubscribe = subscribe(event => { if (event.type === 'state' || event.type === 'error') this.refresh(); });
    if (globalThis.ResizeObserver) { this.resizeObserver = new ResizeObserver(this.onResize); this.resizeObserver.observe(this.canvas); }
    else globalThis.addEventListener('resize', this.onResize);
    if (globalThis.IntersectionObserver) { this.observer = new IntersectionObserver(entries => { const visible = entries.some(entry => entry.isIntersecting); if (visible && !this.inView) this._clear(); this.inView = visible; this.refresh(); }, { threshold: .01 }); this.observer.observe(root); }
    this.resize(); this._description(); this.draw(); this.refresh();
  }
  _description() {
    this.canvas.setAttribute('aria-label', `${MODES[this.mode]} of ${this.source === 'master' ? 'program output' : 'active audio input'}. ${this.mode === 'waveform' ? 'Amplitude from minus1 to plus1 over milliseconds, each channel shown separately.' : this.mode === 'spectrogram' ? 'Time runs left to right; logarithmic frequency runs bottom to top. Color shows level from minus96 to0 decibels.' : 'Logarithmic frequency runs left to right; height and color show spectral level, with older frames behind the current frame.'}`);
    this.colorKey.hidden = this.mode === 'waveform';
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.min(VISUALIZER_LIMITS.width, Math.round(rect.width * ratio))), height = Math.max(1, Math.min(VISUALIZER_LIMITS.height, Math.round(rect.height * ratio)));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.width = rect.width || width; this.height = rect.height || height;
    this.scaleX = width / this.width; this.scaleY = height / this.height;
    if (this.context) { this.waveGradient = this.context.createLinearGradient(0, 0, this.width, 0); for (const [at, r, g, b] of STOPS.slice(1)) this.waveGradient.addColorStop(at, `rgb(${r},${g},${b})`); }
  }
  _setStatus(state, message) { this.root.dataset.visualState = state; if (this.status.textContent !== message) this.status.textContent = message; }
  _release() { if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.tap?.dispose(); this.tap = null; }
  _clear() { this._release(); this.history?.reset(); this.historyContext?.clearRect(0, 0, this.historyCanvas.width, this.historyCanvas.height); this.latestWaveforms = null; this.lastFrame = -Infinity; this.root.dataset.visualFrames = '0'; this.level.textContent = 'No signal'; }
  setPageSuspended(suspended) {
    this.pageSuspended = Boolean(suspended);
    if (!this.pageSuspended && !this.paused) this._clear();
    this.refresh();
  }
  refresh() {
    if (this.disposed) return;
    this.freezeControl.textContent = this.paused ? 'Resume' : 'Freeze'; this.freezeControl.setAttribute('aria-pressed', String(this.paused)); this.freezeControl.setAttribute('aria-label', `${this.paused ? 'Resume' : 'Freeze'} live visualization`);
    this._description();
    if (!this.context || !this.historyContext) { this._setStatus('unavailable', 'Canvas rendering is unavailable in this browser.'); return; }
    const source = this.getSource(this.source);
    if (source?.node !== this.lastSource?.node || source?.context !== this.lastSource?.context || source?.channels !== this.lastSource?.channels) { this._clear(); this.lastSource = source; this.history = source ? new SpectrumHistory(source.context.sampleRate) : null; this.draw(); }
    if (this.paused) { this._release(); this._setStatus('paused', this.motion?.matches ? 'Motion paused. Select Resume to animate the signal.' : 'Display frozen. Select Resume to continue.'); return; }
    if (this.pageSuspended || document.hidden || !this.inView) { this._release(); this._setStatus('suspended', 'Visualization sleeps while this panel is out of view.'); return; }
    if (!source || source.context.state !== 'running') { this._release(); this._setStatus('idle', this.source === 'input' ? 'Start an audio input in Options to view its signal.' : 'Play audio to view the program signal.'); this.draw(); return; }
    if (!this.tap) {
      try { this.tap = new LiveAnalysisTap(source); } catch (error) { this._setStatus('unavailable', `Signal display unavailable: ${error.message}`); return; }
    }
    this._setStatus('live', `${this.source === 'input' ? 'Active input' : 'Program output'} · ${source.channels} ch · ${(source.context.sampleRate / 1000).toFixed(1)} kHz`);
    if (this.frame === null) this.frame = requestAnimationFrame(time => this._tick(time));
  }
  _tick(time) {
    this.frame = null;
    if (this.disposed || !this.tap || this.paused || this.pageSuspended || document.hidden || !this.inView) return;
    const source = this.getSource(this.source);
    if (source?.node !== this.tap.source.node || source?.context !== this.tap.source.context || source.context.state !== 'running') { this.refresh(); return; }
    if (time - this.lastFrame >= 1000 / VISUALIZER_LIMITS.fps - .5) {
      this.lastFrame = time;
      const spectrum = this.tap.read(), column = this.history.push(spectrum, source.context.currentTime);
      this.latestWaveforms = this.tap.waves;
      for (let band = 0; band < VISUALIZER_LIMITS.bands; band++) {
        const rgb = PALETTE[this.history.data[column * VISUALIZER_LIMITS.bands + band]].rgb, pixel = (VISUALIZER_LIMITS.bands - 1 - band) * 4;
        this.columnImage.data[pixel] = rgb[0]; this.columnImage.data[pixel + 1] = rgb[1]; this.columnImage.data[pixel + 2] = rgb[2]; this.columnImage.data[pixel + 3] = 255;
      }
      this.historyContext.putImageData(this.columnImage, column, 0); this.draw();
      this.root.dataset.visualFrames = String(this.history.total);
      if (this.history.total % 8 === 1) this.level.textContent = this.tap.peak > 0 ? `${(20 * Math.log10(this.tap.peak)).toFixed(1)} dBFS peak` : '−∞ dBFS peak';
    }
    this.frame = requestAnimationFrame(next => this._tick(next));
  }
  draw() {
    const ctx = this.context; if (!ctx) return;
    const width = this.width, height = this.height, plot = { x: 42, y: 17, w: Math.max(1, width - 58), h: Math.max(1, height - 48) };
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0); ctx.fillStyle = '#070d18'; ctx.fillRect(0, 0, width, height);
    ctx.font = '10px system-ui, sans-serif'; ctx.lineWidth = 1; ctx.strokeStyle = '#243246'; ctx.fillStyle = '#c4d3e7';
    if (this.mode === 'waveform') this._waveform(ctx, plot);
    else if (this.mode === 'waterfall') this._waterfall(ctx, plot);
    else this._spectrogram(ctx, plot);
    if (!this.history?.count) {
      ctx.fillStyle = '#d8e7f7'; ctx.textAlign = 'center';
      ctx.fillText(this.paused ? 'Select Resume for live audio' : this.source === 'input' ? 'Waiting for an active audio input' : 'Waiting for program audio', plot.x + plot.w / 2, plot.y + plot.h / 2, plot.w - 12);
    }
  }
  _waveform(ctx, plot) {
    const waves = this.latestWaveforms, channels = waves?.length || 1, row = plot.h / channels;
    for (let channel = 0; channel < channels; channel++) {
      const center = plot.y + row * (channel + .5);
      ctx.strokeStyle = '#304157'; ctx.beginPath(); ctx.moveTo(plot.x, center); ctx.lineTo(plot.x + plot.w, center); ctx.stroke();
      ctx.fillStyle = '#c4d3e7'; ctx.textAlign = 'right'; ctx.fillText(channels === 1 ? '+1' : `CH${channel + 1}`, plot.x - 6, channels > 2 ? center + 3 : center - row * .32); if (channels <= 2) ctx.fillText(channels === 1 ? '−1' : '±1', plot.x - 6, center + row * .4);
      if (!waves) continue;
      ctx.strokeStyle = this.waveGradient; ctx.lineWidth = 1.5; ctx.beginPath();
      const steps = Math.min(1024, Math.ceil(plot.w)), wave = waves[channel];
      // Preserve each pixel bucket's extrema: skipping samples can turn a
      // phase-aligned high-frequency tone into a false flat line on a phone.
      for (let step = 0; step < steps; step++) {
        const start = Math.floor(step / steps * wave.length), end = Math.max(start + 1, Math.floor((step + 1) / steps * wave.length)), x = plot.x + step / steps * plot.w;
        let low = 1, high = -1;
        for (let sample = start; sample < end; sample++) { const value = clamp(wave[sample], -1, 1); low = Math.min(low, value); high = Math.max(high, value); }
        if (step) ctx.lineTo(x, center - low * row * .43); else ctx.moveTo(x, center - low * row * .43);
        ctx.lineTo(x, center - high * row * .43);
      }
      ctx.stroke();
    }
    const ms = VISUALIZER_LIMITS.fftSize / (this.history?.sampleRate || 48000) * 1000;
    ctx.fillStyle = '#c4d3e7'; ctx.textAlign = 'left'; ctx.fillText('0 ms', plot.x, plot.y + plot.h + 20); ctx.textAlign = 'right'; ctx.fillText(`${ms.toFixed(1)} ms`, plot.x + plot.w, plot.y + plot.h + 20);
  }
  _spectrogram(ctx, plot) {
    const history = this.history;
    if (history?.count) {
      const oldest = (history.next - history.count + VISUALIZER_LIMITS.frames) % VISUALIZER_LIMITS.frames, first = Math.min(history.count, VISUALIZER_LIMITS.frames - oldest), cell = plot.w / VISUALIZER_LIMITS.frames, start = plot.x + (VISUALIZER_LIMITS.frames - history.count) * cell;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.historyCanvas, oldest, 0, first, VISUALIZER_LIMITS.bands, start, plot.y, first * cell, plot.h);
      if (first < history.count) ctx.drawImage(this.historyCanvas, 0, 0, history.count - first, VISUALIZER_LIMITS.bands, start + first * cell, plot.y, (history.count - first) * cell, plot.h);
    }
    const maxHz = history?.maxHz || 20000;
    ctx.textAlign = 'right'; ctx.lineWidth = 1;
    for (const hz of [20, 100, 1000, 10000, maxHz]) {
      if (hz > maxHz || hz === 10000 && maxHz === 10000) continue;
      const y = plot.y + plot.h * (1 - Math.log(hz / 20) / Math.log(maxHz / 20));
      ctx.strokeStyle = '#c2d3e724'; ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke(); ctx.fillStyle = '#c4d3e7'; ctx.fillText(`${hzLabel(hz)} Hz`, plot.x - 6, y + 3);
    }
    ctx.textAlign = 'left'; ctx.fillText(`−${(history?.windowSeconds || 8).toFixed(1)} s`, plot.x, plot.y + plot.h + 20); ctx.textAlign = 'right'; ctx.fillText('Now', plot.x + plot.w, plot.y + plot.h + 20);
  }
  _waterfall(ctx, plot) {
    const history = this.history, layers = 24, depthX = Math.min(72, plot.w * .18), depthY = plot.h * .43, spectrumHeight = plot.h * .48, frontY = plot.y + plot.h, spectrumWidth = plot.w - depthX;
    if (history?.count) for (let layer = layers - 1; layer >= 0; layer--) {
      const age = Math.floor(layer / (layers - 1) * (history.count - 1)), column = history.column(age), depth = layer / (layers - 1), left = plot.x + depthX * depth, baseline = frontY - depthY * depth;
      ctx.globalAlpha = 1 - .55 * depth;
      for (let band = 0; band < VISUALIZER_LIMITS.bands; band += 2) {
        const offset = column * VISUALIZER_LIMITS.bands + band, value = Math.max(history.data[offset], history.data[offset + 1]), x = left + band / VISUALIZER_LIMITS.bands * spectrumWidth, signalHeight = value / 255 * spectrumHeight;
        ctx.fillStyle = PALETTE[value].css; ctx.fillRect(x, baseline - signalHeight, spectrumWidth * 2 / VISUALIZER_LIMITS.bands + .5, Math.max(1, signalHeight));
      }
    }
    const maxHz = history?.maxHz || 20000;
    ctx.globalAlpha = 1; ctx.fillStyle = '#c4d3e7'; ctx.textAlign = 'left'; ctx.fillText('20 Hz', plot.x, frontY + 20); ctx.textAlign = 'right'; ctx.fillText(`${hzLabel(maxHz)} Hz`, plot.x + spectrumWidth, frontY + 20);
    ctx.textAlign = 'center'; for (const hz of [100, 1000, ...(plot.w > 450 ? [10000] : [])]) if (hz < maxHz) ctx.fillText(hzLabel(hz), plot.x + Math.log(hz / 20) / Math.log(maxHz / 20) * spectrumWidth, frontY + 20);
    ctx.textAlign = 'left'; ctx.fillText(`History ${(history?.capturedSeconds || 0).toFixed(1)} s`, plot.x + 5, plot.y + 4);
    ctx.textAlign = 'right'; ctx.fillText('0 dB', plot.x - 6, frontY - spectrumHeight); ctx.fillText('−96', plot.x - 6, frontY);
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this._release(); this.unsubscribe?.(); this.observer?.disconnect(); this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility); this.motion?.removeEventListener?.('change', this.onMotion); globalThis.removeEventListener('resize', this.onResize);
    this.sourceControl.removeEventListener('change', this.onSource); this.modeControl.removeEventListener('change', this.onMode); this.freezeControl.removeEventListener('click', this.onFreeze);
    this.latestWaveforms = null; this.history = null; this.lastSource = null;
  }
}
