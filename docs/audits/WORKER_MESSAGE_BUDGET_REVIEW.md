# Worker message budget review — 2026-11-19

## Scope and provenance

This is a focused review of `src/message-budget.js`, the admission check used by the browser worker client and worker queue. It follows the independent report in [PR #4](https://github.com/djshellshoxxx/websoundedit/pull/4), reviewed at exact head `7825203f55057b1ffe65b2062a5aa8213adbfef2`. Both proposed files and the PR metadata were retrieved through GitHub. The proposal is based on an older beta checkpoint; the reviewed changes were adapted to local checkpoint `56bfd2e` rather than merging that branch.

Only `src/message-budget.js`, `tests/message-budget.test.js`, and this addendum were changed for this review. The worker/client lifecycle and the queue's existing limits are unchanged.

## Reproduced behavior before the fix

All probes used small binary payloads. No oversized structured clone was needed to establish the issue.

| Probe | Observed result before correction | Corrected behavior |
| --- | --- | --- |
| `new Array(1_000_001)` | Estimated as 32 bytes despite its declared length. | Rejects with `RESOURCE_LIMIT` before enumerating indices. |
| Plain object's enumerable payload getter | Getter executed once during the estimate. | Rejects its accessor descriptor without invoking the getter. |
| Genuine typed array with a shadowing `buffer` getter | Getter executed and a 128-byte backing store was estimated as only 32 bytes. | Uses the intrinsic view accessor and charges the complete backing store. |
| Genuine ArrayBuffer with a shadowing `byteLength` getter | Getter executed and the estimate was 32 bytes; the cloned buffer still held 128 bytes. | Uses the intrinsic ArrayBuffer byte-length accessor. |
| Genuine ArrayBuffer with a null prototype | Estimated as 32 bytes. | Intrinsic branding still identifies and counts its 128-byte storage. |
| Map with a null prototype containing 128 bytes of PCM | Estimated as 32 bytes while structured cloning retained the entry. | Rejects unsupported Map/Set containers through intrinsic brand checks even when their prototypes change. |
| Outer array with 600,000 pending values containing another declared 600,000-element array | Nested enumeration began before the processed-node counter could reject the combined width. | Reserves pending traversal capacity and rejects before nested enumeration. |

The proposal correctly addressed ordinary accessor descriptors and sparse arrays. Its binary path still read caller-overridable properties, and its node checks did not include values already waiting on the traversal stack. Those two concrete gaps were corrected during integration.

## Implementation decisions

Arrays must have the normal array prototype and only dense, enumerable indexed data properties. Extra properties, symbols, holes, accessor indices, and hidden indices are rejected. Plain records are traversed through own property descriptors, avoiding property getter execution.

Binary accounting uses intrinsic accessors for ArrayBuffer, typed arrays, DataView, and supported views over SharedArrayBuffer. It counts each complete backing buffer once, including when several PCM channels share storage or a small view references a larger buffer. Caller-defined `buffer` and `byteLength` getters cannot alter the estimate.

The one-million-value ceiling now includes both visited and pending values before new children are pushed. The existing byte ceiling is checked during property enumeration, so an already excessive message stops before additional properties are inspected. Type errors reject unsupported shapes; `RESOURCE_LIMIT` identifies budget exhaustion.

This is data-shape and queue admission, not a sandbox for arbitrary in-process JavaScript. Reflective inspection can invoke Proxy traps. The getter regressions concern own accessors on the supported data/binary shapes; the width test uses a Proxy only as an observation point to prove that nested enumeration never starts after capacity is exhausted.

## Verification

The 12 new regression tests were run against the unchanged pre-fix implementation: **2 passed, 10 failed**. After correction, all 12 pass. The expanded focused run was:

```sh
node --test tests/message-budget.test.js tests/client.test.js tests/api-admission.test.js
```

Result: **20 passed, 0 failed, 0 skipped**. The run includes the actual EngineClient with a structured-cloning worker test double: malformed messages are rejected before `postMessage`, pending entries and byte leases remain zero, and a subsequent valid PCM message resolves successfully. Existing send-failure recovery, worker terminal failure, queue bounds, and HTTP admission tests remain green.

No browser/native test, broad security audit, commit, push, or PR merge was performed as part of this focused change.
