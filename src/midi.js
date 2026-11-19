/** MIDI 1.0 messages and Standard MIDI Files. No network or device access on import. */
const MAX_NOTES = 10000;
const MAX_SECONDS = 600;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function parseMidiMessage(data) {
  if (!data || !data.length) return null;
  const status = data[0], channel = status & 15, kind = status & 0xf0;
  if (!Number.isInteger(status) || status < 0x80 || status > 0xff) return null;
  if (status === 0xfa) return { type: 'start' };
  if (status === 0xfb) return { type: 'continue' };
  if (status === 0xfc) return { type: 'stop' };
  if (status === 0xf8) return { type: 'clock' };
  if (data.length < 3 || ![data[1], data[2]].every(value => Number.isInteger(value) && value >= 0 && value <= 127)) return null;
  if (kind === 0x90 && data[2]) return { type: 'noteon', channel, note: data[1], velocity: data[2] };
  if (kind === 0x80 || kind === 0x90) return { type: 'noteoff', channel, note: data[1], velocity: data[2] };
  if (kind === 0xb0) return { type: 'cc', channel, controller: data[1], value: data[2] };
  return null;
}

export function midiValue(value, target) {
  check(Number.isInteger(value) && value >= 0 && value <= 127, 'MIDI CC must be 0–127.');
  const { min, max, step = 0, scale } = target;
  check(Number.isFinite(min) && Number.isFinite(max) && max >= min, 'Invalid MIDI target range.');
  const position = value / 127;
  const raw = scale === 'log' && min > 0 ? min * (max / min) ** position : min + (max - min) * position;
  return clamp(step ? min + Math.round((raw - min) / step) * step : raw, min, max);
}

export function normalizeMidiMappings(mappings = []) {
  check(Array.isArray(mappings) && mappings.length <= 128, 'Use at most 128 MIDI mappings.');
  const seen = new Set();
  return mappings.map(mapping => {
    check(mapping && Number.isInteger(mapping.channel) && mapping.channel >= 0 && mapping.channel <= 15, 'Invalid MIDI mapping channel.');
    check(Number.isInteger(mapping.controller) && mapping.controller >= 0 && mapping.controller <= 127, 'Invalid MIDI controller.');
    check(typeof mapping.target === 'string' && mapping.target.length > 0 && mapping.target.length <= 160, 'Invalid MIDI target.');
    const key = `${mapping.channel}:${mapping.controller}`;
    check(!seen.has(key), 'A MIDI channel/controller can only have one mapping.'); seen.add(key);
    return { channel: mapping.channel, controller: mapping.controller, target: mapping.target };
  });
}

function sourceBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('Provide MIDI file bytes.');
}

/** Format 0/1, PPQ MIDI files with tempo maps. SMPTE and independent format 2 songs are rejected. */
export function parseMidiFile(input) {
  const bytes = sourceBytes(input);
  check(bytes.length >= 14 && bytes.length <= 4 * 1024 * 1024, 'MIDI file must be 14 bytes–4 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  check(text(0, 4) === 'MThd' && view.getUint32(4) >= 6, 'Invalid MIDI header.');
  const format = view.getUint16(8), count = view.getUint16(10), ppq = view.getUint16(12);
  check(format <= 1 && count > 0 && count <= 64 && (format !== 0 || count === 1), 'Use a format 0 or 1 MIDI file with at most 64 tracks.');
  check(ppq > 0 && !(ppq & 0x8000), 'SMPTE MIDI timing is not supported; export with musical PPQ timing.');
  let cursor = 8 + view.getUint32(4), eventCount = 0;
  const events = [], tempos = [{ tick: 0, microseconds: 500000 }], trackNames = [];
  for (let track = 0; track < count; track++) {
    check(cursor + 8 <= bytes.length && text(cursor, 4) === 'MTrk', 'Missing MIDI track chunk.');
    const end = cursor + 8 + view.getUint32(cursor + 4); cursor += 8;
    check(end <= bytes.length, 'Truncated MIDI track.');
    let tick = 0, running = 0;
    const vlq = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) { check(cursor < end, 'Truncated MIDI variable-length value.'); const byte = bytes[cursor++]; value = value * 128 + (byte & 127); if (!(byte & 128)) return value; }
      throw new Error('MIDI variable-length value exceeds four bytes.');
    };
    while (cursor < end) {
      check(++eventCount <= 100000, 'MIDI file has too many events.'); tick += vlq();
      check(cursor < end, 'Truncated MIDI event.');
      let status = bytes[cursor++];
      if (status < 128) { check(running >= 0x80 && running < 0xf0, 'Invalid MIDI running status.'); cursor--; status = running; }
      else if (status < 0xf0) running = status;
      if (status === 0xff) {
        check(cursor < end, 'Truncated MIDI meta event.');
        const type = bytes[cursor++], length = vlq(); check(cursor + length <= end, 'Truncated MIDI meta data.');
        if (type === 0x51) { check(length === 3, 'Invalid MIDI tempo event.'); const microseconds = bytes[cursor] * 65536 + bytes[cursor + 1] * 256 + bytes[cursor + 2]; check(microseconds > 0, 'MIDI tempo must be positive.'); tempos.push({ tick, microseconds }); }
        if (type === 0x03 && length <= 200) trackNames[track] = new TextDecoder().decode(bytes.subarray(cursor, cursor + length));
        cursor += length;
        if (type === 0x2f) { check(length === 0, 'Invalid end-of-track event.'); cursor = end; }
      } else if (status === 0xf0 || status === 0xf7) {
        running = 0; const length = vlq(); check(cursor + length <= end, 'Truncated MIDI SysEx.'); cursor += length;
      } else {
        check(status >= 0x80 && status < 0xf0, 'Unsupported MIDI system event in file.');
        const length = [0xc0, 0xd0].includes(status & 0xf0) ? 1 : 2;
        check(cursor + length <= end, 'Truncated MIDI channel event.');
        const data = bytes.subarray(cursor, cursor + length); check([...data].every(x => x < 128), 'Invalid MIDI data byte.');
        const event = parseMidiMessage([status, ...data]);
        if (event?.type === 'noteon' || event?.type === 'noteoff') events.push({ ...event, tick, track });
        cursor += length;
      }
    }
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const tempoMap = [];
  for (const tempo of tempos) { if (tempoMap.at(-1)?.tick === tempo.tick) tempoMap[tempoMap.length - 1] = tempo; else tempoMap.push(tempo); }
  let seconds = 0;
  for (let i = 0; i < tempoMap.length; i++) { if (i) seconds += (tempoMap[i].tick - tempoMap[i - 1].tick) / ppq * tempoMap[i - 1].microseconds / 1e6; tempoMap[i].seconds = seconds; }
  const time = tick => { let lo = 0, hi = tempoMap.length - 1; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tempoMap[mid].tick <= tick) lo = mid; else hi = mid - 1; } const t = tempoMap[lo]; return t.seconds + (tick - t.tick) / ppq * t.microseconds / 1e6; };
  events.sort((a, b) => a.tick - b.tick);
  const active = new Map(), notes = [];
  for (const event of events) {
    const id = `${event.track}:${event.channel}:${event.note}`;
    if (event.type === 'noteon') { const queue = active.get(id) || []; queue.push(event); active.set(id, queue); }
    else {
      const queue = active.get(id), start = queue?.shift();
      if (start) { if (!queue.length) active.delete(id); const startTime = time(start.tick), endTime = time(event.tick); if (endTime > startTime) notes.push({ note: start.note, velocity: start.velocity, channel: start.channel, track: start.track, start: startTime, duration: endTime - startTime }); }
      check(notes.length <= MAX_NOTES, 'MIDI file exceeds 10,000 notes.');
    }
  }
  check(active.size === 0, 'MIDI contains unclosed notes; repair note-off events before importing.');
  check(notes.length > 0, 'No playable MIDI notes found.');
  const duration = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
  check(duration <= MAX_SECONDS, 'MIDI song exceeds the 10-minute timeline limit.');
  return { version: 1, notes, tempo: 60000000 / tempoMap[0].microseconds, duration, ppq, trackNames, source: 'midi' };
}

export function validateMidiSequence(sequence) {
  check(sequence && sequence.version === 1 && Array.isArray(sequence.notes) && sequence.notes.length > 0 && sequence.notes.length <= MAX_NOTES, 'Invalid MIDI sequence.');
  const notes = sequence.notes.map(note => {
    check(note && Number.isInteger(note.note) && note.note >= 0 && note.note <= 127, 'Invalid MIDI note.');
    check(Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127, 'Invalid MIDI velocity.');
    check(Number.isFinite(note.start) && Number.isFinite(note.duration) && note.start >= 0 && note.duration > 0 && note.start + note.duration <= MAX_SECONDS, 'Invalid MIDI note timing.');
    const channel = note.channel ?? 0; check(Number.isInteger(channel) && channel >= 0 && channel <= 15, 'Invalid MIDI channel.');
    return { note: note.note, velocity: note.velocity, channel, start: note.start, duration: note.duration };
  });
  return { version: 1, notes, duration: notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0) };
}

/** Export note timings at a fixed 120 BPM, preserving seconds from the original tempo map. */
export function encodeMidiFile(input) {
  const sequence = validateMidiSequence(input), ppq = 960;
  const events = sequence.notes.flatMap(n => [
    { tick: Math.round(n.start * ppq * 2), data: [0x90 | n.channel, n.note, n.velocity] },
    { tick: Math.max(Math.round(n.start * ppq * 2) + 1, Math.round((n.start + n.duration) * ppq * 2)), data: [0x80 | n.channel, n.note, 0] }
  ]).sort((a, b) => a.tick - b.tick || a.data[0] - b.data[0]);
  const body = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20]; let tick = 0;
  const vlq = n => { const out = [n & 127]; while ((n = Math.floor(n / 128))) out.unshift((n & 127) | 128); return out; };
  for (const event of events) { body.push(...vlq(event.tick - tick), ...event.data); tick = event.tick; }
  body.push(0, 0xff, 0x2f, 0);
  const bytes = new Uint8Array(22 + body.length), view = new DataView(bytes.buffer);
  bytes.set([77,84,104,100,0,0,0,6,0,0,0,1]); view.setUint16(12, ppq);
  bytes.set([77,84,114,107], 14); view.setUint32(18, body.length); bytes.set(body, 22); return bytes;
}

export function renderMidiSequence(input, sampleRate = 48000) {
  const sequence = validateMidiSequence(input);
  check(Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000, 'Invalid MIDI rendering sample rate.');
  check(sequence.notes.reduce((n, note) => n + Math.ceil(note.duration * sampleRate), 0) <= 50000000, 'MIDI polyphony is too dense; import a shorter section.');
  const frames = Math.max(1, Math.ceil(sequence.duration * sampleRate));
  check(frames * 4 <= 256 * 1024 * 1024, 'MIDI render exceeds memory limit.');
  const output = new Float32Array(frames);
  for (const note of sequence.notes) {
    const frequency = 440 * 2 ** ((note.note - 69) / 12), first = Math.round(note.start * sampleRate), count = Math.round(note.duration * sampleRate);
    if (frequency >= sampleRate / 2) continue;
    for (let i = 0; i < count && first + i < frames; i++) {
      const envelope = Math.min(1, i / Math.max(1, .006 * sampleRate), (count - i) / Math.max(1, .025 * sampleRate));
      output[first + i] += Math.sin(2 * Math.PI * frequency * i / sampleRate) * envelope * note.velocity / 127 * .22;
    }
  }
  let peak = 0; for (const value of output) peak = Math.max(peak, Math.abs(value));
  if (peak > .95) for (let i = 0; i < frames; i++) output[i] *= .95 / peak;
  return { sampleRate, channels: [output] };
}

export class MidiController {
  constructor({ onMessage = () => {}, onState = () => {} } = {}) { this.onMessage = onMessage; this.onState = onState; this.access = null; this.inputId = ''; this.outputId = ''; this.boundInputs = new Set(); this.testTimers = new Set(); this.connectionRevision = 0; }
  async connect() {
    check(globalThis.navigator?.requestMIDIAccess, 'Web MIDI is unavailable in this browser. MIDI file import/export still works.');
    const revision = ++this.connectionRevision;
    let access;
    try { access = await navigator.requestMIDIAccess({ sysex: false }); }
    catch { throw new Error('MIDI access was not granted. Allow MIDI in browser site permissions, then connect again.'); }
    if (revision !== this.connectionRevision) return this.ports();
    this.releaseAccess(); this.access = access;
    this.access.onstatechange = () => this.bindInputs(); this.bindInputs(); return this.ports();
  }
  ports() { return { connected: !!this.access, inputs: [...(this.access?.inputs.values() || [])].filter(p => p.state !== 'disconnected').map(p => ({ id: p.id, name: p.name || 'MIDI input' })), outputs: [...(this.access?.outputs.values() || [])].filter(p => p.state !== 'disconnected').map(p => ({ id: p.id, name: p.name || 'MIDI output' })) }; }
  bindInputs() {
    for (const input of this.boundInputs) input.onmidimessage = null; this.boundInputs.clear();
    for (const input of this.access?.inputs.values() || []) if (input.state !== 'disconnected' && (!this.inputId || input.id === this.inputId)) {
      input.onmidimessage = event => { const message = parseMidiMessage(event.data); if (message) this.onMessage(message); }; this.boundInputs.add(input);
    }
    this.onState(this.ports());
  }
  selectInput(id) { this.inputId = id; this.bindInputs(); }
  selectOutput(id) { this.panic(); this.outputId = id; }
  send(data) { const output = this.access?.outputs.get(this.outputId); check(output && output.state !== 'disconnected', 'Select a connected MIDI output first.'); output.send(data); }
  testNote() {
    const output = this.access?.outputs.get(this.outputId); this.send([0x90, 60, 80]);
    const timer = setTimeout(() => { try { output?.send([0x80, 60, 0]); } catch {} this.testTimers.delete(timer); }, 300); this.testTimers.add(timer);
  }
  panic() { const output = this.access?.outputs.get(this.outputId); if (output) for (let channel = 0; channel < 16; channel++) try { output.send([0xb0 | channel, 123, 0]); output.send([0xb0 | channel, 120, 0]); } catch {} }
  releaseAccess() {
    this.panic();
    for (const timer of this.testTimers) clearTimeout(timer);
    this.testTimers.clear();
    for (const input of this.boundInputs) {
      input.onmidimessage = null;
      try { input.close?.()?.catch?.(() => {}); } catch {}
    }
    this.boundInputs.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
  }
  disconnect() { this.connectionRevision++; this.releaseAccess(); this.onState(this.ports()); }
}

/** Polyphonic sample audition. MIDI note 60 is the sample's original pitch. */
export class MidiSampler {
  constructor(getAudio) { this.getAudio = getAudio; this.context = null; this.voices = new Map(); this.generation = 0; this.held = new Map(); }
  async noteOn(note, velocity, channel = 0) {
    const id = `${channel}:${note}`, token = ++this.generation; this.held.set(id, token);
    this.noteOff(note, channel, false);
    const audio = this.getAudio(); if (!audio?.channels?.[0]?.length) { this.held.delete(id); return; }
    this.context ||= new AudioContext(); await this.context.resume();
    if (this.held.get(id) !== token) return;
    while (this.voices.size >= 8) { const first = this.voices.values().next().value; this.noteOff(first.note, first.channel); }
    const buffer = this.context.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
    audio.channels.forEach((samples, c) => buffer.copyToChannel(samples, c));
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    source.buffer = buffer; source.playbackRate.value = 2 ** ((note - 60) / 12); gain.gain.value = velocity / 127;
    source.connect(gain).connect(this.context.destination); this.voices.set(id, { source, gain, note, channel });
    source.onended = () => { source.disconnect(); gain.disconnect(); if (this.voices.get(id)?.source === source) this.voices.delete(id); };
    source.start();
  }
  noteOff(note, channel = 0, releaseHeld = true) {
    const id = `${channel}:${note}`; if (releaseHeld) this.held.delete(id); const voice = this.voices.get(id); if (!voice) return;
    this.voices.delete(id); voice.gain.gain.setTargetAtTime(0, this.context.currentTime, .005); try { voice.source.stop(this.context.currentTime + .03); } catch {}
  }
  stop() { this.held.clear(); for (const voice of [...this.voices.values()]) this.noteOff(voice.note, voice.channel); }
  async close() { this.stop(); const context = this.context; this.context = null; if (context) await context.close(); }
}
