# Beta 2 qualification — 19 November 2026

This record covers the deployment repair and expanded editing, presets, themes, scripting, batch, device and visualization work. It records executed local checks. The [Actions run on the exact published commit](https://github.com/djshellshoxxx/websoundedit/actions) remains the authority for hosted browser, native DAW and deployment results. `build.json` identifies the deployed version and source commit.

## Reproduced findings and corrections

| Finding | Correction and regression |
| --- | --- |
| Recovery could reappear after Clear or overwrite newer work | Serialize storage operations, invalidate stale snapshots and coalesce writes; deterministic race and repeated-edit tests preserve intended state. |
| A late stem export could clear a newer batch collection | Internal encoding retains collection ownership; concurrent export tests preserve the newer job. |
| Batch ZIPs silently lost files sharing a format | Codec display names overwrote unique filenames. The authoritative filename is now applied last; real WAV tests check distinct PCM, collision suffixes, individual downloads and every ZIP entry. |
| A slow valid native encoder tail was terminated early | Use a finite ten-second finalization window followed by bounded drain; verify delayed success and forced termination. |
| Loop before first playback used stale bounds | Stage and validate loop bounds before audio starts; real browser playback verifies the result. |
| Bar snapping assumed four beats | Respect the current time signature for pointer and keyboard movement; cover 3/4, 5/4 and 7/4. |
| Clean high-level peaks could be mistaken for clipping | Require a bounded flat plateau and valid interpolation shoulders; retain exact input when no repair occurs. |
| Builtin-heavy macros could postpone cancellation | Yield across scheduling thresholds; verify asynchronous cancellation and detached UI results. |
| Narrow high frequencies disappeared in waterfall rendering | Preserve peaks when combining neighboring bands; render a narrow 16 kHz odd-band fixture in actual Canvas. Waveform downsampling also preserves extrema. |
| Cached page restoration left audio and visualization permanently disposed | Suspend the display and reset transient audio resources while preserving unsaved project/PCM/rack state. A persisted-event regression then restarts native playback; it does not claim automated navigation entered BFCache. |
| Theme labels retained fixed low-contrast colors | Use semantic colors and inspect computed label contrast in all ten themes. |
| Native rack drag started with its destination outside the viewport | Bring both endpoints into view while retaining native drag and exact reorder assertions. |
| Headless Firefox lacked a clocked audio output in CI | Provide a PulseAudio virtual 48 kHz stereo output. Keep native AudioContext, PCM and AudioWorklet assertions and backend evidence. |

## Local verification

The candidate after the batch filename repair passed **439 unit/integration tests**, with zero failures, skips or cancellations. Production compilation and the DOM-free SDK check passed, including a real PCM edit, WAV round trip and interpreted macro.

All seven fuzz groups passed: audio/WAV, live DSP, macros, Audacity, REAPER, API boundaries and the loopback companion. The macro corpus contains **5,248 cases**, including 128 additional data-tool cases, with no unexpected raw errors, ambient network calls, prototype mutations or forbidden getter calls. [Machine-readable summary](evidence/beta2-local-verification.json).

Focused Chromium verification after the relevant fixes passed **11 live-audio/visualizer/rack cases** and **13 codec/scripting cases**. These exercise actual worklets, OPFS recordings, loop capture, all three views, reduced-motion behavior, drag/XY/Undo, all ten formats, forced-WASM mono MP3 import, seeded nested scripts and two-file batch ZIP output with project/draft restoration.

An independent full WebKit run passed **47 of 48 cases** before the batch correction. Its sole failure reproduced the filename defect; native audio, every codec path, presets, themes and visualization passed. After the fixes, three focused WebKit cases passed for batch ZIP names, native visualization and persisted page lifecycle; all three mobile WebKit cases also passed. The enhanced publication smoke passed against the built local preview, including a real FLAC encode, preset, nested script, ten themes and waveform default. That preview check is not a public deployment claim. Earlier broad attempts exposed corrected defects and local environment restrictions and are not counted as complete passes. Hosted CI executes the full matrix on the final checkout.

Local engines included Chromium Headless Shell 156.0.8078.79 and Playwright WebKit 27.2. Ordinary missing WebKit shared libraries were installed in the owned browser cache. This is engine qualification, not physical Safari/iPhone or audio-interface qualification.

## Stress and resource checks

[The reliability review](RELIABILITY_QA_2026_11_19.md) records passing checks at 64 tracks/512 clips; 40 edits, 30 Undo/Redo pairs and 40 project/WAV round trips; 192 stems across three ZIP collections; and 2,000 recovery schedules. Oversized timeline rendering is rejected before allocation while raw clip export remains available.

`node --expose-gc scripts/benchmark-presets.mjs` processes seven preset families over **ten minutes of synthetic stereo audio at 8 kHz (4.8 million frames)**. Output stays finite with exact dimensions/layout, source hashes remain unchanged, and duration/memory preflights pass. [Measurements](evidence/beta2-preset-stress.json) describe this host, not a hardware-independent speed guarantee.

The visualizer uses a 2,048-point FFT, 192 frequency bands, 240 history frames and at most 30 updates per second. Canvas/buffer sizes are bounded and hidden/offscreen work suspends. Synthetic analyser fixtures are explicitly separate from known-tone native Web Audio tests.

## Publication and limits

### Publication follow-up

The final review expanded the catalog to **36 presets** by adding linked sample-peak normalization at −1, −3 and −6 dBFS plus a separately named, explicitly approximate instrumental-removal center preset. Real PCM regressions check target peaks, channel balance, silence, attenuation and center/side behavior. Freeze now also retains its exact picture and spectral history when the panel is scrolled out of view and back.

The follow-up passed **441 unit/integration tests**, all seven deterministic fuzz groups, production compilation and the DOM-free SDK checks. The dependency audit reported zero known advisories. A focused Firefox 159 browser regression passed for frozen-frame scrolling. The local Chromium executable could not start because its process-singleton socket was denied by this execution environment; cached WebKit lacked required shared libraries. These launch restrictions are not counted as successful browser tests. The complete hosted matrix and the live publication smoke remain required on the final checkout.

The published build now includes the scripting and browser-support guides, the current qualification evidence and the linked historical screenshot. Bundle verification compares these files with their sources and resolves local links in the current guides, API reference, qualification record and distributed third-party notices against actual built files. The live smoke additionally applies the new normalization preset and checks that both new guide URLs return Markdown rather than an application-shell fallback.

[Deployment repair](DEPLOYMENT_REPAIR_20261119.md) separates Pages from wiki/prerelease publication. The main checkout must pass verification before deployment and a live-site check afterward. Packaging restores the verified artifact, checks source/version identity and preserves immutable tags/assets. The separate prerelease retains its mandatory wiki gate.

Vocal/instrumental presets use stereo center/side processing rather than an AI stem model. Results depend on the mix; mono is rejected, other centered sounds can remain with vocals and side-only outputs cancel in mono. Clipped-peak interpolation cannot reconstruct lost information. Mastering presets use RMS/sample peaks, not integrated LUFS or oversampled true peak.

Device access uses browser/OS media and Web Audio APIs. Native ASIO/exclusive drivers, physical MIDI behavior, measured hardware round-trip latency and actual surround speakers are outside the automated evidence. Unsupported optional device selection leaves default output available.

See [Browser support](../BROWSER_SUPPORT.md), [Scripting](../SCRIPTING.md), [User guide](../USER_GUIDE.md) and [API reference](../API.md) for workflows and limits.
