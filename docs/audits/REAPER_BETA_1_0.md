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

## Native grammar probe and remaining acceptance gate

The official REAPER 7.86 executable and checksum are pinned in the native harness. The native grammar probe **passed** in [Actions run 44514197389](https://github.com/djshellshoxxx/websoundedit/actions/runs/44514197389), job `135525836904`, artifact `14524629673`, tested head `b3b7f585e17ac0d8dee27cb1b4cd42c676410778`. The process reported version `7.86/linux-x86_64`, script outcome `OK`, exit code `0`, no signal and no timeout. An untouched native project, native setting dump and provenance are retained in `tests/fixtures/reaper-7.86/`.

The saved native records corrected two implementation-stage field mappings: the track `VOLPAN` third argument is its pan law, and the item `FADEIN`/`FADEOUT` third argument is automatic fade duration. The reader now distinguishes those fields and the writer emits the observed native shape. The genuine file also establishes the default `FIXEDLANES 9 0 0 0 0` record when fixed-lane mode is inactive, and empty project tempo/master-speed envelope containers. Those specific inert forms are accepted; active fixed lanes, envelope points, nonzero fades and unsupported pan laws still reject in regressions.

The first probe set tempo after creating beat-attached items. Native REAPER consequently changed their start, duration and take playback rate. The original project is preserved as a stretch-rejection regression; a separately derived no-stretch test exercises its default records. The next probe/full harness sets tempo before constructing items and markers, and uses the current documented zero automatic-fade duration. PCM/trim/timing assertions were not relaxed.

Local tests and a native grammar probe do not establish full audio interchange. The final native gate must still prove opening WebSoundEdit exports, full master rendering, native saving/reimporting and independent native-origin import in mono, stereo, 5.1 and 7.1. Native pan gain, output channel order and rendered PCM remain subject to that gate until actual results are recorded. No local GUI sandbox workaround was used.
