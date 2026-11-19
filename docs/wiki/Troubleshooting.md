# Troubleshooting and known limitations

[Home](Home) · [User Guide](User-Guide) · [Developer Guide](Developer-Guide) · [Macros and Batch](Macros-and-Batch) · [Project Interoperability](Project-Interoperability) · [Verification evidence](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md)

This guide targets the **1.0.0-beta.1 candidate**. Match the running version and capabilities to the relevant evidence; the source pages do not confirm beta or wiki publication.

## The site shows the wrong version or does not load

Check the [release page](https://github.com/djshellshoxxx/websoundedit/releases) and latest successful [GitHub Actions deployment](https://github.com/djshellshoxxx/websoundedit/actions). A passing draft PR does **not** publish Pages. Refresh cached assets if the deployed build identifier differs. Missing worker, WASM or codec assets may cause an import or effect failure. Report the exact version, browser, requested action and console error.

## No audio output

A project's 5.1/7.1 channel layout does not guarantee surround-capable physical playback. Open Options → Audio output, choose an available device and a supported monitor route/downmix. The browser may require a user gesture to unlock AudioContext. Check operating-system mute/volume, transport state, track mute/solo, output routing and monitor gain. Input monitoring defaults off; enable it deliberately when you want to hear an acquired input. See [input and output setup](User-Guide#input-output-and-surround).

## Microphone, MIDI or system audio missing

Permissions must be explicitly granted. Browser system capture appears only if the screen/tab sharing picker supplies an audio track; not all browsers and operating systems offer that. MIDI access depends on Web MIDI support, device connection and prior permissions. Imported projects cannot arm a pedal or seize devices. Check selected input/physical channel, mapping, edge/debounce and the local Arm control.

## A 5.1/7.1 file is rejected

An unmasked surround WAV or browser-decoded multichannel source can have ambiguous speaker order. If you know that order, open **Options → General & theme → Source layout declaration**, choose the matching 5.1 or 7.1 layout and reimport. The declaration must agree with the channel count and any known speaker mask; it does not convert the file or override contradictory metadata. Return to **Auto** for ordinary imports. A macro/API import must pass its own explicit `layout` argument; it does not inherit this manual-import preference.

The separate project output layout controls rendering and does not identify an unknown source. Pitch-preserving stretch/pitch currently requires mono/stereo; linked surround speed processing is available when changing pitch and speed together is acceptable. Unsupported codec/layout combinations report their limitation instead of silently dropping channels.

## Project not reopening or REAPER media missing

Save a native session to keep editable WebSoundEdit data. An audio export does not contain editable track placement or rack definitions. Extract the entire REAPER package including `project.rpp` and `media/`. A loose RPP import needs explicitly supplied media; the editor will not read arbitrary referenced paths. If two supplied files have the same basename, provide an exact matching alias or an unambiguous package.

For complex DAW effects/routing, render compatible WAV stems in the original application and retry. Save and close an Audacity AUP3 before import so it has no pending recovery data. Audacity 3.4.2 legacy AUP import needs an empty project at the matching rate. See [Project Interoperability](Project-Interoperability) for the supported subset and preservation choices.

## A macro fails or seems to skip files

Use **Validate** before Run. Only registered commands and allowed data expressions are supported. Supply file aliases before calling `file.import`, or let **Batch files** import each chosen input if the script has no import command. A variable such as `input` must exist in that run's context. Browser-only device commands need the browser runtime and its permissions.

A batch cannot start while another command is still decoding/importing or editing. During snapshot, processing and restoration, outside mutation/export calls return `BUSY`; status, navigation and **Stop batch** remain accessible. Wait for restoration before editing again. Normal Run macros remain interactive. The default batch error policy stops at the first failed input; opt into continuing only when you want later files attempted. Check the per-file results and collected-output count.

Cancellation stops future actions after the current atomic operation; completed edits and downloads remain. Browser collected output is bounded to 128 MiB. Use smaller batches or the CLI output directory for larger jobs. The [macro/batch guide](Macros-and-Batch) explains aliases, isolation, export naming and cancellation.

## Recorder stopped early

Long recordings use browser disk-backed OPFS storage and a bounded write queue. Quota exhaustion, device loss or write backpressure can stop capture and leave a recoverable partial manifest. Check **Options → Recording & storage**, the available browser capabilities, estimated quota, written bytes and queued bytes. Open **Recording archive** and use **Recover interrupted recordings** to preserve the last complete range where available. Keep the archive until the required audio has been exported.

Pause omits the paused wall-clock interval; it does not remove gaps already captured. Stop the current take before reading its own archive. Archive reads and exports are blocked during active recording so they cannot starve the writer; pausing allows work on other completed archives.

Audition/import only the range needed for editing, within the ten-minute/256 MiB resident budget. A supported writable-file picker streams a full WAV/RF64 export without assembling the whole recording in memory. Without that picker, exports are bounded to 64 MiB; choose a shorter range. Storage remains tied to the browser, device and site until exported. See [loop layers and recording](User-Guide#loop-layers-and-long-recordings).

## UDP companion unavailable

The browser cannot send raw UDP directly. Start and authenticate the optional local Node companion, configure named destinations and connect it in **Options → Streaming companion**. Browser local-network permission may be required. Streaming needs an already acquired input; connecting the companion does not start the microphone. It binds loopback and checks Host, Origin and Bearer token. Only supported, installed encoding profiles appear. The receiver must match packet format/sample rate/channels. UDP is unencrypted/lossy; compressed formats may not recover from dropped stream headers or missing packets. Review gap/queue/error status; stop and restart when required. Follow the [companion setup guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/COMPANION.md) for the actual profile and receiver contract.

## Report a reproducible defect

Open an [issue](https://github.com/djshellshoxxx/websoundedit/issues) with app version and commit/build identifier; browser/OS; sample rate and channel layout; command/parameters; minimal synthetic or non-sensitive fixture; exact expected vs actual PCM/UI behavior; steps to reproduce; and whether export, live monitoring or a recorded archive was involved. Do not upload private recordings, tokens or machine-specific companion configurations.

## Source and scope

Adapted from the documentation contribution in [PR #5](https://github.com/djshellshoxxx/websoundedit/pull/5), at [commit 9798db8](https://github.com/djshellshoxxx/websoundedit/commit/9798db8c7555fb987132dcf8f9f5412f16196577), and reconciled with the current command schemas and repository guides. This page documents the **1.0.0-beta.1 candidate**; it does not announce a published beta, completed native verification or a live wiki.
