# REAPER / surround interchange implementation audit

Scope: the new RPP grammar, project/media resolver, shared ZIP boundary, native harness and Audacity surround export boundary. This supplements the preserved [published 0.2 baseline audit](INTERCHANGE_BASELINE_0_2.md); it does not replace its historical findings.

## Deterministic evidence

Run `node tests/fuzz/reaper-interchange.mjs docs/audits/REAPER_BETA_1_0_FUZZ.json`.

- Seed: `0x52505031`; Node `v24.22.3`.
- 1,536 text mutations, 512 full import mutations, 256 ZIP mutations and 10 explicit boundary cases: **2,314 cases**.
- Corpus SHA-256: `ed70e4de6972735f8837b588075d07e5977f7222fe68a3e02801a41eac15dae4`.
- 496 syntax parses accepted; 365 were serializable back through the supported writer grammar. Opaque/unknown token forms can parse but are not necessarily writable or importable.
- 39 imports accepted. Every accepted result loaded through the engine's independent project validation and remained within the ten-minute timeline.
- Zero invalid accepted projects, input mutations or ambient network calls. The corpus is small and bounded; no memory-exhausting stress payload was executed.
- The focused REAPER/Audacity/shared archive test command passed **35 tests**, zero skips: `node --test tests/reaper.test.js tests/audacity.test.js tests/interchange-security.test.js`.

The JSON report contains exact counters and measured local duration. Duration is evidence for this run, not a browser or hardware-independent performance guarantee. Passing these cases does not prove the absence of other parser or compatibility defects.

## Findings resolved during implementation review

| Finding | Reproduction / risk | Change and regression |
| --- | --- | --- |
| Physical line allocation | A byte-bounded RPP can contain millions of blank lines; splitting the entire text creates an unnecessarily large intermediate array. | Scan line spans without a whole-file split; cap physical lines at 50,000, including blanks/comments. Boundary regression and fuzz case. |
| Numeric grammar disagreement | JavaScript `Number('0x1')` accepts hexadecimal even though native decimal fields do not use that grammar. | Explicit finite decimal/exponent token grammar. A hexadecimal gain is rejected before conversion. |
| Output-layout sidecar disagreement | A supplied sidecar could declare a layout inconsistent with the RPP's native master/render channels. | Require consistent supported channel counts; reject custom down-routing and contradictory metadata. |
| Audacity accidental surround flattening | Expanding the shared PCM type to 6/8 channels would otherwise feed them to a mono/stereo native writer without meaningful surround routing. | Default rejection; explicit speaker-named split-mono stems preserve individual PCM and enforce track/clip expansion limits. Both AUP3 and legacy AUP are covered. |
| Escaped package metadata expansion | A valid 8 KiB metadata object containing quote characters creates a JSON sidecar larger than 16 KiB. | The sidecar limit is 32 KiB, including JSON escaping and project fields. Maximum quoted metadata round-trips in a focused regression. |

## Explicit security and resource boundaries

Imported RPP is data. The code contains no `eval`, native script executor, ambient filesystem reader or fetch path. Exact absolute media references can only select aliases in the explicitly supplied map. Unique-basename remapping reports what it selected; ambiguity fails. The parser uses bounded UTF-8 bytes, line lengths, tokens, records and nesting before building unrestricted data structures. Project extensions are not restored as executable or armed application state.

ZIP preflight/CRC/DEFLATE protections from the 0.2 audit remain shared and unchanged. Media and decoded PCM budgets are enforced independently. Source clips have explicit frame/timeline bounds. The optional caller-provided media decoder is a trusted adapter and receives the remaining PCM budget; returned data is validated, but the importer cannot prevent arbitrary work inside a caller's own callback.

## Historical native grammar probe

The official REAPER 7.86 executable and checksum are pinned in the native harness. The native grammar probe **passed** in [Actions run 44514197389](https://github.com/djshellshoxxx/websoundedit/actions/runs/44514197389), job `135525836904`, artifact `14524629673`, tested head `b3b7f585e17ac0d8dee27cb1b4cd42c676410778`. The process reported version `7.86/linux-x86_64`, script outcome `OK`, exit code `0`, no signal and no timeout. An untouched native project, native setting dump and provenance are retained in `tests/fixtures/reaper-7.86/`.

The saved native records corrected two implementation-stage field mappings: the track `VOLPAN` third argument is its pan law, and the item `FADEIN`/`FADEOUT` third argument is automatic fade duration. The reader now distinguishes those fields and the writer emits the observed native shape. The genuine file also establishes the default `FIXEDLANES 9 0 0 0 0` record when fixed-lane mode is inactive, and empty project tempo/master-speed envelope containers. Those specific inert forms are accepted; active fixed lanes, envelope points, nonzero fades and unsupported pan laws still reject in regressions.

The first probe set tempo after creating beat-attached items. Native REAPER consequently changed their start, duration and take playback rate. The original project is preserved as a stretch-rejection regression; a separately derived no-stretch test exercises its default records. The next probe/full harness sets tempo before constructing items and markers, and uses the current documented zero automatic-fade duration. PCM/trim/timing assertions were not relaxed.

The grammar probe alone did not establish full audio interchange. The separate full native gate below subsequently supplied the rendered-audio evidence. No local GUI sandbox workaround was used.

## Full native gate — 19 November 2026

[Actions run 44534120888](https://github.com/djshellshoxxx/websoundedit/actions/runs/44534120888), job `135594938041`, passed both native DAW gates. Its overall verification job failed later browser checks (**39 passed, 16 failed, one skipped**); this is native compatibility evidence, not a passing release or deployment claim.

### Exact provenance

- Pull-request candidate: `517f7d33547dfa6fa3b2c83bd223bdca1b11fd4d`.
- Actual checkout, GitHub's `refs/pull/2/merge`: `887497fe5aada524565d24b5948dd4a872624227`, merging that candidate into `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`.
- Checked tree: `62f52485acf68a5efe0d763059f55d426991c5f7`, confirmed identical to the candidate tree.
- Runner: Ubuntu **24.04.5**, image `20261116.133.1`; Node **v24.22.3**, npm **11.19.1**.
- Native version: **REAPER 7.86/linux-x86_64**, recorded in the native-saved RPP headers and checked by each native Lua session. The downloaded official archive passed SHA-256 verification against `c2f9d8616bd1dc6175993b82451e1c6e352c6761e7ae6d72400a3f3dfb03bedb`.
- [Evidence artifact 14537633215](https://github.com/djshellshoxxx/websoundedit/actions/runs/44534120888/artifacts/14537633215), `beta-verification-evidence`, archive SHA-256 `e4058ce4db0e0fc5d1fe82d8b750d5a05561e96ffbe95eb79ff21e6949d5e448`. Its `test-results/reaper-native/report.json` SHA-256 is `62518545010859f826d5dab92a99b2fa569b9292fc66e9d86443eaca89009028`.

`xvfb-run -a node scripts/verify-reaper.mjs test-results/reaper-native` completed successfully. All **eight native sessions** have process evidence showing exit code **0**, `signal: null`, `timedOut: false` and script outcome `OK`. The report has `status: "passed"`.

### Actual full-mix comparisons

All cases used **48 kHz** audio. Each WebSoundEdit-export case compared **7,440 frames** per channel (0.155 seconds); each independently created native project compared **4,320 frames** per channel (0.09 seconds). Values below are maximum absolute sample differences, measured on the native full master WAV render and the editor's rendered mix.

| Layout | Channels | Web export → native render | Native save → Web reimport | Independent native project → Web mix |
| --- | ---: | ---: | ---: | ---: |
| Mono | 1 | `5.960464477539063e-8` | `0` — exact | `5.960464477539063e-8` |
| Stereo | 2 | `5.98374754190445e-8` | `0` — exact | `5.960464477539063e-8` |
| 5.1 | 6 | `6.007030606269836e-8` | `1.3877787807814457e-17` | `6.030313670635223e-8` |
| 7.1 | 8 | `6.007030606269836e-8` | `1.3877787807814457e-17` | `6.05359673500061e-8` |

The existing tolerances were retained: **`4e-5`** for native WAV comparisons and **`5e-7`** for native-save/reimport comparisons. Every channel, frame count and sample rate was checked. The WAV fixture writer is independent of the application WAV encoder, with distinct channel frequencies and impulses. Native assertions also check track/clip counts and names, positions, lengths, active-take and source-channel counts, Always mix behavior, markers and metadata title. The independent native-origin cases check fixed tempo, exact visible trimmed PCM, overlapping clips and the imported full mix. The exported fixtures exercise translated gain/pan and mono tracks mixed into the wider layouts. Native resaves are imported without the original JSON sidecar, so native project fields supply their tags and output-layout interpretation.

Expected conversion notices remain visible: committed audio rather than draft racks, baked visible trims for native-origin clips, and explicit canonical-order interpretation of loose 5.1/7.1 master channels. The passing fixtures do not establish arbitrary plugin, custom-routing, changing-tempo, transformed-take or physical surround-device compatibility. They are short synthetic comparisons, not long-duration capture or subjective musical evaluation.

### Companion CI evidence and scope

The same checkout passed **316 unit/integration tests**, zero failures/skips, in **4,539.387 ms**, all seven deterministic fuzz families, and the production/API build. The REAPER corpus again exercised **2,314 cases**, with zero invalid accepted results, caller-byte changes or ambient network calls. Its CI corpus hash is `b5ba5f5eb812f5d7dedff2d36bf10fd9fa67a692b9a7e163bd27bc9e608c3498`; the earlier implementation-stage corpus record above remains historical.

`npm audit --audit-level=moderate --json` completed successfully and reported **zero known npm vulnerabilities at every severity** for the checked lockfile. The dependency report SHA-256 is `8d848341f190357d152f375f28aa33f0a05be1963c07b515ed81aff28f9f0a92`; the tested lockfile SHA-256 is `7fcaf4987830b0e1890c05179ced60dbff1abef51cdf96004b2136837701c8e0`. This is an advisory-database result for npm dependencies at that run, not a proof of security or an audit of every native/system-library component.

Audacity also passed its three native cases in this run; the [baseline audit's follow-up](INTERCHANGE_BASELINE_0_2.md#native-correction-verification--19-november-2026) records their measured results. Browser failures remain a separate release blocker and are not overridden by these native, unit, fuzz or dependency passes. Subsequent source corrections require the release workflow to verify the resulting checkout again.
