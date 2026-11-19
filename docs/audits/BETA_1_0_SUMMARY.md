# WebSoundEdit 1.0 beta — verification and audit record

Status: release candidate; final native/browser, screenshot and publication evidence is recorded below when those gates finish. The specification was written before implementation in [BETA_1_0.md](../specs/BETA_1_0.md).

## Sequence and scope

The creative 0.2 workbench was published first at commit `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`. Post-publication audio, UI/MIDI, interchange and API audits preserved their original failing evidence. Corrections were applied and verified before the beta expansion. [The baseline summary](BASELINE_0_2_SUMMARY.md) links that historical evidence.

Beta implementation was split between audio/runtime, interface/guidance, project interchange and command/macro/companion work. Independent review produced bounded reproductions before corrections. Review covered command/data boundaries, asynchronous cancellation, ownership of device/worker/socket resources, native project parsing, queue/memory limits, actual output PCM and user-visible recovery behavior. No tests used personal audio or external UDP receivers.

## Executed candidate checks

At the first integrated feature checkpoint, **271 Node tests passed with zero failures or skips**. The later integrated local rerun passed **299/299 tests, zero skips**, including SDK composition, batch ownership across snapshot/execution/restore, import-layout declarations, integer query parsing, conversion resource limits and paused-transport manual ramps. All seven fuzz gates and the full production bundle gate passed again. [Latest local evidence](BETA_1_0_LOCAL_FINAL.json) retains report paths and log hashes; final CI counts remain separate.

The production Vite build and DOM-free `api.js` validation executed a real PCM edit, WAV round trip and interpreted typed macro. The first native REAPER 7.86 grammar probe passed in Actions run `44514197389`, leading to explicit parser corrections for track pan-law and item auto-fade fields. Full native open/render/save/reimport remains a separate gate.

### Deterministic fuzz families

The release gate is `npm run test:fuzz`. Each family saves a machine-readable report under `test-results/audits/` and exits nonzero on invariant failure. Mutation counts are not vulnerability counts: an accepted mutation passes only if its resulting data remains valid, bounded and loadable.

| Family | Candidate coverage | Reproducible source |
| --- | --- | --- |
| Core audio | 2,400 randomized editing commands, 600 DSP cases, 1,800 WAV round trips, 1,800 WAV mutations, rejection/undo/save-load invariants | `scripts/fuzz-audio.mjs` |
| Live and surround | 360 stateful DSP/block-partition/zero-wet/atomic graph configurations, 360 multichannel edits and round trips, 720 malformed WAV checks | `scripts/fuzz-live-audio.mjs` |
| Macro language and schemas | 4,096 parser cases, 512 independently calculated valid programs, 512 invalid/static/dynamic/hostile-data/bound cases; total 5,120 | `tests/fuzz/macros.mjs` |
| Audacity/archive/XML/SQLite | 1,691 mutations/boundary cases and six focused historical reproductions, caller-byte/prototype/loadability invariants | `tests/fuzz/interchange-baseline.mjs` |
| REAPER | 1,536 text mutations, 512 import mutations, 256 ZIP mutations, 10 boundary cases; total 2,314 | `tests/fuzz/reaper-interchange.mjs` |
| HTTP/worker baseline | 1,210 negative cases plus queue saturation/abandonment and worker-failure cleanup | `scripts/audit-api-baseline.mjs` |
| Companion | 1,024 schema cases, 768 PCM cases, eight exact raw-output comparisons, 128 lifecycle interleavings, 128 loopback HTTP cases; total 2,056 | `tests/fuzz/companion.mjs` |

The existing unit suite also retains 8,192 deterministic MIDI/mapping/rack cases. Reports contain seeds and, where relevant, corpus/source hashes. Historical initial failures are kept separately from successful reruns.

## Findings and corrections

Detailed lane reports contain reproductions, severity reasoning, exact tests and limits:

- [Macro audit](MACRO_BETA_1_0_REVIEW.md): static/dynamic validation, bounded AST/data handling, hostile accessors, sparse arrays, forbidden ambient execution, aggregate resource limits and cancellation.
- [Companion/security audit](COMPANION_BETA_1_0_REVIEW.md): pending stream cancellation, encoder flush failure reporting, HTTP abort propagation, stale browser responses and competing macro status ownership. All five original reproductions passed after correction.
- [Audio/runtime audit](AUDIO_BETA_1_0.md): multichannel identity, explicit mixing, graph/voice/event budgets, scheduled automation, input/capture independence, recording lifecycle, storage accounting and performance evidence.
- [UI and batch ownership review](UI_BETA_1_0.md): concurrent edits/exports, delayed file operations, private ownership, recovery persistence and interactive macro behavior.
- [REAPER audit](REAPER_BETA_1_0.md): genuine file grammar, bounded supplied-media aliases, inactive/native record handling and supported interchange boundaries.

Additional integration checks cover preserved original project state during failed file replacement, recorded action portability, explicit clicked-track export, exact same-pitch MIDI timing, tooltip opt-out, batch cancellation/restore and disposal blocking new work. Conversion output uses preflight/frame/output limits and bounded temporary files so an extreme rate/layout request cannot grow without bounds.

## Security properties examined

Macros are interpreted data, without JavaScript evaluation, shell commands or arbitrary filesystem/network access. The runtime validates finite plain data and rejects prototype/accessor forms; static macro validation happens before the first edit, while dynamic values are checked at execution. Imported trigger definitions remain disarmed. Credentials are excluded from saved projects and recordings.

The companion requires a Bearer token, exact loopback Host and an explicitly allowed browser Origin. It accepts supplied file bytes rather than local paths. UDP targets are operator-pinned literal addresses; typed profiles construct fixed encoder arguments with `shell:false`. Input, output, normal request admission, encoder queues, browser chunks and UDP datagrams have independent bounds. Cancellation stays reachable with a full normal request queue. A stalled input has an idle cutoff.

DAW importers validate archive paths, entry overlap, sizes, CRCs, expansion budgets, XML depth/attributes, SQLite table schemas, PCM ranges and media aliases. They do not fetch missing media from network addresses or arbitrary local paths. Unsupported semantic constructs are rejected or explained; file extensions do not masquerade JSON as native projects.

Dependency auditing runs on the exact lockfile in CI. Audio/browser/code review is a bounded audit, not a proof that no defect can exist.

## Native and browser release gates

The verified workflow runs native Audacity and pinned REAPER 7.86 with independent fixtures and comparisons of actual rendered samples. Chromium tests exercise the published-style bundle, actual AudioWorklets, synthetic acquired input, OPFS recording, pause/resume, range export/import, loop layers, UI editing, metadata, codecs and layout choices. Help images are captured from the actual UI with callout locations measured from DOM geometry; they are visually reviewed before being added to the guide.

The main publication job repeats the same required gates, deploys Pages, checks `build.json` against the exact deployed commit and completes a real browser edit. Only then does it create the 1.0 beta prerelease and attach archives/checksums. Final run IDs, counts, commit identity and screenshots are added here after verification.

## Practical limits

The resident waveform editor remains bounded to ten minutes and 256 MiB decoded PCM. Long sets use the disk-backed archive and bounded range operations. Recording estimates depend on real browser storage and hardware; the tests do not claim an uninterrupted multi-hour physical input session. RF64 large-size tests construct headers without allocating hours of audio.

Physical MIDI pedals, guitar latency and 5.1/7.1 output routing were not available to the automated test environment. Their software paths use synthetic devices and explicit matrices. A chosen project layout does not manufacture hardware channels. Pitch-preserving stretch/pitch remains mono/stereo; linked speed, ordinary DSP and compatible formats support surround. Live rendering starts effect history empty at the requested boundary and does not append hidden tails. Key detection is a heuristic. UDP is unencrypted, lossy and not RTP; receiver/format support must match the selected profile.
