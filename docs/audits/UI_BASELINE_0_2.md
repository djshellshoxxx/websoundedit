# Published 0.2 UI and MIDI baseline audit

Date: 19 November 2026. Runtime under review: published `0.2.0`, release commit `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`. The root agent confirmed the live BETA 0.2 badge, three demo tracks and exact `app-75ZGK-o6.js` asset before this audit began. The local planning checkout was `cbf5175119f61c34beed0fd06bb713bc2396c994`; beta runtime implementation had not started.

Status: baseline observations recorded; **runtime fixes are pending the coordinated fix stage**. New failing regressions remain active. This report does not claim that all UI behavior has been exercised after publication.

## Executed evidence

Runtime: Node `v24.22.3`.

```sh
node --test tests/midi.test.js tests/midi-baseline.test.js tests/rack-config.test.js
node --test tests/ui-baseline.test.js
node --check tests/ui-baseline.spec.js
```

| Check | Actual result |
| --- | --- |
| Existing MIDI/rack tests plus new MIDI audit regressions | 17 tests: 16 passed, 1 failed; no skips/todos |
| Pending microphone permission / teardown regression | 1 test executed and failed |
| New browser regression file syntax | Passed |
| Fresh browser execution | Pending CI; no local browser attempt was made |

The two failures reproduce the confirmed defects below. They are not hidden behind skipped/todo tests.

### Deterministic fuzz cases

`tests/midi-baseline.test.js` contains bounded generators and mutations, with their seeds in source. It ran **8,192 cases**:

| Family | Seed | Cases | Result |
| --- | --- | ---: | --- |
| SMF valid inputs, truncation, mutated bytes and corrupt declared chunk lengths | `0x20b37a11` | 4,096 | 1,135 parsed to finite, bounded notes; 2,961 rejected with controlled errors; no invariant failures |
| MIDI mapping validation and caller immutability | `0x20b37a12` | 2,048 | 1,024 valid configurations accepted; 1,024 invalid configurations rejected; caller data preserved |
| Rack settings validation and caller immutability | Same deterministic generator as mappings | 2,048 | 1,024 valid configurations accepted; 1,024 invalid configurations rejected; caller data preserved |

The fuzz inputs remain small; the audit does not attempt to exhaust host memory. Parser acceptance is checked for note count, channel/track bounds, finite positive timing and the ten-minute limit. This bounded campaign does not establish correctness for every legal MIDI file or arbitrary malformed input.

## Confirmed findings

### UI-MIDI-001 — P2: export changes overlapping note durations across source tracks

Location: `src/midi.js`, `validateMidiSequence()` and `encodeMidiFile()`.

The validator drops each note's source track, and the writer emits one format-0 track. Two overlapping notes sharing pitch/channel but belonging to separate source tracks then pair with different note-offs when imported again.

Reproduction, executed after publication:

```js
const notes = [
  { note: 60, velocity: 100, channel: 0, track: 0, start: 0, duration: 2 },
  { note: 60, velocity: 80, channel: 0, track: 1, start: 1, duration: 0.5 },
];
parseMidiFile(encodeMidiFile({ version: 1, notes }));
```

Expected durations: `2` and `0.5` seconds on tracks 0 and 1. Actual durations: `1.5` and `1` seconds, both on track 0. This contradicts the UI's retained original-note-timing export behavior.

Regression: `MIDI export preserves overlapping same-pitch notes on independent source tracks` in `tests/midi-baseline.test.js` fails on the published runtime. Preserve validated source track identity and emit separate format-1 note tracks, or reject unsupported ambiguous overlaps before generating a misleading file. Recheck ordinary format-0 files and tempo-map timing after the fix.

### UI-REC-002 — P2: teardown cannot invalidate an outstanding microphone permission request

Location: `src/app.js`, `record()` and `stopRecordingStream()`; the latter is called by the page teardown handler.

`record()` awaits `getUserMedia()` without a request-generation/cancellation guard. Calling teardown before that promise resolves does nothing to the future stream. A late permission result still constructs and starts a recorder and leaves its stream active.

The regression runs the exact published functions in a Node VM with a controlled permission promise, a fake recorder and a fake media track. It calls `record()`, then `stopRecordingStream()`, then resolves permission. Expected: zero recorders started and the late track stopped once. Observed: **one recorder started; the track was never stopped**.

Regression: `tests/ui-baseline.test.js`. This is a device-free asynchronous lifecycle test, not a physical microphone or browser permission test. The fix should invalidate pending acquisition during teardown/stop/project replacement, stop late streams, and bind finalization callbacks to the recording/session that created them. The future long-recording runtime must preserve these semantics.

## Code-review candidates awaiting browser execution

These have focused browser regressions, but are not counted as browser-reproduced failures yet.

| ID | Observation | Regression / expected behavior |
| --- | --- | --- |
| UI-STATE-C01 | `boot()` catches invalid settings without replacing the invalid `settings.shortcuts` object. `shortcutFor()` can return a non-string, while the keyboard handler calls `.startsWith()` on it. | `malformed saved shortcut preferences recover to working defaults` in `tests/ui-baseline.spec.js`: malformed persisted shortcuts should fall back to usable defaults with no page errors. |
| UI-INPUT-C02 | The original Tools panel silently ignores an out-of-range typed number but leaves that number displayed; Apply remains available with the last accepted value. The newer rack already restores invalid values. | `Tools restore or clearly reject an invalid typed value before Apply`: restore the accepted value or visibly block applying until corrected. |

`project names, metadata and dynamic track labels remain text rather than markup` adds a browser check for hostile-looking labels across the timeline, metadata editor and sample-key dialog. It is a regression specification, not a claimed observed XSS vulnerability.

## Review coverage and limits

Reviewed the app's command dispatch, preview invalidation and Apply/undo path, selection/channel handling, project and recipe replacement, settings validation/persistence/recovery, keyboard dispatch, modal focus boundaries, track rendering and metadata/key/MIDI dialogs. The existing implementation escapes user-facing labels before HTML insertion or uses text/value properties; this review did not establish a script-injection path at those inspected sites. Rack normalization rejects invalid types/ranges before mutation, and its new fuzz cases exercised caller immutability.

Existing tests cover pending preview invalidation, one-step undo and exact selection/channel isolation, key/metadata/theme persistence, recipe prevalidation, MIDI connection replacement, pending MIDI permission cancellation, keyboard rack reordering and desktop/mobile overflow. Those cases passed in the release workflow before deployment; **that earlier evidence is not relabeled as a new post-publication browser run**. The new browser file awaits CI because the local browser environment previously rejected Chromium's socket creation and the root agent directed no repeat launches.

No physical MIDI device, actual microphone capture, surround hardware or long-duration recording was tested in this lane. No runtime source was changed during baseline collection, and no beta feature was implemented here.

## Required follow-through

1. Repair UI-MIDI-001 and UI-REC-002 with their active assertions intact.
2. Execute the new browser regressions and the existing UI suite in CI; confirm or dismiss the two review candidates using those results.
3. Record fix commits, final counts and any remaining limitations in the final beta verification record.
