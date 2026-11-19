# Published 0.2 interchange baseline audit

Date: 19 November 2026. Audited runtime: published main `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`, after the owner confirmed successful Pages deployment in run `44497716093` and the live `app-75ZGK-o6.js` asset. The branch specification and this audit add documentation/tests only; this report does not claim fixes or beta implementation.

## Evidence and scope

Reviewed `src/audacity.js`, `src/audacity-xml.js`, `src/metadata.js`, the portable-session loader boundary, relevant `fflate` and `@xmldom/xmldom` implementation paths, and Audacity's primary source for channel/clip serialization. The core-audio audit separately owns WAV and engine/session fixes; MIDI and browser UI have separate audit lanes.

Executed on Node **v24.22.3**, Linux, using the exact lockfile: `sql.js 1.16.0`, `fflate 0.8.3`, `@xmldom/xmldom 0.9.12`.

```sh
node --test tests/audacity.test.js tests/metadata.test.js
node tests/fuzz/interchange-baseline.mjs --out docs/audits/INTERCHANGE_BASELINE_0_2.json
```

The existing suite passed **15 tests**, including actual ffprobe metadata checks. The deterministic audit executed **1,691 corpus cases and six focused reproductions**, seed **`0x41554459`** (`1096107097`). [Machine-readable results](INTERCHANGE_BASELINE_0_2.json) contain exact source SHA-256 values, all counters, exception categories, failing case identity and observed timings. [The runner](../../tests/fuzz/interchange-baseline.mjs) regenerates inputs in memory; it does not retain large binary fixtures. The largest deliberately inflated focused payload was 1,048,629 bytes. No exhaustion test was performed.

| Corpus | Cases | Accepted | Rejected | Accepted result failed its invariant |
| --- | ---: | ---: | ---: | ---: |
| Legacy XML byte mutation/truncation | 256 | 10 | 246 | 0 |
| Binary XML mutation/truncation | 256 | 10 | 246 | 0 |
| AU block mutation/truncation | 256 | 151 | 105 | 0 |
| Legacy ZIP mutation/truncation | 256 | 11 | 245 | 0 |
| AUP3 SQLite mutation/truncation | 256 | 186 | 70 | 1 |
| Six numeric-field boundary families | 132 | 20 | 112 | 0 |
| Unsafe ZIP paths | 7 | 0 | 7 | 0 |
| XML depth | 8 | 4 | 4 | 0 |
| XML trust-boundary examples | 8 | 3 | 5 | 0 |
| Metadata shapes, fields and limits | 256 | 48 | 208 | 0 |

Acceptance of an arbitrary mutation is not itself a defect: many mutations affect unused SQLite bytes, AU waveform summaries or harmless attributes. The runner checks that accepted project results load into `AudioEditor`, accepted AU PCM is finite and correctly sized, binary XML can pass through the text codec, and input byte arrays remain unchanged. No input mutation or global prototype modification was observed. No hangs or process crashes occurred in this bounded run.

## Confirmed findings

### INT-01 — P1: generated SQLite columns execute before document bounds are enforced

**Location:** `src/audacity.js`, `importAup3`, table-kind validation and subsequent `length(dict)` / `length(doc)` queries.

The importer checks that `project` and `sampleblocks` have SQLite type `table`, but does not check their column definitions. A virtual generated column is part of an ordinary table and passes this check. `trusted_schema=OFF` does not prohibit all built-in expressions in generated columns.

**Reproduction:** focused case `sqlite-generated-column` creates a 12,288-byte AUP3-shaped database. Its `doc` column is computed from `CAST(substr(hex(zeroblob(1048576)),1,0)||source AS BLOB)`. The expression creates a 1 MiB zero blob and a 2 MiB hexadecimal string to return the stored 51-byte document. Import succeeds as `Computed schema`, including the editor loadability check. The final recorded focused run took 30.151 ms; that timing includes fixture creation and is not a performance guarantee.

**Effect:** caller-controlled schema expressions can consume work and transient memory before the importer's final BLOB size checks. A larger expression is not constrained by the small on-disk file or resulting document size. The audit did not execute a large allocation, demonstrate code execution, or establish filesystem/network access. The confirmed issue is bypass of intended parsing resource bounds.

**Required fix:** validate genuine ordinary table/column structure before selecting document/sample values. Reject virtual tables, generated/hidden columns and incompatible types/keys; retain supported ordinary Audacity schemas. Keep `trusted_schema=OFF`, `query_only=ON`, bound queries and parameterized block IDs. Add a regression requiring this small fixture to fail before expression-bearing columns are read.

Primary references: [SQLite generated columns](https://www.sqlite.org/gencol.html), [trusted_schema behavior](https://www.sqlite.org/pragma.html#pragma_trusted_schema). The executable reproduction, rather than those general documents alone, establishes the application finding.

### INT-02 — P2: understated DEFLATE sizes evade the actual output-work bound

**Location:** `src/audacity.js`, `zipFiles`, central-directory size validation followed by `unzipSync`.

**Reproduction:** focused case `zip-deflate-size-understatement` makes a 1,209-byte ZIP whose real XML-plus-space payload is **1,048,629 bytes**. Both local and central headers claim **53 uncompressed bytes**. Import succeeds as `Bounded`; the focused run took 34.834 ms.

**Effect:** `fflate` receives a buffer sized to the declared output. In this DEFLATE path it continues expanding the stream and returns the truncated prefix. The fixed buffer prevents the demonstrated case from allocating its full real output; this is **not** a demonstrated unlimited output-buffer allocation. It does mean the advertised decompressed-size budget does not bound actual inflate work, and an inconsistent archive is silently accepted.

**Required fix:** use the same validated entry list for extraction and enforce the declared and aggregate output limits during expansion, before processing bytes beyond the permitted output. Reject declared/actual length disagreement. A CRC check alone is insufficient if it is performed only after unbounded expansion. Preserve existing EOCD-comment, count, ZIP64, path, encrypted/multipart and payload-range protections.

### INT-03 — P2: ZIP checksums are never verified

**Location:** `src/audacity.js`, `zipFiles` extraction.

**Reproduction:** focused case `zip-crc-mismatch` sets both local and central CRC-32 fields to zero in a 173-byte archive. The project imports successfully. The same code path handles PCM AU entries, so damaged but otherwise parseable samples can pass silently.

**Effect:** archive integrity is not checked. A CRC is a corruption detector, not an authenticity or security signature; no authenticity claim is implied here.

**Required fix:** verify each extracted supported file's CRC-32, exact output length and coherent local/central metadata before returning the archive map. Regression fixtures should cover corrupted XML, corrupted AU PCM and unchanged valid archives.

### INT-04 — P3: accepted AUP3 PCM can violate the editor's documented sample bound

**Location:** `src/audacity.js`, AUP3 sample decoding and `decodeAudacityAU`; compare the core `checkAudio` bound in `src/engine.js`.

**Reproduction:** seed `0x41554459`, `aup3-sqlite` case **14**, input SHA-256 `c76b1274057ad563c7020058082d899a451be4a5d65acab545a58e2f9901ddc8`, is accepted by `importAudacity` but rejected by `project.load`. The focused reproduction sets a sample to `100000000`; import succeeds, then the engine reports `PCM contains a non-finite or unreasonable sample.`

**Effect:** the import function can return a project that its consumer cannot load, and performs avoidable serialization/allocation before the useful error. The editor still rejects the sample; this audit does not claim that it plays or is committed to an existing project.

**Required fix:** apply the same finite/sample-magnitude policy during AU and AUP3 decoding. Keep the core validation as defense in depth. Add positive/negative boundary and large-finite-value regressions.

### INT-05 — P3: binary XML writer and reader disagree at the depth limit

**Location:** `src/audacity-xml.js`, `encodeBinaryXML` uses `depth > 64`; `decodeBinaryXML` uses `stack.length >= 64`.

**Reproduction:** focused case `binary-writer-reader-depth-boundary` builds a root plus 64 descendants. The writer accepts it; its own reader throws `Audacity XML is too complex.`

**Effect:** an internal codec boundary is inconsistent. Normal editor-generated projects are much shallower, so this is not established as a normal-project data-loss defect.

**Required fix:** define one maximum element depth/count convention and use it consistently in text and binary read/write paths. Test the accepted limit and the first rejected level.

## Confirmed resource-hardening gap, without an exhaustion claim

### INT-H01: XML attributes are not included in the preparse complexity budget

`readXML` counts markup tokens before constructing a DOM, then checks element depth/count afterward. It does not bound attributes per element or across the document. Focused case `xml-attribute-count` accepts **10,000 attributes in a 98,900-byte single-element document**, taking 70.575 ms in the recorded run. This bypasses neither the 8 MiB text limit nor the element limit; attributes simply have no explicit object-count budget.

Add an attribute/token/depth preflight before DOM allocation, or a bounded streaming builder, using limits generous enough for real Audacity fields. The run did not approach the full 8 MiB attribute case or exhaust memory. Treat the measured acceptance as the confirmed gap and larger resource impact as a risk to mitigate, not a measured result.

## Boundaries that held in the exercised cases

- All seven traversal/absolute/backslash/NUL ZIP path examples were rejected. Existing tests also rejected mismatched directory counts, ZIP64 locators, stored-size mismatch and invalid local payload offsets; an EOCD signature inside a valid ZIP comment did not redirect extraction.
- Internal DTD/entity declarations, compressed legacy external-audio references, known unsupported plugin/note/time-track data, nonempty envelopes, overlapping native clips, recovery/autosave state and missing sample blocks were rejected in the combined targeted suite/corpus.
- External DOCTYPE text was removed without fetching its target; the implementation uses an in-memory XML parser and supplied companion files. No imported reference initiates a host file read or network fetch.
- SQLite block queries use bound parameters, the database is read-only after creation, and handles/statements are closed in `finally`. INT-01 shows why these measures do not replace schema validation.
- Known metadata fields have plain-object, type, control-character, individual-length and aggregate UTF-8 limits. Output arguments are structured, not shell fragments. The ffprobe tests confirmed tags in the tested output containers.
- Existing overlap-lane, pan-law and native Audacity behavior remains covered by the prior published release gate. This audit ran **no new native GUI session** and makes no new native-version compatibility claim.

## Fix-stage handoff

Runtime files were deliberately left unchanged pending collection of the baseline audit lanes. Prioritize INT-01, then combine INT-02/03 in a bounded archive extractor with CRC verification. Apply INT-04/05 and INT-H01 with focused regression tests. Re-run the unchanged audit seed and the native Audacity gate after fixes, preserving this JSON as historical baseline evidence and saving fixed-stage evidence separately.

The independently reported engine base64 stack overflow also affects `exportAudacity`, which validates portable projects through `project.load`. The core-audio audit owns that root-cause fix. Passing the listed corpus is not proof that all parser bugs, all Audacity versions or worst-case resources are safe.
