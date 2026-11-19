# WebSoundEdit 1.0 beta specification

Status: specification before implementation. Target version: `1.0.0-beta.1`.

## Release sequence

1. Finish the already-approved 0.2 Pages release at `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72` and verify the live site.
2. Audit that published baseline: deterministic fuzzing, functional QA/QC, code review, bug investigation, dependency audit, and security review. Record reproducible findings and fix confirmed defects.
3. Implement the requirements below against this specification, with additive APIs and regression tests. Update the specification explicitly if evidence requires a changed contract.
4. Audit and fuzz the new code, including the complete macro and HTTP command surfaces. Resolve release-blocking findings and record actual evidence and remaining capability limits.
5. Merge the verified source, publish GitHub Pages, verify the live build, and create the GitHub prerelease/tag `v1.0.0-beta.1` with release notes, distributable files and checksums.

Planning may occur while the 0.2 deployment is queued. Baseline audits and feature implementation begin after its publication. A successful pull-request build is not publication.

## Product goals

Keep one approachable workbench for sample editing, track export and live performance. Add discoverable guidance, a unified options surface, accessible track/selection controls, reproducible text macros, batch processing, live input/loop layers, long recording, surround layouts and REAPER exchange. Every new user operation must also have a discoverable API command and macro equivalent. Retain existing selection/channel isolation, actual PCM effects, bounded undo, native JSON sessions, Audacity exchange and static hosting.

The browser remains local-first: files and recordings stay on the device unless the user explicitly starts the configured local streaming companion. Device permissions and active networking are never restored or started by importing a project, macro or settings file.

## 1. Options and guidance

### Unified options

Provide an addressable in-app Options view (`#options` and section routes), with Back/Close and browser-history behavior that preserves the active project. Give help stable chapter routes. Options has clear sections for general behavior, input, output, channel layout, MIDI, shortcuts/macros, streaming and help. It must expose:

- Tooltip enable/disable, current theme, and existing keyboard shortcuts.
- Available microphone/audio-interface inputs, channel selection, browser capture-processing constraints, input monitoring and input gain.
- System/tab audio capture when the browser supplies audio through display capture. Explain an unavailable audio track and close all acquired audio/video tracks on failure or stop.
- Available output devices and actual channel capability. Unsupported output-selection APIs receive an explicit unavailable state.
- Mono, stereo, 5.1 and 7.1 project/output layouts; separate project layout from actual monitoring hardware.
- All existing MIDI connection, input/output, CC mapping, note triggering, file import/export and panic controls, plus command/pedal mappings.
- Macro shortcut and on-import trigger configuration, recorder/storage status, companion connection and streaming destination/profile choices.
- A prominent link to the extensive illustrated help section.

Persist preferences, never live permission grants, active microphone/recording/streaming state, connection tokens, or armed imported macro triggers. Device changes, permission denial, disappearance and disconnect must leave an accurate visible state.

### Tooltips

Every feature/action/control receives concise usage guidance on hover and keyboard focus. Include effect parameter purpose, units/range, wet/dry, selection scope, destructive/undo behavior where relevant, and links to help chapters. Escape dismisses guidance. Turning tips off removes tooltip presentation without removing accessible names or labels. Dynamically created effect/track/macro controls are included.

### Illustrated help

Create searchable, linked chapters covering navigation, tracks/selections/zoom, editing, effects/XY, key colors, metadata/export, MIDI, surround/routing, recording, live looping, automation/macros/batches, companion UDP, project compatibility and recovery. Use screenshots of the actual running beta with measured arrow/callout annotations, not invented UI images. Show useful desktop and mobile contexts. Each registered command category has an explanation and examples; syntax help describes errors, cancellation and limits.

## 2. Selection, tracks and export

- Add visible zoom-to-selection, zoom in/out and fit controls; keep keyboard equivalents. Selection zoom must not change the selected samples.
- Add direct close/remove controls for each track; removal remains undoable and releases that track's active loop/voice.
- Provide direct track save/export controls targeting the clicked track, without accidentally exporting another selected track.
- Save one track as a native editable session, all tracks as the full session, export one track/selection/mix, or export all tracks as a ZIP of individually named stems. Use collision-free safe filenames and explicit dry/committed versus live-render behavior.
- Preserve existing whole-project and Audacity workflows. Never label JSON as a native DAW file.

Concrete I/O uses `file.import`, `file.export` and `file.exportStems`; modal navigation uses `ui.*` names. `project.saveTrack({trackId})` returns a sanitized single-track native session, retaining valid selections and filtering clip-keyed MIDI/live references. Independent track renders can explicitly set `respectMute:false` and `respectSolo:false`; their gain/pan and selected output layout still apply. Existing render defaults stay compatible. Expose `view.zoomSelection`, `view.zoom` and `view.fit` as semantic commands.

## 3. Unified command API

Keep existing engine command names. A new `CommandRuntime` combines engine, browser/workbench, live audio and companion adapters. Each command descriptor has a canonical `method` (also exposed as `id`), label/category, description, parameter schema, return description, recordable/undoable flags and capability requirements.

```js
const runtime = new CommandRuntime({ coreExecute, coreCommands, getState, adapters });
runtime.register(descriptor, handler);
runtime.commands();
await runtime.execute(method, params, { origin: 'ui', signal });
const unsubscribe = runtime.subscribe(event => {});
```

Successful semantic events include method, normalized parameters, origin, context and result. Nested implementation calls must not be recorded twice. Queries, repeated preview-pointer noise and recorder controls are excluded from action recording. Imported binary inputs are referenced through explicit supplied input aliases; scripts do not embed entire PCM buffers or acquire arbitrary filesystem/network access.

Use the same operations from UI buttons, keyboard shortcuts, MIDI triggers, recorded macros, typed scripts and applicable local HTTP calls. Browser-only capabilities return a structured unsupported/permission-required result in headless use. Include public API exports and examples, and retain existing API compatibility.

## 4. Text macros and batch jobs

### Language

`.wsemacro` is UTF-8 text, with a version comment and a defined grammar. Implement a parser/interpreter; do not use `eval`, `Function`, ambient JavaScript objects or shell execution.

Support sequential command calls with object arguments, variables and assignment, bounded arrays/objects, arithmetic, comparisons, Boolean logic, `if`/`else`, `repeat`, `for ... of`, `while`, and explicit waits. Allow safe own-property/index reads from supplied values and command results; forbid prototype traversal and arbitrary function invocation.

```js
// WebSoundEdit Macro 1
for (file of inputs) {
  file.import({ input: file, replace: true });
  effect.trimSilence({ thresholdDb: -48, minDuration: 0.05, padding: 0.01 });
  effect.normalize({ targetDb: -1 });
  file.export({ scope: 'track', format: 'flac', name: file.stem });
}
```

`effect.trimSilence` trims the two ends only and preserves internal pauses; existing remove-silence behavior stays available separately. All-silent input remains unchanged with an explanatory result.

### Compiler/runtime contract

`src/macro.js` exports `parseMacro(text)`, `validateMacro(ast, catalog)`, `formatMacro(ast)`, `stepsToMacro(steps)` and `MacroRunner`. The runner accepts `execute`, `getCommands` and `getContext`, runs with variables/AbortSignal/events/limits, and supports cancellation. Errors identify line/column, command and completed step count without exposing secrets.

Preflight syntax, command names, capabilities and statically known arguments before mutation; validate dynamic arguments at execution. Bound source bytes, tokens, nesting, AST nodes, strings/collections, command count, loop iterations, queued jobs and execution time. Cooperative yields and abort checks prevent an infinite loop from locking the UI. Commands remain atomic; already completed exports, capture or network effects are not falsely described as rolled back.

### Recording and visual editing

Record successful semantic actions into the same canonical text format used by typed scripts. Show ordered editable steps for simple call sequences, with parameter editing, add/remove/reorder, and text view. Preserve structured logic programs as scripts; never silently flatten loops/conditions into a different program. Save/load/export scripts, validate before running, expose progress, errors and Stop.

An optional **Record timing** mode inserts explicit waits between semantic actions. Ordinary editing-mode recording omits thinking time. Name the control **Record actions** to distinguish it from audio recording. Smooth repeatable effect sweeps use audio-clock automation points rather than relying on UI-event timing.

Support explicit local shortcut assignments and an optional locally armed on-import macro. Imported projects/scripts may supply definitions but cannot arm triggers. Suppress recursive on-import triggers during macro/batch imports. Batch jobs process supplied inputs sequentially in isolated/cleared editor state, report per-file results, and support cancel and a deliberate continue-on-error setting. Output collection has a size limit or streaming destination.

### Musical automation

Expose transport play/pause/stop/seek/loop, beat/time waits, live rack parameters and automation lanes. A script can loop a track while changing wet/dry on the audio clock. Automation supports step and linear points, bounded time/value ranges and stable effect IDs. Changing live controls must not stop transport or repeatedly render the entire source buffer.

## 5. Multichannel audio

Extend PCM with optional layout metadata and project `outputLayout`. Infer old mono/stereo data. Support 1, 2, 6 and 8 channels throughout validation, engine serialization, selection, DSP, analysis, rendering, WAV and playback plans.

| Layout | Canonical channel order | WAVE speaker mask |
| --- | --- | --- |
| Mono | M | `0x4` when explicit |
| Stereo | FL, FR | `0x3` when explicit |
| 5.1 | FL, FR, FC, LFE, BL, BR | `0x3f` |
| 7.1 | FL, FR, FC, LFE, BL, BR, SL, SR | `0x63f` |

Centralize speaker labels and conversion matrices in `channel-layout.js`. Honor recognized masks and reorder explicitly when supported. Ambiguous surround sources require an explicit layout choice. Surround WAV uses WAVEFORMATEXTENSIBLE. Selection accepts all channels or index arrays, retaining left/right aliases. No effect/codec may silently discard surround channels; unsupported codec/layout combinations must be reported.

Keep mono equal-power front L/R panning. For multichannel pan, adjust the front pair and retain other-channel gain. Use an explicit monitoring downmix, excluding LFE by default. File channels and project layout do not prove that an output device can reproduce surround; show actual destination capability and offer a clear monitoring fallback.

## 6. Shared real-time audio and live loops

### Routing

`LiveAudioRuntime({ engine, playback })` shares one lazily unlocked AudioContext with ordinary transport, loop voices and MIDI samples. The program route is track source → track rack → master rack → recording tap → monitoring conversion → selected output. Metronome is monitoring-only. `Playback.setAudioRoute(...)` and `playPlan(...)` retain the existing selection-preview `play(audio, options)` API.

Implement persistent stateful DSP in an AudioWorklet: delay/reverb memory, modulation phase, filters, tape/stutter/bit reduction and wet/bypass/order must continue across blocks. Validate parameters using the rack catalogue. Use audio-clock automation and avoid blocking or unbounded allocation in processing callbacks.

Initial runtime-wide limits are 64 MiB DSP state/scratch, 65 rack graphs including master, 128 total stages with at most 12 per rack, 128 active program/loop/MIDI voices and 8,192 queued automation events. Validate actual sample-rate/channel memory estimates before allocating a candidate graph. Excessive graph requests fail atomically, preserving active playback; unchanged stable effect IDs retain state when reordered. Publish the actual limits in capabilities and test CPU behavior without promising hardware-independent latency.

`audio.playbackPlan` supplies independent track sources. Runtime-owned loops are excluded from the ordinary plan, preventing duplicate voices. Project replacement/dispose stops input, loops, notes and stale callbacks; track removal releases only the affected voices. MIDI sampler output joins the shared master.

### Live command groups

- Devices: `audio.capabilities`, `audio.devices.list`, `audio.input.start/stop`, `audio.output.set`, `audio.monitor.set`.
- Transport: `transport.play/pause/stop/seek/set` with loop, BPM and timeline settings.
- Effects: `live.rack.set`, `live.param.set`, `automation.set/clear` for master or a track.
- Capture: `loop.capture.start/stop/cancel` and a semantic capture toggle.
- Layers: `loop.track.list/play/stop/mute/remove`.

`live.render` snapshots live racks and automation and uses the same DSP kernel offline for an explicit scope/range/layout. Automation retains timeline-relative timing; delay/filter history starts empty at the requested range start, and there is no implicit tail extension. The recorder is the way to capture current running feedback/tails. Export labels distinguish committed audio from this live-settings render. Stem exports can use a common project-length range for alignment.

Input supports a microphone/audio interface or display-provided system audio. Acquisition and audio unlock require explicit user gestures when the browser requires them. Monitoring defaults off. Loop capture uses sample-clock beat/bar quantization or immediate boundaries, bounded PCM and clear armed/recording/playing state. Every completed loop creates a new editable track; one loop voice starts at the correct boundary. Users can layer guitar input with a button or MIDI pedal and independently mute, stop or delete each layer.

MIDI action mappings use edge detection/debounce so note-off or pedal release cannot double-trigger capture. Mapping any registered action or saved macro is supported; panic/stop releases active notes and capture safely.

## 7. Long recordings

The resident waveform editor remains bounded at 256 MiB decoded PCM and a ten-minute timeline. Long DJ-set capture is a separate disk-backed recording archive with bounded range audition/import, not a higher unbounded RAM cap.

`recording-store.js`, a capture worklet and a dedicated storage worker persist bounded chunks and recoverable manifests to OPFS. Expose elapsed time, actual format/channels, written bytes, queued bytes, quota estimate and explicit errors. Pause omits wall-clock gaps. Backpressure or quota failure stops with a recoverable partial file, never silently drops audio or grows memory indefinitely.

Commands: `recorder.start/pause/resume/stop`, `recordings.list/recover/export/importRange/auditionRange/delete`. Export streams to a chosen file when available; use RF64 or explicit segmented WAV when RIFF limits would be exceeded. Recovery scans only owned manifests. Range actions read only their requested section. Permission refusal, tab interruption, output failure and exhausted quota are tested. Never claim an accelerated test is an actual multi-hour hardware recording.

## 8. UDP streaming companion

GitHub Pages cannot open raw UDP sockets. Extend the opt-in Node companion with authenticated live PCM ingest and configured UDP output profiles. UI/options/API/macros call the same `stream.start/stop/status` commands through the local bridge.

The live runtime provides a bounded input subscription with interleaved float chunks, sequence, sample rate/layout/channels, frame count and discontinuity data. Slow consumers receive an explicit discontinuity/failure, not an unbounded queue.

The companion binds loopback only, retains exact Host/Origin validation and a per-run Bearer token, and accepts named destinations configured by its operator. Scripts cannot choose arbitrary filesystem paths, network URLs or FFmpeg command strings. Start requires explicit connection/arming; imported data cannot auto-start broadcasting. Keep credentials in memory only and out of logs, URLs, project files and macros.

Provide capability-advertised stream profiles for supported PCM/compressed formats (for example PCM, Opus, MP3, AAC/MPEG-TS and FLAC where the local encoder supports them), with typed bitrate/rate/channel settings. Validate format/codec choices against a safe streamable registry, invoke FFmpeg with argument arrays and no shell, bound child-process/chunk queues, report errors/discontinuities, and terminate owned encoders cleanly. Unsupported combinations receive an actionable error; do not promise arbitrary codecs installed nowhere.

## 9. REAPER and Audacity exchange

`importReaper(bytes, { name, files, decodeMedia })` and `exportReaper(portableProject, { format: 'zip' })` return the existing `{ project,warnings }` or `{ bytes,mime,ext,warnings }` shapes. Export a genuine `.rpp` plus relative `media/*.wav`, instructions and supported metadata. Loose RPP import requires explicitly supplied media; never read a referenced host path or URL implicitly.

Use Cockos/WDL token quoting and nested block grammar, with preparse text/line/token/depth/record limits. Preserve supported PCM, names, positions, visible trims, one active take, constant mix, overlap sums, markers and fixed tempo. Support canonical multichannel media. Reject unsupported active plugins, automation, complex routing/folders, comping, source modes or time/pitch transforms instead of changing their sound silently. Explain stem rendering as a compatible route.

Treat RPP source references separately from archive entry paths. An exact alias in the caller's explicitly supplied media map may satisfy an absolute source reference without accessing that path. A unique uploaded basename may be remapped with a clear notice; ambiguous names fail. ZIP entry paths remain relative and bounded, and no project reference initiates host-filesystem or network access.

Keep Audacity's genuine mono/stereo exchange. Surround defaults to a clear rejection, with explicit `multichannel: 'split-mono'` channel-stem export. This preserves individual channel PCM/identity; it is not an Audacity surround mixer. Retain the legacy Audacity 3.4.2 project-rate instruction and all existing recovery/schema/ZIP/XML guards.

Native acceptance uses an official pinned REAPER binary/checksum, an independently created fixture, full native render comparison and native save/reimport. Pre-FX accessor checks alone do not establish the audible mix. Preserve the current real Audacity gate.

## 10. Audit, fuzzing and quality gates

Record findings with severity, file/location, reproduction, effect, fix and regression test. Distinguish observed defects, mitigated risks, unsupported capabilities and untested hardware. Do not claim that passing tests prove the absence of all bugs.

| Area | Required evidence |
| --- | --- |
| Published 0.2 baseline | Post-publication QA, code/security review and deterministic fuzz run; fixes for confirmed defects |
| Macros | Grammar/roundtrip/semantic tests; random and structured mutation fuzz; infinite-loop, depth, huge input, cancellation, prototype/injection and resource-limit cases |
| Engine/API | Valid/invalid stateful command fuzz, atomic rejection, channel/selection/history invariants, HTTP auth/Host/Origin/body/queue limits |
| UDP bridge | Local deterministic receiver/encoder tests, capability validation, sequencing/backpressure/stop cleanup, no arbitrary command/path/target execution |
| Audio | 1/2/6/8-channel impulses and matrix checks, exact zero-wet/bypass, streaming state continuity, automation timing and bounded capture |
| Long recording | Bounded queued memory, durable chunk/manifests, recovery/quota/interruption cases, large-file header/streaming checks and range-only reads |
| Files | RPP/AUP3/AUP/WAV/MIDI malformed/oversized/truncated/archive/path fuzz, native REAPER and Audacity render/save/reimport |
| UI QA | Desktop/mobile, keyboard/focus/tooltips-off, options persistence, recorded/typed macros, batch progress/cancel, track export/close, selection zoom, loop controls |
| Security | Trust-boundary review, dependency audit with exact lockfile, escaping/XSS, no ambient script execution or secrets in artifacts, safe process/filesystem lifecycle |
| QC/release | Build/API verification, screenshots visually reviewed, exact remote/source tree match, all required CI gates green, deployed version/assets checked, prerelease assets/checksums verified |

Fuzz corpora and seeds are reproducible. Report actual executed case counts, versions, failing seeds and fixes. Device-free tests use synthetic/fake input and MIDI mocks and are labeled accordingly. Actual guitar/pedal latency, surround hardware and multi-hour physical capture require that hardware; do not substitute an unsupported claim.

## Primary implementation references

- [Chrome Direct Sockets and Isolated Web Apps](https://developer.chrome.com/docs/iwa/direct-sockets)
- [Node UDP datagram sockets](https://nodejs.org/docs/latest-v24.x/api/dgram.html)
- [Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [Worker-only synchronous file access](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
- [Cockos/WDL project parser](https://github.com/justinfrankel/WDL/blob/main/WDL/projectcontext.cpp)
- [Cockos/WDL token lexer](https://github.com/justinfrankel/WDL/blob/main/WDL/lineparse.h)
- [REAPER ReaScript API](https://www.reaper.fm/sdk/reascript/reascripthelp.html)
- [Audacity compatibility and primary format references](../AUDACITY.md)
