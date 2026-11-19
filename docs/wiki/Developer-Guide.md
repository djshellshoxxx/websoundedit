# Developer Guide

This page targets the **1.0.0-beta.1 source candidate**. It describes implemented interfaces and the repository's verification/release flow. It does not claim a successful beta deployment, completed hardware testing or wiki publication. Consult the [beta audit summary](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) for actual evidence.

[Home](Home) · [User Guide](User-Guide) · [API reference](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/API.md) · [Engine contract](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/ENGINE_CONTRACT.md)

## Get the matching source

Use the source revision associated with the intended release or candidate. While beta validation is pending, the repository's default branch and published editor may describe an earlier release.

Node **22.12 or newer** is required; CI uses Node 24. Native FFmpeg supplies the Node companion's compressed codecs and the full local audio integration suite. The browser uses its bundled codecs.

```bash
git clone https://github.com/djshellshoxxx/websoundedit.git
cd websoundedit
npm ci
node scripts/prepare-codecs.mjs
npm run dev
```

Open the address printed by Vite. To produce the complete static distribution:

```bash
npm run build
npm run preview
```

The build prepares self-hosted codec assets, bundles the application and `api.js`, and verifies the public SDK. Serve `dist/` over HTTP; workers, WASM and browser device APIs are not a filesystem-only page workflow.

## Runtime boundaries

| Interface | Owns | Does not imply |
| --- | --- | --- |
| `window.websoundedit` | The open browser workbench, file controls, UI, devices and visible session | A hosted REST server |
| `AudioEditor` | PCM editing, project state, rendering, history and core commands | DOM, device permission or file-picker access |
| `createCoreRuntime()` | Typed core dispatch, successful-command events and action recording | Browser file/live adapters |
| `createBrowserRuntime()` | Core dispatch plus owned live-audio and companion adapters | The workbench DOM or automatic connection to devices |
| CLI / local HTTP companion | Its own local editor, supplied file aliases, encoding and configured streams | Remote control of an already-open Pages tab |

The built `api.js` exports the engine, runtime composition, macro helpers, shared schemas, channel-layout helpers and supported interchange functions. Importing the SDK does not acquire a microphone or start playback. Discover capabilities in the runtime you actually use; adapters differ between browser, core-only and Node environments.

## Browser API

Wait for startup before addressing the visible session. The unified catalog contains command schemas, descriptions, availability and capability metadata:

```js
await window.websoundedit.ready;
const catalog = window.websoundedit.commandCatalog();
const state = await window.websoundedit.execute('project.state', {});
console.log(catalog, state);
```

This example normalizes the first two seconds of the selected clip and returns encoded WAV bytes without starting a download. It uses an explicit clip ID and valid bounds for the actual source:

```js
await websoundedit.ready;
const state = websoundedit.getState();
const clip = state.tracks.flatMap(track => track.clips)
  .find(item => item.id === state.selectedClipId);
if (!clip) throw new Error('Select a clip first.');

await websoundedit.execute('selection.set', {
  clipId: clip.id,
  start: 0,
  end: Math.min(2, clip.duration),
  channels: 'all'
});
await websoundedit.execute('effect.normalize', { targetDb: -1 });
const output = await websoundedit.execute('file.export', {
  scope: 'selection', format: 'wav', bitDepth: 24, download: false
});
const project = await websoundedit.saveProject({ download: false });
console.log(output.mime, output.bytes.byteLength, project.name);
```

Browser imports require a supplied `File`. `websoundedit.inputs.supply(files)` returns aliases; canonical `file.import` accepts one of those aliases. Macros and HTTP requests cannot name arbitrary browser-local paths. `file.export` performs concrete I/O; `ui.file.export` only opens the dialog. Use the semantic commands when recording or scripting operations.

Save/load through the public commands so UI settings, live definitions, device teardown and validation follow the same lifecycle as manual use. Reading metadata through `getState()` is separate from requesting PCM through `clip.getAudio` or `audio.render`.

## Direct JavaScript engine

Save this program at the repository root and run it with Node. It synthesizes real PCM, applies an edit, and writes a small WAV using the built-in encoder:

```js
import { writeFile } from 'node:fs/promises';
import { createCoreRuntime } from './src/sdk-runtime.js';
import { encodeWav } from './src/wav.js';

const runtime = createCoreRuntime();
try {
  await runtime.execute('audio.generate', {
    type: 'tone', frequency: 220, duration: 0.5,
    channels: 1, amplitude: 0.2, name: 'Example tone'
  });
  await runtime.execute('effect.fadeOut', { duration: 0.05 });
  const audio = await runtime.execute('audio.render', {
    scope: 'clip', raw: true
  });
  await writeFile('tone.wav', encodeWav(audio, { bitDepth: 24 }));
} finally {
  runtime.dispose();
}
```

PCM is `{sampleRate, channels: Float32Array[], layout}`. Channels must have equal length and finite values. Canonical layouts contain 1, 2, 6 or 8 channels. Use the channel-layout helpers rather than guessing surround order.

Core engine calls are serialized. The workbench also limits queued worker jobs, and the command runtime bounds active operations. An invalid command rejects with a message/code; do not mutate internal engine state or retain references as an alternative to executing commands.

## Macros and command schemas

WebSoundEdit Macro 1 is bounded text interpretation, not JavaScript `eval`. It supports variables, arithmetic, conditions, bounded loops, arrays/objects, safe own-property access, command calls and waits. Recorded and handwritten programs use the same `.wsemacro` text format.

A batch-friendly cleanup macro is:

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: input.stem});
```

The batch wrapper supplies `input` and imports it automatically when the script contains no `file.import`. Browser batches restore the original session once and reject outside mutations throughout snapshot, processing and restoration. Node batches create an isolated editor per input. Ordinary browser macros remain interactive.

The following browser macro requires a project containing at least four seconds of audio. It installs a live filter and schedules an explicit timeline sweep:

```wsemacro
// WebSoundEdit Macro 1
live.rack.set({target: "master", chain: [
  {id: "wiki-filter", effect: "filter", enabled: true, wet: 1,
   params: {type: "lowpass", frequency: 500, q: 0.707}}
]});
automation.set({target: "master", enabled: true, lanes: [
  {slotId: "wiki-filter", param: "frequency", points: [
    {time: 0, value: 500, curve: "linear"},
    {time: 4, value: 5500, curve: "linear"}
  ]}
]});
transport.play({scope: "mix", position: 0});
wait({seconds: 4});
transport.stop({});
```

Validate known syntax, command names and static arguments before execution. Dynamic values are checked again when commands run. `parseMacro`, `validateMacro`, `formatMacro`, `macroToSteps`, `stepsToMacro` and `MacroRunner` are exported by the SDK. Give `MacroRunner` the actual runtime's `execute`, `commands` and context providers; a core-only catalog cannot promise file or device capabilities.

Command descriptors use JSON Schema plus `method`, `id`, `label`, `category`, `description`, `recordable`, `undoable`, `capabilities` and `available`. Define concrete operations once and register their handlers with `CommandRuntime`. Nested `context.execute` suppresses duplicate recording and preserves explicit command ownership. UI navigation and transient previews should not become misleading edit steps.

See [MACROS.md](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md) for the full grammar, limits, cancellation, timing, triggers and live-layer examples.

## CLI and local HTTP

Inspect the commands and installed encoder capabilities:

```bash
node scripts/cli.mjs --commands
node scripts/cli.mjs --capabilities
```

Process a local file with the included JSON recipe:

```bash
node scripts/cli.mjs --input recording.wav \
  --recipe examples/cleanup.json \
  --output cleaned.wav --save-project cleaned-session.json
```

Save the cleanup macro above as `cleanup.wsemacro` and run isolated input files:

```bash
node scripts/cli.mjs --batch \
  --input kick.wav --input snare.wav \
  --macro cleanup.wsemacro --output-dir exports
```

`--continue-on-error` records a per-file failure and continues deliberately. Macro output paths are chosen by the CLI's output directory; the script receives aliases. WAV works without native FFmpeg, while compressed codecs depend on its installed encoders.

Start the local HTTP service explicitly:

```bash
npm run api -- --allow-origin https://djshellshoxxx.github.io
```

It binds `127.0.0.1:8787` and prints a per-run token. The configured origin excludes the `/websoundedit/` path. Requests require `Authorization: Bearer <token>`. This shell example queries capabilities after you provide that token:

```bash
export WEBSOUNDEDIT_TOKEN='paste-the-printed-token-here'
curl --fail --silent --show-error \
  -H "Authorization: Bearer $WEBSOUNDEDIT_TOKEN" \
  http://127.0.0.1:8787/v1/capabilities
```

The API includes `/v1/commands`, `/v1/state`, binary import/export, portable projects, typed `/v1/execute`, macro status and cancellation. Use binary export rather than a JSON array of samples for large outputs. The HTTP editor is independent of the visible browser tab; exchange native project JSON to move the session.

UDP streaming requires a separately supplied startup destination configuration and an acquired input. The companion advertises available profiles, enforces named destinations and bounds its PCM/encoder/network queues. Read [COMPANION.md](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/COMPANION.md) for exact profiles, raw PCM order, receiver setup and counters. A macro cannot supply a shell command or arbitrary network destination.

## Code map and extension contracts

| Area | Primary source |
| --- | --- |
| Project commands, history and PCM state | `src/engine.js` |
| Worker client and message admission | `src/client.js`, `src/worker.js` |
| Core schema and runtime dispatch | `src/command-schema.js`, `src/command-runtime.js` |
| Macro parser, runner and recorder | `src/macro.js`, `src/macro-recorder.js` |
| Shared file schemas | `src/file-commands.js` |
| Browser file/export adapter | `src/file-ui.js` |
| Core/browser SDK composition | `src/sdk-runtime.js`, `src/public-api.js` |
| Offline processing and rack definitions | `src/dsp.js`, `src/rack-dsp.js`, `src/rack-config.js` |
| Stateful live processing and routing | `src/realtime-dsp.js`, `src/rack-worklet.js`, `src/live-audio.js` |
| Disk archive and capture | `src/recording-store.js`, `src/recording-worker.js`, `src/capture-worklet.js` |
| Project interchange | `src/audacity.js`, `src/reaper.js` |
| Browser workbench integration | `src/app.js`, the `*-ui.js` modules |
| Local CLI/HTTP runtime | `scripts/node-runtime.mjs`, `scripts/cli.mjs`, `scripts/server.mjs` |

Keep schemas and defaults shared across adapters. A new UI control should invoke the same semantic command that scripts can discover. Separate device permission from loading saved definitions. Preserve explicit target IDs for clicked-track operations and validate replacements before losing the current project.

Stable rack stage IDs connect reordering, XY, MIDI and automation. Live parameter changes should use the live scheduling path, not repeatedly render the entire committed mix. Track removal and project replacement must release their owned voices, captures and stale callbacks. Dispose SDK browser runtimes when their owning application surface ends.

## Project and resource contracts

Native JSON uses versioned `websoundedit` project data with planar `f32le-base64` PCM. Save/load commands perform resource and field validation. Projects preserve current edited audio rather than undo history or clipboard contents. UI settings and live rack definitions are distinct from active permission, trigger arming and network sessions.

Selections are clip-relative; placements and automation points are timeline-relative. Duration-changing channel edits require all source channels. Layout conversion uses the canonical matrices. Live offline rendering starts with empty effect history at the requested range, while the recorder captures the running graph's actual history.

Principal resident bounds are a ten-minute timeline, 256 MiB decoded PCM, 64 tracks and 512 clips. Racks allow twelve stages; live processing additionally has aggregate graph, stage, voice, DSP-memory and automation budgets. Codec, file-alias, macro-value, output-collection and archive queues have their own bounds. Use the exported limits and actual capability/status responses rather than duplicating them in integrations.

See the [portable format](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/PROJECT_FORMAT.md), [engine contract](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/ENGINE_CONTRACT.md), [Audacity subset](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/AUDACITY.md), and [REAPER subset](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/REAPER.md).

## Tests and evidence

Run the meaningful local gates for a changed revision:

```bash
npm test
npm run test:fuzz
npm run test:performance
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite uses the production preview; build before running it. Native exchange checks use the separately installed applications, for example:

```bash
xvfb-run -a node scripts/verify-audacity.mjs
xvfb-run -a node scripts/verify-reaper.mjs test-results/reaper-native
```

The CI setup installs its native dependencies and pins the REAPER download with a checksum. See the [verification action](https://github.com/djshellshoxxx/websoundedit/blob/main/.github/actions/verify/action.yml) for exact setup and the [acceptance plan](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/ACCEPTANCE.md) for workflows.

Evidence has distinct meanings: schema/unit tests, seeded invalid-input corpora, native DAW round trips, real browser worklet/storage/codec tests, visual screenshot review, and physical hardware/long-duration testing. Synthetic DSP throughput is not measured device latency. A written browser case is not a passing browser result.

The workflow uploads `test-results/` and `playwright-report/` as **`beta-verification-evidence`**. It continues eligible independent checks after a failure to retain diagnostics; the failure still prevents a successful release. Cite the tested commit and actual artifact rather than reusing a historical pass count for new code.

## Build and publication flow

The [Pages workflow](https://github.com/djshellshoxxx/websoundedit/blob/main/.github/workflows/pages.yml) verifies pull-request candidates. A main-branch publication runs the same reusable verification action before deploying. Its gates include unit/integration tests, dependency audit, seeded fuzzing, recorded DSP measurements, build/SDK verification, native Audacity/REAPER exchange and browser workflows.

After successful verification, the workflow deploys the Pages artifact, runs the published-site smoke test, packages the web distribution and matching companion source, produces SHA-256 checksums, and invokes the prerelease publication script. Failures retain their failed status; collecting diagnostic artifacts does not authorize deployment.

A completed release needs the exact verified source, successful deployment and live smoke evidence. Review the built version/provenance, public assets, release notes and downloadable packages. Repository administration and wiki publication are separate from generating these source pages; the current Pages workflow does not push a GitHub wiki.

## Documentation and screenshots

Specifications precede implementation in [docs/specs](https://github.com/djshellshoxxx/websoundedit/tree/main/docs/specs). Keep command examples aligned with current schemas and explain capability limits where users choose an operation. Keep the detailed [user guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/USER_GUIDE.md), [macro guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md), [API](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/API.md), and these wiki sources consistent.

`tests/help-capture.spec.js` defines 22 screenshots of actual UI states, with arrows measured from live DOM bounds. It saves `help-captures.json` after each successful capture. `complete: false` identifies partial evidence; review the passing attempt, source revision, captions and images before publication.

Copy accepted PNGs to `public/help/` and populate `HELP_IMAGES` in `src/help-content.js`. The capture manifest uses `file`, while the app expects `path: 'help/<filename>.png'`, plus chapter, width, height, alt text and caption. Do not use a leading slash or `public/` in that path. The renderer adds the site's base URL.

The [User Guide's illustration index](User-Guide#illustrated-workflow-index) already points at the stable future Pages paths. Those links are explicitly conditional on reviewed assets being published. Source documentation, passing screenshots, Pages publication and wiki publication should each be recorded accurately.
