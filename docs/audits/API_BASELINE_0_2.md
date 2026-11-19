# Published 0.2 API and security audit

Baseline: main `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`, tree `cfc2634a1cefa56d9e640665e1d1cd0257c371eb`.

The [Pages workflow](https://github.com/djshellshoxxx/websoundedit/actions/runs/44497716093) completed its deployment on 19 November 2026 at 10:39:32 UTC. A direct browser observation subsequently showed **BETA 0.2**, the three-track synthesized demo ready, and `/websoundedit/assets/app-75ZGK-o6.js`. Local commit `816edcd` has exactly the published tree; subsequent local commits before this audit contain only the beta specification and continuation note.

## Executed checks

- Node `v24.22.3`; `node --test tests/api.test.js`: **7 passed**, no skipped cases. This included real local HTTP requests, CLI editing/project save, and installed FFmpeg FLAC/MP3/Opus/M4A encode/decode.
- `node scripts/audit-api-baseline.mjs`: seed **0x51ec2026**; **1,210** malformed-command, JSON, parameter, origin, Host and oversized-body cases. All expected rejections preserved editor state. Separate tiny concurrency and worker-failure probes reproduced the findings below. A first run completed its assertions but could not write its report because the shared disk was full; generated build copies were removed and the full audit was rerun successfully.
- `npm audit --json` against the installed lockfile: **0 known vulnerabilities** (59 total dependencies reported; 10 production). This is an advisory database result, not evidence of an absence of application or native-code vulnerabilities.
- Manual code review covered `scripts/server.mjs`, `scripts/cli.mjs`, `scripts/node-codecs.mjs`, `src/client.js`, `src/worker.js`, public API exports, recovery storage, rendering entry points and the workflow trust boundary. Separate audio, UI/MIDI and interchange reports cover their owned implementations.

## Confirmed findings

| ID | Severity | Reproduction and impact | Required correction |
| --- | --- | --- | --- |
| API-01 | Medium | Hold the first synthetic editor command, send 25 simultaneous authenticated 1 KiB requests: all 25 are retained and later return 200. Individual body limits do not limit aggregate queued bodies/jobs. GET capabilities can also spawn encoders independently of that queue. | Admit requests before reading bodies; bound aggregate bytes and jobs, release on error/disconnect, cache capability probes and cancel queued abandoned work. |
| API-02 | Medium | A mocked worker throws `DataCloneError` from `postMessage`; `EngineClient.execute` rejects but its pending map retains one entry. Repeated bad calls leak entries. | Remove pending entries on synchronous send failure and cover worker/message failures in regression tests. |
| API-03 | Medium | After `worker.onerror`, a subsequent execute remains pending because the dead worker is still accepted. | Make terminal failure explicit, reject future commands promptly, add disposal and bounded queue admission. |
| API-04 | Low | HTTP `track.add` with `params:false` returns 200 and creates a track, although the direct engine rejects non-object parameters. Worker code has the same `params || {}` normalization. | Default only omitted parameters; preserve and reject supplied invalid types. |

These findings do not establish unauthenticated remote access. The companion requires a bearer token and binds to loopback. API-01 is a resource boundary failure available to an authorized local client or faulty automation.

## Boundary review

Observed protections include exact loopback Host checks, exact optional browser Origin checks, timing-safe bearer comparison, no caller-supplied filesystem paths in the HTTP endpoints, owned temporary conversion directories, FFmpeg argument arrays without a shell, a local protocol/format allowlist on decoding, and cleanup in `finally` blocks. The inspected rendered user names/metadata use escaping or text content. No confirmed token leak, command execution, path traversal or authentication bypass was found in this lane.

Additional hardening should bound JSON response expansion (large Float32Array results otherwise become numeric JSON arrays), pending browser-worker requests and concurrent native capability probes. These are resource risks identified by review, separate from the four reproduced findings. Archive inflate validation is covered by the interchange audit.

The public browser's follow-up project-export interaction encountered CDP timeouts after the successful version/demo/asset observation. It is not counted as a successful post-publication export. The existing main verification evidence is 125 unit tests, 31 browser tests and genuine native Audacity exchange; the beta integration must rerun browser workflows after the fixes.

## Reproduction and evidence

Run `node scripts/audit-api-baseline.mjs` from the repository. It writes `test-results/audits/api-baseline.json` and prints the seed, case count and observations. The script uses synthetic tiny inputs, random per-run credentials and local loopback requests; credentials are never recorded. After the fixes, the same probe should no longer report the finding IDs, and dedicated regression tests must enforce the corrected behavior.

Status: baseline audit complete; corrections pending the combined baseline fix stage.
