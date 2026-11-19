# Audio baseline audit — published 0.2

Date: 2026-11-19. Initial phase: **post-publication baseline; no runtime fixes applied during the audit**. The original evidence is preserved below; authorized fix verification appears at the end.

## Source and execution evidence

The release coordinator verified that Pages workflow `44497716093` deployed successfully, and the live page displayed BETA 0.2 with `app-75ZGK-o6.js` and the demo ready. Published main was `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`.

The checkout used for this audit was `cbf5175119f61c34beed0fd06bb713bc2396c994`. Source equivalence was checked by the coordinator: local `816edcd` has tree `cfc2634a1cefa56d9e640665e1d1cd0257c371eb`, identical to the published merge tree. The difference from `816edcd` to the audit checkout consists only of `docs/specs/BETA_1_0.md` and `docs/handoffs/BETA_1_0_CONTINUATION.md`; there were no runtime changes between publication and these reproductions. Tests and this report were added after that baseline.

Runtime: Node `v24.22.3`, Linux. All generated PCM remained in memory. The seeded corpus uses tiny 8 kHz buffers; the separate reload reproduction uses 30 seconds of mono 48 kHz PCM. No native audio devices, browser playback, or third-party native processes were exercised by this lane.

## Results

The existing eight audio suites passed **77 tests, 0 failures**. Four new regression assertions fail against the published baseline. Seeded fuzzing completed its full corpus and reported 84 invariant failures, all attributable to two of the three independently confirmed findings below. There were no unexpected command rejections and no additional failure categories in this corpus.

| Area | Executed | Result |
| --- | ---: | --- |
| Stateful engine commands | 2,400 | 1,731 accepted; 669 deliberately invalid inputs rejected |
| Rejected-command atomicity | 669 | All preserved project, history, selection, and revision |
| Accepted-command state checks | 1,731 | 1,647 passed; 84 exposed the name or trim findings |
| Undo/redo roundtrips | 136 | Passed |
| Portable project roundtrips | 104 | Passed for the small generated inputs reaching this check |
| Rack DSP, zero-wet, ownership, and reverse checks | 600 | Passed |
| WAV PCM16, PCM24, and float32 roundtrips | 1,800 | Passed within quantization bounds; float32 exact |
| WAV mutations | 1,800 | 1,411 rejected; 389 valid mutations accepted with valid PCM |
| Existing audio tests | 77 | Passed |
| New focused regression tests | 4 | Failed as expected before fixes |

Seeds: `0x57455345`, `0x00c0ffee`, `0x51ec7100`. For each seed the harness runs 8 engine sequences of 100 commands, followed by 200 DSP cases and their WAV checks. A failed state invariant resets that editor so subsequent cases do not merely report the same damaged state. UUID strings differ between runs, but the random choices, case indices, and failure categories are seeded. Input clips contain 64–319 frames and at most two channels; DSP buffers contain 1–256 frames. The engine corpus bounds itself to six tracks and twelve clips.

Raw case counts and failure locations are in [audio-baseline-fuzz.json](audio-baseline-fuzz.json). The executable harness is [scripts/fuzz-audio.mjs](../../scripts/fuzz-audio.mjs); the four explicit assertions are in [tests/baseline-audio-regressions.test.js](../../tests/baseline-audio-regressions.test.js).

## Confirmed findings

### AUDIO-01 — Ordinary saved projects can fail to reopen

**Severity: high.** `base64ToBytes` in `src/engine.js` validates the entire base64 string with a repeated-group regular expression. On this runtime a valid 30-second mono 48 kHz project saved by the editor throws `RangeError: Maximum call stack size exceeded` while loading. The saved channel contains 7,680,000 base64 characters. A 10-second sample reopens; a 60-second sample also fails. The exact duration at which a particular JavaScript runtime fails is not part of the file format and should not determine loadability.

Reproduction: generate 30 seconds at 48 kHz, execute `project.save`, then `project.load` that unchanged portable object in a new editor. The error originates at `RegExp.test`, `base64ToBytes`, then `decodePCM`. The file is well below the editor's documented PCM and timeline caps. This also affects any interchange path that reloads a portable session before export.

Required fix: validate the alphabet, total length, and terminal padding without a recursive repeated-group regex, then decode with the existing exact frame/byte checks. Preserve malformed-base64 rejection. The focused regression requires the restored portable project to equal the saved project.

### AUDIO-02 — Generated clip names break the editor's own saved format

**Severity: medium.** Valid 200-character clip names are accepted on import or creation. `clip.duplicate` appends ` copy` and produces a 205-character name; `clip.split` appends ` · B` and produces a 204-character name. Both commands succeed and their results save, but reopening rejects them with `Names must contain 1–200 characters.` The general project limit check does not validate names.

The seeded engine corpus reproduced this 23 times: 13 duplicate failures and 10 split failures. The first reproducible locations are seed `0x57455345`, sequence 1, step 1 (`clip.duplicate`) and sequence 0, step 5 (`clip.split`). The two focused tests each create a maximum-length name, perform the operation, require bounded generated names, and reload the saved result.

Required fix: use a single bounded suffix helper wherever a name is generated from an existing valid name. Apply it to duplicate tracks and loop names as well as the two confirmed broken clip paths, so related operations do not unexpectedly reject the same valid source name. Preserve user-supplied name validation.

### AUDIO-03 — Explicit trim leaves selection and selected IDs inconsistent

**Severity: medium.** When a different clip is currently selected, `edit.trim` with an explicit `target.clipId` updates `project.selection` for the target but leaves `selectedClipId` and `selectedTrackId` pointing at the previous clip. Commands that use the current selected clip can consequently target a different clip from the visible selection.

Reproduction: create First, then Second; trim First using an explicit range of 0.25–0.75 seconds. The resulting selection refers to First, while the selected clip remains Second. The seeded corpus reproduced this 61 times: 33 selected-clip mismatches and 28 selected-track mismatches. First location: seed `0x57455345`, sequence 0, step 97.

Required fix: select the target track/clip as part of trim before establishing its new range. The regression additionally checks the 4,000-frame result at 8 kHz, timeline placement at 0.25 seconds, and exact undo restoration.

## Review and tested invariants

The engine review followed its mutation snapshot/rollback path, shared immutable PCM ownership, unique-buffer resource accounting, selection repair, channel targeting, mixing, portable serialization, and history trimming. Tests check valid selected IDs and bounds, unique track/clip IDs, portable name lengths, finite PCM, timeline limits, and bounded history. Deliberately invalid multi-step recipes and partially applied updates must roll back the complete project and history. The existing suites also cover selected-channel isolation, mix pan laws, single-channel restrictions, failed-effect atomicity, rack order, effect defaults, key invalidation and copies, and playback cancellation/state transitions.

The DSP checks verify unchanged source PCM, distinct result buffers, constant rack duration/channel count, exact zero-wet identity, finite output, and reverse-twice identity. WAV mutation checks include invalid RIFF identity, unsupported channel counts, declared lengths beyond the supplied buffer, and seeded single-bit mutations. A payload mutation can legitimately decode; those results must still satisfy audio validation.

The reviewed 0.2 contract supports only mono and stereo; wider channel counts are intentionally rejected in this baseline. Surround support is an upcoming specified feature, not treated as a baseline defect. The 10-minute timeline and 256 MiB decoded-audio caps remain in effect. This bounded audit does not claim exhaustive state exploration, real-time device performance, or measured maximum heap usage. Native Audacity/container review, UI/MIDI review, and API admission/security review are separate audit lanes.

## Repeatable commands

```sh
node --test tests/engine.test.js tests/dsp.test.js tests/wav.test.js tests/codecs.test.js tests/rack-dsp.test.js tests/key-detection.test.js tests/creative-engine.test.js tests/playback.test.js
node --test tests/baseline-audio-regressions.test.js
node scripts/fuzz-audio.mjs --out=docs/audits/audio-baseline-fuzz.json
```

The first command exits 0 on this baseline. The second and third exit 1 for the documented findings. Runtime fixes and beta feature implementation remain gated on completion of all baseline audit lanes.

## Authorized fixes and verification

After all baseline lanes were preserved in local commit `7096561` / remote commit `09d2c8e927c6078010a6490cebacd865ac4b2d39`, the coordinator authorized the baseline fixes. No beta features are included in this change.

- **AUDIO-01:** replaced the repeated-group base64 regex with a bounded linear alphabet scan and terminal padding handling. The existing size and decoded-frame checks remain. The 30-second roundtrip now succeeds. Added malformed alphabet, misplaced padding, and wrong-length cases; rejection preserves the project. Independent review also identified a preexisting acceptance of nonzero unused padding bits. A final sextet check now rejects these noncanonical encodings for both one and two padding characters; two additional atomic-rejection tests cover them.
- **AUDIO-02:** introduced a shared suffix helper that keeps generated names within 200 UTF-16 code units without splitting a surrogate pair. Duplicate clip/track, split, and loop name paths use it. Explicit user names retain the existing validation. The maximum-length duplicate/split roundtrips now succeed; an additional case covers generated track/loop names and Unicode boundaries.
- **AUDIO-03:** trim now selects its target track and clip before creating the new selection range. The explicit-other-clip regression passes its selected IDs, frame count, placement, and exact undo checks.

Verification on 2026-11-19:

| Check | Fixed result |
| --- | ---: |
| Original eight suites plus focused regressions | **85 passed, 0 failed** |
| Engine commands using the same seeds and corpus sizes | **2,400 completed, 0 failures** |
| Accepted commands / state checks | 1,766 passed |
| Invalid commands / atomicity checks | 634 passed |
| Unexpected rejections | 0 |
| Undo/redo roundtrips | 142 passed |
| Small portable project roundtrips | 113 passed |
| DSP cases | 600 passed |
| WAV roundtrips | 1,800 passed |
| WAV mutations | 1,800 checked: 1,411 rejected and 389 valid accepted results |

The initial fixed run revealed an overly strict test oracle: a selection end expressed as `0.009625000000000002` loaded as `0.009625`, representing the same sample boundary. The portable-roundtrip comparison now compares selection start/end **frame indices exactly**, with all other fields and PCM still compared exactly. This is a test correction, not an additional runtime change. No sample or selection extent changed. The fixed counts differ from the historical counts because the harness no longer resets editors after the repaired invariants fail.

The baseline JSON above is unchanged. The successful fixed-run evidence is in [audio-baseline-fixed-fuzz.json](audio-baseline-fixed-fuzz.json).

```sh
node --test tests/baseline-audio-regressions.test.js tests/engine.test.js tests/creative-engine.test.js tests/dsp.test.js tests/rack-dsp.test.js tests/key-detection.test.js tests/wav.test.js tests/codecs.test.js tests/playback.test.js
node scripts/fuzz-audio.mjs --out=docs/audits/audio-baseline-fixed-fuzz.json
```

Both commands exit 0. The four original regression assertions remain active, alongside four additional malformed-input, canonical-padding, and generated-name boundary tests. No runtime changes outside `src/engine.js` were needed for these three findings.
