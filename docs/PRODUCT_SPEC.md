# WebSoundEdit — product and engineering specification

Version 1 · CircuitDriftLabs · 18 November 2026

## 1. Product purpose

WebSoundEdit is a local-first audio editing workbench hosted as a static GitHub Pages application. It combines precise region editing, a compact multitrack timeline, visible audio processing, and a scriptable engine. A person should be able to import audio, select a passage, hear and see a change, make a loop, and export the result without learning a large digital audio workstation.

The processing engine is also a reusable JavaScript module. A Node command-line runner and optional authenticated local HTTP companion let scripts perform complete editing jobs on audio supplied from the user’s computer. The GitHub Pages site itself is not an HTTP processing server. The architecture and its browser/file-access implications are explained in [RESEARCH.md](RESEARCH.md).

This document specifies intended behavior and acceptance requirements. It is not a claim that all acceptance checks have already passed. [ENGINE_CONTRACT.md](ENGINE_CONTRACT.md) defines the initial implementation interfaces; API documentation and automated tests record the shipping implementation.

## 2. Primary workflows

### Quick edit

Import a file, drag a time selection, play the selection, cut or trim it, apply an optional fade, then export the selected audio or full clip. Undo must recover each edit.

### Make a musical loop

Import a recording, estimate BPM, correct the BPM or beat position, select a beat-aligned region, audition it repeatedly, soften the loop seam, and export or repeat it on the timeline. The metronome follows the same project timing as the grid.

### Shape a mix

Import several tracks, place clips at timeline positions, adjust gain/pan/mute/solo, edit an individual track or channel, and export the mix. EQ, compression, limiting, and ducking preview must be audible and visible before committing a change.

### Automate an edit

A script imports audio bytes or opens a local input through the CLI, calls the same engine commands used by the interface, applies a JSON recipe, and saves audio plus an optional portable JSON project. The script must not need to simulate mouse movement.

### Design new material

Use beat slicing/reordering to rearrange a musical phrase. Use seeded granular processing or the tone/noise/sweep generators to make textures, transitions, and test signals. Saved parameters reproduce the same seeded result.

## 3. Interface structure and ergonomics

The visual identity follows CircuitDriftLabs: a dark instrument-panel aesthetic, readable typography, clear accent colors, technical meter and waveform details, and restrained decoration. The interface should feel like an audio tool rather than a general website dashboard. The project header links to the CDL main site, and the CDL main site links back to WebSoundEdit.

The priority order follows the official editing workflows compared in [RESEARCH.md](RESEARCH.md); it does not claim a statistical command-frequency ranking.

| Area | Purpose | Required controls |
| --- | --- | --- |
| Persistent transport | Audition without losing editing context | Play/pause or stop, selection playback, loop, playhead time, metronome, BPM |
| Edit rail | Reach common edits beside the audio | Undo/redo, cut/copy/paste, split, delete, trim, reverse, fades, zoom |
| Timeline | Understand arrangement and time | Track rows, clips, waveforms, time/beat ruler, playhead, selection, loop bounds |
| Track strip | Balance and isolate tracks | Name, select, gain, pan, mute, solo, remove/duplicate through accessible commands |
| Selection inspector | Make scope unambiguous | Active clip, start, end, duration, left/right/all channels, playback/export selection |
| Processing inspector | Compare a specific change | Effect selection, labeled numeric controls, preview, apply, original/processed visual comparison |
| Analysis area | See signal and rhythm | Peak/RMS information, clipping indication, spectrum, BPM evidence, silence ranges |
| Command palette | Reach every registered feature | Searchable commands, API method, description, editable keyboard binding |

At smaller widths the inspector can stack below the timeline. Transport and selection remain easy to reach. Controls must not become inaccessible behind horizontal page overflow. The waveform itself may scroll horizontally when zoomed.

Labels should use plain names with units: `Threshold (dB)`, `Attack (ms)`, `Pan`, `Pitch (semitones)`, `Time ratio`, and `BPM`. A tooltip may explain a control but must not be the only available name. Numeric entry must supplement sliders so exact settings and keyboard operation are possible.

### Keyboard behavior

Every UI operation and engine command has a route through the command registry/palette. Frequent actions additionally have default shortcuts. Users can assign or replace bindings and save those settings as JSON. The command list shows both the current shortcut and the API identifier.

Use familiar transport/edit shortcuts where possible, with alternatives for browser-reserved combinations. Shortcut handlers ignore editable text fields unless the shortcut is intentionally an application-level save action. Dialogs expose focusable controls, return focus to their trigger, and close with Escape where cancellation is possible. Waveform selections are editable numerically without a mouse. Shortcut collisions must be reported rather than silently creating ambiguous behavior.

## 4. Audio, timeline, and selection model

The shared engine processes finite floating-point PCM in mono or stereo. A project contains a sample rate, BPM, beats per bar, beat offset, tracks, markers, current selection, and settings. Each track contains independently positioned clips and has gain, pan, mute, and solo state. Clip start positions are in project seconds. Selection positions are relative to their clip.

Imported audio is converted to the project sample rate before mixing. Internal processing may retain values outside −1 to +1 so that headroom is not silently discarded. Integer exports must apply the documented conversion/clipping behavior, and the UI exposes clipping information before export.

### Selection rules

1. A selection identifies one clip, a start and end, and an all/left/right channel scope.
2. A visible selection takes precedence for region-capable operations; otherwise the active clip is the target.
3. Explicit API targets override the current selection. An invalid explicit target produces an error rather than falling back to an unrelated clip.
4. Start/end times are validated and converted to sample indices consistently. Empty selections are rejected for operations that require audio.
5. An ordinary effect changes only the selected samples/channels. Audio outside the interval remains unchanged.
6. Duration-changing and channel-structure-changing operations require coherent channel scope. If left/right-only operation cannot preserve alignment, reject it and explain that all channels are required.
7. Duration changes alter the selected clip. Later clips are not silently moved elsewhere in the project.
8. Selection playback and selection export use the same sample bounds as selection editing.

These rules apply equally to reverse, pitch/time processing, normalization, silence, EQ, dynamics, ducking, loop rendering, and sound-design processing when the operation supports region scope.

## 5. Feature specifications

### 5.1 Import, export, and conversion

**Import:** support file picker and drag/drop. Create a clip on a track, retain a readable name, report sample rate/channel count/duration, and show decoding errors without discarding the existing project. Native browser decoding may be used when suitable; the bundled codec engine supplies additional formats.

**Export scopes:** complete mix, track, clip, and selection. A selected channel can be exported independently. Exports use rendered PCM from the same processing engine as playback. A download must contain an actual audio file of the chosen format, not a renamed WAV.

**Formats:** WAV is the baseline PCM encoder. The codec-backed export surface should include MP3, FLAC, Ogg Vorbis, Opus, AAC/M4A, AIFF, ALAC/M4A, and WMA when supported by the bundled encoder build. The application must expose actual capabilities; an unavailable codec must produce an explicit explanation or be unavailable in the picker. Container and codec names should be distinguished, particularly M4A/AAC/ALAC and Ogg/Vorbis/Opus.

**Settings:** expose appropriate sample rate, channels, bitrate or quality, and PCM bit depth. Validate settings against the selected encoder. Offer useful defaults rather than meaningless options such as a lossy bitrate setting for PCM WAV. Preserve the original input filename stem in the suggested export name. Report progress and actionable failures.

**Conversion-only workflow:** import and export without editing, through both GUI and scripting. No audio upload is necessary. Native FFmpeg is an optional local dependency for CLI formats beyond the built-in WAV path.

### 5.2 Selection editing and arrangement

| Operation | Required behavior |
| --- | --- |
| Split/chop | Split a clip at a cursor or selection boundary into independently addressable clips. Preserve timing and sample content. |
| Cut/copy/paste | Use an internal audio clipboard; paste at the explicit cursor/selection target with sample-rate/channel validation. |
| Delete | Remove the selected duration from the clip. Show the resulting shorter clip; do not silently move other tracks. |
| Silence | Replace selected audio with zeros without changing duration. |
| Trim | Retain the selected portion and discard the rest of the active clip; document resulting timeline placement. |
| Reverse | Reverse only the target samples while preserving duration and untouched channels. |
| Duplicate | Create an independent editable clip or track copy with a new identifier. |
| Move | Set clip start on the timeline; reject negative or invalid positions. |
| Undo/redo | Restore audio, layout, selection, and relevant project state for a committed edit. A new edit clears redo. |

Undo history is bounded to control memory. The limit and the fact that older history can expire must be visible or documented. Saving a project preserves the current editable state; indefinite undo history across reloads is not required for version 1.

### 5.3 Gain, fades, normalization, channels, and phase

**Gain:** a dB adjustment on a region or the track mixer. Distinguish committed region gain from non-destructive track level.

**Fades:** fade in and fade out over an explicit duration, limited to the target. Display the resulting envelope and allow a short boundary fade to reduce clicks.

**Normalization:** peak target in dBFS, applied with linked gain by default for stereo. It must not be called loudness or LUFS normalization. Silence must remain finite and silent rather than producing infinite gain. DC removal is a separate operation or explicit option.

**Channel tools:** all/left/right editing, swap stereo channels, mono downmix, and pan. The active channel scope remains visible. Mono/stereo conversion behavior and center-pan gain are documented. Stereo image inspection includes correlation when meaningful.

**Phase tools:** polarity inversion and signed time alignment in milliseconds/samples. Label them separately. An inversion changes sample sign; a delay shifts timing. Neither control is described as a frequency-independent arbitrary phase rotator.

### 5.4 Pitch, time, speed, and BPM matching

Provide separate controls for pitch shift with duration preserved, time stretch with pitch preserved, and speed/rate change that changes both. Pitch is entered in semitones; time stretch uses an output/input duration ratio, with a source-to-target BPM helper where available.

A pitch preview and a committed pitch edit use the same algorithm. Time stretching updates region/clip length predictably and preserves coherent stereo timing. Extremely short or invalid inputs must produce a defined result or error. The engine must flush/pad the processing pipeline correctly so a render does not lose the ending of a clip. Processing quality limitations at extreme settings are documented rather than described as transparent or mastering-grade.

Manual BPM correction updates the project timing reference. It does not itself stretch audio. Stretching to a different BPM is a separate audio command.

### 5.5 Parametric EQ

Use multiple independently enabled bands. Each band exposes filter type, frequency, gain where applicable, and Q. Required types are peaking, low-pass, high-pass, low shelf, and high shelf. Validate frequency against Nyquist and reject invalid Q or non-finite values.

The inspector should display an EQ response visualization and/or before/after spectrum together with the processed waveform. Rendering uses actual filter processing; drawing a curve is not the audio implementation. Selected-range EQ must not overwrite samples outside the target.

### 5.6 Compressor and limiter

**Compressor:** threshold, ratio, attack, release, knee, and makeup gain. Stereo-linked detection avoids unstable image shifts by default. Provide meaningful level/gain-reduction information or before/after level analysis. Ratios, durations, and thresholds are validated.

**Limiter:** ceiling, release, and lookahead. The promised ceiling must be stated as a sample-peak ceiling unless a true-peak algorithm is actually implemented and measured. The limiter should preserve timing after compensating its internal lookahead. An output at the chosen ceiling does not establish codec/intersample true-peak compliance.

Both tools apply to the active selection or clip and update waveform/analysis from their resulting PCM.

### 5.7 Silence detection and removal

Detection accepts a threshold in dBFS, a minimum duration, and boundary padding. It returns labeled ranges without editing audio. For stereo, a range should be called silent only under the documented linked-channel rule, so activity in one channel is not accidentally removed because the other is quiet.

Show detected ranges and their count/total duration. Removal is an explicit edit using those settings, not an automatic side effect of detection. Restrict time-removal to all channels so left/right stay aligned. Allow auditioning a range and undoing removal. Do not classify all low-volume music or a fade as unwanted material merely because it is below threshold.

### 5.8 BPM detection, grid, and metronome

Return a BPM estimate, confidence/evidence value, candidate alternatives, and estimated beat offset. Search bounds are configurable. Silence or insufficient rhythmic evidence returns an honest weak/no-result outcome rather than a confident arbitrary tempo.

Expose numeric BPM override, half/double correction, and beat offset. The grid, metronome, beat shaping, and beat-repeat calculations share project timing. The metronome is an audition aid and is excluded from normal audio export unless an explicit rendering option is added. Playback speed and looping must not leave stray metronome clicks running after stop.

### 5.9 Loop creation

Set loop bounds from the current selection, audition continuously, repeat the selected audio a requested number of times, and export it separately. Beat-grid snapping and exact numeric selection bounds make bars and subdivisions easy to select.

A seam-crossfade option reduces discontinuities. Its effect on total duration must be explicit: overlapping crossfades can shorten repeated material, while fixed-length boundary treatment must keep the requested musical length. Do not claim click-free results for every arbitrary waveform. Users must be able to preview the seam and export the exact previewed samples.

### 5.10 Ducking and rhythmic gate shaping

The ducking section has a source and a gain-control mode:

| Choice | Behavior |
| --- | --- |
| Tempo source | Repeat a gain envelope at a specified number of beats per cycle, aligned to project beat offset and clip timeline position. |
| Track source | Use the actual selected trigger-track signal, aligned on the timeline, to control the target. |
| Volume shaping | Apply an explicit amplitude envelope/depth directly. |
| Compression | Use threshold, ratio, attack, and release to determine gain reduction from the trigger. |

A shape editor or equivalent numeric point list controls cycle shape. Parameters include depth, attack, hold, release, curve, and cycle rate. Points use normalized cycle position and gain. Provide smooth pumping and sharp gate-style presets, including a full-depth closed portion. Preview the applied shape over the waveform and make trigger/source identity visible.

Track-driven ducking must not secretly substitute project BPM for its detector. A muted trigger can still be used as a control signal if that behavior is documented. Reject self-referential or invalid source configurations where they would make processing ambiguous. Depth zero must leave the target unchanged.

### 5.11 Additional musical feature: beat slicing and reordering

Divide a selection by a musical subdivision, reference slices by index, and render an ordered/repeated slice pattern. A pattern such as repeated or reordered indexes produces stutters, fills, or a new loop. Provide an auditionable pattern and duration before committing. Validate indices, pattern length, BPM, and subdivision.

The JSON recipe stores the exact pattern, timing, and selection. Repeating the recipe on the same source produces the same result. This is audio slicing, not a claim of MIDI sequencing, source separation, or automatic beat-perfect transient identification.

### 5.12 Additional sound-design feature: granular texture

Process a selection into a texture using grain size, density, position spread, seed, and dry/wet mix. Window grains to avoid uncontrolled discontinuities. The same seed and settings reproduce the same output. Keep output duration and channel behavior documented; apply to a selection without rewriting unrelated audio.

Also provide deterministic tone, seeded noise, frequency sweep, and rhythmic demonstration-signal generators. These are useful for testing an EQ, building a transition, and learning the editor without uploading a file. Expose duration, level, frequency/end frequency where relevant, sample rate, and seed.

### 5.13 Analysis and supporting essentials

Provide duration, sample rate, channel count, peak level, RMS level, clipped-sample count, DC offset, and stereo correlation where defined. Represent silence consistently rather than displaying `NaN`. Markers name important positions and survive project saving.

The application needs a meaningful empty state, sample/demo audio generated locally, processing indicators, clear errors, and a way to download a project before leaving. JSON settings preserve effect presets, keyboard bindings, and display preferences that can be represented portably. No telemetry or external audio upload is necessary for editing.

## 6. Truthful waveform and preview contract

All displayed processed traces come from the same processed sample data used for preview or export. The original trace can remain as an overlay for comparison. Stable amplitude scales make gain/dynamics changes visible. Time-changing effects update the time axis or clearly mark the changed preview duration.

Pitch and EQ may leave the overview peak envelope similar. The spectrum and close waveform inspection reveal the relevant changes; the interface must not invent a visual change just to make a knob look active. Selection bounds, unprocessed regions, and channel identity remain distinguishable.

Effect preview is non-committing. Repeated parameter changes preview from the committed source rather than repeatedly reprocessing the previous preview. A later request wins over an earlier asynchronous response. Apply commits exactly the parameters being shown, adds one undoable edit, and clears/replaces obsolete preview data. Cancelling a preview restores the committed audio view.

Processing runs in a worker. The main interface remains able to display status. Render progress is informative but need not claim a reliable percentage where the underlying encoder cannot provide one.

## 7. API and automation specification

### Shared command model

`AudioEditor.execute(method, params)` is the common asynchronous entry point. The command registry exposes method names, descriptions, and parameter hints. Each effect is individually addressable by its stable effect identifier through the processing command, with named aliases where offered. No feature should exist only as an uncallable GUI event handler when it changes audio or project state.

| Feature family | Engine operations |
| --- | --- |
| Project | `project.new`, `project.update`, `project.select`, `project.save`, `project.load` |
| Settings/history | `settings.save`, `settings.load`, `history.undo`, `history.redo` |
| Tracks | `track.add`, `track.update`, `track.remove` |
| Clips | `clip.add`, `clip.update`, `clip.remove`, `clip.duplicate`, `clip.split`, `clip.getAudio` |
| Selection/editing | `selection.set`, `selection.clear`, `edit.cut`, `edit.copy`, `edit.paste`, `edit.delete`, `edit.trim` |
| Effects | `effect.apply`, `effect.preview` with an explicit registered effect identifier and validated parameters |
| Analysis | `analysis.bpm`, `analysis.silence`, `analysis.stats` |
| Audio creation/output | `audio.generate`, `audio.render`, `loop.create` |
| Markers/recipes | `markers.add`, `markers.remove`, `recipe.run` |

The browser facade additionally exposes transport, view, file-picker/import, codec export, and keyboard actions. These are clearly identified as browser-adapter capabilities. Browser play/pause is not a requirement of a headless Node audio render. Complete headless editing means the script can generate/import, select, edit, process, arrange, analyze, save, and export without a browser session.

Errors include a useful message and stable category where available. Validation happens before committing state. Unrecognized methods, invalid numbers, malformed points, unavailable codecs, and missing targets must not corrupt the project.

### CLI

The baseline workflow is:

```sh
node scripts/cli.mjs --input input.wav --recipe recipe.json --output output.wav
```

The CLI executes the exact shared engine. A recipe is data, not JavaScript; it contains ordered named commands and JSON parameters. It should support selection edits and project output, with deterministic exit codes and no silent success after a failed command. Non-WAV decoding/encoding uses documented optional native FFmpeg support.

### Local HTTP companion

The companion binds to loopback, prints a generated bearer token, validates Host/Origin, caps request size, and accepts uploaded audio bytes rather than arbitrary filesystem paths supplied over HTTP. Requests use the same command model. Script clients can upload, execute editing commands, retrieve rendered audio, and save/load JSON projects.

A script on another physical machine can use a user-established secure tunnel or run the CLI on the machine holding the files. An unauthenticated public processing service is not included in the Pages deployment. The documentation must show an end-to-end example and state which component is running locally.

## 8. JSON project and settings persistence

Portable projects have an explicit format/version, project timing, tracks/clips, selections, markers, settings, and embedded PCM encoded in base64. They reopen without relying on temporary browser object URLs or missing original files. Embedded PCM increases file size; the UI should make that tradeoff clear.

Project loading validates version, structure, identifiers, rates, channel lengths, base64/PCM representation, numeric finiteness, and resource limits before replacing the current project. Unsupported versions and malformed files produce an error while preserving the open project. Treat loaded JSON as data: never evaluate code, HTML, or arbitrary method names embedded in it.

Settings JSON is distinct from project JSON and can be saved/imported independently. A settings import must not unexpectedly replace audio. Saving and reopening must preserve the rendered signal within the documented float representation.

## 9. Deployment and quality requirements

Build a static site with base-path-safe assets for `/websoundedit/`. Bundle or copy worker and codec assets to the same deployment origin. Lazy-load the large codec engine when conversion is requested. GitHub Actions builds and deploys the tested site to Pages.

The release must document supported browsers/runtime versions, memory constraints, algorithm limitations, and codec dependencies. Stereo audio at 48 kHz in Float32 uses approximately 384 kB per second before copies, history, or codec buffers; practical project limits must account for those multipliers. Bound undo/JSON imports and reject allocations beyond defined limits.

Acceptance evidence belongs in automated test output and a release verification record. At minimum verify selection isolation, channel isolation, timing changes, compressor/limiter behavior, BPM uncertainty, seeded reproducibility, project round trips, API/GUI engine parity, actual encoded formats, and a browser walkthrough. [ACCEPTANCE.md](ACCEPTANCE.md) specifies those checks without predeclaring results.
