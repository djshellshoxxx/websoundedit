# WebSoundEdit

WebSoundEdit is a local audio workbench by Circuit Drift Labs: edit samples, arrange tracks, build effects racks, perform with live loops, and automate the same operations through scripts or an API.

**Guide version: `1.0.0-beta.1`.** Match this guide to the version displayed in the editor. The [release page](https://github.com/djshellshoxxx/websoundedit/releases) identifies downloadable versions; the [verification record](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) and [workflow runs](https://github.com/djshellshoxxx/websoundedit/actions) record their tested scope.

[Open the public editor](https://djshellshoxxx.github.io/websoundedit/) · [Repository](https://github.com/djshellshoxxx/websoundedit) · [User Guide](User-Guide) · [Developer Guide](Developer-Guide)

## Start here

1. Open the editor and explore its locally synthesized demo, or import an audio file.
2. Drag a waveform region or type its exact IN and OUT times. Choose the channels the edit should affect.
3. Adjust a tool or build a chain under **Shape the sound → Effects**. Audition the selection preview, compare it with the original, and Apply when ready.
4. Save a native project JSON to retain editable audio and workbench definitions. Export a mix, selected region, individual track, or aligned stems for listening and exchange.
5. Open **Options** for devices, layout, themes, shortcuts and guidance. **Help** keeps the current project open while you read.

## Choose a workflow

| Task | Guide |
| --- | --- |
| Select, trim, split, zoom and recover edits | [Selection and editing](User-Guide#selection-editing-and-waveform-space) |
| Reorder effects, control wet/dry, stutter a passage or use XY | [Effects, stutter and XY](User-Guide#effects-stutter-and-xy) |
| Detect sample keys and choose a theme | [Keys, themes and guidance](User-Guide#keys-themes-and-guidance) |
| Save one track, export stems or edit tags | [Save, export and metadata](User-Guide#save-export-and-metadata) |
| Exchange editable Audacity or REAPER content | [Project exchange](User-Guide#audacity-and-reaper) |
| Configure microphones, system audio and surround | [Input, output and surround](User-Guide#input-output-and-surround) |
| Use MIDI knobs, notes or pedals | [MIDI controllers and pedals](User-Guide#midi-controllers-and-pedals) |
| Capture loop layers or a long performance | [Loop layers and long recordings](User-Guide#loop-layers-and-long-recordings) |
| Record actions, edit visual steps or process a batch | [Macros and batches](User-Guide#macros-visual-steps-and-batches) |
| Embed the engine, use the CLI or call the local HTTP API | [Developer Guide](Developer-Guide) |

For focused workflows, continue with [Macros and Batch](Macros-and-Batch), [Project Interoperability](Project-Interoperability), or [Troubleshooting](Troubleshooting). These companion pages expand the user guide without changing its preservation and capability limits.

The rack includes echo, delay, reverb, chorus, flanger, phaser, distortion, tremolo, filter, tape, stutter and bitcrusher. Each instance has its own wet/dry control, and its stable identity keeps parameter bindings attached when it moves. Selection mode commits edits to samples; Live mode controls a track or master rack during playback.

## Understand what is saved

A native project includes current edited PCM, track and clip placement, selection, markers, metadata and supported workbench definitions. It does not contain undo history. Opening saved preferences does not reconnect devices, start recording or streaming, or arm imported macros and MIDI actions.

The editable project is bounded to ten minutes and 256 MiB of decoded PCM. The long recorder uses a separate disk archive and imports only bounded ranges into the editor. Audacity and REAPER exchange support documented subsets; an exported project does not transfer every feature of either application.

## References and illustrations

The maintained references are the [full user guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/USER_GUIDE.md), [macro guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md), [API reference](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/API.md), and [beta specification](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/specs/BETA_1_0.md).

The [illustrated workflow index](User-Guide#illustrated-workflow-index) links screenshots of the running application, with arrows to the controls used in each workflow. The in-app Help section presents the same illustrations alongside the relevant instructions.
