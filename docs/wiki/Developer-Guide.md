# Developer Guide — engine, commands, API and companion

[[Home]] · [[Macros and Batch]] · [Full versioned API reference](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/API.md) · [Source](https://github.com/djshellshoxxx/websoundedit)

## 1. Architecture

WebSoundEdit is a static Vite/ES-module browser workbench with a local editing engine. The browser uses a dedicated worker for core editing, AudioWorklet paths for live DSP/capture and local OPFS storage for long recordings. Optional native Node CLI and loopback HTTP companion reuse the editing commands; GitHub Pages does not host a processing API. Direct SDK/CLI use does not require the visual interface.

The engine accepts finite PCM `{sampleRate, channels: Float32Array[], layout}` with 1, 2, 6 or 8 equally sized channels. Working samples can exceed ±1; integer export requires conscious clipping/limiting. Selection time is clip-relative and snap-to-sample, while clip placement uses the project timeline. Undo/history is bounded and does not undo external side effects.

## 2. Clone, test and build

Node 22.12+ is supported by the package. For a local contributor checkout:

```sh
git clone https://github.com/djshellshoxxx/websoundedit.git
cd websoundedit
npm ci
npm test
npm run test:fuzz
npm run build
npm run test:e2e
```

Browser tests require Playwright Chromium dependencies. Native Audacity and pinned REAPER interoperability tests require their respective desktop binaries and a working Xvfb environment in Linux CI. The release workflow executes all required gates on the same exact source head; a green build alone is insufficient for release.

## 3. Engine API

```js
import { AudioEditor } from './src/engine.js';
const editor = new AudioEditor({ sampleRate: 48000 });
const added = await editor.execute('clip.add', {
  name: 'Take',
  audio: { sampleRate: 48000, layout: 'mono', channels: [pcmFloat32Array] }
});
await editor.execute('selection.set', { clipId: added.clipId, start: 0.2, end: 0.8, channels: 'all' });
await editor.execute('effect.reverse');
const clip = await editor.execute('audio.render', { scope: 'clip' });
const project = await editor.execute('project.save');
```

Use `execute(method, params)` rather than mutating the engine's project object. Serial command execution validates parameters before changes. The authoritative engine registry is `commands.list`; for the browser workbench, use `window.websoundedit.commandCatalog()` because capabilities and adapters add methods. Public runtime descriptors include canonical method, schema, category, description, required capabilities and recording/undo semantics.

Core commands include `project.new`, `project.save/load`, `clip.add/update/split/duplicate`, `track.add/update/remove`, `selection.set/clear`, `effect.apply`, `audio.render`, `file.import/export/exportStems` and `history.undo/redo`. Discover exact parameter shapes from the running catalog instead of hardcoding UI examples as universal schemas.

## 4. Macros and command runtime

The browser, visual recorder, MIDI actions, typed scripts and optional companion use a shared named-command registry. `CommandRuntime` permits registered adapters for browser capabilities. Macro 1 is parsed/validated and interpreted with bounded values and execution; no ambient JavaScript evaluation, arbitrary user-supplied shell or unrestricted URL handling. Static errors are detected before mutation; runtime-computed parameters are checked when executed.

```js
import { parseMacro, validateMacro, MacroRunner } from './src/macro.js';
// See docs/MACROS.md and src/command-runtime.js for catalog and runner adapters.
```

A local batch isolates inputs and outputs. A file picker supplies explicit bytes/aliases; simply passing a host path from browser code is not supported. Output collection and iteration limits apply.

## 5. Audio playback and multichannel boundaries

The canonical 5.1 order is FL,FR,FC,LFE,BL,BR; 7.1 adds SL,SR. WAV surround uses WAVEFORMATEXTENSIBLE masks. Project layout is independent of actual physical speaker channels. File and monitor routes should explicitly convert layouts; the default monitor downmix excludes LFE. DSP effects must preserve a supported layout or reject. The resident editor has a ten-minute/256 MiB cap; the disk-backed archive is separate.

The live engine shares an AudioContext, schedules automation on the audio clock, and maintains effect state across worklet blocks. A live configuration must fit graph/voice/event/memory budgets before allocation; unsupported device/browser operations return a capability/permission error rather than silently doing nothing.

## 6. CLI and authenticated local API

```sh
node scripts/cli.mjs --input recording.wav --recipe examples/cleanup.json --output cleaned.wav
node scripts/cli.mjs --capabilities
node scripts/cli.mjs --commands
```

For Python, PowerShell, curl or programmatic clients, launch `node scripts/server.mjs` using its documented loopback configuration. The API is bound to `127.0.0.1` and requires a Bearer token and approved Host/Origin. Requests carry uploaded PCM/audio bytes, not arbitrary filesystem paths. The companion can send UDP only to operator-configured destinations with typed profiles; it has independent encoder, queue and request budgets. See [Companion/streaming guide](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/COMPANION.md).

The Pages site has no server-side PHP, FFmpeg endpoint or UDP capability. Browser audio and system capture require user gestures/permissions when enforced by the browser. Imported macro definitions never acquire devices or start streaming by themselves.

## 7. Project interchange and release verification

Native JSON is WebSoundEdit's richest editable format. Audacity AUP3 and legacy AUP preserve a documented subset of PCM, labels and metadata; surround can be explicitly split into mono stems. REAPER exports genuine RPP plus relative WAV media; importers require explicitly uploaded media for loose RPP. Unsupported active plugins, custom routing, automation, or transformed takes require a rendered/compatible form. See [[Project Interoperability]].

Before merge/release, run unit/integration tests, seven deterministic fuzz families, browser tests (including actual capture/help screenshots), dependency audit, native Audacity/REAPER open-render-save-reimport, and final exact-main deployment verification. Review screenshots visually. The release workflow creates **v1.0.0-beta.1** only after verified Pages deployment, then checks tag/asset identity and checksums. Keep a complete audited report; do not represent queued CI as passing.
