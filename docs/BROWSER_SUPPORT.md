# Browser and mobile verification

WebSoundEdit uses one responsive application for desktop, tablet and phone. Open the normal Pages URL on any device; projects and commands use the same data format.

## Automated browser matrix

| Project | Engine or device profile | Coverage |
| --- | --- | --- |
| `chromium` | Chromium | Complete existing browser suite, formats, editing, recording, macros and help |
| `firefox` | Firefox | Core editing, effects, portable projects, formats, live worklets and repeated-operation stress |
| `webkit` | WebKit | The same common checks in the engine used by Safari |
| `mobile-chromium` | Pixel 7 touch profile | 320/390-pixel phone, tablet and landscape layouts; editing; Options/Help/macros/export |
| `mobile-webkit` | iPhone 13 touch profile | The same mobile journeys in WebKit |

Chromium exercises the engine shared by Chrome and Edge. The automated WebKit build exercises Safari's engine, rather than a physical iPhone or the macOS Safari application. Actual executed results belong to the workflow at the tested commit; a configured test is not evidence that it passed.

## Capability-dependent features

Core selection editing, effects, WAV export, project save/open and ordinary playback do not require Web MIDI, output-device selection or screen sharing. Missing optional APIs are reported without breaking the editor.

| Capability | Behavior |
| --- | --- |
| Microphone/interface | Requested only by an explicit start action; permission and available channels are checked |
| System/tab audio | Available only when the browser's display picker supplies an audio track |
| Output-device selection | Disabled when `AudioContext.setSinkId` is unavailable; system default output remains usable |
| MIDI hardware | Requires Web MIDI and permission; MIDI file import/export is independent |
| Long recordings | Require origin-private file storage (OPFS); quota and storage errors remain visible |
| Streaming file export | Uses the save-file picker where available; bounded downloads remain available otherwise |
| Surround monitoring | Depends on the browser and actual output device; the project layout alone does not establish hardware support |

## Phone controls

Tap a waveform to place the cursor, drag to select, or enter exact IN/OUT times. Use the visible zoom, undo, effect and export controls without a hardware keyboard. Phone tracks put the mixer above a full-width waveform. Use **Hide sound tools** to collapse the inspector when arranging audio.

Touch input suppresses hover tips; the **Quick guide** and Help remain accessible. Keyboard focus and mouse hover still provide guidance when enabled in Options. All desktop tools remain available on the same page.

## Reproduce

```sh
npm ci
npm run build
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

Use `npx playwright test --project=firefox` (or another project name) for a focused run. Test artifacts include responsive screenshots and `browser-stress.json` with measured operations and UI heartbeat counts. Hardware input, physical-device latency and long-duration real-device capture require separate device testing.
