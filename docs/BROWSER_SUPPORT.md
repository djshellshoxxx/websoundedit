# Browser and mobile verification

WebSoundEdit uses one responsive application for desktop, tablet and phone. Open the normal Pages URL on any device; projects and commands use the same data format.

## Automated browser matrix

| Project | Engine or device profile | Coverage |
| --- | --- | --- |
| `chromium` | Chromium | All shared desktop specs, plus the simulated microphone fixture |
| `firefox` | Firefox | All shared desktop specs: editing/effects, formats, native worklets and OPFS recording/recovery, macros/batches, presets/themes, live display, Audacity/REAPER interchange, help and repeated-operation stress |
| `webkit` | WebKit | The same shared desktop suite in the engine used by Safari |
| `mobile-chromium` | Pixel 7 touch profile | 320/390-pixel phone, tablet and landscape layouts; editing; Options/Help/macros/export |
| `mobile-webkit` | iPhone 13 touch profile | The same mobile journeys in WebKit |

Desktop specs are discovered automatically, so new shared tests run in all three engines. The mobile suite uses its own projects. Only `tests/microphone.chromium.spec.js` is limited to Chromium because its simulated input fixture uses Chromium-specific launch flags; native live-audio and OPFS assertions stay in the shared suite. The published-site checks also run in all three desktop engines after deployment and are intentionally skipped in a local build-only run.

Native OPFS recording tests use a fresh temporary WebKit profile because this runner's ephemeral private contexts reject `navigator.storage.getDirectory()` before application code runs. Each profile is closed and removed after its test, while Chromium and Firefox keep their ordinary isolated contexts. The fixture preserves the real storage, worklet, PCM, reload/recovery and export assertions, along with the runner's configured options and failure artifacts.

Chromium exercises the engine shared by Chrome and Edge. The automated WebKit build exercises Safari's engine, rather than a physical iPhone or the macOS Safari application. Actual executed results belong to the workflow at the tested commit; a configured test is not evidence that it passed.

The target is current Chrome, Edge, Firefox and Safari, including responsive mobile use. Optional APIs are detected at runtime rather than inferred from the browser's name. Exact device and codec behavior can vary with browser version, operating system and hardware; the table describes the automated matrix, not a claim of universal device certification.

## Capability-dependent features

Core selection editing, effects, WAV export, project save/open and ordinary playback do not require Web MIDI, output-device selection or screen sharing. Missing optional APIs are reported without breaking the editor.

| Capability | Behavior |
| --- | --- |
| Microphone/interface | Requested only by an explicit start action; Rescan devices refreshes permitted ports, and acquired channels/rate/processing are reported |
| System/tab audio | Available only when the browser's display picker supplies an audio track |
| Output-device selection | Disabled when `AudioContext.setSinkId` is unavailable; system default output remains usable. The permission picker appears only when `selectAudioOutput` is also available |
| MIDI hardware | Requires Web MIDI and permission; MIDI file import/export is independent |
| Long recordings | Require origin-private file storage (OPFS); quota and storage errors remain visible |
| Streaming file export | Uses the save-file picker where available; bounded downloads remain available otherwise |
| Surround monitoring | Depends on the browser and actual output device; the project layout alone does not establish hardware support |
| Live waveform/waterfall/spectrogram | Reads an existing Web Audio signal with Canvas; it never starts input itself. Freeze, reduced motion and offscreen suspension preserve audio playback |
| Ten-format import/export | WAV is built in; other encoders load from the app's own files. Browser decoding has a bundled fallback. Unsupported codecs/layouts report errors |
| Presets, themes and macro data tools | Use shared local processing; none independently requires device permission. Stereo center presets require an original stereo clip with both channels selected |

Device access uses the browser's operating-system audio route. It does not provide exclusive ASIO/WASAPI access, driver installation or sound-card buffer control. Displayed processing/output latency values are browser estimates, not a measured round trip. Input monitoring starts off, and display capture supplies audio only when the chosen browser/OS picker actually provides a track.

## Phone controls

Tap a waveform to place the cursor, drag to select, or enter exact IN/OUT times. Use the visible zoom, undo, effect and export controls without a hardware keyboard. Phone tracks put the mixer above a full-width waveform. Use **Hide sound tools** to collapse the inspector when arranging audio.

Touch input suppresses hover tips; the **Quick guide** and Help remain accessible. Keyboard focus and mouse hover still provide guidance when enabled in Options. All desktop tools remain available on the same page.

The ten-theme gallery, searchable 36-preset catalog and batch setup remain reachable on narrow screens. At the bottom, choose Waveform, Waterfall or Spectrogram and Program output or Active audio input. The plot sizes itself to the screen, retains separate waveform channels and stops animation when frozen or out of view. A reduced-motion preference starts it paused. Mobile decoding/encoding still shares the project's memory limits, so a maximum-size desktop session may be unsuitable for a phone.

## Reproduce

```sh
npm ci
npm run build
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

Use `npx playwright test --project=firefox` (or another project name) for a focused run. The `beta-verification-evidence` artifact includes the machine-readable `test-results/browser-results.json` with each project's actual results, the HTML report, failure traces/screenshots, responsive screenshots and `browser-stress.json` with measured operations and UI heartbeat counts. Hardware input, physical-device latency and long-duration real-device capture require separate device testing.

On a Linux host without a sound device, Firefox needs a functioning system audio backend to run a real-time `AudioContext`. The CI action starts PulseAudio with a 48 kHz stereo virtual output sink, then runs the same real PCM/worklet assertions. This provides an audio clock for headless testing; it neither mocks Web Audio nor verifies a physical interface. Backend diagnostics are retained with the verification artifacts. See [scripting and batch behavior](SCRIPTING.md) and [the user guide](USER_GUIDE.md) for the supported workflows and their limits.
