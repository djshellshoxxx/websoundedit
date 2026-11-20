/** Deterministic centered synthetic music, for execution checks, not quality scores. */
export function stemFixture({ seconds = 9, sampleRate = 44100 } = {}) {
  const frames = Math.round(seconds * sampleRate), channel = new Float32Array(frames);
  let seed = 0x51a7cafe;
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate, beat = time % .5;
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 0x100000000 * 2 - 1;
    const bass = .16 * Math.sin(2 * Math.PI * 55 * time) + .045 * Math.sin(2 * Math.PI * 110 * time);
    const lead = .11 * Math.sin(2 * Math.PI * 440 * time + .5 * Math.sin(2 * Math.PI * 5 * time)) * (.65 + .35 * Math.sin(2 * Math.PI * 2 * time));
    const kick = .16 * Math.exp(-beat * 24) * Math.sin(2 * Math.PI * (65 * beat + 35 * (1 - Math.exp(-beat * 25)) / 25));
    const hat = .05 * noise * Math.exp(-(time % .25) * 120);
    const fade = Math.min(1, frame / 441, (frames - 1 - frame) / 441);
    channel[frame] = (bass + lead + kick + hat) * fade;
  }
  return { sampleRate, channels: [channel] };
}
