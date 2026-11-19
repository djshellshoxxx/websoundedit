# WebSoundEdit 1.0 beta — documentation hub

WebSoundEdit is a local-first multitrack editor for samples, effects, MIDI, automation, live looping and audio-project exchange. The browser workbench runs at **[WebSoundEdit](https://djshellshoxxx.github.io/websoundedit/)**. Most editing is local to the tab. An optional, separately launched Node companion provides authenticated local HTTP automation and operator-configured UDP output; GitHub Pages itself does not provide either service.

**Documentation:** [[User Guide]] · [[Macros and Batch]] · [[Developer Guide]] · [[Project Interoperability]] · [[Troubleshooting]]

## Get started

1. Open the editor. Its generated demo tracks let you explore selection and effects without uploading audio.
2. Import a local file, or select a demo clip. Drag across its waveform to choose a sample range. Use numeric IN/OUT fields for precise bounds.
3. Change a processing parameter, listen with Audition or A/B, and choose Apply to commit an undoable edit.
4. Choose a track-level export for one isolated track or a mix export for the project. Choose a native session save to retain editable audio, clips, markers and settings.
5. For looping, external MIDI, a microphone, system-audio capture or the companion, explicitly enable the capability and review browser permissions under Options.

For annotated, actual-interface screenshots, open the **[in-app help](https://djshellshoxxx.github.io/websoundedit/#help/navigation)**. Screenshots and arrow callouts must come from a verified running beta build; the published 1.0 guide is not considered complete until that capture/review gate passes.

## Versions and evidence

The wiki describes the **1.0 beta feature set**, not the earlier 0.2 live deployment. The definitive published version is the [release page](https://github.com/djshellshoxxx/websoundedit/releases); consult [1.0 beta release notes](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/releases/1.0.0-beta.1.md) until the tagged release is available. Do not infer release from a passing pull-request check.

Source-controlled reference documents: [full user manual](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/USER_GUIDE.md), [macro specification](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/MACROS.md), [API reference](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/API.md), [verification record](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/audits/BETA_1_0_SUMMARY.md).

## Important distinctions

- **Native editable project** is not the same as a rendered WAV/FLAC/Opus export. Save the project to retain editable track structure.
- **Project channel layout** (mono, stereo, 5.1 or 7.1) is independent of actual monitoring hardware. Inspect the output device and monitor/downmix policy in Options.
- **Resident waveform session** remains bounded to ten minutes and 256 MiB of decoded PCM. Disk-backed long recordings are kept in a separate archive; import a selected range for editing.
- **Macro scripts** are interpreted, bounded commands rather than arbitrary JavaScript. They cannot independently read filesystem paths, access a shell or open a network connection.
- **REAPER/Audacity compatibility** covers an explicit subset, not arbitrary plugins, complicated routing or externally referenced files.
