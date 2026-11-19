# WebSoundEdit 0.2 — release verification

Recorded 18 November 2026 (Pacific time).

## Current verification status

The v0.2 feature worktree has passed **125 local unit/integration tests** and the **production build**. Browser workflow verification, native Audacity application verification, and publication of the v0.2 artifact are still pending. The earlier v0.1 deployment does not establish that these new changes have been published or verified in a browser.

The implementation specification was written before feature implementation in commit [3e04bcb](https://github.com/djshellshoxxx/websoundedit/commit/3e04bcbbeb72f1c106002545be074cc27579fbf3). See [Creative workbench v2](specs/CREATIVE_WORKBENCH_V2.md) for the scope and acceptance criteria.

| Check | Current result | What this establishes |
| --- | --- | --- |
| Local `npm test` | **125 passed** | Existing engine/API behavior and the new automated DSP, rack configuration, musical-key, MIDI, metadata and project-format cases described below. |
| Local `npm run build` | **Passed** | The static distribution builds with self-hosted workers/WASM dependencies, notices, public API exports, and the existing bundle verification. |
| Chromium browser workflows | **Pending CI** | Tests are implemented; interaction, layout and browser codec results for v0.2 have not yet been confirmed. |
| Native Audacity application exchange | **Pending CI** | A native application harness is implemented; generated-project unit round trips alone do not establish interoperability with Audacity. |
| GitHub Pages v0.2 deployment | **Pending** | Publication and live asset verification must be recorded after the required jobs pass. |
| Physical MIDI controllers | **Not tested** | MIDI lifecycle and mapping tests use mock devices. |

Local browser launch was blocked by the execution environment's socket restrictions. A separate cloud-preview attempt was also unavailable. These are execution limitations; neither attempt counts as a browser pass. The browser suite remains a required CI gate.

## Local automated coverage

### Existing editing and conversion behavior

The local suite retains the existing engine, DSP, API, WAV, playback, visualization and codec checks: selection/channel isolation, independent pitch and time changes, EQ and dynamics, BPM and silence analysis, ducking/gating, loop construction, granular reproducibility, exact native JSON projects, undo/redo, mixer behavior, CLI/HTTP editing, input validation, clocks and waveform/spectrum calculations.

These local checks are distinct from the browser format round trips, which must run again for v0.2. Previous browser conversion results are recorded separately under the historical baseline below.

### Creative effects and sample keys

- The shared rack catalogue contains echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter and bitcrusher.
- Rack tests check finite output, deterministic processing, serial-order sensitivity, bypass and zero-wet identity, selection boundaries, and one-step undo through the engine.
- Configuration tests check the 12-stage limit, duplicate effect instances with distinct IDs, bounded parameters, stable XY bindings after reorder, invalid settings rejection, and linear/logarithmic controller mappings.
- Key-analysis tests cover major/minor material across pitch classes, harmonic content, several sample rates, opposite-polarity stereo, and later tonal material after a silent introduction. Silence, short samples, a single pitch and broadband noise exercise uncertain results.
- Manual key assignments, persisted analysis, and invalid analysis data have automated coverage. These are deterministic test signals, not a guarantee that every musical recording will receive the correct estimate.

### MIDI and metadata

- MIDI tests cover message bytes, note-on/off, channels and velocity, CC limits and mapping, Standard MIDI File tempo changes, running status, malformed files, note-timing round trips, and bounded synthesis.
- Mock-device tests cover explicit permission requests, unavailable/denied access, reconnection cleanup, device disappearance, disconnect during a pending request, and note-off while the audio context is resuming.
- Metadata tests exercise bounded tag validation and the supported export paths. Audio/tag tests distinguish metadata-only changes from PCM processing.
- Physical device timing, USB driver behavior, browser permission prompts on real hardware, and subjective musical response remain outside this local evidence.

### Audacity project structures

Project-format tests exercise real SQLite `.aup3` structures, legacy `.aup` XML/data packaging, supported PCM/track/clip/tag information, generated round trips, corrupt input, and unsupported features. These checks establish the behavior of the implemented readers/writers against their test fixtures.

The separate native Audacity gate is needed to establish that the application itself can open and exchange the supported projects. Do not describe a generated internal round trip as a successful native Audacity test.

## Browser verification gate

Run `npm run test:e2e` against the freshly built distribution. The existing workflow installs Playwright's Chromium on the GitHub-hosted runner and uploads the `browser-evidence` artifact, including `playwright-report/` and `test-results/`.

### Existing editor and codec cases

Re-run the existing editor interactions and all advertised browser output choices: WAV, MP3, FLAC, Ogg Vorbis, Opus, M4A/AAC, raw AAC, AIFF, ALAC/M4A and WMA. Confirm that format outputs decode to finite, audible PCM with the expected channels and duration.

### New creative workflow cases

The implemented browser cases exercise:

- Adding effects; actual desktop drag/drop; keyboard and button reordering; rotary/numeric wet-dry controls; bypass/removal; and invalid numeric restoration.
- XY pointer and keyboard operation, two independent targets, bindings that follow stage IDs, and project save/load.
- Applying a stutter/tape chain only to the selected region/channel, followed by a single undo that restores the original PCM.
- Key detection and manual override, metadata editing and WAV tag export, themes, expanded waveform width when the inspector collapses, and portable project restoration.
- Rejection of invalid project UI settings before current audio or preferences are replaced.
- Mock MIDI connection, CC learning, independent XY-axis updates, output messages, settings persistence, and device cleanup after project loading, project-replacing recipes and demo loading.
- MIDI file import through the visible file control and export preserving its source note timing.
- Supported Audacity project workflows through the browser, in addition to the native application gate.

Project-replacing recipes restore their final project's interface settings. A recipe ending in a new empty project therefore clears rack stages and MIDI mappings. The direct New Session command retains reusable tool preferences while disconnecting MIDI devices.

### Layout evidence to review

The suite retains desktop/tablet/mobile layout checks and adds screenshots for the populated rack/XY controller, mobile effects controls, and collapsed daylight layouts. New screenshots are written through `testInfo.outputPath`, so they are included in the browser evidence artifact. Review the screenshots as well as the assertions; a screenshot file's existence is not itself a visual approval.

- [ ] Record the tested commit SHA and successful browser CI run URL.
- [ ] Record actual passed/failed/skipped browser counts and browser version from that run.
- [ ] Inspect effects/XY, daylight, collapsed and mobile screenshots.
- [ ] Confirm no unexpected page errors, horizontal overflow, or inaccessible essential controls in the tested cases.

## Native Audacity verification gate

The `verify` job installs Audacity, Xvfb, xauth and the codec test dependencies, then runs the native exchange gate:

```sh
xvfb-run -a node scripts/verify-audacity.mjs
```

Its evidence is uploaded as `native-audacity-evidence` from `test-results/native-audacity/`. The result must identify the actual Audacity version and supported format directions exercised. Native acceptance applies to those tested features and version; it does not imply support for every Audacity project feature or plugin.

- [ ] Record the native CI run URL, tested commit and Audacity version.
- [ ] Confirm the native harness completed successfully and inspect its logs/artifacts.
- [ ] Record the actual `.aup3` and legacy `.aup` exchange cases that passed.
- [ ] Record any remaining format/version boundaries, including rejected sound-changing features.

## Publication and live verification

Target: <https://djshellshoxxx.github.io/websoundedit/>.

The Pages deployment job depends on `verify`, which requires both the browser and native Audacity gates to pass on the same runner. A successful build artifact or pull-request run alone is not a production deployment. Browser tests still execute after a native-test failure to collect useful evidence; either failure prevents publication.

- [ ] Record the final release commit and successful Pages deployment run URL.
- [ ] Confirm that the deployed artifact belongs to the verified release commit.
- [ ] Open the live editor and verify the Effects category and other v0.2 controls.
- [ ] Verify published application assets, public `api.js`, workers/WASM files and notices load from the Pages base path.
- [ ] Record any live checks and their results, then replace the pending statuses above with observed evidence.

## Historical baseline: v0.1

The previous release was tested at commit [0b3acbb09e857182f32d5d56b2a589bcf5411eb8](https://github.com/djshellshoxxx/websoundedit/commit/0b3acbb09e857182f32d5d56b2a589bcf5411eb8) and published by [workflow run 44471962803](https://github.com/djshellshoxxx/websoundedit/actions/runs/44471962803). Its recorded results were 69 passing local tests, a passing build, 21 passing Chromium browser tests, and a successful Pages deployment. The recorded browser was Chromium 159.0.8154.6 with Playwright 1.65.1 on the GitHub-hosted Ubuntu runner, using Node 24.

The previous live verification checked HTTP responses, application/API assets, codec resources, and Circuit Drift Labs links. Circuit Drift Labs integration was recorded at commit `99d7590368056a487c41ef0b1acc105f40040da3`. The existing [desktop screenshot](screenshots/workbench.png) depicts that older release. These historical observations are retained for provenance and must not be reported as v0.2 evidence.

## Boundaries

The editor supports mono/stereo PCM within a 10-minute timeline, 256 MiB PCM budgets, 64 tracks and 512 clips. Effects in the new rack preserve duration; their tails remain inside the selected interval. Select trailing silence when the intended sound needs room to decay.

Audacity files preserve the supported data model, not arbitrary realtime plugins, unsupported sound-changing transformations, or every version-specific project feature. Native WebSoundEdit JSON retains its own interface/rack/MIDI settings. MIDI note-file export retains source notes rather than translating subsequent audio edits back to MIDI. Key detection is heuristic. Normalization and limiting use sample peaks rather than LUFS normalization or oversampled true-peak metering.

GitHub Pages hosts the static editor and SDK. Filesystem/HTTP automation runs through the included local CLI or explicitly started loopback companion; there is no Pages-hosted REST processing server. This verification does not establish Safari/Firefox compatibility, physical MIDI or microphone performance on every device, or subjective audio quality for all material.
