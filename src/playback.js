/** Browser-only playback. No AudioContext exists until an explicit play() call.
 * Source positions remain in source seconds when playbackRate changes:
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start
 * Clicks use the audio clock, with lookahead scheduling:
 * https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques
 */
const bounded = (value, fallback, min, max, name) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${name} must be between ${min} and ${max}.`);
  return n;
};
const barLength = (value = 4) => {
  const n = bounded(value, 4, 1, 16, 'Beats per bar');
  if (!Number.isInteger(n)) throw new RangeError('Beats per bar must be an integer.');
  return n;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const modulo = (n, divisor) => ((n % divisor) + divisor) % divisor;
const safelyDisconnect = (node) => { try { node?.disconnect(); } catch { /* Already detached. */ } };

/** Pure transport-clock mapping, exported for deterministic clock verification. */
export function playbackPosition({ offset, elapsed, rate, duration, loop, loopStart, loopEnd }) {
  const position = offset + Math.max(0, elapsed) * rate;
  if (loop && loopEnd > loopStart && position >= loopEnd - 1e-9) {
    const length = loopEnd - loopStart, wrapped = modulo(position - loopEnd, length);
    // Decimal beat/loop times accumulate floating-point dust. Snap within a
    // nanosecond so the boundary beat is not accidentally skipped by ceil().
    return loopStart + (wrapped < 1e-9 || length - wrapped < 1e-9 ? 0 : wrapped);
  }
  return clamp(position, 0, duration);
}

export class Playback {
  constructor({ onTime, onEnded, onMeter } = {}) {
    this.onTime = onTime;
    this.onEnded = onEnded;
    this.onMeter = onMeter;
    this._context = null;
    this._source = null;
    this._buffer = null;
    this._playing = false;
    this._generation = 0;
    this._duration = 0;
    this._position = 0;
    this._timelineOffset = 0;
    this._anchorPosition = 0;
    this._anchorTime = 0;
    this._rate = 1;
    this._loop = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._bpm = 120;
    this._beatsPerBar = 4;
    this._beatOffset = 0;
    this._metronome = false;
    this._nodes = [];
    this._clicks = new Set();
    this._timer = null;
    this._scheduledUntil = 0;
    this._visibilityHandler = () => this._tick();
  }
  get context() { return this._context; }
  get playing() { return this._playing; }
  get position() { return this._playing ? this._timelineOffset + this._audioPositionAt(this._context.currentTime) : this._position; }
  get rate() { return this._rate; }
  get loop() { return this._loop; }
  get metronome() { return this._metronome; }

  async play(audio, { offset = 0, loop = false, loopStart = 0, loopEnd, rate = 1, bpm = 120, beatsPerBar = 4, beatOffset = 0, metronome = false, timelineOffset = 0 } = {}) {
    if (!audio || !Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2 || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 192000) throw new TypeError('Playback requires mono or stereo PCM with a valid sample rate.');
    const frames = audio.channels[0]?.length;
    if (!frames || audio.channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== frames)) throw new RangeError('Select nonempty, equal-length audio channels to play.');
    if (frames / audio.sampleRate > 600 || frames * audio.channels.length * 4 > 256 * 1024 * 1024) throw new RangeError('Playback exceeds the 10-minute / 256 MiB decoded-audio limit.');
    for (const channel of audio.channels) for (const sample of channel) if (!Number.isFinite(sample)) throw new RangeError('Playback audio contains a non-finite sample.');
    const duration = frames / audio.sampleRate;
    const options = {
      offset: bounded(offset, 0, 0, duration, 'Playback offset'),
      loopStart: bounded(loopStart, 0, 0, duration, 'Loop start'),
      loopEnd: bounded(loopEnd, duration, 0, duration, 'Loop end'),
      rate: bounded(rate, 1, 0.25, 4, 'Playback rate'),
      bpm: bounded(bpm, 120, 20, 400, 'BPM'),
      beatsPerBar: barLength(beatsPerBar),
      beatOffset: bounded(beatOffset, 0, -3600, 3600, 'Beat offset'),
      timelineOffset: bounded(timelineOffset, 0, 0, 3600, 'Timeline offset'),
    };
    if (loop && options.loopEnd <= options.loopStart) throw new RangeError('Loop end must follow loop start.');
    // Cancel any previous pending resume as well as previous audible playback.
    this._generation++;
    const generation = this._generation;
    this._halt(false);
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('This browser does not support Web Audio playback.');
    if (!this._context || this._context.state === 'closed') this._context = new Context({ latencyHint: 'interactive' });
    const ctx = this._context;
    // Call resume synchronously inside the initiating play gesture, before copying PCM.
    if (ctx.state !== 'running') await ctx.resume();
    if (generation !== this._generation) return false;
    if (ctx.state !== 'running') throw new Error('Audio playback needs a user gesture. Press Play again.');
    this._buffer = ctx.createBuffer(audio.channels.length, frames, audio.sampleRate);
    audio.channels.forEach((channel, c) => this._buffer.copyToChannel(channel, c));
    this._duration = duration;
    this._timelineOffset = options.timelineOffset;
    this._rate = options.rate;
    this._bpm = options.bpm;
    this._beatsPerBar = options.beatsPerBar;
    this._beatOffset = options.beatOffset;
    this._metronome = Boolean(metronome);
    this._loop = Boolean(loop);
    this._loopStart = options.loopStart;
    this._loopEnd = options.loopEnd;
    this._channelCount = audio.channels.length;
    let position = options.offset;
    if (this._loop && position >= this._loopEnd) position = this._loopStart + modulo(position - this._loopEnd, this._loopEnd - this._loopStart);
    if (!this._loop && position >= duration) position = 0;
    this._createMeterGraph();
    this._playing = true;
    // A short scheduling lead allows the first click and PCM to start together.
    this._startSource(position, ctx.currentTime + 0.015);
    this._scheduledUntil = this._anchorTime;
    globalThis.document?.addEventListener('visibilitychange', this._visibilityHandler);
    this._timer = setInterval(() => this._tick(), 25);
    this._tick();
    return true;
  }

  _createMeterGraph() {
    const ctx = this._context;
    this._output = ctx.createGain(); this._output.gain.value = 1;
    this._output.connect(ctx.destination);
    this._splitter = ctx.createChannelSplitter(2);
    this._output.connect(this._splitter);
    this._silentSink = ctx.createGain(); this._silentSink.gain.value = 0;
    this._silentSink.connect(ctx.destination);
    this._analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    this._meterData = this._analysers.map((analyser, index) => {
      analyser.fftSize = 2048;
      this._splitter.connect(analyser, index);
      analyser.connect(this._silentSink);
      return new Float32Array(analyser.fftSize);
    });
    this._nodes = [this._output, this._splitter, this._silentSink, ...this._analysers];
    // Metronome deliberately bypasses output meters and export PCM.
    this._clickOutput = ctx.createGain(); this._clickOutput.gain.value = 1;
    this._clickOutput.connect(ctx.destination);
    this._nodes.push(this._clickOutput);
  }

  _startSource(position, when) {
    const ctx = this._context, source = ctx.createBufferSource();
    source.buffer = this._buffer;
    source.playbackRate.setValueAtTime(this._rate, when);
    source.loop = this._loop;
    source.loopStart = this._loopStart;
    source.loopEnd = this._loopEnd;
    source.connect(this._output);
    this._source = source;
    this._anchorPosition = position;
    this._anchorTime = when;
    this._position = this._timelineOffset + position;
    const generation = this._generation;
    source.onended = () => {
      if (this._source !== source || generation !== this._generation || !this._playing) return;
      const endPosition = this._timelineOffset + this._duration;
      this._halt(false);
      this._position = endPosition;
      this.onTime?.(endPosition);
      this.onEnded?.(endPosition);
    };
    source.start(when, position);
  }

  _audioPositionAt(time) {
    return playbackPosition({ offset: this._anchorPosition, elapsed: time - this._anchorTime, rate: this._rate,
      duration: this._duration, loop: this._loop, loopStart: this._loopStart, loopEnd: this._loopEnd });
  }
  _tick() {
    if (!this._playing) return;
    this.onTime?.(this.position);
    if (this._analysers) {
      const peaks = this._analysers.map((analyser, c) => {
        analyser.getFloatTimeDomainData(this._meterData[c]);
        let peak = 0;
        for (const value of this._meterData[c]) peak = Math.max(peak, Math.abs(value));
        return peak;
      });
      const left = peaks[0], right = this._channelCount === 1 ? left : peaks[1];
      this.onMeter?.({ left, right, clipped: left >= 1 || right >= 1 });
    }
    if (this._metronome) this._scheduleMetronome();
  }

  _scheduleMetronome() {
    const ctx = this._context;
    if (!ctx || ctx.state !== 'running') return;
    // Sub-25-ms loops are valid audition loops, but not a usable metronome cycle.
    if (this._loop && (this._loopEnd - this._loopStart) / this._rate < 0.025) return;
    const now = ctx.currentTime;
    const horizon = now + (globalThis.document?.hidden ? 2.1 : 0.3);
    let cursor = Math.max(this._scheduledUntil, now + 0.003, this._anchorTime);
    const beat = 60 / this._bpm;
    let segments = 0;
    while (cursor < horizon && segments++ < 200) {
      const position = this._audioPositionAt(cursor);
      const boundary = this._loop ? this._loopEnd : this._duration;
      const remaining = (boundary - position) / this._rate;
      if (remaining <= 1e-8) {
        if (!this._loop) break;
        cursor += 1e-7; continue;
      }
      const segmentEnd = Math.min(horizon, cursor + remaining);
      const timelineStart = this._timelineOffset + position;
      const timelineEnd = timelineStart + (segmentEnd - cursor) * this._rate;
      let index = Math.ceil((timelineStart - this._beatOffset) / beat - 1e-8);
      let beatTime = this._beatOffset + index * beat;
      while (beatTime < timelineEnd - 1e-8) {
        const when = cursor + (beatTime - timelineStart) / this._rate;
        if (when >= now && when >= this._scheduledUntil - 1e-8) this._scheduleClick(when, modulo(index, this._beatsPerBar) === 0);
        index++;
        beatTime = this._beatOffset + index * beat;
      }
      cursor = segmentEnd;
      if (!this._loop && cursor >= this._anchorTime + (this._duration - this._anchorPosition) / this._rate) break;
    }
    this._scheduledUntil = Math.max(this._scheduledUntil, horizon);
  }

  _scheduleClick(when, downbeat) {
    const ctx = this._context, oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(downbeat ? 1400 : 950, when);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(downbeat ? 0.10 : 0.075, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.032);
    oscillator.connect(gain); gain.connect(this._clickOutput);
    const click = { oscillator, gain };
    this._clicks.add(click);
    oscillator.onended = () => { safelyDisconnect(oscillator); safelyDisconnect(gain); this._clicks.delete(click); };
    oscillator.start(when);
    oscillator.stop(when + 0.04);
  }

  _clearClicks() {
    for (const { oscillator, gain } of this._clicks) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Source has already ended. */ }
      safelyDisconnect(oscillator); safelyDisconnect(gain);
    }
    this._clicks.clear();
    this._scheduledUntil = this._context?.currentTime ?? 0;
  }

  setRate(rate) {
    rate = bounded(rate, 1, 0.25, 4, 'Playback rate');
    if (this._playing) {
      const now = Math.max(this._anchorTime, this._context.currentTime);
      this._anchorPosition = this._audioPositionAt(now);
      this._anchorTime = now;
      this._source.playbackRate.cancelScheduledValues(now);
      this._source.playbackRate.setValueAtTime(rate, now);
      this._clearClicks();
    }
    this._rate = rate;
    if (this._playing && this._metronome) this._scheduleMetronome();
  }
  setMetronome(enabled) {
    this._metronome = Boolean(enabled);
    this._clearClicks();
    if (this._playing && this._metronome) this._scheduleMetronome();
  }
  setTempo(bpm, beatOffset = this._beatOffset, beatsPerBar = this._beatsPerBar) {
    const nextBpm = bounded(bpm, 120, 20, 400, 'BPM');
    const nextOffset = bounded(beatOffset, 0, -3600, 3600, 'Beat offset');
    const nextBarLength = barLength(beatsPerBar);
    this._bpm = nextBpm;
    this._beatOffset = nextOffset;
    this._beatsPerBar = nextBarLength;
    this._clearClicks();
    if (this._playing && this._metronome) this._scheduleMetronome();
  }
  setLoop(enabled, { start = this._loopStart, end = this._loopEnd } = {}) {
    start = bounded(start, 0, 0, this._duration, 'Loop start');
    end = bounded(end, this._duration, 0, this._duration, 'Loop end');
    if (enabled && end <= start) throw new RangeError('Loop end must follow loop start.');
    let position = this._playing ? this._audioPositionAt(this._context.currentTime) : this._position - this._timelineOffset;
    this._loop = Boolean(enabled);
    this._loopStart = start; this._loopEnd = end;
    this._clearClicks();
    if (this._playing) {
      this._source.onended = null;
      try { this._source.stop(); } catch { /* Already stopped. */ }
      safelyDisconnect(this._source);
      if (this._loop && position >= end) position = start + modulo(position - end, end - start);
      this._startSource(clamp(position, 0, this._duration), this._context.currentTime);
      this._scheduledUntil = this._anchorTime;
      if (this._metronome) this._scheduleMetronome();
    }
  }
  pause() {
    const position = this.position;
    this._generation++;
    this._halt(false);
    this._position = position;
    this.onTime?.(position);
    return position;
  }
  stop() {
    this._generation++;
    this._halt(true);
    this.onTime?.(0);
  }
  _halt(reset) {
    this._playing = false;
    clearInterval(this._timer); this._timer = null;
    globalThis.document?.removeEventListener('visibilitychange', this._visibilityHandler);
    if (this._source) {
      this._source.onended = null;
      try { this._source.stop(); } catch { /* Natural end or previous stop. */ }
      safelyDisconnect(this._source);
      this._source = null;
    }
    this._clearClicks();
    this._nodes.forEach(safelyDisconnect); this._nodes = [];
    this._analysers = null; this._meterData = null;
    this._buffer = null;
    this.onMeter?.({ left: 0, right: 0, clipped: false });
    if (reset) { this._position = 0; this._timelineOffset = 0; }
  }
  async dispose() {
    this.stop();
    if (this._context && this._context.state !== 'closed') await this._context.close();
    this._context = null;
  }
}
export default Playback;
