/** Shared, DOM-free processing recipes. These are starting points, not content recognition.
 * The UI, worker, API and tests use the same immutable catalog and stable IDs.
 */
export const PRESET_CATEGORIES = Object.freeze(['Cleanup', 'Vocals', 'Instruments', 'Compression', 'Limiting', 'Mastering', 'Creative']);
export const DEFAULT_PRESET_ID = 'auto-limiter';
const step = (effect, params = {}, wet) => ({ effect, params, ...(wet === undefined ? {} : { wet }) });
const eq = (...bands) => step('eq', { bands: bands.map(([type, frequency, gainDb = 0, q = .707]) => ({ type, frequency, gainDb, q })) });
const compressor = (thresholdDb, ratio, attackMs, releaseMs, makeupDb = 0, kneeDb = 6) => step('compressor', { thresholdDb, ratio, attackMs, releaseMs, makeupDb, kneeDb });
const limiter = (ceilingDb = -1, lookaheadMs = 5, releaseMs = 120) => step('limiter', { ceilingDb, lookaheadMs, releaseMs });
const auto = (targetRmsDb = -18, maxBoostDb = 6, ceilingDb = -1) => step('autoLimiter', { targetRmsDb, maxBoostDb, ceilingDb, lookaheadMs: 5, releaseMs: 120 });
const preset = (id, title, category, description, steps, limitations = '', stereoOnly = false) => ({ id, title, category, description, limitations, stereoOnly, steps });
const peakLimit = 'Controls sample peaks; does not measure LUFS or intersample true peaks.';
const masterLimit = 'A fixed starting point for listening and adjustment, not automatic professional mastering. Controls sample peaks, not LUFS or true peaks.';
const centerLimit = 'Requires a stereo clip and both channels. Uses stereo center/side math, not AI source separation. Centered instruments remain with centered vocals; panned vocals and stereo reverb may remain elsewhere.';

const catalog = [
  preset('repair-clipped-peaks', 'Repair clipped peaks', 'Cleanup', 'Reconstruct short, flat, near-full-scale peaks from their unclipped shoulders, then add -1 dBFS headroom when a repair succeeds.', [step('repairClipping', { threshold: .98, maxClipMs: 4, maxBoostDb: 6, ceilingDb: -1 })], 'Conservative interpolation for short hard-clipped peaks only. It cannot recover the original recording or repair long, edge, heavily distorted or non-flat clipping. Clean audio is left unchanged.'),
  preset('remove-dc', 'Remove DC offset', 'Cleanup', 'Center each selected channel around zero without changing its length.', [step('dcRemove')], 'Removes the mean of the selection; it does not remove hum or background noise.'),
  preset('remove-rumble', 'Reduce low rumble', 'Cleanup', 'A 70 Hz high-pass filter reduces handling noise and low-frequency rumble.', [eq(['highpass', 70])], 'Also reduces musical content below the cutoff.'),
  preset('reduce-hiss', 'Soften high-frequency hiss', 'Cleanup', 'A 9 kHz low-pass filter gently rolls off high-frequency hiss.', [eq(['lowpass', 9000])], 'Also softens wanted high frequencies. It is not a learned noise-removal model.'),
  preset('gentle-noise-gate', 'Gentle room-noise gate', 'Cleanup', 'Reduce quiet gaps with a linked-channel gate, a soft floor and a slow release.', [step('noiseGate', { thresholdDb: -48, hysteresisDb: 6, floorDb: -24, attackMs: 4, holdMs: 80, releaseMs: 180, channelMode: 'linked' }, 1)], 'Noise under speech or music remains; quiet wanted sounds can be attenuated.'),
  preset('strong-noise-gate', 'Firm room-noise gate', 'Cleanup', 'Close quiet gaps more firmly while keeping selected channels linked.', [step('noiseGate', { thresholdDb: -36, hysteresisDb: 6, floorDb: -72, attackMs: 2, holdMs: 60, releaseMs: 120, channelMode: 'linked' }, 1)], 'Use on isolated sources; this can cut soft words, breaths and decaying notes.'),

  preset('vocal-center', 'Vocal isolation · stereo center', 'Vocals', 'Extract the shared stereo center and focus it on 120 Hz–8.5 kHz; return the same center signal to left and right.', [step('stereoCenter', { mode: 'center', lowHz: 120, highHz: 8500, amount: 1 })], centerLimit, true),
  preset('instrumental-sides', 'Instrumental isolation · stereo sides', 'Vocals', 'Extract the stereo difference to reduce centered vocals and retain side information.', [step('stereoCenter', { mode: 'sides' })], `${centerLimit} Centered bass and drums are removed too. The side-only left/right output cancels when summed to mono.`, true),
  preset('vocal-reduction', 'Vocal removal · center reduction', 'Vocals', 'Reduce shared center information from 160 Hz–8.5 kHz while preserving center bass and out-of-band highs.', [step('stereoCenter', { mode: 'reduce', lowHz: 160, highHz: 8500, amount: 1 })], `${centerLimit} This is partial center reduction, not guaranteed vocal removal.`, true),
  preset('de-esser-gentle', 'Gentle de-esser', 'Vocals', 'Dynamically reduce the high-frequency band above 5.5 kHz by up to 6 dB while preserving the low band.', [step('deEsser', { frequency: 5500, thresholdDb: -26, ratio: 3, maxReductionDb: 6, attackMs: 1, releaseMs: 70 })], 'Frequency-selective processing can also reduce cymbals and other bright sounds; it does not recognize words.'),
  preset('de-esser-strong', 'Focused de-esser', 'Vocals', 'Control stronger sibilance above 4.5 kHz with up to 12 dB of linked high-band attenuation.', [step('deEsser', { frequency: 4500, thresholdDb: -30, ratio: 6, maxReductionDb: 12, attackMs: .5, releaseMs: 95 })], 'Can dull bright material; audition before applying.'),
  preset('vocal-presence', 'Vocal presence', 'Vocals', 'Clear low rumble, add presence, level vocal dynamics and catch sample peaks.', [eq(['highpass', 80], ['lowshelf', 180, -1], ['peaking', 3000, 2.5, 1]), compressor(-22, 3, 8, 100, 2), limiter(-2)], peakLimit),

  preset('bass-definition', 'Bass definition', 'Instruments', 'Shape the bass range and control sustained notes without flattening the attack.', [eq(['highpass', 30], ['lowshelf', 90, 2], ['highshelf', 3000, -2]), compressor(-20, 4, 25, 150), limiter(-2)], peakLimit),
  preset('drum-punch', 'Drum punch', 'Instruments', 'Preserve leading transients, add weight and presence, and control the resulting peaks.', [eq(['highpass', 35], ['lowshelf', 80, 1], ['peaking', 4000, 2, 1]), compressor(-18, 4, 25, 90, 2, 4), limiter()], peakLimit),
  preset('acoustic-warmth', 'Acoustic clarity', 'Instruments', 'Reduce low-mid buildup, add a little air and lightly compress an acoustic performance.', [eq(['highpass', 70], ['peaking', 250, -2, 1], ['highshelf', 7000, 1.5]), compressor(-22, 2, 18, 180, 1)], 'Tone and level depend on the recording; the chain does not include a final limiter.'),
  preset('piano-smooth', 'Smooth piano', 'Instruments', 'Tame low-mid buildup and bright edges while gently leveling sustained piano notes.', [eq(['highpass', 35], ['peaking', 250, -1.5, 1], ['highshelf', 5000, -1]), compressor(-20, 2, 35, 200, 1.5), limiter(-2)], peakLimit),

  preset('compression-gentle', 'Gentle bus compression', 'Compression', 'A soft knee and 1.7:1 ratio gently control dynamics with no makeup boost.', [compressor(-18, 1.7, 25, 180, 0, 9)]),
  preset('compression-vocal', 'Vocal leveling compression', 'Compression', 'A 3:1 ratio, fast attack and 3 dB makeup gain bring speech or singing forward.', [compressor(-24, 3, 8, 100, 3)], 'Makeup gain can raise peaks; add a limiter if needed.'),
  preset('compression-drums', 'Punchy drum compression', 'Compression', 'A 5:1 ratio and slower attack emphasize drum transients with a quick recovery.', [compressor(-20, 5, 25, 65, 2, 4)], 'Makeup gain can raise peaks; add a limiter if needed.'),
  preset('compression-broadcast', 'Dense speech compression', 'Compression', 'Firm speech leveling with makeup gain and a -1.5 dBFS sample-peak ceiling.', [compressor(-24, 6, 3, 100, 5), limiter(-1.5)], `Not a broadcast loudness-compliance preset. ${peakLimit}`),

  preset('auto-limiter', 'Auto limiter', 'Limiting', 'Measure selected PCM RMS, add at most 6 dB toward -18 dBFS RMS, then limit sample peaks to -1 dBFS.', [auto()], 'Does not boost silence or material below -60 dBFS RMS. The gain cap and peak ceiling may prevent reaching the RMS target. No LUFS or true-peak measurement.'),
  preset('limiter-transparent', 'Transparent peak limiter', 'Limiting', 'Catch sample peaks at -1 dBFS with 5 ms lookahead and a smooth release.', [limiter()], peakLimit),
  preset('limiter-punchy', 'Fast peak limiter', 'Limiting', 'A -0.5 dBFS ceiling, 2 ms lookahead and quick release control short peaks.', [limiter(-.5, 2, 45)], peakLimit),
  preset('limiter-headroom', 'Headroom limiter', 'Limiting', 'Reserve -3 dBFS sample-peak headroom with a longer lookahead and release.', [limiter(-3, 8, 180)], peakLimit),

  preset('master-balanced', 'Balanced mastering start', 'Mastering', 'Subtle broad EQ, gentle compression and bounded automatic level/peak control.', [eq(['highpass', 30], ['lowshelf', 100, .5], ['highshelf', 8000, .75]), compressor(-18, 1.7, 30, 180), auto(-18, 3)], masterLimit),
  preset('master-warm', 'Warm mastering start', 'Mastering', 'Add low-end warmth, soften the top and gently control dynamics before limiting.', [eq(['lowshelf', 120, 1.5], ['highshelf', 7000, -1]), compressor(-20, 2, 25, 200), auto(-17, 4)], masterLimit),
  preset('master-bright', 'Clear mastering start', 'Mastering', 'Open the top end, reduce low-mid buildup and use a gentle de-esser before final level control.', [eq(['highpass', 35], ['peaking', 250, -1, 1], ['highshelf', 7000, 1.5]), step('deEsser', { frequency: 5500, thresholdDb: -24, ratio: 2, maxReductionDb: 3, attackMs: 1, releaseMs: 80 }), compressor(-18, 1.6, 20, 150), auto(-17, 4)], masterLimit),
  preset('master-loud', 'Louder mastering start', 'Mastering', 'Firm compression and bounded automatic gain produce a denser, louder starting point.', [compressor(-22, 3, 8, 90, 3), auto(-14, 6)], `${masterLimit} Stronger processing reduces dynamic range.`),

  preset('telephone', 'Telephone voice', 'Creative', 'A narrow 350 Hz–3.5 kHz band and light saturation create a telephone-like texture.', [eq(['highpass', 350], ['lowpass', 3500]), step('distortion', { drive: 2, tone: 2500 }, .25)]),
  preset('vintage-tape', 'Warm tape color', 'Creative', 'Add saturation, subtle wow/flutter and low-frequency cleanup, then control peaks.', [step('tape', { drive: 1.8, warmth: .55, wow: .08, flutter: .04 }, .7), eq(['highpass', 45]), limiter()], peakLimit),
  preset('spacious-chorus', 'Spacious chorus', 'Creative', 'Combine a gentle chorus with a small room and a final sample-peak limiter.', [step('chorus', { rate: .6, depthMs: 6, delayMs: 20 }, .25), step('reverb', { room: .45, damping: .5, predelayMs: 20 }, .16), limiter()], 'Effect tails end at the selected interval; extend the clip with silence first when you need a longer tail.'),
  preset('rhythmic-pulse', 'Rhythmic pulse', 'Creative', 'Combine 4 Hz tremolo with a 250 ms echo-like delay and a final sample-peak limiter.', [step('tremolo', { rate: 4, depth: .8 }, 1), step('delay', { timeMs: 250, feedback: .25 }, .2), limiter()], 'Uses fixed rates, not tempo synchronization. Delay tails end at the selected interval.'),
];

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const AUDIO_PRESETS = deepFreeze(catalog);
const byId = new Map(AUDIO_PRESETS.map(entry => [entry.id, entry]));
export function getAudioPreset(id) {
  if (typeof id !== 'string' || !byId.has(id)) throw new RangeError(`Unknown audio preset: ${typeof id === 'string' ? id : '(invalid id)'}`);
  return byId.get(id);
}
