# User Guide

This guide describes **1.0.0-beta.1**. Check the version displayed by the editor and consult the [verification record](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) for tested behavior and hardware limits.

[Home](Home) · [Developer Guide](Developer-Guide) · [Complete repository user guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/USER_GUIDE.md)

Focused guides: [Macros and Batch](Macros-and-Batch) · [Project Interoperability](Project-Interoperability) · [Troubleshooting](Troubleshooting).

## Start with a sample

Open the demo or choose **Import audio**. You can also drop supplied audio files into the editor. Each imported sound becomes editable PCM at the project's working sample rate. Compressed source files can therefore occupy considerably more memory after decoding.

Click a clip to work on it. Drag a region of its waveform to select a passage. Press Space to play/pause, Shift Space to audition the selection, and Ctrl/Command K to search all workbench actions. Keyboard shortcuts pause while you type in a text field.

Save a native project JSON when you want a portable copy of the current edit. It embeds the audio, so reopening that session does not require finding the original source files.

## Selection, editing and waveform space

Selection IN and OUT are seconds within one clip; a clip's placement is measured on the project timeline. Type exact bounds when a drag is too coarse. Choose **All channels**, a named speaker, or a supported custom channel selection. Edits to individual channels preserve the others; operations that change duration or channel count require all channels.

Cut, Copy, Paste, Delete, Trim and Split sit above the waveform. Trim keeps the selected interval. Moving or shortening a clip does not silently move neighboring clips. Undo/Redo restore the editable state within the bounded history.

**Selection** zoom changes the view without changing sample boundaries. **Fit** shows the full project. Collapse the entire **Shape the sound** inspector when you want more waveform width. Every track has its own Save/Export and close controls: the track action targets the clicked track even when another is selected.

For a tool such as gain, pitch, stretch, EQ or a fade:

1. Select its intended clip, interval and channels.
2. Change the tool parameters and wait for the processed preview.
3. Audition and use A/B to compare the original with the preview.
4. Apply to commit one undoable edit.

A selection preview is temporary and is not included in ordinary exports until applied. Pitch and stretch are independent controls; varispeed changes both pitch and duration. The current independent time/pitch processing supports mono and stereo. Normalization and limiting use sample peaks, without LUFS targeting or true-peak oversampling.

## Effects, stutter and XY

Open **Shape the sound → Effects** and add up to twelve stages. Available processors are echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter and bitcrusher. Duplicate instances are allowed.

Processing follows the displayed order from top to bottom. Drag a grip, use the move buttons, or focus a grip and use Up/Down/Home/End. Bypass preserves a stage's settings while skipping its processing. Each stage has its own wet/dry control: zero passes its incoming signal, one hundred percent uses its processed result, and intermediate positions blend them before the next stage.

For a stutter, select the passage, set the tempo and add **Stutter**. Slices per beat determines the repeated fragment, Gate controls its audible portion, and edge fade softens the joins. The first short slice repeats across the selected interval. Filter supplies low-pass, high-pass, band-pass and notch modes; Tape supplies drive, wow, flutter and warmth.

Echo, delay and reverb preserve the processed interval's duration. Include trailing silence when you need room for a tail beyond the original sound.

Assign X and Y to two continuous parameters, including wet/dry. They can belong to different stages or the same one. Drag the pad, use its keyboard controls, or map MIDI CC to its axes. Stable stage IDs preserve assignments when you reorder effects; removing a stage clears its missing XY target.

| Processing mode | What changes | How to retain the sound |
| --- | --- | --- |
| Selection | A draft preview for the selected clip or region | Apply, then save/export committed audio |
| Live | The running Master or selected track rack | Save its definitions, explicitly render live effects, or record the running program |

Live parameter controls preserve transport playback. Committed edits made during Live mode affect the next playback snapshot. Removing a track releases its voices; replacing a project stops owned live resources.

For a repeatable sweep, open **Live performance → Effect automation**. Choose a target, stage and numeric parameter; enter timeline points with `step` or `linear` curves and click **Set lane**. Live export evaluates those points at their actual timeline times, starting effect history empty at the render range. Use the recorder to preserve feedback/history already sounding during a performance.

## Keys, themes and guidance

**Detect key** analyzes the selected sample. **Sample keys** analyzes every sample and offers manual overrides. Written tonic/mode labels and confidence accompany the colors. Short, percussive, noisy or mixed-key material may produce an uncertain estimate; confidence is a heuristic.

Choose Studio, Daylight, Midnight or Terminal from the quick theme control or **Options → General & theme**. The waveform colors and surrounding interface follow that choice. Turn off hover/focus guidance globally in Options if you prefer; accessible labels and the full guide remain available.

Options and Help use addressable routes such as `#options/input` and `#help/effects`. Moving between them keeps the current session alive.

## Save, export and metadata

Choose scope and format separately in Export:

| Choice | Result |
| --- | --- |
| Full mix | Rendered project audio |
| One track | That track's audio or a one-track editable project |
| Selected clip / region | The chosen clip or selected interval |
| Stem ZIP | Independent, uniquely named track renders |
| Native session JSON | Current edited PCM, arrangement, metadata and saved workbench definitions |
| Audacity / REAPER project | The supported editable interchange subset |

Independent track/stem rendering includes gain/pan and ignores mute/solo unless requested. **Honor track mute** changes the mute behavior. Project-length alignment gives stems a common timeline start and end; otherwise each keeps its own extent from project zero.

**Raw / committed PCM without mix controls** bypasses track gain/pan while retaining applied sample edits. **Committed audio + mix controls** renders the current edit through the mixer. **Render current live effects** additionally prints the live racks and automation. The last choice does not reproduce an already-running delay's prior history.

Open **Metadata** to edit title, artist, album and other supported tags before exporting. Tags are stored in the session; the selected audio format determines which can be embedded. The dialog reports that format's support. Tags, track names and export filenames are separate values.

WAV supports 16/24-bit PCM and 32-bit float. Float WAV preserves sample headroom above full scale. Other formats depend on an available shipped browser encoder or an installed native encoder in the companion. Converting a lossy source into a lossless container does not restore discarded information.

## Audacity and REAPER

For Audacity, open supported `.aup3` projects, a legacy `.aup` with its `_data` files, or a corresponding ZIP. Export genuine AUP3 or a legacy project/data ZIP. Surround export defaults to rejection; explicitly choose speaker-labeled mono splitting when that is the desired exchange. It preserves channel audio and identity without claiming a native Audacity surround mixer.

For REAPER, supply a project/media ZIP or one loose `.rpp` with its referenced local files. References resolve only against the files you supplied. The importer reports missing or ambiguous media and does not fetch an embedded network URL or arbitrary machine path. Export packages genuine RPP text with its WAV media.

Plugins, automation, routing and other unsupported features have explicit compatibility limits. Read the [Audacity matrix](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/AUDACITY.md) and [REAPER matrix](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/REAPER.md). Keep native WebSoundEdit JSON when you need its effect drafts, MIDI mappings, key annotations and macro definitions to round-trip completely.

## Input, output and surround

Open **Options → Audio input**, choose a microphone/interface or system/tab audio, and press **Start input** to request access. Opening Options alone does not begin capture. Use zero-based physical input indices, such as `0, 1`, and select the available channels deliberately.

Monitoring defaults off. Input gain and monitor gain are separate. Echo cancellation, noise suppression and automatic gain are optional browser/device processing requests; their default is off for music. A display picker may provide no audio track, which the app reports without retaining an unused capture.

In **Audio output**, choose a supported output device and monitoring layout. Read the reported capability/fallback. Project render layout, input channels and physical output capability are distinct; choosing 7.1 does not add speakers to a stereo device.

| Layout | Channel order |
| --- | --- |
| Mono | M |
| Stereo | FL, FR |
| 5.1 | FL, FR, FC, LFE, BL, BR |
| 7.1 | FL, FR, FC, LFE, BL, BR, SL, SR |

For source files with unidentified surround channels, General Options offers an explicit 5.1/7.1 source-layout declaration. Keep Auto for ordinary imports. A declaration must match the known source; it does not convert channels. Saved device IDs are preferences and do not restore permission or active connections.

## MIDI controllers and pedals

Open **Options → MIDI & pedals**, connect MIDI and choose actual ports. Hardware access depends on browser Web MIDI support and explicit permission; MIDI-file import/export works separately.

Incoming note 60 plays the selected sample at original pitch. Other notes transpose it, and note-off releases the voice. Stop all notes clears owned voices and sends all-notes-off to the selected output.

For a knob, add a rack target, choose the parameter or XY axis, click **Learn next CC**, then move the controller. For a pedal/pad, select note or CC, channel, number, threshold, debounce and a command or saved macro. Enter its arguments, add the mapping and arm it locally. Press edges trigger actions; held values and release do not repeatedly fire. Imported action definitions remain disarmed.

MIDI files use supported format 0/1 PPQ timing and tempo maps. Import renders a simple sine instrument and retains source timing/velocity for later MIDI export. That export does not transcribe subsequent waveform edits or restore the original instrument plugin.

## Loop layers and long recordings

In **Live performance → Capture & loop layers**, choose acquired input, Master program or a specific track. Set the tempo, beat count and Immediate/Next beat/Next bar boundary. Capture completes at its sample-clock boundary and creates an editable track with an independent loop voice. **Stop & keep take** commits completed audio early; Cancel discards an unfinished take.

Choose **Input** for guitar or microphone layering when the first repeat needs the most direct transition. Input and individual-track captures switch to repetition on the audio clock. Master program captures the whole mix and can briefly delay the first audible repeat while changing the capture connection; the repeating phase stays aligned. Input/output device latency is separate.

Each layer has Play, Stop, Mute and Delete. Stop keeps its track; Delete removes it. Transport Stop stops loop voices too. Runtime-owned loop tracks are omitted from ordinary transport playback to avoid sounding twice.

The **Long recorder** writes bounded PCM chunks to the browser's OPFS archive. Choose a source/name and optional size/time bounds, then Start. Pause omits the paused wall-clock gap, Resume continues the take, and Stop retains the archive. Written and queued byte counters describe actual storage progress.

In **Recording archive**, recover interrupted takes, audition/import a bounded range, export, or explicitly delete an archive. Stop the current take before reading it. Active recording blocks archive reads/exports; pausing permits work with other completed archives.

Full export streams WAV/RF64 to a writable file where the browser supports the save picker. Otherwise choose a bounded export up to 64 MiB. Range audition/import remains limited by the editor's ten-minute/256 MiB budget. The configured archive ceiling is 24 hours and 512 GiB, further limited by real storage and sustained throughput; it is not evidence of a completed physical-duration test.

## Macros, visual steps and batches

Open **Macros → Record actions**, choose whether to retain elapsed timing, and start recording. Perform the edits, then finish recording and review the generated text. Successful semantic operations become commands. Visual steps support simple sequences with editable arguments and reorder controls. Programs with variables, loops or conditions remain intact in Script mode.

This macro cleans the selected whole clip and exports it. It deliberately clears any narrower selection first:

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: "cleaned-sample"});
```

For **Batch files**, save a macro, supply inputs, choose the error policy and run. A macro without a `file.import` call receives an automatically imported file. Use `input.stem` as the export name to retain each supplied filename stem. Each file starts with a fresh project; the wrapper restores the original session after completion, error or cancellation.

While the browser batch owns the project, outside editing, imports, exports and MIDI controls receive `BUSY`. Status, Help and the persistent Stop batch control remain available through restoration. Earlier commands must finish before batch admission. Ordinary Run macros remain interactive. Use semantic commands such as `effect.gain` and `file.export` in batches rather than UI action wrappers.

Saved shortcuts and after-import triggers require local enablement. Importing definitions never arms them, and macro/batch imports suppress the import hook to prevent recursion. See the [macro guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md) for batches, variables, loops, cancellation and automation examples.

## Optional companion streaming

The Pages app is static; it does not provide a public REST processor or raw UDP socket. The optional local companion supplies authenticated HTTP and configured UDP destinations.

Start the companion, then explicitly connect in **Options → Streaming companion** using its loopback endpoint and current token. Start input separately. Choose an advertised destination and profile, then broadcast. Tokens remain in memory and outside saved projects/macros. The browser may require local-network access.

Destinations are configured by the companion operator; a script cannot introduce an arbitrary URL or encoder command. Encoded profiles depend on installed native FFmpeg support. See [companion setup and receiver formats](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/COMPANION.md).

## Recovery and current limits

Save native sessions and export archives for copies independent of browser storage. **Options → Help & recovery → Clear recovery copy** removes the editor recovery record while keeping the current project open. It does not delete long-recording archives.

| Area | Current contract |
| --- | --- |
| Editable timeline and decoded PCM | Ten minutes; 256 MiB |
| Arrangement | 64 tracks; 512 clips |
| Effects rack | Twelve stages per rack |
| Browser batch | 128 supplied aliases; 128 MiB collected output |
| MIDI file | 4 MiB; 10,000 notes; normal timeline bounds |
| Long recording | OPFS, AudioWorklet, bounded queues and actual storage quota |

Undo covers resident editing state, not completed file downloads, MIDI output or network broadcasts. Native-format support, physical MIDI/device behavior and long-duration recording evidence are separate topics in the [verification record](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md).

## Illustrated workflow index

These illustrations come from the running application. Numbered callouts point to the controls described in each workflow. Open in-app Help to view the images with their full chapter instructions.

| Workflow | Illustration |
| --- | --- |
| Desktop navigation | [Editor](https://djshellshoxxx.github.io/websoundedit/help/guide-editor-desktop.png) |
| Mobile waveform space | [Collapsed mobile editor](https://djshellshoxxx.github.io/websoundedit/help/guide-editor-mobile.png) |
| Selection and preview | [Editing a selected interval](https://djshellshoxxx.github.io/websoundedit/help/guide-selection-editing.png) |
| Ordered effects and XY | [Effects rack](https://djshellshoxxx.github.io/websoundedit/help/guide-effects-desktop.png) |
| Repeatable effect movement | [Automation lane](https://djshellshoxxx.github.io/websoundedit/help/guide-effect-automation.png) |
| Key labels and overrides | [Sample keys](https://djshellshoxxx.github.io/websoundedit/help/guide-sample-keys.png) |
| Export sound and scope | [Export options](https://djshellshoxxx.github.io/websoundedit/help/guide-export-metadata.png) |
| Editable file tags | [Metadata editor](https://djshellshoxxx.github.io/websoundedit/help/guide-metadata-editor.png) |
| Audacity and REAPER | [Project exchange](https://djshellshoxxx.github.io/websoundedit/help/guide-project-compatibility.png) |
| Input and monitoring | [Input Options](https://djshellshoxxx.github.io/websoundedit/help/guide-input-options.png) |
| Actual output capability | [Output Options](https://djshellshoxxx.github.io/websoundedit/help/guide-output-options.png) |
| Speaker order | [Channel layouts](https://djshellshoxxx.github.io/websoundedit/help/guide-channel-layout.png) |
| Controller actions | [MIDI pedals](https://djshellshoxxx.github.io/websoundedit/help/guide-midi-pedals.png) |
| Independent live takes | [Loop layers](https://djshellshoxxx.github.io/websoundedit/help/guide-live-layers.png) |
| Disk-backed capture | [Long recorder](https://djshellshoxxx.github.io/websoundedit/help/guide-long-recorder.png) |
| Structured scripts | [Macro editor](https://djshellshoxxx.github.io/websoundedit/help/guide-macros-desktop.png) |
| Captured editing actions | [Action recorder](https://djshellshoxxx.github.io/websoundedit/help/guide-macro-recording.png) |
| Editable ordered commands | [Visual macro steps](https://djshellshoxxx.github.io/websoundedit/help/guide-macro-visual-steps.png) |
| Supplied-file processing | [Batch preparation](https://djshellshoxxx.github.io/websoundedit/help/guide-batch-preparation.png) |
| Optional UDP integration | [Companion connection](https://djshellshoxxx.github.io/websoundedit/help/guide-companion-streaming.png) |
| Theme and tooltip preference | [Mobile Options](https://djshellshoxxx.github.io/websoundedit/help/guide-options-mobile.png) |
| Local recovery controls | [Help and recovery](https://djshellshoxxx.github.io/websoundedit/help/guide-recovery-controls.png) |
