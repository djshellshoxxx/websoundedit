# WebSoundEdit 1.0 beta — User Guide

[Open the editor](https://djshellshoxxx.github.io/websoundedit/) · [Illustrated in-app guide](https://djshellshoxxx.github.io/websoundedit/#help/navigation) · [[Home]] · [[Macros and Batch]]

## 1. Workbench and selection

The arrangement has tracks with clip waveforms and a separate sound-tools inspector. Choose **Hide sound tools** to increase waveform space. Import audio from a local file or use the generated demo. A clip may be offset on the project timeline, while its selection IN/OUT values are relative to the clip.

Select a clip, then drag a waveform range. Double-click selects the whole clip; numeric IN/OUT fields refine the sample boundaries. **Selection zoom** fits the chosen range without modifying either selected samples or committed audio. Zoom in/out changes display scale; Fit restores the broader view. A channel selector permits all channels, a named speaker or an explicit index set. Length-changing effects require aligned channels.

Alt-drag moves a clip. Track gain, pan, mute and solo alter arrangement rendering; overlapping clips mix. Track close/remove is undoable and releases only that track's active voices. Undo and Redo apply to editor state, not previously downloaded files or external stream packets.

## 2. Audition and commit

Open **Shape the sound**. Gain, pitch shift, speed, time stretch, fades, EQ and other operations can generate a temporary processed preview. **Audition** listens to it; **A/B** contrasts preview and original; **Apply** commits an undoable change. Spectrum and processed waveform views come from PCM results, not a decorative filter drawing.

**Trim quiet ends** removes qualifying leading and trailing silence while preserving quiet passages in the middle. **Remove silence** is a separate operation that may remove qualifying interior sections. Threshold is in dB; minimum duration and padding control detection. Sample-peak normalization is not LUFS normalization or oversampled true-peak limiting.

## 3. Ordered effects and XY

Use Effects to add echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter or bitcrusher. The rack supports twelve stages, each with bypass and wet/dry. Order matters; a later stage receives the previous stage's blend. Reorder by drag handle or keyboard, retaining stable IDs for automation.

The XY pad maps one continuous parameter to X and another to Y, potentially from different stages. MIDI continuous controllers can map to parameters. **Selection** mode previews or commits processed PCM. **Live** mode changes a master/track rack during playback on the audio clock; it is not an automatic destructive edit. Reverb/delay tails outside the chosen export range are not silently extended.

## 4. Files, individual tracks, stems and sessions

Save the **full native editable session** to preserve project data. Save a **single-track native session** to work on one track independently. Individual track export targets the clicked track, regardless of another previous selection; the available scopes include clip, selection, track and full mix. **Export all stems** creates a safely named ZIP containing separately rendered tracks, with alignment/range choices described by the export controls.

Compressed codec availability differs between browser and Node environments. Inspect capabilities and actual export labels. Audacity and REAPER exports are separate native interchange formats with documented constraints—see [[Project Interoperability]]. Existing native JSON remains the most complete editable WebSoundEdit session format.

## 5. Options, themes and tooltips

Open **Options** for Studio, Daylight, Midnight or Terminal themes; guidance toggle; keyboard shortcuts; project/output layouts; input/output devices; MIDI and pedals; macro triggers; recorder storage; companion settings; help and recovery. Every discoverable control has hover/focus guidance including purpose and relevant units. Disabling visual tips does not remove accessible labels or help.

Microphone and interface capture use browser permissions. System audio is available only if the browser/display-sharing picker actually supplies an audio track. Device selection cannot override browser or operating-system restrictions. Input gain, selected physical channel indices and monitoring are independent settings. Monitoring defaults off to avoid feedback. Permission failures/disconnects should remain visible.

## 6. Mono, stereo, 5.1 and 7.1

A file's sample layout, the project's render layout and the actual output device are three separate concepts. Known surround speaker order is FL/FR/FC/LFE/BL/BR for 5.1 and FL/FR/FC/LFE/BL/BR/SL/SR for 7.1. The editor uses explicit conversion matrices and WAVEFORMATEXTENSIBLE masks for surround WAV. Monitoring may downmix to an available device; LFE is omitted by default from downmix.

When importing a maskless surround WAV, choose an explicit source speaker layout in Options instead of relying on Auto. An unsupported channel/layout/effect/codec combination must produce a clear error, never silently discard audio channels. Pitch-preserving time/pitch transformations are currently mono/stereo only.

## 7. MIDI, recording and live loops

Select MIDI inputs/outputs, map note triggers or CC controllers, and optionally configure a pedal command. Review the mapping, threshold and debounce; **Arm** locally to permit MIDI-triggered editing or capture. Note-off/release should not double-trigger an action. Imported project settings do not arm a pedal or acquire hardware.

**Live performance** can receive audio from an approved microphone/interface or supported system capture, process a live rack, and create loop layers with buttons or MIDI pedals. Each completed loop becomes an editable track; its voice can be played, muted, stopped or removed independently. Transport and music automation follow a shared audio clock.

The long recorder writes chunks to a disk-backed archive rather than allocating an unbounded browser waveform. Pause omits gaps; manifest recovery and range audition/import are available. Use streamed WAV/RF64 export for a long recording. A recovered partial file may exist after quota or backpressure failure; inspect actual disk-space and queue indicators before capture.

## 8. Shortcuts, macros, help

Press **Ctrl K** (Command K on macOS) to find registered actions. Configure shortcuts in Options. Macros can record actions into a text script, run typed logic, map shortcuts and process a batch sequentially; they do not embed audio or credentials. See [[Macros and Batch]] for examples, permissions, cancellation and the safety model.

The **[illustrated help chapters](https://djshellshoxxx.github.io/websoundedit/#help/navigation)** explain selection, tools, MIDI, routing, loops, projects, macros and recovery using captures of the running UI. If a build's screenshot is absent, do not treat a future screenshot plan as already published.
