# REAPER project exchange

WebSoundEdit exports an actual `project.rpp` with a relative `media` directory of 32-bit float WAV files. Extract the ZIP and keep both together when opening it in REAPER. A small `websoundedit-project.json` preserves the project name, output layout and all supported metadata fields. It is a package sidecar, not a replacement for the native RPP.

## API

```js
import { importReaper, exportReaper } from './src/reaper.js';

const opened = await importReaper(projectBytes, {
  name: 'Session.rpp',
  files: new Map([
    ['media/voice.wav', voiceBytes],
    ['C:\\Old computer\\bass.wav', explicitlyUploadedBassBytes],
  ]),
});
await engine.execute('project.load', { project: opened.project });

const saved = await exportReaper(await engine.execute('project.save'), {
  format: 'zip',
});
// { bytes: Uint8Array, mime: 'application/zip', ext: 'zip', warnings: string[] }
```

`importReaper(bytes, {name, files, decodeMedia})` returns `{project,warnings}`. ZIP input must contain exactly one RPP. Loose RPP input requires an explicitly supplied `Map<string,Uint8Array>` of its media. Neither form reads a referenced operating-system path or fetches a URL.

The optional local decoder has the signature `decodeMedia(bytes, {name, sampleRate, maxPcmBytes}) → Promise<PCM> | PCM`. The built-in WAV reader runs first. Other supported file-source types require this explicit decoder or a WAV export from REAPER. A decoder must honor the provided budget; its result is checked for finite samples, channel layout, sample rate and size. Surround PCM must identify its canonical layout. Device acquisition, plugin execution and network access are not decoder responsibilities.

## Media references

An exact supplied alias wins, including a Windows absolute path, Unix absolute path or URL-shaped string. Such a string is only a lookup key into the caller's uploaded bytes. Relative paths resolve against the RPP's supplied directory. If no exact or relative alias exists, a unique uploaded basename may satisfy the reference and produces a visible remapping notice. Two uploaded files with that basename are ambiguous and fail until the caller supplies an exact alias. There is no implicit filesystem or network fallback.

ZIP entries use the shared archive reader: paths are relative, no `..` or drive/absolute paths, no symlinks, no encryption, no ZIP64. Local and central headers must agree. CRC32, compressed lengths, decompressed lengths, payload ranges and the bounded DEFLATE stream are checked before files become media.

## Supported sound and timeline

| Feature | Behavior |
| --- | --- |
| Mono, stereo, 5.1, 7.1 PCM | Canonical WAV speaker masks and channel order; every channel remains represented. |
| Track/clip names, order, positions | Preserved within the editor's name, sample-grid and timeline bounds. |
| One active file take | Imported; extra takes, comping and transformed sources require rendering first. |
| Visible source trims | Imported as the visible PCM range. Hidden source audio remains in the original media, outside the imported clip. |
| Constant item gain/polarity | Rendered into clip PCM with a notice. |
| Track gain, pan, mute and solo | Supported direct routing; pan controls are translated to preserve audible gains. |
| Overlapping clips | Writer explicitly uses Always mix. Import rejects overlapping replacement-mix items. |
| Point markers, fixed tempo/time signature | Preserved; regions and changing tempo maps need conversion/rendering. Non-quarter denominators remain in project settings for export. |
| Tags | Supported fields appear in the package sidecar and WAV tags; single-line values also become native REAPER render metadata. |
| Project UI, script/device state | Not restored or executed. WebSoundEdit-specific controls remain in the native JSON session. |

The initial native pan subset is an explicit 0 dB linear balance law. WebSoundEdit uses equal-power mono panning and cosine front-pair balance. The exported native track gain and pan values can therefore differ from their WebSoundEdit values while representing the same audible gains. Mixed source-layout tracks can split into separate native tracks so each receives the appropriate translation.

For surround media routed to a smaller output layout, a direct native master send would lose channels rather than reproduce the editor's defined downmix. Those exported clips render the static channel matrix, gain and pan into new PCM, with neutral native controls and a notice. This includes the editor's intentional default LFE omission. Same-layout and supported wider-layout exchange retains source channel PCM.

REAPER's numbered master channels do not identify physical speakers. A package sidecar preserves the WebSoundEdit output layout. For a loose native project, the importer reports its interpretation of numbered surround channels in canonical order; confirm the original routing. Source WAV files with ambiguous surround masks still require an explicit layout at their decoder boundary.

Active plugins, audio automation, complex sends/folders, custom channel routing, replacement overlap mixing, item fades, take panning, multiple takes, comping, time/pitch stretching, reverse/source sections and non-file sources are not silently approximated. The importer names the unsupported record and asks for rendered stems or a simpler project. This release does not claim to import arbitrary REAPER sessions without preparation.

## Limits

RPP limits apply before or during tree construction: 8 MiB UTF-8, 50,000 physical lines, 64 KiB per line, 16,384 characters per token, 256 tokens per line, 100,000 tokens, 20,000 records including block delimiters, and 64 nested levels below the root. The parser supports the Cockos/WDL single, double and backtick quote styles; backslashes are ordinary characters. It never evaluates project text.

Files and packages are bounded at 320 MiB, with at most 20,000 entries. One archive entry, including a WAV's headers and tags, must fit 256 MiB; package metadata has a 32 KiB text limit. Decoded source PCM and imported visible PCM each have a 256 MiB budget. The editable project remains at 64 tracks, 512 clips, 1,000 markers and ten minutes. Layout/overlap/channel expansion must also fit those bounds. The shared archive reader permits at most 20,000 DEFLATE blocks across extracted entries and verifies stream output length before inflation.

## Native verification

The pinned official Linux x86-64 binary is REAPER **7.86**, released November 13, 2026:

- [Official archive](https://www.reaper.fm/files/7.x/reaper786_linux_x86_64.tar.xz)
- [Official checksum listing](https://www.reaper.fm/download.php?hashes=1)
- SHA-256: `c2f9d8616bd1dc6175993b82451e1c6e352c6761e7ae6d72400a3f3dfb03bedb`

`scripts/probe-reaper.mjs` obtains a genuinely native project and settings using an independent WAV fixture encoder. `scripts/verify-reaper.mjs` opens WebSoundEdit exports in native REAPER, checks their structure, renders the full master mix, saves them natively and reimports them. It also creates independent native projects, including overlapping trimmed sources, and compares their rendered audio after import. Cases cover all four layouts with distinguishable channel signals. The native runner uses a private configuration and REAPER's supported evaluation; it does not alter license state or use pre-FX accessor output as a substitute for a full mix render.

Implementation-stage status: local deterministic unit and parser tests pass. The genuine native grammar probe passed in [Actions run 44514197389](https://github.com/djshellshoxxx/websoundedit/actions/runs/44514197389); its untouched fixture and provenance are retained in `tests/fixtures/reaper-7.86/`. That probe confirms native save/exit and field serialization. The full native render/open/save/reimport gate is still required for a passing audio-interchange release claim. See the release verification document for the actual tested head, native version and measured PCM differences.

### Primary references

- [Cockos/WDL line lexer](https://github.com/justinfrankel/WDL/blob/main/WDL/lineparse.h) and [project context](https://github.com/justinfrankel/WDL/blob/main/WDL/projectcontext.cpp)
- [REAPER ReaScript API](https://www.reaper.fm/sdk/reascript/reascripthelp.html): track pan laws, media-item mix flags, render configuration, native save and metadata APIs
- [REAPER supported formats and audio systems](https://www.reaper.fm/about.php)

The JavaScript parser and writer are original implementations; no proprietary REAPER implementation code is copied.
