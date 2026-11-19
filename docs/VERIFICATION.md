# WebSoundEdit 0.1 — release verification

Recorded 18 November 2026 (Pacific time).

## Published result

- Editor: https://djshellshoxxx.github.io/websoundedit/
- Tested application commit: `0b3acbb09e857182f32d5d56b2a589bcf5411eb8`.
- [Successful verification and GitHub Pages deployment](https://github.com/djshellshoxxx/websoundedit/actions/runs/44471962803).
- Circuit Drift Labs integration commit: `99d7590368056a487c41ef0b1acc105f40040da3`. The main site's Tools menu, browser-tools section, project index and release catalogue link to the editor. The editor's brand and footer link back.

The published editor returned HTTP 200. Its application JavaScript, CSS, public `api.js`, CDL mark, API reference and Opus copyright notice matched the locally verified production files byte for byte. The FFmpeg WASM file returned HTTP 200 with `application/wasm` and the expected 32,232,419-byte size. The main-site markup contained three editor links and a source link; the editor markup contained two links back to CDL.

## Automated results

| Check | Result | Coverage |
| --- | --- | --- |
| Node engine/API suite | **69 passed; 0 failed; 0 skipped** | DSP measurements, selected-region and channel isolation, independent pitch/time changes, EQ/dynamics, silence/BPM, ducking/gating, loops, granular reproducibility, exact project JSON, history, mixer behavior, HTTP/CLI editing, input validation, clock/metronome behavior, waveform/spectrum calculations and real codec outputs. |
| Production build | **Passed** | Same-origin worker and codec packaging, included notices, preserved public API exports, DOM-free import of built `api.js`, actual edit and WAV round trip. |
| Chromium browser suite | **21 passed** | Ten editor workflows plus ten format round trips and a separate native/forced-fallback mono MP3 test. |
| GitHub Pages deployment | **Passed** | Verified artifact uploaded and deployed by `actions/deploy-pages`. |

Browser tests ran with Playwright 1.65.1 and Chromium 159.0.8154.6 on the GitHub-hosted Ubuntu runner. Node 24 was used for verification and build.

### Actual format checks

All ten advertised output choices encoded real files with the expected container/codec signatures, then imported to finite, audible stereo PCM at the working sample rate:

**WAV, MP3, FLAC, Ogg Vorbis, Opus, M4A/AAC, raw AAC, AIFF, ALAC/M4A and WMA.**

Opus additionally passed forced FFmpeg WASM fallback import. Dedicated-encoder tests independently decoded mono and stereo output with native FFmpeg/ffprobe and checked exact lengths, including 17-frame, 960-frame and 96,001-frame inputs. They also checked Ogg checksums, page/granule structure, pre-skip/end trimming, separate left/right tones, full-complexity noise and cancellation.

### Browser interaction checks

The suite exercised pointer and exact numeric selection, channel isolation, visible waveform changes during a noncommitting preview, Apply/Undo/Redo, stretch/split, project JSON, drawn envelope editing, keyboard envelope-point controls, real track-driven sidechain compression, looping/metronome transport, file import, selection downloads, empty-track mix playback and settings validation/restoration.

Layouts were checked at **1440 × 1000**, **768 × 1024** and **390 × 844** CSS pixels. The command entry and BPM correction controls remained visible and horizontally contained. Full-page screenshots are in the workflow's `browser-evidence` artifact; a permanent desktop capture is in [screenshots/workbench.png](screenshots/workbench.png).

## Boundaries of this verification

These results cover the named automated cases and the deployed static files. They do not establish Safari/Firefox compatibility, hardware microphone capture on every device, subjective listening quality for all material, or completion of every exploratory case in [ACCEPTANCE.md](ACCEPTANCE.md).

The initial release supports mono/stereo PCM, a 10-minute timeline, bounded 256 MiB PCM budgets, 64 tracks and 512 clips. Independent pitch/time processing uses WSOLA. Normalization and limiting measure sample peaks; LUFS normalization and oversampled true-peak metering are not implemented. These boundaries are also documented in the README and API contract.

GitHub Pages hosts the static editor and SDK. Scripted filesystem/HTTP work runs through the included local CLI or explicitly started loopback companion; there is no Pages-hosted REST processing server.
