# WebSoundEdit — acceptance and verification plan

This is a test plan, not a test report. A box is not evidence of a pass; record the actual command, fixture, browser, and result in the release verification record. The first release should test the behavior it promises and state any remaining limitations explicitly.

## 1. Core editing and selection invariants

| ID | Scenario | Required result |
| --- | --- | --- |
| EDIT-01 | Reverse a middle selection of a deterministic ramp. | Only samples inside the selected interval reverse. Prefix and suffix are unchanged. Duration is unchanged. |
| EDIT-02 | Apply gain/EQ to only the left channel of a stereo clip with distinct channels. | Right channel remains unchanged; left changes only in range. |
| EDIT-03 | Request a duration-changing operation on only one stereo channel. | Operation is rejected or explicitly coerced by a documented UI action before processing; no silent channel misalignment. |
| EDIT-04 | Split a clip at a known sample and render the pieces at their original positions. | The reconstructed audio matches the unsplit source within float tolerance. |
| EDIT-05 | Cut/copy/paste/trim/delete a region with known boundaries. | Resulting samples, duration, and clip placement match the documented semantics. |
| EDIT-06 | Change one clip’s duration with another clip later on a different track. | The other clip’s start does not change implicitly. |
| EDIT-07 | Undo and redo an edit; then undo and make a different edit. | Original state restores, redo restores the edit, and the new edit clears redo. |
| EDIT-08 | Submit an invalid target, empty range, non-finite number, or unknown method. | Clear error; existing project remains usable and unchanged. |

## 2. DSP correctness

Use deterministic synthetic signals for measurable checks. Tests should exercise audible invariants and numeric boundaries, rather than merely asserting that a function returns an array.

| ID | Scenario | Required result |
| --- | --- | --- |
| DSP-01 | Normalize a nonzero signal to a known peak target. | Peak reaches target within float tolerance and stereo balance is preserved under linked mode. Silence stays silent and finite. |
| DSP-02 | Remove a known DC component. | Mean approaches zero without modifying data outside selection. |
| DSP-03 | Invert polarity, swap channels, and apply signed sample delay. | Sign/channel/timing behavior matches labels; no hidden resampling or duration change unless documented. |
| DSP-04 | Pan mono audio to left/center/right. | Output-channel levels match the documented pan law. |
| DSP-05 | Apply EQ to known low/high or single-frequency tones. | Frequency response changes in the expected direction; extreme valid settings remain finite. |
| DSP-06 | Compress signals below/above threshold. | Above-threshold level is reduced according to ratio/envelope; below-threshold behavior and makeup gain are correct. |
| DSP-07 | Limit a transient signal with lookahead. | Sample peaks respect the promised ceiling; compensated duration/timing are correct; no unsupported true-peak claim. |
| DSP-08 | Shift a sustained tone by +12 semitones with duration preserved. | Dominant frequency is approximately doubled; duration is preserved within the stated sample tolerance. |
| DSP-09 | Stretch the same tone to 2× duration with pitch preserved. | Duration approximately doubles and dominant frequency remains stable. The ending is not truncated by an unflushed pipeline. |
| DSP-10 | Change speed to 2×. | Duration approximately halves and dominant frequency approximately doubles. |
| DSP-11 | Fade a known constant-amplitude region. | Endpoints/envelope are correct and no unselected audio is altered. |
| DSP-12 | Run supported effects on very short clips, silence, and stereo inputs. | Defined finite result or clear validation error; no crash, NaN, or channel-length mismatch. |

## 3. Rhythm, sidechain, and creative tools

| ID | Scenario | Required result |
| --- | --- | --- |
| RHY-01 | Detect BPM on a generated click/drum pattern at a known tempo. | Correct tempo or a disclosed half/double alternative appears among candidates; confidence is meaningful. |
| RHY-02 | Detect BPM on silence and unstructured noise. | No arbitrary high-confidence musical tempo is asserted. |
| RHY-03 | Manually change BPM, then apply an explicit stretch-to-tempo operation. | Manual correction changes timing metadata only; explicit stretch changes audio duration. |
| RHY-04 | Apply tempo ducking at different rates and beat offsets. | Envelope period and alignment follow project tempo and timeline position. Depth zero is neutral; full-depth gate reaches its defined closed level. |
| RHY-05 | Apply audio sidechain compression with a trigger active in only one interval. | Target ducks during the trigger interval according to attack/release; it does not simply follow a fixed BPM. |
| RHY-06 | Reorder a selection of distinct beat slices. | Output order and repeated slices match the pattern; invalid indices are rejected. |
| RHY-07 | Generate granular/noise output twice with identical seed/parameters. | Identical results; another seed changes the generated material. |
| RHY-08 | Loop and export a selected region with seam treatment. | Playback and export use the same samples; total duration follows the documented crossfade rule. |
| RHY-09 | Start, stop, and loop playback with metronome enabled. | Clicks follow tempo/loop timing, cease on stop, and are absent from ordinary exports. |

## 4. Silence tools

| ID | Scenario | Required result |
| --- | --- | --- |
| SIL-01 | Signal contains silence shorter/longer than the minimum duration. | Only qualifying ranges are returned with correct bounds/padding. Detection does not edit. |
| SIL-02 | One stereo channel is quiet while the other contains audio. | Linked detection does not erase the active channel’s material. |
| SIL-03 | Remove qualifying silence inside a selected region. | Correct duration reduction with coherent channels; material outside the target follows the documented edit semantics. Undo restores it. |

## 5. Multitrack, files, and persistence

| ID | Scenario | Required result |
| --- | --- | --- |
| FILE-01 | Mix two clips with known offsets/gain/pan. | Render reflects timeline alignment, mute/solo rules, and track settings. |
| FILE-02 | Import an audio file with a sample rate different from the project. | Duration/pitch remain correct after conversion; source format errors leave the project intact. |
| FILE-03 | Export mix, track, clip, selection, and one selected channel. | Each file contains only its intended scope with correct channel count and duration. |
| FILE-04 | Export every advertised codec and inspect/redecode outputs. | Actual container/codec match the label; audio is finite and audible; invalid configurations fail clearly. |
| FILE-05 | Save and reload portable project JSON containing multiple tracks, edits, markers, settings, and selection. | No source-file reattachment required; render and metadata round-trip accurately. |
| FILE-06 | Import malformed/oversized/unsupported-version JSON. | Validation error before replacement; current project remains intact. |
| FILE-07 | Save/load settings JSON independently. | Preferences and shortcuts round-trip without replacing audio. |
| FILE-08 | Exceed history/resource limits through controlled fixtures. | Defined bounded behavior; clear error or documented history eviction rather than uncontrolled allocation. |

## 6. API and local automation

| ID | Scenario | Required result |
| --- | --- | --- |
| API-01 | Execute a representative edit chain directly in the engine and through the browser facade. | Same signal result; every audio/project operation is registered and discoverable. |
| API-02 | Run CLI input → selection → reverse/stretch/EQ → normalize → output. | Valid output with expected duration/signal changes and useful exit code. No UI scripting required. |
| API-03 | Execute a JSON recipe with a malformed command. | Failure is reported clearly with documented transactional/partial-progress semantics. |
| API-04 | Start local HTTP companion and issue authenticated upload, edit, render, project save/load. | Complete script workflow works over the documented endpoints. |
| API-05 | Send missing/wrong bearer token, unapproved Origin/Host, oversized request, and arbitrary path parameter. | Requests are rejected as designed; no unauthorized local file access. |
| API-06 | Inspect deployment with no companion running. | Site remains usable; it does not claim GitHub Pages is running a processing server. |

## 7. Browser and visual verification

Run the full shared desktop suite in Chromium, Firefox and WebKit, plus the mobile Chromium and WebKit layout projects. The default `npm run test:e2e` command selects all five projects. Shared desktop specs are included automatically; only the Chromium simulated microphone fixture is engine-specific. Preserve the native worklet, PCM and OPFS assertions in every desktop engine. Linux verification requires a working audio backend; CI provides a clocked PulseAudio null sink. Record each engine's actual result from `test-results/browser-results.json`, and report any environment blocker separately from an application failure. Published-site checks run after deployment and are intentionally skipped in a local build-only run.

| ID | Scenario | Required result |
| --- | --- | --- |
| UI-01 | Load published Pages URL and all worker/codec assets under `/websoundedit/`. | No missing assets, wrong base paths, or unhandled startup errors. |
| UI-02 | Import, select by drag, refine bounds numerically, preview, apply, undo, save selection. | Controls operate in a predictable order; selection scope is always clear. |
| UI-03 | Change gain, reverse, pitch, stretch, and EQ. | Processed waveform comes from actual output PCM; time length changes correctly; spectrum supports frequency inspection. |
| UI-04 | Change preview controls rapidly while a render is pending. | Stale render results do not overwrite newer settings; preview does not accumulate edits. |
| UI-05 | Operate transport, edit, effects, export, project JSON, and command search with keyboard. | Every feature has a reachable keyboard route; focus remains visible and text entry does not trigger unintended edits. |
| UI-06 | Assign and save a shortcut, then reload settings. | Binding works, collision behavior is clear, and settings persist accurately. |
| UI-07 | Inspect 320px, 768px, and desktop widths. | Primary controls remain reachable; inspector stacks appropriately; no unintended page overflow hides actions. |
| UI-08 | Navigate to/from CDL main site. | Both links point to the actual published destinations. |
| UI-09 | Inspect import/export/processing network traffic. | Audio is not uploaded to a server by the editing workflow. Codec assets may download. |

## 8. Release evidence template

Record:

- Commit and build/deployment identifiers.
- Automated test commands and pass/fail summary.
- Fixture sample rates, channel counts, and duration for signal tests.
- Browser/version, viewport, and actual manual workflow exercised.
- Codec formats actually encoded and decoded successfully.
- Published URL and response/asset checks.
- Known limitations, remaining acceptance items, and whether they affect a requested feature.

Do not substitute a successful build for DSP validation, or a matching file extension for proof of conversion.
