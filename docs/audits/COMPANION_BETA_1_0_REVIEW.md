# Independent companion / headless boundary review

Scope: read-only review of `scripts/server.mjs`, `scripts/node-runtime.mjs`, `scripts/udp-streams.mjs`, `src/companion.js` and `scripts/cli.mjs` during 1.0 beta implementation. Supporting command schemas, codecs and admission code were read to follow these boundaries. The root owner makes implementation changes; this review adds only independent tests, fuzzing and evidence.

Reproduce the focused cases with:

```sh
node --test tests/companion-audit.test.js
node tests/fuzz/companion.mjs docs/audits/COMPANION_BETA_1_0_FUZZ.json
```

The tests use synthetic owned UDP sockets/encoder processes and authenticated loopback HTTP. The browser race uses the supported injected-fetch adapter to model a completed response racing cancellation; it does not claim that every browser delivers an aborted fetch response. No external UDP receiver, microphone, native encoder or user directory is involved.

## Confirmed findings

The initial focused run had **8 tests: 3 passed, 5 failed**, zero skips, Node `v24.22.3`, 521.824 ms. These are implementation-stage findings, not reports of exploitation of a published release.

| ID | Severity | Exact reproduction and observed effect | Required correction / owner status |
| --- | --- | --- | --- |
| CMP-01 | P2 | Hold the promise returned by `UdpStreams.getCapabilities()`, call `start()`, call `stop()`, then release capabilities. `stop()` returns inactive while the pending `start()` subsequently creates a socket and returns an active session. | Root added an owned startup controller and cancellation across capability/connect/spawn waits. Independent regression passes: stopped startup cannot become active. |
| CMP-02 | P2 | Start an encoded stream with an injected child, call `stop()`, then have the child close with exit code 17 when stdin finishes. The stopped result has `error:null`. The close handler suppresses failures whenever `stopping` is true. | Root retains nonzero encoder exits and input/flush errors during stopping while reaping resources. Independent regression passes: the stopped result reports the encoder failure. |
| CMP-03 | P2 | Use actual loopback HTTP to start a stream while its synthetic socket connection is held. Abort the HTTP request, then release the socket connection. Admission is released, but the stream becomes active and its socket stays open. | Root forwards the execution signal through the Node stream adapter and enforces it during startup. Independent HTTP regression passes: no active stream remains and its owned socket closes. The original reproduction did not establish ongoing audio capture. |
| CMP-04 | P2 | Start the browser bridge, delay its successful start response, disconnect, then deliver the completed response through the injected fetch adapter. The bridge remains disconnected but changes `stream.active` to true and subscribes to live PCM. | Root rechecks connection generation, local startup cancellation and connection state after the response. Independent regression passes: no active local stream or input subscription is restored. |
| CMP-05 | P2 | Start `NodeWorkbench` macro `wait({seconds:1});`, wait for its start event, then make a competing direct `macro.run` call. The second call correctly rejects `MACRO_BUSY`, but its wrapper's `finally` sets the first run's public `running` status to false. | Root rejects a competing run before replacing the active state. Independent regression passes: the first macro continues to report running. This direct API case never bypassed the interpreter's single-run lock. |

The focused tests retain cleanup in `finally` blocks and release held gates even when an assertion fails. They assert the intended corrected behavior, so unresolved defects make the command exit nonzero.

Independent correction rerun: **8 / 8 focused tests passed**, zero failures/skips, in **457.024 ms**. The root owner separately reported the eight original companion tests passing; this review's eight-case rerun and the deterministic corpus below are its independent evidence.

## Passing boundary controls and source observations

- Exact Host, Origin and bearer checks passed: missing/wrong credentials return 401; a foreign Host or non-allowed Origin returns 403; the configured exact Origin and a body-free allowed preflight work. The Host test uses `node:http` because Fetch normalizes a caller-supplied Host. No authorization bypass was observed.
- An authenticated body larger than a configured 1 KiB request limit returns 413, restores admission job/byte counters to zero and leaves the editor unchanged.
- A two-input batch uses separate editors, preserves the parent project's full serialized state, produces distinct safe output names and accounts for both retained artifacts and their bytes exactly.
- The server binds through `startApiServer()` to `127.0.0.1`; privileged routes check the bearer token. The browser bridge keeps the token in a private in-memory field and sets redirect rejection, omitted credentials and loopback address-space intent on requests. Imported project text is not used as an endpoint.
- UDP targets are operator-configured literal IP/port entries selected by an ID. Encoder arguments are assembled as an argument array for a fixed `ffmpeg` executable with `shell:false`, fixed input/output pipes and enumerated profiles. Macro parameters do not choose arbitrary commands, URLs or filesystem paths.
- Node file imports resolve explicitly supplied byte aliases. CLI paths come from explicit operator arguments; macro export names are sanitized and sink writes use exclusive creation (`wx`) with bounded collision handling. Review found no macro-to-filesystem-path or shell-injection path in the exercised implementation.
- Body, source PCM, retained artifacts, packet and encoder-queue bounds are separate controls. The fuzz suite checks rejected PCM atomicity, packet sequencing, exact raw output, queue draining, startup cancellation and repeated cleanup using bounded fixtures. It does not run memory-exhaustion payloads.

## Deterministic corpus and remaining limits

`tests/fuzz/companion.mjs` uses seed `0x434f4d31`. The corrected implementation passed **2,056 / 2,056 cases**, zero invariant failures, in **1,008 ms** on Node `v24.22.3`. Corpus SHA-256: `835c8cb7036b136335dad15d095ca44fa9c17bfabec60b10879cb32d2e638d73`.

The executed corpus contains 1,024 schema cases (512 valid, 512 invalid), 768 PCM cases (256 valid, 512 invalid) across mono/stereo/5.1/7.1 and f32/s16 output, eight aggregate output comparisons, 128 lifecycle interleavings and 128 loopback HTTP cases. Each case contributes to the corpus hash. `COMPANION_BETA_1_0_FUZZ.json` records exact counters, source hashes and measured phase durations; invariant failures cause a nonzero exit. Durations describe this run, not a hardware-independent performance claim.

Schema cases distinguish accepted descriptor shapes from cross-field runtime policy. PCM cases check that malformed input changes neither sequencing nor counters and that accepted raw output matches an independent byte conversion. Lifecycle cases cover pending-capability stop/abort/dispose, competing starts, stale browser responses, encoder flush errors, normal cleanup and bounded backlog draining. HTTP cases cover credentials, Host/Origin, malformed JSON, wrong parameter types, oversized bodies and a successful read-only command.

These fixtures do not replace real FFmpeg profile/receiver tests, browser permission testing or the final release workflow. They do not prove exhaustive security, operating-system scheduling behavior, physical-device behavior, UDP delivery/reliability or performance on other hardware. The native REAPER render gate remains independent of this companion review.
