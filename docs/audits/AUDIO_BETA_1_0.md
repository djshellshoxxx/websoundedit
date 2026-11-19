# Audio engine and live runtime — 1.0 beta evidence

Date: 2026-11-19. Implemented after the published 0.2 baseline audit and fix gate, against `docs/specs/BETA_1_0.md`. Feature checkpoint: remote `8d843590c3d8fb9701a01befb9b1a7821ed5418f` / local `b51581f`. This report covers the audio lane; the release owner records the combined browser, interchange, API and deployment gates separately.

## Executed results

The complete owned audio regression group passed **157 tests, zero failures, zero skips** under Node **v24.22.3**, Linux. It includes the existing engine, DSP, WAV, rack, key, MIDI, playback, codec and baseline regressions as well as the new multichannel/live/recording tests.

```sh
node --test tests/engine.test.js tests/dsp.test.js tests/wav.test.js \
  tests/rack-dsp.test.js tests/creative-engine.test.js \
  tests/key-detection.test.js tests/baseline-audio-regressions.test.js \
  tests/channel-layout.test.js tests/realtime-dsp.test.js \
  tests/live-audio.test.js tests/recording-store.test.js \
  tests/audio-devices.test.js tests/midi.test.js tests/playback.test.js \
  tests/codecs.test.js tests/opus.test.js
```

Two deterministic fuzz corpora passed after implementation:

| Corpus | Seeds | Executed checks | Failures |
| --- | --- | --- | --- |
| Beta live/multichannel | `0x10be7a26`, `0x51ec7100`, `0x0071a11e` | 360 random stateful DSP configurations; 360 block-partition comparisons; 360 exact zero-wet comparisons; 360 rejected graph atomicity checks; 360 channel-isolated edits; 360 undo roundtrips; 360 single-track session roundtrips; 360 WAV roundtrips; 720 malformed WAV checks | 0 |
| Preserved baseline | `0x57455345`, `0x00c0ffee`, `0x51ec7100` | 2,400 engine commands: 1,766 accepted and 634 expected rejections; 634 atomic rejection checks; 1,766 state checks; 142 undo/history and 113 project roundtrips; 600 DSP cases; 1,800 WAV roundtrips and 1,800 WAV mutations | 0 |

The baseline WAV mutations included 389 structurally valid accepted mutations and 1,411 rejected mutations. Acceptance is not itself a fuzz failure; the harness checks the resulting PCM and format invariants.

Reproduce the exact reports:

```sh
node scripts/fuzz-live-audio.mjs --out=docs/audits/audio-beta-fuzz.json
node scripts/fuzz-audio.mjs --out=docs/audits/audio-beta-baseline-fuzz.json
node scripts/benchmark-live-dsp.mjs --out=docs/audits/audio-beta-performance.json
```

The first development run of the new fuzz harness called a nonexistent `clip.select` command and stopped its engine subcases. The harness was corrected to use the actual selection API, and the complete corpus was rerun. The attached beta report contains the successful complete run; this harness error is not reported as an engine defect.

## Implemented audio model

`channel-layout.js` defines the canonical speaker order used by PCM, project state, mixing, browser routing, portable sessions and extensible WAV:

| Layout | Channels in order | WAVE speaker mask |
| --- | --- | --- |
| mono | M | `0x0004` |
| stereo | FL, FR | `0x0003` |
| 5.1 | FL, FR, FC, LFE, BL, BR | `0x003f` |
| 7.1 | FL, FR, FC, LFE, BL, BR, SL, SR | `0x063f` |

Old mono/stereo PCM remains accepted without a layout tag. Surround requires a canonical layout or a recognized WAV speaker mask. Ambiguous native browser decodes and unsupported masks require an explicit user choice; they are not silently collapsed to stereo. Browser and Node codec paths preserve declared channel counts for formats that support them and reject unsupported surround combinations.

Mixing uses explicit matrices. Mono pan uses equal-power front-left/front-right gains. Balance changes the front pair of an existing multichannel clip while preserving the other channels' gain. Surround-to-stereo includes center/back/side contributions and excludes LFE by default. Monitoring conversion is separate from project/export layout, and insufficient hardware channels produce an explicit monitor downmix state.

Channel selections accept `all`, the legacy left/right aliases, or validated index arrays. Selected-channel effects preserve every untouched channel and frame exactly. Temporary three/four/five/seven-channel selection buffers are internal; persisted PCM still uses the four canonical layouts.

`audio.render` supports explicit track identity, range, output layout, raw PCM and independent `respectMute`/`respectSolo` flags. Stems can start at project zero and end at a common project end. `project.saveTrack` returns a genuine portable session and filters selection, clip-keyed MIDI references and live rack references to the retained track plus master.

`effect.trimSilence` removes qualifying leading/trailing silence and preserves interior pauses. All-silent input is left unchanged with an explanatory result. The existing remove-silence operation retains its separate behavior.

## Shared live route and control

`LiveAudioRuntime({engine, playback})` is lazy and permission-free at construction. The shared program route is independent track/loop sources → track rack → master rack → recording tap → explicit monitor conversion → selected output. MIDI sample voices borrow the same context and master destination. Metronome audio goes only to monitoring.

Normal playback uses one independently routed source per audible track. Starting a loop takes ownership of that track's source, and runtime-owned loop tracks are excluded from ordinary playback plans. If all tracks are already loop voices or muted, a silent source supplies the transport clock without duplicating program audio. Live parameter changes and rack reordering do not stop the running sources or rerender their full PCM buffers.

The AudioWorklet and `live.render` use `RealtimeRackDSP`: echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter and bitcrusher. Delay/filter history and modulation phase persist across processing blocks. Stable unchanged stage IDs retain state when reordered. Wet zero is exact dry output while the stage's internal history continues advancing. Replacing a stage with another effect cancels incompatible queued controls. Stutter recaptures its slice when division or tempo changes.

Step/linear automation uses the audio timeline. An explicit `live.param.set` time or beat is compiled into persistent automation points, so the same schedule applies after seek, loop, save/load and offline rendering. Immediate knob moves use bounded audio-clock parameter ramps. `automation.clear` removes the persisted lane schedule.

`live.render` snapshots rack definitions and automation. Its history begins empty at the requested range start, automation retains timeline-relative time, and the result has exactly the requested duration. It does not include unrequested trailing reverb/delay. The archive recorder captures the currently running history and feedback instead.

## Device, loop and archive lifecycle

`AudioDevices` lists devices without requesting access. Microphone/display acquisition is explicit. Monitoring defaults off. Requested browser processing constraints and returned native settings remain distinguishable. A display capture that supplies no audio closes all acquired audio/video tracks and reports the missing audio. Permission denial and device disappearance remain visible in state.

Input PCM subscriptions supply bounded interleaved chunks with sequence, starting frame, sample rate, layout, channel count and explicit dropped-frame accounting. Slow subscribers cannot create an unbounded queue. Stopping input deactivates subscriptions and closes every acquired track.

Loop capture uses AudioContext sample-frame boundaries with beat/bar or immediate scheduling. Input/track capture has a direct worklet transition at the captured end boundary. Master-source capture detaches its input before connecting the loop back to the master, avoiding a feedback graph cycle; this handoff can introduce a short main-thread-dependent transition gap while the loop retains its scheduled audio-clock phase. Loop state reports the transition type and observed handoff delay in frames/seconds. Each completed capture creates a new editable track with independent play, stop, mute and remove controls. A late stop request cannot claim to remove frames that were already captured; the acknowledged boundary is the actual captured frame boundary.

Project replacement/reset stops transport, input, loops, notes and capture resources. Generation checks also cover delayed worklet initialization and delayed recording taps. A late initialization cannot revive a previous project or dispose a newer graph. `resetProject({preserveSettings:true})` supports output-layout changes: playback stops, graph channel counts rebuild lazily, and rack definitions remain available. Loading live settings replaces stale stopped graphs and never restores active device permission or recording state.

Long recordings use a dedicated storage worker, interleaved float PCM in OPFS, and alternating generation-numbered manifests. Audio bytes are flushed before their manifest commit. Recovery considers only owned archive paths, validates manifests and clamps the confirmed frame range to the actual payload. Pause omits wall-clock gaps. Backpressure, capacity and quota failures stop with a recoverable confirmed range.

Archive reads are deliberately excluded during active recording because the storage worker serializes disk work. Pause/stop first; the currently open recording must be stopped before reading its archive. This avoids a large range/export read starving capture writes. Exports stream to a chosen writable handle and use RF64 when RIFF's size field would overflow. Without a streaming destination, export is limited to a 64 MiB range. Range audition/import read only the requested section, bounded by the editor's duration/PCM limits. Failed or cancelled exports abort the destination.

## Resource admission and performance

| Resource | Enforced limit |
| --- | --- |
| Resident editor/range PCM | 256 MiB and at most 600 seconds, whichever limits the requested layout/rate first |
| Independent playback PCM | 256 MiB across the aligned track buffers |
| Aggregate live DSP state/scratch estimate | 64 MiB, validated at the actual context sample rate and channel count |
| Live graph/stage counts | 65 graphs including master; 128 total stages; 12 stages per rack |
| Program/loop/MIDI voices | 128 voices and 256 MiB total voice PCM reservations |
| Automation lanes plus queued parameter events | 8,192 points/events across all racks |
| Loop capture PCM | 64 MiB for the capture buffers |
| Disk queue | 8 MiB queued PCM; bounded worklet buffer pool; at most 32 storage requests |
| Input consumers | 8 subscribers, each with 1–16 queued bounded chunks |
| Archive settings | At most 24 hours / 512 GiB per recording, constrained further by actual quota; 1,000 owned records |

Admission tests request excessive eight-channel/high-rate graphs and verify that rejection occurs before graph allocation, preserving the current node and its output. They also combine automation points and pending events across multiple graphs rather than checking each graph separately.

The CPU benchmark processes one second of synthetic 48 kHz audio in 128-frame blocks, after 32 warmup blocks. This is Node CPU throughput, not measured device latency. The final recorded run was:

| Channels | Rack | Wall time per audio second | Estimated DSP state/scratch |
| --- | --- | ---: | ---: |
| 2 | Filter, delay, reverb | 53.243 ms | 1,197,056 bytes |
| 2 | All twelve effects | 241.505 ms | 7,038,080 bytes |
| 6 | Filter, delay, reverb | 200.220 ms | 3,578,880 bytes |
| 6 | All twelve effects | 521.822 ms | 21,065,088 bytes |
| 8 | Filter, delay, reverb | 176.650 ms | 4,769,792 bytes |
| 8 | All twelve effects | 812.760 ms | 28,078,592 bytes |

The eight-channel twelve-effect case uses substantial CPU time in this environment. Memory admission is not a promise that every admitted combination meets an audio deadline on every device. Several heavy racks, high sample rates, other active processing and browser scheduling can exceed the available CPU budget. The unequal six/eight-channel short-run timings also show why these figures should not be treated as stable hardware rankings.

## Concrete defects found and corrected during implementation

| Finding | Impact | Regression evidence |
| --- | --- | --- |
| Recipe `params || {}` accepted false/zero/null | Raw recipes differed from direct parameter validation | Prior gain step rolls back for six invalid parameter forms |
| Future parameter values entered current settings early | Offline export changed audio before a scheduled event | Exact pre-event samples, persisted schedule and load/render equivalence |
| Event/point admission counted only unacknowledged messages | Acknowledged future controls could exceed the shared queue | Two graphs fill the combined 8,192 budget; next change sends no mutation |
| Changed effect retained incompatible queued controls | A later event could address a removed parameter | Effect replacement clears only incompatible scheduled state |
| Surround speed used an invalid temporary sample-rate tag | Valid 8 kHz/192 kHz varispeed endpoints rejected | Both endpoints and both rate extremes for 5.1/7.1 |
| Input stop changed the global project generation | Stopping input cancelled unrelated master capture | Master capture remains valid and commits one layer |
| Late graph/tap completion crossed project reset | Old callbacks could reactivate resources | Delayed graph/tap tests assert disposal and protect newer graphs |
| Concurrent recorder cleanup finalized twice | Device/reset paths could race a user stop | Shared completion promise and equal stop results |
| Ordinary playback and loop ownership overlapped | A track could play twice | Track source released before loop; all-loop plan uses silence only for clock |
| Layout/settings replacement reused old graph definitions | Channel count or effect selection could stay stale | Rebuild assertions with retained settings and new channel count |
| Input cleanup cleared denial status | UI could lose the actual device failure | Denial remains visible with inactive input |
| Archive reads could block capture writes | Long exports risked bounded-pool exhaustion | Active-recording read rejection without stopping capture |

## Remaining verification boundaries

`tests/live-audio.spec.js` contains production-browser tests for actual bundled AudioWorklets, audible master PCM, OPFS pause/resume, WAV export, archive reload/recovery, sample-clock loop insertion and fake-browser microphone cleanup. The UI lane also supplies end-to-end interaction tests. These browser gates run through CI; they were not represented as locally executed browser tests in this report.

The local OPFS/device tests use explicit synthetic adapters, fake tracks and small PCM buffers. The RF64 test constructs an eight-hour size header without allocating or recording eight hours of audio. No physical guitar/pedal latency, surround audio-interface routing, multi-hour physical capture or hardware-specific browser processing has been claimed.

Pitch-preserving stretch and duration-preserving pitch shifting remain explicitly mono/stereo capabilities of the current SoundTouch path. Surround varispeed, ordinary DSP, all live effects, mixing, WAV and compatible codec paths retain all channels. Unsupported surround time/pitch combinations reject instead of processing only the front pair. Existing playback buffers are snapshots: committed PCM edits take effect on the next playback start; live effects and automation affect the current playing sources.

The final release still requires the combined CI gates, source/deployment match and deployed beta verification recorded by the release owner.

## Post-checkpoint codec output resource fix

The release review identified a concrete high-severity export allocation gap in the native FFmpeg path. A valid 600-second, eight-channel, 8 kHz source occupies 153.6 MB of float PCM, but requesting 192 kHz/32-bit WAV projects 3,686,400,000 payload bytes. The prior encoder had no output `-fs` bound or filesystem size check before `readFile`; the workbench's later artifact limit could therefore reject only after creating and reading the large file.

`codec-budget.js` now admits export dimensions before layout conversion, resampling or uncompressed container allocation. Projected float PCM is limited to 256 MiB and ten minutes. In-memory encoded outputs have a 128 MiB ceiling, with conservative container/encoder guard space. Uncompressed WAV/AIFF projections include bounded metadata/header allowance and reject before allocation when they cannot fit.

Native FFmpeg receives an output `-fs` limit. Its output is checked with filesystem `stat` before `readFile`; a file at or near the stop threshold is rejected as potentially truncated, never returned as a successful shortened export. The browser FFmpeg wrapper/core pinned in this repository exposes `ffprobe`; it writes only `format=size` into a tiny report, validates that size, and transfers the output file only after the check. The browser output also has `-fs`. Opus worker encoding counts page bytes against the same maximum before building the final concatenated output. Native decode likewise checks its already bounded output file before reading it.

The policy accepts a smaller internal `maxOutputBytes` value so artifact collectors can enforce their remaining budget before encoding. It is not an arbitrary user-provided filesystem or FFmpeg option. This cap applies to in-memory codec exports; disk-backed archive WAV/RF64 streaming remains a separate path and can export long recordings without constructing an oversized byte array.

The same `exportLimits` values are exposed by native codec capabilities, browser codec capabilities and `audio.capabilities`: encoded bytes, projected PCM bytes, maximum duration, guard space and the separate streaming-archive path. An additional regression compares the native/browser reports against the shared policy.

Follow-up command:

```sh
node --test tests/codec-budget.test.js tests/codecs.test.js \
  tests/opus.test.js tests/metadata.test.js
```

Result: **21/21 tests passed, zero skips**, including six new resource regressions. They cover the exact multi-gigabyte projection using dimensions only, small injected limits in both encoder entry points, an injected native stat/read oracle that proves oversized files are never read, a browser ffprobe/read oracle that proves only the tiny report is transferred on rejection, Opus page limits and cleanup, and a real small native FFmpeg `-fs` truncation case. The tests allocate only short synthetic audio; no multi-gigabyte file or buffer was created. The earlier 157-test owned regression run is preserved above rather than misrepresented as a subsequent combined run.

## Post-checkpoint paused-transport ramp correction

A reproduced live-control defect affected input monitoring and independently playing loops when ordinary transport was paused. The transient manual ramp used transport timeline time; with timeline rate zero, a scheduled ten-millisecond wet/dry change remained at its initial value indefinitely. A pure DSP reproduction processed 2,048 frames at 8 kHz with a frozen timeline and still observed wet zero plus one pending ramp.

Transient manual ramps now advance on the DSP's audio sample clock. The worklet translates the runtime's AudioContext time into that clock when it receives the gesture. Persisted explicit time/beat schedules remain automation lanes evaluated on transport time, so pausing the transport still pauses a written timeline sweep. The regression proves both behaviors in the same real DSP kernel: the manual ramp completes with zero pending events while a later timeline point remains unapplied until timeline time advances.

`tests/live-audio.spec.js` also includes a production-browser test using a known synthetic tone captured into an independently playing loop. It pauses ordinary transport, applies a fifty-millisecond manual wet/dry ramp, records the real master output, and compares RMS before and after the gesture. This is an actual worklet/recording test for CI, not a claim of physical guitar/microphone measurement.

The most recent focused Node run was **42/42 passed, zero skips**:

```sh
node --test tests/codec-budget.test.js tests/realtime-dsp.test.js \
  tests/live-audio.test.js
```

This includes the capability-limit regression added after the 21-test codec run. No additional hardware or browser execution is implied by these Node results.

## Browser CI 44534120888: concrete corrections

The first combined production-browser run reported **39 passed, 16 failed, one skipped**, after the unit/fuzz/build and native Audacity/REAPER gates passed. The failure log is preserved in `test-results/audits/ci-44534120888.log`; browser traces were downloaded under the matching audit directory. The source fixes below retain the meaningful browser assertions. Their next complete browser execution remains a CI release gate.

| Reproduced cause | Correction and regression |
| --- | --- |
| Recording worker called `.map` on a manifest's numeric `channels`, failing start/pause/stop replies. | Transfer PCM buffers only when `channels` is an actual array. A harness imports the actual worker module, applies structured-clone transfers and completes start/append/pause/resume/stop/range/recover/list/delete with exact stereo PCM. |
| Pinned FFmpeg core 0.12.10 leaves `ret` at `-1` for successful `ffprobe`, despite producing a valid size report. | Accept only `0`/`-1` with a freshly truncated, strictly numeric report and the existing size threshold. Actual pinned WASM tests cover success, oversized output, missing input and failed probe status. A real read-only stale-report fixture proves a failed truncation stops before probing or reading the source file. |
| Loop boundaries were chosen before asynchronous graph/worklet preparation. A late worklet lost 64 samples from the requested 6,000-frame capture. | Arm after preparation. If the processor still receives a late boundary, shift the full requested period to the current frame or next quantized grid point and acknowledge its actual bounds. The actual processor harness reproduces a 64-frame-late start, checks all 6,000 captured samples and verifies repeat phase. |
| Master capture output was routed back to its own source while that source remained attached. | Keep master capture output off the live master until completion; detach the capture source before connecting playback. Actual `CaptureTap` connectivity is checked before and after handoff. Input capture preserves its direct audio-clock transition. |

The cycle correction follows the [Web Audio rendering algorithm](https://www.w3.org/TR/webaudio/#rendering-loop): cycles remaining after delay-node processing are muted. The chosen master handoff adds no hidden delay effect and does not restart or shift the loop anchor. Its narrow limit is that the audible master-capture transition waits for main-thread delivery/connection; the delay is not a hardware-independent constant. Completed loop state exposes `transition`, `transitionDelayFrames` and `transitionDelaySeconds`, and armed capture state exposes `transition`. Input/track captures use `audio-clock`; master capture uses `main-thread`.

Focused verification after these corrections: **35 passed, zero failed, zero skipped**:

```sh
node --test tests/codec-budget.test.js tests/capture-worklet.test.js \
  tests/recording-worker.test.js tests/recording-store.test.js \
  tests/live-audio.test.js
```

These are direct module/WASM executions with explicit synthetic I/O. The production-browser loop test additionally retains its precise duration assertion and now checks exactly 6,000 frames, non-silent captured audio and the reported master transition. No local browser or physical-device run is represented by the Node results.
