# Creative workbench v2 — implementation specification

Status: approved by the owner's implementation request; written before feature implementation.
Date: 2026-11-18 (America/Los_Angeles)
Baseline: `e16173cd7c76d4bb7ab20ecb3c6f20e2f1fa4a71` on `main`.
Destination: <https://djshellshoxxx.github.io/websoundedit/>.

## 1. Goals and scope

Extend the existing local-first multitrack editor without replacing its audio engine, selection semantics, undo, project recovery, scripting API, or Pages publishing pipeline. Processing and file conversion remain on the user's device. Complete the implementation, verification, integration, and Pages deployment in this change.

The requested additions are an ordered creative effects rack, stutter, sample key analysis and colors, MIDI, an XY controller, export metadata, themes, a collapsible inspector, and useful Audacity project interoperability.

## 2. Effects rack

Add **Effects** directly after **Tools** in the Shape the sound categories. Keep the existing processors and category navigation available. Effects opens a serial rack with an effect picker and an ordered list of instances. A user can add the same effect more than once, remove a stage, bypass a stage, or move it. Limit the rack to 12 stages to bound processing and interface complexity.

Initial effects:

| Effect | Intended sound and controls |
| --- | --- |
| Echo | Distinct decaying repeats; time, feedback, tone |
| Delay | Adjustable delayed signal and regeneration |
| Reverb | Deterministic diffuse room tail; decay, room/damping controls |
| Chorus | Modulated short delay; rate and depth |
| Flanger | Short swept delay with feedback |
| Phaser | Cascaded modulated all-pass filtering |
| Distortion | Nonlinear saturation; drive/tone/output |
| Tremolo | Amplitude modulation; rate/depth |
| Filter | Low-pass, high-pass, band-pass and notch; cutoff and resonance |
| Tape | Saturation, warmth and wow/flutter modulation |
| Stutter | Repeat a small tempo-derived slice within the selected region |
| Bitcrusher | Bit-depth and sample-hold reduction |

The five additional effects after echo/delay/reverb are chorus, flanger, phaser, distortion, and tremolo. Filter, tape, stutter, and bitcrusher are additional choices.

Every rack stage has a visible rotary wet/dry control with an accessible numeric/range equivalent, 0–100% wet. Zero wet and bypass preserve the input exactly. The stage combines its own dry input and processed result; serial order therefore changes the signal. Controls use finite, bounded values and output must remain finite. Input PCM is never mutated.

Use both pointer/touch dragging and explicit move-up/down buttons; support keyboard controls, visible focus, and meaningful labels. Dragging changes actual processing order. A label explains that audio flows from the top stage to the bottom stage.

### Selection, preview, and commit

Rack effects preserve duration and channel layout. Process only the current clip-relative selection and selected channels, or the whole chosen clip when there is no selection. Echo/reverb tails remain inside that interval; the interface must explain that selecting extra trailing silence gives tails room. No samples outside the selection change.

Changes render an asynchronous draft from original audio, updating the real PCM waveform. Existing Audition, A/B, Reset, and Apply continue to work. Apply commits the entire chain as one undoable edit. A stale preview must not replace a later selection or parameter change. Invalid stages fail atomically. Rack state persists in project settings and recovery; saving a project preserves the uncommitted rack configuration separately from committed PCM.

### Shared engine contract

`effect.rack` and `effect.preview` with `effect: 'rack'` accept:

```json
{"chain":[{"id":"stage-1","effect":"delay","enabled":true,"wet":0.35,"params":{}}]}
```

`audio.renderPreview` supports the same rack parameters. Core APIs also expose the individual new effects. A shared schema supplies names, default parameters, ranges, and options to the UI and DSP validator.

## 3. XY controller

The Effects panel includes an XY pad with independent selectors for X and Y. Each selector can bind a continuous parameter or wet/dry amount from any rack instance. Choices identify the instance and parameter, including duplicate effect instances. Axis normalization maps 0–1 into the selected parameter range; frequency-style controls may use logarithmic mapping.

Pointer movement updates both values and requests a coalesced PCM preview. Keyboard arrows and explicit axis range controls provide equivalent access. Bindings survive reorder because they use instance IDs, and are cleared/reassigned when the instance is removed. The controller changes parameter values; it does not claim sample-accurate performance automation or recorded automation lanes.

## 4. Inspector, themes, and waveform

Make the whole Shape the sound inspector collapsible using a clearly labelled button with `aria-expanded`. On wide layouts, collapse removes the inspector column so the waveform occupies the released horizontal area. On small layouts, it removes the inspector body. Keep a visible reopen control, preserve chosen category/settings, persist the preference, and redraw canvases after layout changes.

Provide at least four complete themes, including the existing dark studio appearance, a light theme, and two distinct darker styles. Use CSS variables for panel, text, edge, focus, accent, and waveform palettes. Persist the chosen theme in local settings and include it in exported settings. Controls and dialogs must remain readable.

Waveforms use richer, meaningful per-channel/per-clip color while preserving amplitude and time accuracy. Estimated musical keys can supply clip colors; text labels accompany color, so color is not the only identifier. Unknown key remains visibly labelled as unknown. Never imply that a purely visual color change changes the audio.

## 5. Sample key detection

Add Detect key and Detect all sample keys actions. Analyze each whole clip independently in the worker, using bounded audio windows, chroma energy and major/minor template correlation. Return a human-readable key, pitch class, mode, heuristic confidence, alternatives/chroma, and a deterministic color. Silence, insufficient tonal evidence and ambiguous material must return an uncertain/unknown result rather than inventing a key.

Store key analysis on clip metadata, include it in native JSON save/load, and display it in the selection inspector/track context with a confidence explanation. Permit a manual key override. Invalidate or mark the estimate stale when PCM changes; copying unchanged audio may preserve it. All commands are discoverable through the existing API. Automated analysis tests use synthetic known-key material and non-tonal inputs; estimates are not guaranteed musical truth.

## 6. MIDI

Provide a MIDI panel with an explicit Connect MIDI action, input/output port selection, device hot-plug handling, and clear unavailable/denied/no-device states. Request Web MIDI without SysEx. No device permission request occurs on startup.

Support MIDI note-on/off for auditioning the selected sample, MIDI transport start/continue/stop, and CC learning/mapping to rack parameters, wet/dry, and XY axes. Preserve mappings as settings, bound values, avoid stuck notes, and release listeners/voices on disconnect and project replacement. Provide a stop/panic action. Output functionality may send an explicit test note and transport messages to a selected device. Hardware-independent parsers/mapping logic and mock-device browser tests verify functionality; physical hardware verification is reported separately.

Support Standard MIDI File import/export for useful exchange: import note timing and tempo, render a clearly identified simple synthesized audio track for editing, and retain the original MIDI sequence for MIDI export where feasible. MIDI files describe notes rather than recorded PCM. This is not a full notation editor, instrument host, or audio-to-MIDI transcriber.

## 7. Metadata

Add a metadata editor for title, artist, album, album artist, track number, date/year, genre, comment and copyright where supported. Validate lengths, store tags in the project, and prefill export options. Export embeds supported tags in WAV RIFF INFO, OpusTags, and FFmpeg-supported tagged containers. Make raw/unsupported-container limitations explicit in the export dialog; do not promise tags where the container cannot carry them. Audio samples must remain unchanged by metadata-only operations. Metadata values are passed as argument values, never shell expressions or HTML.

## 8. Audacity compatibility

### Native modern project format

Implement actual `.aup3` SQLite project loading and saving, using a bundled, self-hosted SQLite WASM dependency and an original binary-XML encoder/decoder informed by Audacity's source. Preserve supported mono/stereo PCM clips, clip offsets/names, audible track gain/pan/mute/solo, timeline labels, sample rate, and project tags. Translate the two applications’ gain/pan laws to preserve audio; displayed knob values may differ. Split mixed mono/stereo clip tracks on export where Audacity requires separate channel layouts. Use bounded input/resource validation and transactional replacement of the current project.

Audacity project features beyond the editor's data model need explicit handling. Detect realtime plugins, unsupported stretch/time mappings, envelopes, external/aliased/missing blocks, unsupported schemas, and other material transformations. Preserve them only if accurately supported; otherwise reject the affected import with an actionable explanation or require a user-visible supported interchange path. Do not silently discard a feature that changes the sound. Do not present native `.aup3` as universally lossless for all Audacity versions.

### Legacy project format

Support legacy `.aup` XML plus `_data` PCM blocks. Use ZIP for a single-download export that contains the actual `.aup` and its related data directory. Import the matching ZIP or a user-selected `.aup` plus its data files. Explain extraction before opening in Audacity. Validate paths and decompressed sizes. A renamed WebSoundEdit JSON file is never an Audacity project.

### Interchange and verification

Retain project JSON as the complete WebSoundEdit session format, including effect-rack settings and MIDI mappings. WAV/FLAC audio and Audacity-compatible label text are useful supplemental interchange when native project features cannot be reproduced. State exactly which features survive each format. Verify both directions with generated round trips and, where the environment supports it, real Audacity-generated fixtures and real application open/export checks. Publish any remaining interoperability boundaries in documentation and the project dialog.

Reference material:

- Audacity project documentation: <https://manual.audacityteam.org/man/audacity_projects.html>
- Audacity source: <https://github.com/audacity/audacity>
- Web MIDI specification: <https://www.w3.org/TR/webmidi/>
- Web MIDI browser requirements: <https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API>

## 9. Verification and release gates

1. Preserve and pass the existing engine, DSP, API, playback, visualization, codec and browser tests.
2. Verify actual DSP output: wet-zero identity, bypass identity, finite stereo output, changed output at useful settings, deterministic results, order sensitivity, selection boundaries and one-step undo.
3. Verify key analysis on tonal/silent/noisy examples, persistence, manual override, and invalidation after PCM editing.
4. Verify MIDI parsing, CC mapping, transport and no-device/denied behavior; distinguish mock tests from physical hardware tests.
5. Decode exported metadata-bearing files and verify tag values plus unchanged duration/channels.
6. Exercise native and legacy Audacity projects, unsupported features, corrupt files and resource limits.
7. Browser-test adding/reordering effects, wet/dry, XY, stutter selection, collapsed inspector width, themes, save/load and export. Check desktop and mobile layouts and keyboard alternatives.
8. Build the static distribution with self-hosted dependencies, run the existing bundle checks, commit the integrated result, publish through the repository's verification/deployment workflow, and verify the deployed revision and live page.
9. Record actual test results and any remaining compatibility limitations. Do not report an unobserved deployment or untested hardware as verified.
