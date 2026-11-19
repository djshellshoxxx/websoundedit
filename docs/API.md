# WebSoundEdit API v1

WebSoundEdit has a single editing engine used by the visual editor, JavaScript SDK, CLI and optional local HTTP service. Every audio feature has a named command. No cloud account or audio upload to a third-party service is needed.

## Choose an integration

| Interface | Runs where | Best use |
| --- | --- | --- |
| Browser facade, `window.websoundedit` | The open editor tab | Control the visible session, transport, imports, effects and exports |
| `AudioEditor` ES module | Your own browser page or Node process | Embed the engine and edit PCM programmatically |
| JSON recipe CLI | Your computer | Edit and convert local files with a script or scheduled job |
| Authenticated `/v1` HTTP companion | Your computer, bound to `127.0.0.1` | Python, PowerShell, curl and other programs send files and editing commands |

**GitHub Pages hosts the static application and SDK. It does not host an HTTP processing server.** A script cannot POST a file to the Pages address and expect server-side processing. Run the companion or import the module when editing files from a script. A browser tab can only access files that the user supplies through browser file APIs. The companion accepts uploaded bytes and never accepts an arbitrary local path in an HTTP request.

Official platform references: [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Web Audio AudioBuffer](https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer), [FFmpeg.wasm Node support](https://ffmpegwasm.netlify.app/docs/faq/). The browser uses a dedicated libopus WASM worker for Opus and single-thread FFmpeg.wasm for additional formats. The Node companion uses native FFmpeg from `PATH`; ffmpeg.wasm 0.12 is not a Node encoder.

## Quick start: a local file

Install Node 22.12 or newer and clone the repository. Install native FFmpeg if compressed formats are needed. WAV processing works without FFmpeg.

```sh
git clone https://github.com/djshellshoxxx/websoundedit.git
cd websoundedit
npm ci
node scripts/cli.mjs --input recording.wav --recipe examples/cleanup.json --output cleaned.wav
```

The sample recipe removes DC, high-passes the signal, compresses, peak-normalizes and applies a sample-peak limiter. Adjust its settings to suit the material.

```sh
# Pure conversion; no editing required.
node scripts/cli.mjs --input song.mp3 --output song.flac

# Multiple imports become separate tracks, mixed on export.
node scripts/cli.mjs --input drums.wav --input bass.wav --output mix.wav

# Save a project that the browser can reopen with the PCM already embedded.
node scripts/cli.mjs --input song.wav --recipe examples/cleanup.json --save-project session.json

# Render an existing project.
node scripts/cli.mjs --project session.json --output mix.opus

# Inspect codecs and commands on this machine.
node scripts/cli.mjs --capabilities
node scripts/cli.mjs --commands
```

A single input with no recipe, project or explicit scope is treated as format-only conversion: its channel count, sample rate and raw amplitude are preserved unless a new sample rate is requested. Editing recipes render through the mixer. The CLI accepts `--scope mix|track|clip|selection`, `--bit-depth 16|24|32`, `--float`, `--bitrate 192`, and `--sample-rate 48000`. `--sample-rate` chooses a new project's working rate; loaded projects retain their own rate. `--float` requests floating-point WAV and must be used with `--bit-depth 32`. Output format defaults to the output filename's extension. ALAC uses `--format alac` with an `.m4a` output name.

## Direct JavaScript engine

In Node, import `./src/engine.js` from the clone. The built site also provides a bundled `api.js` ES module for browser integrations. See [examples/direct-engine.mjs](../examples/direct-engine.mjs) for a complete local-file program.

```js
import { AudioEditor } from './src/engine.js';

const editor = new AudioEditor({ sampleRate: 48000 });
const imported = await editor.execute('clip.add', {
  name: 'Take one',
  audio: { sampleRate: 48000, channels: [leftFloat32Array, rightFloat32Array] }
});

await editor.execute('selection.set', {
  clipId: imported.clipId,
  start: 1.5,
  end: 3.5,
  channels: 'all'
});
await editor.execute('effect.reverse');
await editor.execute('effect.pitch', { semitones: 7, preserveDuration: true });
await editor.execute('effect.stretch', { ratio: 1.25, preservePitch: true });

const selectedPCM = await editor.execute('audio.render', { scope: 'selection' });
const projectJSON = await editor.execute('project.save');
```

`execute(method, params)` returns a Promise. Calls to the same editor are serialized. Errors reject with a human-readable `message` and, for engine validation errors, a `code`. An unknown method uses `UNKNOWN_COMMAND`; an invalid/empty explicit selection fails instead of processing the whole clip. `getState()` returns metadata without PCM. `getProject()` is intended for internal integration and exposes the live project; do not mutate it. Use commands for changes.

### Audio values and time units

- PCM is `{sampleRate, channels: Float32Array[], layout}` with 1, 2, 6 or 8 equal-length finite channels. Layouts are `mono`, `stereo`, `5.1` and `7.1`. Surround channel order is explicit; conversion uses the shared matrices in `src/channel-layout.js`.
- Working samples are floating point. Internal audio may exceed ±1; use the limiter or normalize before integer export if needed.
- Clip `start` is seconds on the project timeline. Selection `start` and `end` are seconds **relative to that clip** and snap to sample boundaries.
- A selection affects one clip and all channels, left/right where applicable, or an explicit zero-based channel index list. Length-changing operations require all channels so speaker channels stay aligned.
- If there is a selection on the active clip, an effect uses it. Otherwise the active clip is used.
- Explicit `target` overrides the selection: `{trackId?, clipId?, start?, end?, channels?}`. A range must supply both endpoints and contain at least one sample. An explicit target without a range means the whole targeted clip.
- Duration-changing edits change only the chosen clip. They do not silently move clips later on the timeline. `clip.update` changes placement explicitly.

### Effect call shapes

These calls are equivalent:

```js
await editor.execute('effect.pitch', {
  semitones: -5,
  preserveDuration: true,
  target: { clipId, start: 2, end: 4, channels: 'all' }
});

await editor.execute('effect.apply', {
  effect: 'pitch',
  params: { semitones: -5, preserveDuration: true },
  target: { clipId, start: 2, end: 4, channels: 'all' }
});
```

`effect.preview` accepts the second shape and returns the **entire target clip's new PCM**, including untouched samples outside the selected interval. It does not change the project, undo history or committed audio.

`audio.renderPreview` accepts the same effect parameters plus `scope: 'mix'|'track'|'clip'|'selection'`. It auditions the draft through the same mixer, with the draft clip's changed duration and selection range. Its temporary substitution is always restored; no edit is committed.

## Command reference

The authoritative runtime registry is `await editor.execute('commands.list')`, the exported `COMMANDS` array, or `GET /v1/commands`. Each entry has `method`, `description`, `parameters` examples and `mutates`. Parameter examples are hints, not required literal values. Do not send null placeholder IDs.

### Projects, tracks and clips

| Method | Parameters and result |
| --- | --- |
| `commands.list` | Returns the complete command registry. |
| `project.state` | Returns metadata, track/clip IDs, selection, settings, duration and history availability. |
| `project.new` | `{name?,sampleRate?,bpm?}`; creates an empty project. |
| `project.update` | `{name?,bpm?,beatsPerBar?,beatOffset?}`; tempo metadata, beat grid and metronome settings. BPM 20–400; beats/bar 1–16. Changing BPM alone does not stretch existing audio. |
| `project.select` | `{trackId?,clipId?}`; selects a track/clip, without editing audio. |
| `project.save` | Returns a portable JSON object with base64 float PCM. |
| `project.load` | `{project}`; accepts that object or its JSON string. Validates before replacing the session. |
| `settings.save` | Returns `{format:'websoundedit-settings',version:1,settings}`. |
| `settings.load` | `{settings}`; accepts a settings object or the settings wrapper. |
| `history.undo`, `history.redo` | Return true if an edit was restored; false if there is no entry. |
| `track.add` | `{name?}`; returns the new track metadata. |
| `track.update` | `{trackId?,name?,gainDb?,pan?,mute?,solo?}`; gain −96 to +24 dB, pan −1 to +1. |
| `track.remove` | `{trackId?}`; removes that track and its clips. |
| `clip.add` | `{audio,name?,trackId?,start?}`; creates a track if trackId is omitted; resamples to project rate. Returns IDs and audio metadata and selects the clip. |
| `clip.update` | `{clipId?,trackId?,name?,start?,destinationTrackId?}`; moves/renames a clip, optionally to another track. |
| `clip.remove` | `{clipId?,trackId?}`. |
| `clip.duplicate` | `{clipId?,start?,newTrack?}`; default position is immediately after the source. |
| `clip.split` | `{clipId?,at}`; at is clip-relative and inside the clip. Returns `{left,right}` metadata; selects the right half. |
| `clip.getAudio` | `{clipId?}`; returns a copy of raw clip PCM, without mixer gain/pan. |
| `markers.add` | `{time,name?}`; timeline seconds. |
| `markers.remove` | `{markerId}`. |

New edits after Undo discard Redo. History is bounded to 30 edits and 256 MiB of distinct PCM across current/history states; very large edits can evict older entries. Project files contain the current edited state, not the undo history.

### Selections and edits

| Method | Parameters and behavior |
| --- | --- |
| `selection.set` | `{clipId?,trackId?,start,end,channels:'all'|'left'|'right'}`; clamps to clip bounds then rejects an empty result. |
| `selection.clear` | Removes the interval; the clip remains active. |
| `edit.copy` | Optional `target`; copies the selection or active clip into the internal clipboard. |
| `edit.cut` | Optional `target`; requires a selected range and all channels, then removes that range. |
| `edit.paste` | `{clipId?,trackId?,at?}`; inserts clipboard PCM at a clip-relative time; defaults to selection start or clip end. Creates a clip if no clip is active. |
| `edit.delete` | Requires a selected range and all channels. Use `effect.silence` to mute one channel instead. |
| `edit.trim` | Keeps the selected range. Defaults to preserving its timeline location; `keepTimelinePosition:false` keeps the old clip start. |
| `loop.create` | `{repeats?,crossfadeMs?,newTrack?,name?,start?,target?}`; copies/repeats the selection as a new clip. Default newTrack is true. |
| `recipe.run` | `{commands:[{method,params},...]}`; runs 1–256 commands as one undoable atomic edit. On failure all project changes and clipboard changes roll back. Nested recipes and history commands are rejected. |

Loop creation keeps the source clip and selects the new loop clip. Render `scope:'clip'` to export just that loop, or mute/remove the source track before a full mix if it overlaps. Loop crossfades overlap adjacent repeats, shortening the total by `overlap × (repeats−1)`. Use zero crossfade for exact beat-count duration, or adjust loop bounds to account for overlap. Edge fades can smooth zero-crossing mismatches without adding overlaps.

### Effects: one method per feature

Each accepts its listed parameters and optional `target`. The generic `effect.apply` and `effect.preview` take `{effect,params,target}`.

| Method | Parameters |
| --- | --- |
| `effect.gain` | `db` |
| `effect.fadeIn`, `effect.fadeOut` | `duration` in seconds |
| `effect.normalize` | `targetDb`; sample-peak normalization, not LUFS normalization |
| `effect.reverse` | No effect parameters |
| `effect.invert` | No effect parameters; polarity inversion |
| `effect.phase` | `delayMs`; signed sample delay; select left/right for phase alignment |
| `effect.pan` | `pan` −1…+1; mono becomes stereo, stereo uses balance |
| `effect.mono` | Whole-clip downmix to mono |
| `effect.swap` | Swap stereo channels |
| `effect.eq` | `bands:[{type,frequency,gainDb,q,enabled}]`; peaking, lowshelf, highshelf, lowpass or highpass |
| `effect.compressor` | `thresholdDb,ratio,attackMs,releaseMs,kneeDb,makeupDb` |
| `effect.limiter` | `ceilingDb,lookaheadMs,releaseMs`; sample-peak limiter, not a true-peak meter/limiter |
| `effect.stretch` | `ratio` = output duration/input duration, `preservePitch:true` |
| `effect.pitch` | `semitones,preserveDuration:true` |
| `effect.speed` | `rate`; changes duration and pitch together |
| `effect.silence` | Replaces selected samples with zeros |
| `effect.removeSilence` | `thresholdDb,minDuration,padding` in seconds; may remove the clip if it is wholly silent |
| `effect.dcRemove` | Remove the selected signal's mean DC offset |
| `effect.duck` | See the ducking section below |
| `effect.loop` | `repeats,crossfadeMs`; replaces selected range with repeated audio |
| `effect.beatRepeat` | `division,pattern,bpm?`; division = slices per beat; zero-based pattern indexes into the selected audio's slices |
| `effect.granular` | `grainMs,density,spread,seed,mix`; seeded granular texture |

### Ducking, sidechain and gate envelopes

Tempo volume ducking is deterministic gain modulation aligned to project BPM and beat offset. It does not pretend to be audio-triggered sidechain compression.

```js
await editor.execute('effect.duck', {
  source: 'tempo', mode: 'volume', depth: 0.8, rate: 1,
  attack: 0.01, hold: 0.05, release: 0.8, curve: 1
});
```

`rate` is beats per envelope cycle: `1` quarter-note cycles at 4/4, `0.5` eighth notes, `0.25` sixteenth notes. `depth` is 0–1. Attack/hold/release are normalized fractions of a cycle for the default shape; `curve` controls curvature. `points:[{x,y},...]` supplies a custom shape; x is cycle position 0–1 and y is gain 0–1. At full depth, y=0 closes the gate and y=1 opens it. Closely spaced points make hard rhythmic gating; sloped points make gentler recovery.

For a **real audio-triggered sidechain**, choose another track. Its aligned signal drives the detector, while the chosen target is the signal being processed:

```js
await editor.execute('effect.duck', {
  source: 'track', sourceTrackId: kickTrackId,
  mode: 'compressor', depth: 1,
  thresholdDb: -24, ratio: 8, attackMs: 2, releaseMs: 120
});
```

The sidechain uses source-track gain/pan and ignores that source track's mute switch so a silent trigger track is possible. The source cannot be the target track. Tempo compression mode instead uses the beat envelope as its trigger. Gain envelopes and compressor detector modes are distinct controls.

### Analysis, generation and rendering

| Method | Parameters and result |
| --- | --- |
| `analysis.bpm` | Optional `minBpm,maxBpm,target`; returns BPM estimate, confidence, candidate tempos and beatOffset. Does not automatically change project BPM. Silence or weak periodicity can yield no usable estimate; inspect confidence. |
| `analysis.silence` | `thresholdDb,minDuration,padding,target?`; returns `{start,end}` intervals relative to the analyzed range. Add the selection's start to display them against the clip. |
| `analysis.stats` | Optional `target`; returns duration, sample rate, channel count, peak/RMS dBFS, clipping count, DC and correlation. Silent logarithmic values are `-Infinity` in JS and `null` in JSON. |
| `audio.generate` | `type:'tone'|'noise'|'sweep'|'drums',duration,frequency?,endFrequency?,amplitude?,seed?,bpm?,trackId?,start?,name?`; creates a new track/clip unless trackId supplied. |
| `audio.render` | `scope:'mix'|'track'|'clip'|'selection'`, optional IDs; mix/track accept timeline `start,end`. Returns AudioData. |
| `audio.renderPreview` | `{effect,params,target?,scope?}`; returns draft processed audio through the mixer without committing. |

Mix render is stereo float PCM and follows gain, pan, mute, solo and clip offsets. Mono track pan is equal-power; centered mono contributes approximately −3 dB to each output channel. Stereo pan is balance. Clip/selection render includes the track's gain and pan, ignores its mute switch, and exports only the selected channel when left/right is selected. `raw:true` on clip/selection render bypasses mixer gain/pan. Use `clip.getAudio` for raw whole-clip data.

BPM is metadata unless a stretch effect is requested. To match a recording from 120 BPM to 128 BPM while preserving pitch, use `effect.stretch` ratio `120 / 128`, then `project.update` BPM 128. Manual half/double BPM correction simply sets half/double the project BPM and keeps the audio unchanged.

## HTTP API

Start the companion explicitly:

```sh
npm run api
# WebSoundEdit local API: http://127.0.0.1:8787
# Bearer token: (a fresh random token is printed here)
```

The service binds to `127.0.0.1`. Supply `-- --port 9000` to choose another port. Every endpoint requires `Authorization: Bearer TOKEN`; there is no unauthenticated file endpoint. The Host header must match the loopback server. Browser origins are denied by default. For an intentional browser integration use:

```sh
npm run api -- --allow-origin https://djshellshoxxx.github.io
```

The token is still required, and browser local-network/mixed-content rules can still apply. CLI/Python scripts do not send browser Origin headers. For a computer on another machine, use an authenticated tunnel such as SSH port forwarding to this loopback port; the service does not offer a public bind switch.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /v1/commands` | Bearer token | `{apiVersion:1,commands:[...]}` |
| `GET /v1/state` | Bearer token | Current metadata |
| `GET /v1/capabilities` | Bearer token | Native FFmpeg availability and encodable format IDs |
| `POST /v1/import?name=take.wav` | Raw bytes, `Content-Type: audio/*` or `application/octet-stream`; optional trackId and start query values | `{result:{clipId,trackId,...},state}` |
| `POST /v1/execute` | JSON `{method,params}` | JSON `{result,state}`; PCM-returning commands serialize Float32Array channels as numeric arrays |
| `POST /v1/export` | JSON `{format,bitDepth?,float?,bitrate?,sampleRate?,channels?,render:{scope,...}}` | Encoded audio bytes and matching Content-Type |
| `GET /v1/project` | Bearer token | Portable project JSON |
| `POST /v1/project` | Portable project JSON or `{project:...}` | `{result,state}` |

Use binary `/v1/export` for large renders; raw numeric arrays have substantial JSON overhead. File uploads are capped at 256 MiB, JSON requests at 384 MiB; decoded project PCM has its separate 256 MiB cap. Formats outside WAV require native FFmpeg and their encoders. Native FFmpeg is invoked with argument arrays, bounded runtime, temporary local files, disabled network input protocols and an audio-container allowlist. Files are deleted afterward. Requests never become shell command strings.

An error response is `{error:{code,message}}` with a non-2xx status. Invalid commands/parameters return 400, authentication errors 401, denied Host/Origin 403, request/resource limits 413 and wrong Content-Type 415. The current project remains intact after failed edits.

### Python: edit a file through HTTP

The included script uses Python's standard library; no pip packages are required.

```sh
# In another terminal, run npm run api first and use the printed token.
export WEBSOUNDEDIT_TOKEN='paste-the-token-here'
python3 examples/remote-edit.py input.wav output.flac --recipe examples/cleanup.json --project edited.json
```

PowerShell:

```powershell
$env:WEBSOUNDEDIT_TOKEN = 'paste-the-token-here'
python examples/remote-edit.py input.wav output.wav --recipe examples/cleanup.json --project edited.json
```

The program uploads file bytes, runs the recipe, downloads encoded audio and optionally saves a JSON project. This is a complete script-driven edit using the same engine as the GUI. See [remote-edit.py](../examples/remote-edit.py) for the full implementation.

## Browser UI commands and shortcuts

The running editor exposes `window.websoundedit`. Its `execute` method dispatches core editing commands to a worker. File import/export, playback, loop transport, view/zoom and metronome belong to the browser adapter because they depend on a browser device and DOM; these do not create a hosted server. Use the editor's API/help panel and command palette to discover those adapter commands and keyboard bindings. The direct engine and HTTP companion provide all audio transformations, project edits, analyses and renders; audible playback and waveform navigation run in a browser.

### Browser facade methods

Always wait for startup before controlling the editor:

```js
const editor = window.websoundedit;
await editor.ready;
console.log(editor.commands()); // { core: [...], ui: [...] }
await editor.execute('selection.set', { start: 1, end: 2, channels: 'all' });
await editor.execute('effect.reverse');
editor.setMetronome(true);
editor.setLoop(true);
await editor.play({ scope: 'selection' });
```

| Browser method | Behavior |
| --- | --- |
| `ready` | Promise that resolves after the engine and initial/recovered session are ready. |
| `execute(method,params)` | Runs a core command and refreshes the visual editor. `ui.*` methods invoke the corresponding UI actions; many open a panel or dialog. Use named core effects to commit processing directly. |
| `commands()` | Returns core registry plus UI action names, descriptions and configured shortcuts. |
| `getState()` | Returns a copied metadata snapshot. |
| `importFile(file, {name?,start?,trackId?})` | Decodes a browser File/Blob and adds/selects a clip. Returns its IDs and metadata. |
| `exportAudio({scope?,format?,sampleRate?,channels?,bitDepth?,bitrate?,name?,download?})` | Renders and encodes committed audio. Returns `{bytes,ext,mime,...}`. Set `download:false` to receive bytes without a download. Default scope is mix. `channels` is `original` or `mono`; original means rendered channels. Apply a draft before exporting it. |
| `saveProject({download=true})` | Returns portable JSON including UI settings; normally downloads it. Set download false for a script. |
| `loadProject(projectObject)` | Restores a portable project, embedded audio and UI settings. |
| `saveSettings()` | Returns the UI settings object, including effect values and shortcuts. |
| `loadSettings(value)` | Loads UI settings JSON; accepts its UI wrapper or the engine settings wrapper. |
| `play({scope='mix'})` | Auditions mix, clip or selection, including the currently visible effect preview. Browser audio unlock may require a user gesture first. Calling during playback toggles pause for the same scope. |
| `pause()` | Stops playback at the current cursor. |
| `stop()` | Stops playback and returns cursor to timeline zero. |
| `setMetronome(boolean)` | Enables/disables the transport click. Project BPM/beatOffset/beatsPerBar set its grid. |
| `setLoop(boolean)` | Enables/disables looping. A selected interval defines the mix loop; selection/clip audition loops its rendered range. |
| `setPlaybackRate(rate)` | Sets audition rate, 0.5–2.0. It changes playback speed/pitch and does not edit stored samples. Use stretch/pitch effects for independent rendered changes. |
| `startRecording()`, `stopRecording()` | Begin/end browser microphone capture. Microphone permission and HTTPS are required. Recordings become clips. |
| `previewEffect(effect,params)` | Loads effect controls and schedules the processed waveform preview. This is a UI operation; use `execute('effect.preview',...)` or `execute('audio.renderPreview',...)` for an awaitable PCM result. |
| `loadCodecs()` | Loads the same-origin single-thread FFmpeg engine and returns probed format availability. |
| `codecCapabilities()` | Returns formats immediately; availability is null until probing, except built-in WAV. |
| `clearRecovery()` | Removes the IndexedDB recovery copy; does not remove the open project. |
| `view.fit()`, `view.zoomIn()`, `view.zoomOut()`, `view.zoomSelection()` | Changes waveform navigation only. |

UI command examples are `execute('ui.help')`, `execute('ui.settings')` and `execute('ui.effect',{effect:'eq'})`. Use `commands().ui` to discover actual action IDs rather than assuming every dialog action accepts core-command parameters.

Browser project settings include the current UI values, while standalone engine settings are arbitrary validated JSON. User audio remains on the device. Loading the site's scripts/codecs is a download; file import and processing do not upload audio.

## Resource and quality boundaries

This release supports up to 64 tracks, 512 clips, 1,000 markers and a 10-minute timeline, subject to a 256 MiB decoded PCM budget. Browser decoder/encoder overhead and undo memory can make smaller jobs preferable. These are application guardrails, not a promise that every phone can process a maximum-sized project. DSP runs on float PCM; the built-in time/pitch algorithm is suitable for a lightweight editor and can sound different from an offline mastering tool at extreme ratios. Peak normalization and the limiter do not claim integrated LUFS or oversampled true-peak compliance.

## Creative workbench API (0.2)

All new audio processors are core commands, usable from the browser, DOM-free engine, recipes, CLI and companion: `effect.echo`, `effect.delay`, `effect.reverb`, `effect.chorus`, `effect.flanger`, `effect.phaser`, `effect.distortion`, `effect.tremolo`, `effect.filter`, `effect.tape`, `effect.stutter`, `effect.bitcrusher` and `effect.rack`. `commands.list` returns defaults; the exported `RACK_EFFECTS` schema describes ranges and choices.

A serial rack processes the current selection (or whole selected clip). Each stage has its own dry/wet blend. One rack application creates one undo entry:

```js
await editor.execute('effect.rack', {
  chain: [
    {id: 'filter-1', effect: 'filter', enabled: true, wet: 1,
      params: {type: 'lowpass', frequency: 2400, q: 0.707}},
    {id: 'echo-1', effect: 'echo', enabled: true, wet: 0.3,
      params: {timeMs: 250, repeats: 3, decay: 0.45}}
  ]
});
```

Order is significant. A bypassed or 0%-wet stage is an exact identity. Chains are limited to 12 stages; effect dimensions remain unchanged and tails stop at the selection boundary. `effect.preview` and `audio.renderPreview` accept `{effect: 'rack', params: {chain}, ...}` without committing audio. Stutter divides one beat according to `division` and repeats the first slice across the interval using project BPM.

Key detection analyzes the entire sample and stores its estimate, independent of a narrower current selection:

```js
const key = await editor.execute('analysis.key', {clipId});
const all = await editor.execute('analysis.keyAll');
await editor.execute('clip.key', {clipId, tonic: 9, mode: 'minor'}); // A minor
await editor.execute('clip.key', {clipId, tonic: null}); // clear label
await editor.execute('metadata.update', {
  metadata: {title: 'Afterhours', artist: 'Example', genre: 'Electronic'}
});
```

`keyAnalysis` is included in clip state and native projects. Unknown/ambiguous audio has a null key. PCM edits invalidate the estimate; undo restores it. `metadata.update` replaces the normalized tag set. Browser `exportAudio` defaults to the project's tags and accepts an explicit `metadata` override; container-specific omissions are returned in `result.warnings`.

Browser-specific editing helpers:

```js
const rack = websoundedit.rack.get();
websoundedit.rack.add('tape');
websoundedit.rack.load(rack); // versioned {version,chain,xy} config
websoundedit.rack.setParameter(stageId, 'wet', 0.4);
websoundedit.rack.move(stageId, 0);
await websoundedit.midi.connect(); // explicit permission-bearing action
websoundedit.midi.disconnect();
await websoundedit.midi.importFile(midiFile);
const midiBytes = websoundedit.midi.export({download: false});
const audacity = await websoundedit.exportAudacity('aup3', {download: false});
```

The pure `api.js` bundle additionally exports `processRack`, `processRackEffect`, `createRackEffect`, `normalizeRackChain`, `detectKey`, `manualKey`, `keyColor`, `normalizeMetadata`, `metadataSupport`, `parseMidiFile`, `encodeMidiFile`, and `renderMidiSequence`. MIDI note-file functions work without hardware permissions. The browser sampler and controller have no automatic device access.

`encodeMidiFile(sequence)` preserves source track indices 0–63, using format 1 when separate tracks are needed. Timings are quantized to 960 PPQ at 120 BPM. Nested overlapping notes with the same pitch and channel within one track are rejected because their note-offs cannot preserve voice identity under FIFO pairing; put those notes on separate source tracks. Ordinary FIFO overlaps and simultaneous starts remain supported.

For native project conversion from source modules, `exportAudacity(portableProject,{format:'aup3'|'aup'})` returns `{bytes,mime,ext,warnings}`. `importAudacity(bytes,{name,files})` returns `{project,warnings}`, where `files` optionally maps relative filenames to legacy AU block bytes. The legacy export is a ZIP with a real `.aup` and its `_data` folder. See [interoperability boundaries](AUDACITY.md) before claiming arbitrary Audacity project compatibility.

## 1.0 beta: typed runtimes and recorded macros

The browser now exposes `websoundedit.commandCatalog()` as a flat array of descriptors. Each descriptor includes `method`, `schema`, recordability and capability information. `websoundedit.commands()` retains the older `{core, ui, all}` grouping. Use the catalog rather than hard-coding feature availability. The built `api.js` also exports `createCoreRuntime`, `createBrowserRuntime`, `MacroRunner`, `parseMacro`, `validateMacro`, `formatMacro`, `LiveAudioRuntime`, `CompanionBridge`, channel-layout helpers, WAV/RF64 helpers and genuine Audacity/REAPER exchange functions.

```js
import { createCoreRuntime, MacroRunner } from './api.js';
const runtime = createCoreRuntime();
const runner = new MacroRunner({
  execute: runtime.execute.bind(runtime),
  getCommands: () => runtime.commands()
});
await runner.run(`
  audio.generate({duration: 1, frequency: 440});
  effect.normalize({targetDb: -3});
  let stats = analysis.stats({});
`);
runtime.dispose();
```

`createBrowserRuntime()` composes an in-process editor, playback, live effects, input capture, loop layers, disk recording and the companion bridge. It acquires no permission until an explicit command requests that capability. `runtime.live`, `runtime.companion` and `runtime.engine` are the owned interfaces; `await runtime.dispose()` closes admission immediately and releases owned resources. The full workbench adds user-supplied file aliases, download dialogs and UI commands.

`runtime.live.getState()` reports `capture.transition` while arming and `loops[].transition` for captured layers. Input and track capture use `"audio-clock"`; master capture uses `"main-thread"` because its capture input must disconnect before playback reconnects to the master, avoiding a circular audio graph. `transitionDelayFrames` and `transitionDelaySeconds` record the observed master handoff delay while preserving the scheduled repeat phase. They are not hardware input/output latency measurements.

All command inputs are bounded plain data. Accessors, prototype keys and executable objects are rejected. Unknown or unsupported methods fail before execution. Macro text is interpreted, never passed to JavaScript `eval` or `Function`. Static validation catches known argument problems before the first step; dynamic errors report command, line, column and completed steps. Cancellation occurs between atomic edits and interrupts waits; already completed edits remain applied. Digital silence returns `null` for negative-infinite dB values retained in macro variables, matching JSON. Test `stats.peakDb === null` before numeric comparisons.

The browser records successful semantic actions with `macro.record.start` / `macro.record.stop`; imported files become supplied `input` aliases instead of embedded PCM. Imported projects do not arm MIDI, shortcuts, startup scripts or network credentials. See [Macros](MACROS.md) for the language and visual recorder.

### New HTTP companion resources

All paths retain exact Host/Origin validation and Bearer authentication. The server binds loopback only.

| Endpoint or method | Behavior |
| --- | --- |
| `GET /v1/commands` | Complete typed core, file, macro and streaming catalog; unavailable browser methods remain explicit |
| `GET /v1/capabilities` | Installed encoders, pinned UDP destinations, profiles and bounds |
| `POST /v1/inputs?name=take.wav` | Supply file bytes; response is an alias for `file.import` and isolated batches |
| `GET /v1/artifacts/:id` | Download a retained output artifact, authenticated |
| `POST /v1/execute` | Execute `{method, params}` through the shared validated runtime |
| `POST /v1/cancel` | Cancel an active macro/batch even when normal admission is full |
| `GET /v1/macro/status` | Read progress without waiting for the editor queue |
| `POST /v1/stream/:id/pcm` | Bounded binary interleaved f32le input with sequence/frame query fields |

`file.import`, `file.export`, `file.exportStems`, `macro.validate`, `macro.run`, `macro.batch`, `macro.cancel`, `macro.status`, `macro.record.start`, `macro.record.stop`, `stream.start`, `stream.stop` and `stream.status` are available through `/v1/execute`. The Node runtime advertises browser capture/transport commands as unavailable. Filesystem paths cannot be supplied by an HTTP request or macro. Explicit CLI arguments are the operator's file selection.

A workbench retains at most 128 input aliases / 256 MiB and 128 output artifacts / 128 MiB. Download and remove retained artifacts to reclaim memory, or use the CLI's bounded sequential file sink. `file.input.remove` and `file.artifact.remove` release retained data. The server admits at most eight active/queued normal jobs with a 512 MiB aggregate reservation. See [Companion](COMPANION.md) for live UDP setup and its separate bounded queues.
