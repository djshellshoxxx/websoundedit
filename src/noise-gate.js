/** Shared allocation-free, per-sample gate envelope for offline and live racks.
 * The peak detector opens at threshold and closes below threshold-hysteresis
 * after hold. Attack/release are one-pole time constants, not lookahead.
 * Callers admit parameters through the rack's common schema before processing.
 */
export function createNoiseGateState(channels) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new RangeError('Noise gate needs 1–8 channels.');
  return { gains: new Float64Array(channels), remaining: new Float64Array(channels), open: new Uint8Array(channels), initialized: false };
}

export function configureNoiseGate(state, params, sampleRate) {
  if (state.thresholdDb !== params.thresholdDb || state.hysteresisDb !== params.hysteresisDb) {
    state.thresholdDb = params.thresholdDb; state.hysteresisDb = params.hysteresisDb;
    state.threshold = 10 ** (params.thresholdDb / 20);
    state.closeThreshold = 10 ** ((params.thresholdDb - params.hysteresisDb) / 20);
  }
  if (state.floorDb !== params.floorDb) {
    state.floorDb = params.floorDb; state.floor = 10 ** (params.floorDb / 20);
    // The floor is a minimum gain. In particular, a live change to 0 dB must
    // become exactly transparent even if the gate was previously closed.
    for (let channel = 0; channel < state.gains.length; channel++) state.gains[channel] = Math.max(state.floor, state.gains[channel]);
  }
  if (state.attackMs !== params.attackMs || state.sampleRate !== sampleRate) {
    state.attackMs = params.attackMs;
    state.attack = params.attackMs === 0 ? 0 : Math.exp(-1000 / (sampleRate * params.attackMs));
  }
  if (state.releaseMs !== params.releaseMs || state.sampleRate !== sampleRate) {
    state.releaseMs = params.releaseMs; state.release = Math.exp(-1000 / (sampleRate * params.releaseMs));
  }
  if (state.holdMs !== params.holdMs || state.sampleRate !== sampleRate) {
    state.holdMs = params.holdMs; state.holdFrames = Math.round(params.holdMs * sampleRate / 1000);
    for (let channel = 0; channel < state.remaining.length; channel++) state.remaining[channel] = Math.min(state.remaining[channel], state.holdFrames);
  }
  state.sampleRate = sampleRate;
  if (!state.initialized) { state.gains.fill(state.floor); state.initialized = true; }
  if (state.channelMode !== params.channelMode && params.channelMode === 'linked') {
    let gain = state.gains[0], hold = state.remaining[0], open = state.open[0];
    for (let channel = 1; channel < state.gains.length; channel++) {
      gain = Math.max(gain, state.gains[channel]); hold = Math.max(hold, state.remaining[channel]); open |= state.open[channel];
    }
    state.gains.fill(gain); state.remaining.fill(hold); state.open.fill(open);
  }
  state.channelMode = params.channelMode;
}

function advance(state, channel, peak) {
  if (peak >= state.threshold || state.open[channel] && peak >= state.closeThreshold) {
    state.open[channel] = 1; state.remaining[channel] = state.holdFrames;
  } else if (state.remaining[channel] > 0) state.remaining[channel]--;
  else state.open[channel] = 0;
  const target = state.open[channel] ? 1 : state.floor, current = state.gains[channel];
  const coefficient = target > current ? state.attack : state.release;
  state.gains[channel] = target + coefficient * (current - target);
}

/** Inspect all detector channels before the caller overwrites any output. */
export function noiseGateFrame(state, channels, frame) {
  if (state.channelMode === 'linked') {
    let peak = 0;
    for (let channel = 0; channel < channels.length; channel++) peak = Math.max(peak, Math.abs(channels[channel][frame]));
    advance(state, 0, peak);
    for (let channel = 1; channel < channels.length; channel++) {
      state.gains[channel] = state.gains[0]; state.remaining[channel] = state.remaining[0]; state.open[channel] = state.open[0];
    }
  } else for (let channel = 0; channel < channels.length; channel++) advance(state, channel, Math.abs(channels[channel][frame]));
  return state.gains;
}
