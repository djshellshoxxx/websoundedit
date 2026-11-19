# WebSoundEdit 1.0 beta continuation

## Owner directive and publication gate

The owner requested actual implementation, independent testing and audits, branch consolidation, GitHub Pages publication, a GitHub Releases **1.0 beta**, and an updated GitHub wiki. Begin the post-publication audit and feature implementation **after the existing 0.2 work has finished and been published**. The full accepted design is [BETA_1_0.md](../specs/BETA_1_0.md).

Observed on 19 November 2026 at approximately 02:00 America/Los_Angeles:

- [PR #1](https://github.com/djshellshoxxx/websoundedit/pull/1) is merged.
- Main is `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`.
- [Main workflow 44497716093](https://github.com/djshellshoxxx/websoundedit/actions/runs/44497716093) has a successful `verify` job (`135469070849`, completed 09:57:52 UTC) and a queued `deploy` job (`135481132343`). There were no pending deployment approval requests in the inspected API response.
- The public site returned HTTP 200, but still served the older build at this observation. HTTP 200 is not evidence that 0.2 deployed.
- The planning branch `codex/v1-beta-performance-20261119` was at `8ff03d29a8c71080bf412fd31ecc205c888f2d56`; its source tree differs from main only by the beta specification.
- A separate local checkout was prepared at `/workspace/scratch/6995f84af96b/websoundedit`, on `codex/beta-implementation-20261119`. The older checkout under `/workspace/scratch/e62f5b8c5a7f/websoundedit` was inspected without changes. Do not assume either transient checkout remains available; the remote branch and this handoff are authoritative.

**No beta implementation, completed formal baseline audit, 1.0 release, or wiki publication is claimed by this handoff.** Refresh the workflow and live asset evidence before progressing. An hourly conditional continuation has been configured in the owner's ChatGPT task named **WebSoundEdit 1.0 beta**, with the full implementation and release directive. It must stop itself once the verified release and wiki are published.

## Acceptance checklist

### Published baseline review

- [ ] Verify 0.2 Pages deployment and served assets.
- [ ] Run reproducible deterministic fuzzing.
- [ ] Run functional QA, including browser workflows and persistence/recovery.
- [ ] Complete an independent code audit.
- [ ] Investigate deep state, audio, parser and lifecycle bugs.
- [ ] Complete security and dependency review.
- [ ] Reproduce and fix every confirmed finding; record exact commits, commands, seeds and results.

### Guidance and options

- [ ] Hover and keyboard-focus tooltips for every action and dynamically created control, with concise purpose, units, scope and usage guidance.
- [ ] Tooltip toggle that preserves accessible labels.
- [ ] Unified Options covering themes, MIDI, audio input/output/system capture, channel layouts, shortcuts, macros and help.
- [ ] Accurate browser/device availability, permission failure and disconnect states.
- [ ] Extensive searchable help with real running-UI screenshots and measured arrows/callouts, including desktop and mobile.

### Tracks, selections and file workflows

- [ ] Visible selection zoom, zoom in/out and fit, preserving the selected samples.
- [ ] Direct undoable track removal that stops only the affected voices.
- [ ] Per-track editable session save and full-session save.
- [ ] Individual track, selection and mix export; all tracks as safely named stems in a ZIP.
- [ ] Clicked-track targeting independent of which track was previously selected.
- [ ] Actual mono/stereo/5.1/7.1 PCM, project, channel selection, DSP, render and WAV support.
- [ ] Separate export/project layout from monitoring hardware; explicit unsupported format/effect handling and monitoring fallback.

### Macro, scripting and API

- [ ] Unified discoverable semantic command registry covering existing and new editing, design, musical, transport and file operations.
- [ ] Visual action recording produces the same text script format used by typed scripts.
- [ ] Visual sequence builder with parameter editing, add/remove/reorder; preserve structured scripts without flattening them.
- [ ] Script save/load/export, validation, progress, cancellation and useful source locations in errors.
- [ ] Variables, assignment, arithmetic, comparisons, Boolean logic, if/else, repeat/for/while, command results and waits.
- [ ] Bounded parser/interpreter; no eval, Function, arbitrary function calls, prototype access, shell commands or ambient network/filesystem access.
- [ ] Full static preflight before mutation and dynamic argument validation during execution.
- [ ] Sequential isolated batch processing with per-file outcomes, cancellation, explicit continue-on-error and bounded output retention.
- [ ] Local shortcuts and deliberately armed on-import triggers; imported scripts/projects cannot arm triggers or acquire devices.
- [ ] Suppress recursive import triggers and duplicate recording of nested implementation calls.
- [ ] End-only silence trim, normalization, conversion and export example, preserving internal pauses.
- [ ] Audio-clock transport and musical parameter automation without repeatedly stopping playback or rendering entire source buffers.
- [ ] API parity and honest capability reporting in browser, CLI and local HTTP contexts.

### Compatibility, documentation and release

- [ ] Genuine REAPER `.rpp` plus relative WAV media export; safe ZIP packaging.
- [ ] Simple RPP import with explicitly supplied media, bounded token/block parsing and meaningful unsupported-feature reporting.
- [ ] Preserve supported timing, trims, names, constant mix, overlap sums, markers, fixed tempo and layouts.
- [ ] Native or independent exchange verification where available; distinguish internal round trips from native-app evidence.
- [ ] Preserve Audacity and WebSoundEdit native session compatibility.
- [ ] Update README, API, compatibility documentation and help for every new feature.
- [ ] Publish GitHub wiki Home, User Guide, Developer Guide and sidebar, retaining version-controlled source.
- [ ] Repeat all five audit/testing lanes against the final integration, including fuzzing immediately before publication.
- [ ] Merge completed branches only after exact-head required checks and independent review pass.
- [ ] Publish GitHub Pages and prerelease/tag `v1.0.0-beta.1`, with distributable assets, notes and checksums.
- [ ] Verify served version/assets, tag/commit, release assets/checksums and live wiki URLs.

The existing beta specification also includes previously discussed live input/loop layers, long recording and optional UDP companion work. Preserve that accepted context and reconcile it explicitly during implementation. Do not claim the whole specification is complete while required sections remain unfinished.

## Preliminary reproducible findings

These are **pre-publication discovery results**, not the requested completed post-publication audit. They were reproduced in the previous checkout at `a78dacf`, whose runtime source matches the main 0.2 tree. Recheck after publication and before fixing.

### P1: ordinary saved projects cannot reopen

`src/engine.js` uses a repeated-group base64 validation regex in its portable PCM decoder. A 30-second mono 48 kHz project saves successfully but loading it raises `RangeError: Maximum call stack size exceeded` in V8. The same happened at 60 seconds; 1-second and 10-second cases reopened.

```js
import { AudioEditor } from './src/engine.js';
const editor = new AudioEditor({ sampleRate: 48000 });
await editor.execute('audio.generate', { duration: 30 });
const project = await editor.execute('project.save');
await new AudioEditor().execute('project.load', { project });
```

Replace the recursive/repeated-group validation with bounded length/padding checks and linear character validation. Retain canonical base64 validation. Add realistic-size round trips and malformed late-character/padding cases.

### P2: generated clip names invalidate the app's own projects

`clip.duplicate` and `clip.split` append ` copy` and ` · B` to names that can already be 200 characters long. The saved project then fails to load with `Names must contain 1–200 characters.`

```js
const editor = new AudioEditor({ sampleRate: 8000 });
await editor.execute('clip.add', {
  name: 'x'.repeat(200),
  audio: { sampleRate: 8000, channels: [new Float32Array(8000).fill(0.1)] }
});
await editor.execute('clip.duplicate'); // Also reproduce separately with clip.split({at:0.5}).
const project = await editor.execute('project.save');
await new AudioEditor().execute('project.load', { project });
```

Reserve space for generated suffixes using a shared helper and inspect all generated names. Add save/reopen tests for the maximum valid source name.

### P2: explicit trim leaves inconsistent selected IDs

Trimming a nonselected clip using an explicit target updates the selection but leaves the selected track/clip pointing elsewhere.

```js
const editor = new AudioEditor({ sampleRate: 8000 });
const first = await editor.execute('audio.generate', { duration: 1, name: 'First' });
await editor.execute('audio.generate', { duration: 1, name: 'Second' });
await editor.execute('edit.trim', {
  target: { clipId: first.clipId, start: 0.25, end: 0.75 }
});
const state = editor.getState();
console.log(state.selectedClipId === state.selection.clipId); // false
```

Restore coherent target selection and verify PCM, placement and undo state.

### P2: MIDI export changes overlapping note durations

`encodeMidiFile` drops the source track identity and writes one format-0 track. Overlapping notes with the same channel and pitch on different source tracks can pair with different note-offs.

```js
const sequence = { version: 1, notes: [
  { note: 60, velocity: 100, channel: 0, track: 0, start: 0, duration: 2 },
  { note: 60, velocity: 80, channel: 0, track: 1, start: 1, duration: 0.5 }
] };
parseMidiFile(encodeMidiFile(sequence));
```

Observed durations after round trip were 1.5 seconds and 1 second, with both notes on track 0. Preserve track-separated events in format 1 or reject ambiguous unsupported overlaps instead of changing retained note timing silently.

### Security/resource candidate requiring further investigation

The local HTTP companion bounds individual request bodies but reads bodies before queuing work and has no aggregate queued-byte/job admission budget. Reproduce with small configurable limits and concurrent requests, not by exhausting a shared host. Check cancellation, aborted body reads, child-process cleanup and queue release on failure.

Read-only review found existing loopback Host/Origin checks, timing-safe bearer comparison, argument-array FFmpeg invocation, protocol/format restrictions, archive path/size validation and escaping at the inspected UI sites. No confirmed authentication bypass, arbitrary execution, filesystem escape or token leak was established. This limited observation is not a clean security audit.

### Executed existing tests

```sh
node --test tests/engine.test.js tests/dsp.test.js tests/wav.test.js tests/codecs.test.js
```

**43 passed, 0 failed, 0 skipped.** Those existing cases do not cover the four reproduced defects. No beta tests or fuzz cases are claimed as completed.

## Parallel implementation boundaries

1. **Macro core:** new `command-runtime.js`, `macro.js`, `macro-recorder.js` and focused unit/fuzz tests. Preserve current engine command names. Runtime descriptors include schema, capability, undo and recordability information. Record successful semantic operations once.
2. **Audio core:** new `channel-layout.js`, engine/DSP/WAV/rack channel changes and selection/render/serialization tests. Keep these coupled invariants under one worker's ownership.
3. **REAPER exchange:** new `reaper.js`, dedicated tests and compatibility documentation. Reuse existing bounded Audacity ZIP preflight carefully; never substitute unbounded decompression.
4. **UI/integration:** Options, tooltips, macro editor, file/export adapters, playback, channel visualization, help, browser tests and final integration. Assign live audio separately when an agent slot becomes free.

Important discovered constraints:

- Current `core('track.update')` and draft effect previews stop transport. Musical automation needs a live graph and an audio-clock scheduler, not repeated offline preview rendering.
- Current time/pitch buffers are explicitly stereo. Removing channel guards alone corrupts surround data; implement linked multichannel processing or return an explicit unsupported result.
- Current renderer and waveform lanes assume stereo. Layout selectors alone do not implement multichannel editing.
- Audacity export must explicitly reject unsupported surround after core validation expands.
- Cockos/WDL accepts double, single and backtick token delimiters without JavaScript backslash escaping. Do not use JSON string parsing as an RPP tokenizer.
- Native REAPER pan laws cannot be assumed identical. Verify supported native controls or bake documented static mix controls into media and use neutral native controls.
- Generated RPP passing the app's own importer is not native REAPER verification.

Primary references: [WDL line parser](https://github.com/justinfrankel/WDL/blob/main/WDL/lineparse.h), [WDL project context](https://github.com/justinfrankel/WDL/blob/main/WDL/projectcontext.cpp), [Web Audio specification](https://www.w3.org/TR/webaudio/).

## Next concrete action

Refresh the main Pages workflow. When deployment succeeds, verify live app and API assets against the built 0.2 source. Complete the formal baseline audit, fix the reproduced defects with regressions, and then begin the feature work under explicit file ownership. Keep this checklist and actual verification evidence current. Publication approval is already present in the owner's instruction; a new confirmation is unnecessary unless an actual protection or permission boundary requires it.
