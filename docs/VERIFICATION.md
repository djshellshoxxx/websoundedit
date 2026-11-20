# WebSoundEdit release verification

The current beta.2 qualification record is [BETA_2_QUALIFICATION_20261119.md](audits/BETA_2_QUALIFICATION_20261119.md). Hosted results belong to the [Actions run on the exact commit](https://github.com/djshellshoxxx/websoundedit/actions). The earlier beta record remains in [BETA_1_0_SUMMARY.md](audits/BETA_1_0_SUMMARY.md). The evidence below is the historical 0.2 record and does not describe the expanded beta limits.

## Historical 0.2 release

Verification record for release 0.2.0.

## Current verification status

The v0.2 feature head [acc40cc3c5d68d7dbdddde4353bbc4b723259e65](https://github.com/djshellshoxxx/websoundedit/commit/acc40cc3c5d68d7dbdddde4353bbc4b723259e65) passed **125 unit/integration tests**, the **production build**, **31 Chromium browser tests**, and **all three native Audacity exchange cases** in [workflow run 44496126861](https://github.com/djshellshoxxx/websoundedit/actions/runs/44496126861), job `135463633081`. The browser suite completed in **48.4 seconds**, with no retries, flaky results or skipped tests.

This is passing pull-request verification. The Pages release is gated by the same verification job on `main`, followed by a successful deployment; publication is not claimed by this record.

The implementation specification was written before feature implementation in commit [3e04bcb](https://github.com/djshellshoxxx/websoundedit/commit/3e04bcbbeb72f1c106002545be074cc27579fbf3). See [Creative workbench v2](specs/CREATIVE_WORKBENCH_V2.md) for the scope and acceptance criteria.

| Check | Current result | What this establishes |
| --- | --- | --- |
| `npm test` in CI | **125 passed** | Existing engine/API behavior and the automated DSP, rack configuration, musical-key, MIDI, metadata and project-format cases described below. The same 125 tests also passed locally. |
| `npm run build` in CI | **Passed** | The static distribution builds with self-hosted workers/WASM dependencies, notices, public API exports, and bundle verification. |
| Chromium browser workflows | **31 passed in 48.4 s** | Editor interactions, layouts, project workflows and real browser codec conversions passed without retries, flaky results or skips. |
| Native Audacity application exchange | **3 cases passed** | Audacity 3.4.2 opened/imported, rendered and saved the supported modern/legacy fixtures; an independently created native project also imported correctly. Numerical results appear below. |
| GitHub Pages v0.2 deployment | **Gated by `main` verification and deployment** | The passing pull-request run supplies verification evidence; it is not a Pages deployment. |
| Physical MIDI controllers | **Not tested** | MIDI lifecycle and mapping tests use mock devices. |

Local browser launch was blocked by the execution environment's socket restrictions, and a separate cloud-preview attempt was unavailable. Browser and native application evidence therefore comes from the completed GitHub-hosted Ubuntu 24.04 run. Neither unavailable local attempt is counted as a pass.

## Automated unit and integration coverage

### Existing editing and conversion behavior

The suite retains the existing engine, DSP, API, WAV, playback, visualization and codec checks: selection/channel isolation, independent pitch and time changes, EQ and dynamics, BPM and silence analysis, ducking/gating, loop construction, granular reproducibility, exact native JSON projects, undo/redo, mixer behavior, CLI/HTTP editing, input validation, clocks and waveform/spectrum calculations.

The unit/integration checks and the browser format round trips both passed for v0.2 in the recorded run. Previous release results remain separately identified under the historical baseline below.

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
- Physical device timing, USB driver behavior, browser permission prompts on real hardware, and subjective musical response remain outside this evidence.

### Audacity project structures

Project-format tests exercise real SQLite `.aup3` structures, legacy `.aup` XML/data packaging, supported PCM/track/clip/tag information, generated round trips, corrupt input, and unsupported features. These checks establish the behavior of the implemented readers/writers against their test fixtures.

The separate native Audacity gate also passed, establishing application-level exchange for the supported fixtures and tested version. Its measurements below are distinct from the generated internal round-trip tests.

## Browser verification gate

The workflow ran `npm run test:e2e` against the freshly built distribution and uploaded the [browser-evidence artifact](https://github.com/djshellshoxxx/websoundedit/actions/runs/44496126861/artifacts/14515552084), including `playwright-report/` and `test-results/`. The report records 31 expected results, zero unexpected results, zero flaky results and zero skipped tests.

The tested browser was **Chrome for Testing / Chromium Headless Shell 159.0.8154.6**, Playwright browser revision **1255**, on Ubuntu 24.04. The job logs record those downloaded binaries. **Playwright 1.65.1** is pinned in the [tested lockfile](https://github.com/djshellshoxxx/websoundedit/blob/acc40cc3c5d68d7dbdddde4353bbc4b723259e65/package-lock.json), and `npm ci` completed before the tests. This establishes coverage for that Chromium configuration, not other browser engines or versions.

### Existing editor and codec cases

The passing suite exercised existing editor interactions and all advertised browser output choices: WAV, MP3, FLAC, Ogg Vorbis, Opus, M4A/AAC, raw AAC, AIFF, ALAC/M4A and WMA. Format outputs decoded to finite, audible PCM with the asserted channels and duration.

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

### Layout evidence

The passing suite includes desktop/tablet/mobile layout checks and screenshots for the populated rack/XY controller, mobile effects controls, and collapsed Daylight layouts. Screenshots are retained in the browser evidence artifact. The effects/XY desktop view, current Daylight desktop/mobile views and mobile rack were visually reviewed and accepted. The automated checks for the tested layouts passed; this does not establish every device, display size or browser combination.

- Tested head and successful run: `acc40cc3c5d68d7dbdddde4353bbc4b723259e65`, [run 44496126861](https://github.com/djshellshoxxx/websoundedit/actions/runs/44496126861).
- Browser result: **31 passed, zero failures/skips/retries/flaky results; 48.4 seconds**.
- Screenshot review: effects/XY desktop, Daylight desktop/mobile and mobile rack accepted; responsive layout assertions passed.

## Native Audacity verification gate

The `verify` job installs Audacity, Xvfb, xauth and the codec test dependencies, then runs the native exchange gate:

```sh
xvfb-run -a node scripts/verify-audacity.mjs
```

The [native-audacity-evidence artifact](https://github.com/djshellshoxxx/websoundedit/actions/runs/44496126861/artifacts/14515845571) contains `report.json`, command transcripts, process-exit records, generated projects, native-saved projects and WAV renders. Its report has `passed: true` and identifies **Audacity 3.4.2+dfsg-1build4**. All three native processes exited with code **0**; the imports returned no warnings.

| Case | Native render maximum sample difference | Native save/reimport maximum sample difference | Audio compared |
| --- | ---: | ---: | --- |
| WebSoundEdit AUP3 → Audacity → WebSoundEdit | `2.9802322387695312e-8` | `2.9802322387695312e-8` | 72,000 stereo frames at 48 kHz |
| WebSoundEdit legacy AUP/data → Audacity AUP3 → WebSoundEdit | `2.9802322387695312e-8` | `2.9802322387695312e-8` | 72,000 stereo frames at 48 kHz |
| Independent Audacity project created from WAV → native AUP3 → WebSoundEdit | Native render supplied the independent reference | **0 — exact match** | 48,000 stereo frames at 48 kHz |

The modern and legacy cases passed native track/clip/label inspection, full stereo rendering, native saving, metadata checks, clip-name/placement checks and original PCM checks. The fixture includes overlapping clips exported into separate track lanes. Maximum-difference tolerances remained `0.0002` for comparison with native WAV rendering and `0.000002` for the modern/legacy save-and-reimport mix; none of these assertions were relaxed.

The legacy case sets the blank native project's sample rate to **48 kHz before `Import2`**. Audacity 3.4.2's legacy importer can scale clip offsets when the initial project rate differs from the file's rate. That prerequisite appears in the legacy export UI, ZIP instructions and [Audacity compatibility documentation](AUDACITY.md). Standard legacy XML offsets and PCM are unchanged; the AUP3 path does not require this workaround.

These results establish exchange for the tested Audacity version and supported fixtures. Unsupported realtime plugins, sound-changing transformations, recovery states and newer/unrecognized schemas retain the documented rejection behavior. They are not covered by a universal Audacity round-trip claim.

## Publication and live verification

Target: <https://djshellshoxxx.github.io/websoundedit/>.

The Pages deployment job depends on `verify`, which requires unit tests, the build, browser tests and native Audacity exchange to pass on the same runner. After the release reaches `main`, its verification and deployment jobs determine publication. The passing pull-request run recorded here is not itself a production deployment. Browser tests still execute after a native-test failure to collect useful evidence; either failure prevents publication.

Deployment confirmation must identify the successful `main` run and deployed commit. Live verification then checks the Effects controls and the published application/API, workers, WASM resources and notices under the Pages base path. No v0.2 live-site or deployment result is claimed in this pre-deployment verification record.

## Historical baseline: v0.1

The previous release was tested at commit [0b3acbb09e857182f32d5d56b2a589bcf5411eb8](https://github.com/djshellshoxxx/websoundedit/commit/0b3acbb09e857182f32d5d56b2a589bcf5411eb8) and published by [workflow run 44471962803](https://github.com/djshellshoxxx/websoundedit/actions/runs/44471962803). Its recorded results were 69 passing local tests, a passing build, 21 passing Chromium browser tests, and a successful Pages deployment. The recorded browser was Chromium 159.0.8154.6 with Playwright 1.65.1 on the GitHub-hosted Ubuntu runner, using Node 24.

The previous live verification checked HTTP responses, application/API assets, codec resources, and Circuit Drift Labs links. Circuit Drift Labs integration was recorded at commit `99d7590368056a487c41ef0b1acc105f40040da3`. The existing [desktop screenshot](screenshots/workbench.png) depicts that older release. These historical observations are retained for provenance and must not be reported as v0.2 evidence.

## Boundaries

The editor supports mono/stereo PCM within a 10-minute timeline, 256 MiB PCM budgets, 64 tracks and 512 clips. Effects in the new rack preserve duration; their tails remain inside the selected interval. Select trailing silence when the intended sound needs room to decay.

Audacity files preserve the supported data model, not arbitrary realtime plugins, unsupported sound-changing transformations, or every version-specific project feature. Native WebSoundEdit JSON retains its own interface/rack/MIDI settings. MIDI note-file export retains source notes rather than translating subsequent audio edits back to MIDI. Key detection is heuristic. Normalization and limiting use sample peaks rather than LUFS normalization or oversampled true-peak metering.

GitHub Pages hosts the static editor and SDK. Filesystem/HTTP automation runs through the included local CLI or explicitly started loopback companion; there is no Pages-hosted REST processing server. This verification does not establish Safari/Firefox compatibility, physical MIDI or microphone performance on every device, or subjective audio quality for all material.
