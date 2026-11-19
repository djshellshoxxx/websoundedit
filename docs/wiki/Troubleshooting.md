# Troubleshooting and known limitations

[[Home]] · [[User Guide]] · [[Developer Guide]] · [Verification evidence](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/audits/BETA_1_0_SUMMARY.md)

## The site shows the wrong version or does not load

Check the [release page](https://github.com/djshellshoxxx/websoundedit/releases) and latest successful [GitHub Actions deployment](https://github.com/djshellshoxxx/websoundedit/actions). A passing draft PR does **not** publish Pages. Refresh cached assets if the deployed build identifier differs. Missing worker, WASM or codec assets may cause an import or effect failure. Report the exact version, browser, requested action and console error.

## No audio output

A project's 5.1/7.1 channel layout does not guarantee surround-capable physical playback. Open Options → Audio output, choose an available device and a supported monitor route/downmix. The browser may require a user gesture to unlock AudioContext. Check operating-system mute/volume and monitor settings. Avoid input monitoring through speakers that can feed back into a live microphone.

## Microphone, MIDI or system audio missing

Permissions must be explicitly granted. Browser system capture appears only if the screen/tab sharing picker supplies an audio track; not all browsers and operating systems offer that. MIDI access depends on Web MIDI support, device connection and prior permissions. Imported projects cannot arm a pedal or seize devices. Check selected input/physical channel, mapping, edge/debounce and the local Arm control.

## A 5.1/7.1 file is rejected

An unmasked surround WAV may have ambiguous speaker order. Under Options choose the correct **imported source layout** and reimport. It must agree with the channel count and any known speaker mask. The separate **project output layout** sets rendering—not the input's identity. Pitch-preserving stretch/pitch currently requires mono/stereo. Unsupported codec/layout combinations report a limitation rather than silently drop channels.

## Project not reopening or REAPER media missing

Save a native session to keep editable WebSoundEdit data. An audio export is not a project. Extract the entire REAPER package including `project.rpp` and `media/`. A loose RPP import needs explicitly supplied media; the editor will not read arbitrary referenced paths. For complex native DAW effects/routing, render/freeze tracks to compatible WAV stems and retry. Audacity 3.4.2 legacy import needs an empty project at the matching rate.

## A macro fails or seems to skip files

Use **Validate** before Run. Only registered commands and allowed data expressions are supported. Supply file aliases before calling `file.import`, or let Batch files import each chosen input if the script has no import command. A permission-dependent browser command may not work in headless CLI. The batch owns the editor while running: outside editing/export calls return `BUSY`, but status, Stop and Help remain accessible. Cancel stops future actions; previously saved outputs are not rolled back. For large batches use CLI output directories rather than exceeding the browser's collected output budget.

## Recorder stopped early

Long recordings use browser disk-backed OPFS storage and a bounded chunk queue. Quota exhaustion or backpressure can stop capture and leave a recoverable partial manifest. Check storage permission, estimated available quota, queued bytes and recorded chunks. Pause removes gaps. Use range audition/import for editing rather than trying to load a multi-hour session into the ten-minute resident editor. Large exports require streamed WAV/RF64 or segmented output.

## UDP companion unavailable

The browser cannot send raw UDP directly. Start and authenticate the optional local Node companion and configure destination names in its operator settings. It binds loopback and checks Host, Origin and Bearer token. Only supported, installed encoding profiles appear. The receiver must match packet format/sample rate/channels. UDP is unencrypted/lossy; compressed formats may not recover from dropped stream headers or missing packets. Review gap/queue/error status; stop and restart when required.

## Report a reproducible defect

Open an [issue](https://github.com/djshellshoxxx/websoundedit/issues) with app version and commit/build identifier; browser/OS; sample rate and channel layout; command/parameters; minimal synthetic or non-sensitive fixture; exact expected vs actual PCM/UI behavior; steps to reproduce; and whether export, live monitoring or a recorded archive was involved. Do not upload private recordings, tokens or machine-specific companion configurations.
