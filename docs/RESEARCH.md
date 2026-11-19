# WebSoundEdit — research and design decisions

Research reviewed 18 November 2026. This document explains the evidence behind the interface and architecture. The product specification describes required behavior; this document does not establish that a feature has passed testing.

## What can be said about the “most used” controls?

The research did not establish a representative, public telemetry dataset ranking audio-editor commands by usage frequency. Claiming that an exact percentage of users prefer a particular command would therefore be unsupported. Instead, the interface priorities below use **convergence across official editor documentation**, combined with the workflows explicitly requested for this project.

Audacity’s editing and shortcut documentation foreground selection, transport, cut/copy/paste, delete, trim, split, undo/redo, and zoom. Ableton’s Arrangement documentation likewise makes selection the prerequisite for editing and places transport, timeline navigation, and track controls close to the arrangement. These are strong workflow precedents; they are not usage statistics. [1][2][3]

| Priority | Controls | Design decision | Evidence basis |
| --- | --- | --- | --- |
| Persistent | Play/stop, selection playback, loop, undo/redo, import/export | Keep these available while changing effects or switching tracks. | Transport and edit commands recur in the official workflows. [1][2] |
| Immediately beside waveform | Selection bounds, split, cut, copy, paste, delete, trim, reverse, zoom to selection | Editing should start from the audio being inspected. Numeric bounds supplement dragging. | Both editors use selection-based editing; Audacity documents direct numeric selection controls. [1][2][4] |
| Persistent track strip | Gain, pan, mute, solo, track selection | Let users balance and audition material without leaving the timeline. | Ableton groups mixer controls with arrangement tracks. [2] |
| Contextual inspector | Pitch/time, EQ, dynamics, channels, silence tools, ducking | Show the chosen operation’s parameters and target together, instead of presenting every parameter at once. | Clip-local controls and focused tool views are established patterns; this grouping is a WebSoundEdit design inference. [2][5] |
| Discoverable command search | All commands, shortcuts, descriptions, API identifiers | Make infrequent functions reachable without expanding the permanent toolbar. | Audacity supports command/shortcut customization; keyboard operability is an accessibility requirement. [1][6] |

## Selection is the editing contract

Audacity documents selecting a region on one or more tracks before applying effects, deleting, or moving that region. Ableton distinguishes selecting a clip from selecting a time span. WebSoundEdit should preserve that distinction: a selected track is not automatically the same as selected samples. [2][4]

Every operation needs an explicit, visible scope. At minimum that means the active track, start and end time, and channel choice. Editing a highlighted region should leave samples outside that region unchanged unless the command explicitly changes duration. Time-changing commands must state their ripple behavior. Selection playback and export should use the same bounds as editing.

Loop creation should be a short path from the same selection: select, audition, set loop, optionally soften boundaries, export. Ableton documents consolidating selected material into a loop, while Audacity exposes loop-to-selection as a dedicated command. [1][2]

## Make the visuals physically truthful

A waveform displays sample amplitude over time. A spectrogram displays frequency content over time. Audacity specifically recommends waveform views for precise cutting and spectrograms for frequency information. [7]

Consequently, the display must be recalculated from the actual processed audio rather than animated independently of the signal. Gain, fades, compression, inversion, or gating can change the amplitude trace clearly. Pitch shifting changes periodic structure, but a zoomed-out peak envelope can look similar before and after a pitch change. A frequency view and sufficiently close waveform zoom make that change interpretable. A pitch knob must never merely stretch the drawing while playback uses a different algorithm.

The useful comparison is original audio against processed audio, with stable scales and an audible preview. Automatic vertical normalization of every displayed waveform can hide gain changes; display scaling should therefore be explicit and separate from signal normalization.

## Tempo and sidechain controls

Automatic tempo estimation is an estimate. Ableton documents cases where the estimated tempo is doubled or halved and supplies correction controls. WebSoundEdit should show a detected BPM with evidence strength, allow numeric replacement, and make half/double corrections easy. [8]

Changing the project’s BPM is different from changing audio duration. The first updates the beat grid, metronome, and tempo-based processing. The second requires an explicit stretch operation with a source and target tempo. This prevents a user correcting a mistaken detector result from inadvertently rendering their audio at a new speed.

Two ducking modes should have distinct names and behavior:

1. **Beat-synced volume shaping:** a repeating envelope follows project tempo. Depth, cycle length, phase, and shape determine the gain applied. Square or sharply edged shapes can create rhythmic gating.
2. **Audio sidechain compression:** another audio signal drives a detector; threshold, ratio, attack, and release determine gain reduction on the target. The trigger signal does not have to be audible in the mix. This is the sidechain relationship documented by Ableton. [9]

A drawn tempo envelope is useful even without a kick track, but should not be described as if it detects a separate kick. Conversely, an audio-triggered compressor should react to the trigger’s actual activity rather than a metronome approximation.

## GitHub Pages and the API boundary

GitHub Pages publishes static files and does not execute application server languages. A GitHub Pages URL therefore cannot itself expose a running audio-processing HTTP service. [10]

A viable architecture consists of a static browser application plus a reusable processing API. Scripts can call the same command model through an imported module, a local command-line runner, or a user-run local service. The local runner can open paths on the machine where it executes. A hosted page, in contrast, receives files through a picker, drag/drop, or explicitly granted browser file access. `FileReader` cannot open an arbitrary local path supplied by a remote script. [11][12]

If an HTTP bridge is offered, it is a local companion application, not a Pages-hosted endpoint. Its authentication, allowed origins, allowed paths, and bind address need to be defined. The default design should not expose arbitrary local-file editing to unrelated websites or network clients.

## Decoding, encoding, and conversion

Web Audio’s `decodeAudioData()` accepts complete encoded files, produces decoded audio, and resamples to the context rate. Native decoding support varies by browser and format. Browser decoding and encoding capabilities are different, so the ability to import a format does not establish the ability to export it. [13]

For broad conversion, a same-origin FFmpeg WebAssembly distribution can run in a worker. The project supplies single-thread and multithread cores; its documented multithread path requires `SharedArrayBuffer` security conditions. A single-thread core is the straightforward baseline for a static Pages deployment that does not control cross-origin-isolation headers. [14][15]

The browser must advertise the formats supported by the included build and validate settings before encoding. WebCodecs offers runtime configuration checks, but it does not imply universal codec availability or automatic container packaging. [16]

The FFmpeg WebAssembly project documents significant browser memory/performance constraints, and it no longer supports Node.js beginning with its 0.12 generation. A local Node runner should use a compatible JavaScript processing path and native FFmpeg when needed; it should not assume the browser wrapper runs unchanged in Node. [17]

WAV is a sensible baseline for exact, easily inspected sample output. Compressed formats can be added with actual encoder-backed paths. Converting lossy input to a lossless file preserves the decoded result; it does not reconstruct information removed by the source encoder.

### Pitch/time library integration

The selected `@soundtouchjs/core` 2.1.1 package belongs to SoundTouchJS’s newer API generation. Its upstream documentation uses named constructor options and describes the core package as suitable for custom/offline/non-browser pipelines. It exposes the WSOLA `Stretch` stage and interleaved sample buffers. Older examples using `PitchShifter`, `SimpleFilter`, or public `SoundTouch.tempo`/`rate` controls do not describe the current API. Implementation should follow the pinned package’s source/types and verify pitch, duration, and end-of-stream flushing with signal tests. [23]

The FFmpeg installation guide recommends downloading and hosting its package because the wrapper spawns a worker. WebSoundEdit’s same-origin deployment follows this pattern rather than importing the wrapper directly from a public CDN at runtime. [24]

## Normalization, silence, and phase labels

Peak normalization changes gain to target the largest sample peak. It is not a measurement of perceived loudness and should not be presented as LUFS normalization. Audacity explicitly distinguishes this difference. DC removal is a separate mean-removal operation that can accompany normalization. [18][19]

Silence detection should expose its threshold and minimum duration, preview the detected ranges, and allow inspection before removal. Quiet fades and intended pauses can fall below a detector threshold; Audacity’s silence tool documentation describes these tradeoffs. [20]

“Phase” also needs precise labels: polarity inversion multiplies samples by −1, whereas sample delay changes timing. The latter produces a frequency-dependent phase difference when mixed with another signal. A general phase-rotation claim should not be attached to a simple inversion switch.

## Ergonomic and accessible control requirements

All operations need a keyboard path, including selection bounds, effect parameters, exports, and JSON import/export. Command search complements direct shortcuts; it should not be the only way to understand controls. Shortcuts must not fire while users type in editable fields, and browser-reserved shortcuts need an alternative route. The W3C keyboard criterion concerns the availability of keyboard operation, not the existence of a unique one-key binding for every action. [6]

Touch and mouse targets must remain usable at compact viewport sizes. WCAG 2.2’s minimum target-size criterion uses 24 by 24 CSS pixels subject to its exceptions; its enhanced target-size criterion uses 44 by 44. Larger transport and frequently used edit buttons are a reasonable WebSoundEdit design choice, not a claim that all controls must have the same dimensions. [21][22]

## Primary sources

1. Audacity, [Commands and Keyboard Shortcut Reference](https://manual.audacityteam.org/man/keyboard_shortcut_reference.html).
2. Ableton, [Arrangement View](https://www.ableton.com/en/manual/arrangement-view/).
3. Ableton, [Live Keyboard Shortcuts](https://www.ableton.com/en/manual/live-keyboard-shortcuts/).
4. Audacity, [Selecting Audio — the basics](https://manual.audacityteam.org/man/selecting_audio_the_basics.html).
5. Ableton, [Clip View](https://www.ableton.com/en/manual/clip-view/).
6. W3C, [Understanding SC 2.1.1: Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard).
7. Audacity, [Multi-view](https://manual.audacityteam.org/man/multi_view.html).
8. Ableton, [Audio Clips, Tempo, and Warping](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/).
9. Ableton, [Live Audio Effect Reference](https://www.ableton.com/en/manual/live-audio-effect-reference/).
10. GitHub, [Creating a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).
11. MDN, [FileReader](https://developer.mozilla.org/en-US/docs/Web/API/FileReader).
12. MDN, [File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).
13. MDN, [BaseAudioContext.decodeAudioData()](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData).
14. ffmpeg.wasm, [Overview](https://ffmpegwasm.netlify.app/docs/overview/).
15. ffmpeg.wasm, [Usage](https://ffmpegwasm.netlify.app/docs/getting-started/usage/).
16. MDN, [Codec selection](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection).
17. ffmpeg.wasm, [FAQ](https://ffmpegwasm.netlify.app/docs/faq/).
18. Audacity, [Amplify and Normalize](https://manual.audacityteam.org/man/amplify_and_normalize.html).
19. Audacity, [Normalize](https://manual.audacityteam.org/man/normalize.html).
20. Audacity, [Truncate Silence](https://manual.audacityteam.org/man/truncate_silence.html).
21. W3C, [Understanding SC 2.5.8: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum).
22. W3C, [Understanding SC 2.5.5: Target Size (Enhanced)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced).
23. SoundTouchJS, [core package README](https://github.com/cutterbl/SoundTouchJS/blob/master/packages/core/README.md).
24. ffmpeg.wasm, [Installation](https://ffmpegwasm.netlify.app/docs/getting-started/installation/).
