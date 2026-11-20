# Post-beta reliability and stress review

Base examined: `83c1dcfb1a78b7d9a8448f4f08a8aa4bdc766166`. This lane covered editor recovery, file/export ownership, archive and parser boundaries, recording storage, command/resource limits, and companion shutdown. All fixtures use synthetic audio. Browser, deployment, new feature and physical-device qualification belong to the final integration record.

## Reproduced defects and corrections

| Finding | Reproduction and effect | Correction and regression |
| --- | --- | --- |
| Recovery reappears after Clear | Hold the actual recovery callback at `project.save`, clear the stored record, then release the snapshot. The previous code writes the removed project back to IndexedDB. | `RecoveryScheduler` invalidates stale snapshots and serializes writes with clears. A clear waits behind an already-started write. New edits can still create a new recovery copy. Tests cover both race windows, batch cancellation, stale success/error messages and storage errors. |
| A late stem export erases a batch output collection | Hold a real-editor stem render, start a new collection and acquire batch ownership, then release the earlier export. Its correct `BUSY` rejection used to run a `finally` block that replaced the newer collection with `null`. | Internal stem encoding no longer changes the shared collection. The regression preserves an existing batch result, and a separate test verifies that only the final ZIP enters a collection. |
| Encoder shutdown discards a valid slow tail | The original full Node suite passed 333/334 tests; the native Opus streaming case was killed at the two-second flush deadline under load. A deterministic delayed-encoder reproduction also shows that a valid 2.5-second finalization is killed. | Encoder finalization has an advertised ten-second ceiling, followed by the existing two-second UDP drain ceiling. Tests prove a slow successful tail is delivered and an unresponsive encoder is still killed at the finite deadline. Nonzero/forced exits remain errors. |

The reviewed import/archive paths retain their existing size, path, CRC, finite-PCM and decompression-work checks. This focused review does not claim exhaustive security coverage.

## Executed qualification

```sh
node --test --test-concurrency=2 \
  tests/recovery.test.js tests/file-concurrency.test.js \
  tests/editor-stress.test.js tests/beta-ui-logic.test.js \
  tests/companion-audit.test.js tests/companion.test.js
```

Result: **43 passed, zero failures, zero skips**, about 4.0 seconds on the final lane run. The suite includes genuine native FFmpeg Opus, MP3, AAC/TS and FLAC stream/decode checks in addition to synthetic lifecycle cases. Earlier failing cases were rerun after their corrections. JavaScript syntax and `git diff --check` also passed.

## Stress scenarios

- Create **64 tracks and 512 clips**, then reject another track and another clip without changing the saved project.
- Perform **40 edits**, traverse **30 undo/redo pairs**, and run **40 JSON save/reopen plus float-WAV encode/decode cycles**. Compare the mix with an independently calculated signal sum and preserve the complete portable project. Retained PCM history is **8,126,464 bytes**, within the existing bounds; this is the engine's PCM accounting, not a process-heap measurement.
- Produce **192 WAV stems** in three consecutive 64-track ZIP collections. Verify every track once, output PCM, collection accounting, no unintended downloads and unchanged editor state.
- Coalesce **2,000 recovery schedule requests** into the expected write/cancel operations using deterministic timers.
- Put a **32-frame, eight-channel, 192 kHz** clip near the ten-minute timeline limit. Reject the projected multi-gigabyte full render before allocation while retaining valid raw clip export and the original session.

These stress checks exercise supported object-count limits and repeated operations with small allocations. They do not attempt to exhaust a browser or shared host, or establish a hardware-independent latency guarantee.
