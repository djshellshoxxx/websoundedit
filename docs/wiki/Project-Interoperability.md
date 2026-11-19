# Project interoperability: native sessions, Audacity, REAPER and audio exports

[Home](Home) · [User Guide](User-Guide#save-export-and-metadata) · [Troubleshooting](Troubleshooting#project-not-reopening-or-reaper-media-missing) · [Full Audacity guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/AUDACITY.md) · [Full REAPER guide](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/REAPER.md)

These instructions describe the **1.0.0-beta.1 candidate's supported subset**. Keep the original DAW project and consult the [beta verification record](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) for actual tested revisions and native render results.

## Which output should I choose?

| Goal | Choose | What it preserves |
| --- | --- | --- |
| Reopen the editable WebSoundEdit project | Native session JSON | Supported clips, embedded PCM, arrangement, selection, project metadata and editing settings |
| Move only one editable track | Save single-track session | That track and its valid related edit/session references |
| Print finished audio | WAV/FLAC/Opus/available codec | Rendered audio in the selected encoding; no editable track arrangement or undo history |
| Share separate tracks | All-stems ZIP | Independent named track renders; confirm alignment/range |
| Transfer to Audacity | Native AUP3 or legacy AUP exchange | Documented audio/clip/track subset and metadata |
| Transfer to REAPER | RPP/media ZIP | Genuine project.rpp plus relative WAV media; documented subset |

## Native sessions and rendered audio

Native WebSoundEdit JSON preserves current edited PCM, placement, selection, markers, metadata and supported workbench definitions, including rack drafts, key annotations, MIDI mappings and macros. Undo history and the clipboard are not serialized. Opening saved definitions does not reconnect devices, start capture/streaming or arm imported actions. The [portable project format](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/PROJECT_FORMAT.md) defines the complete contract.

Single-track session saving keeps the clicked track and valid related references. A stem export instead creates independent audio files; choose project-length alignment when every stem should start at project zero and share an end time. Independent stem exports ignore mute and solo unless explicitly requested. See [save/export controls](User-Guide#save-export-and-metadata).

A selection preview is temporary until Apply. Native Audacity/REAPER exports use committed clip audio; they do not transfer WebSoundEdit's live graph. To transfer that processing, export audio with **Render current live effects** and use the resulting media. An offline live render starts effect history empty at its range start and ends at the requested boundary; use the recorder to capture already-running feedback and tails.

## Audacity

WebSoundEdit writes genuine AUP3 SQLite and legacy AUP/data-folder formats. Choose AUP3 for a self-contained file, or extract an AUP ZIP and keep `project_data` beside `project.aup`. A loose AUP needs its referenced audio blocks supplied together. Save and close a project in Audacity before import; pending recovery/autosave data is rejected instead of opening a stale saved version.

The supported subset includes mono/stereo PCM, clip names/placement, track mute/solo, translated gain/pan, labels and project tags. The apps' pan laws differ, so control values can change while audible gains are preserved. Overlapping WebSoundEdit clips split into Audacity lanes; mixed mono/stereo tracks can split into separate layout groups. Visible trims are rendered into imported PCM; hidden trimmed audio is not retained. Cut-line edit history is rejected.

Active plugins, volume envelopes, unsupported time/pitch transforms, external audio blocks and malformed native overlaps require preparation in Audacity. Render the unsupported processing or export compatible audio stems first. For legacy Audacity **3.4.2** AUP import, prepare an empty Audacity project at the rate listed in the package README; AUP3 avoids that legacy-specific rate prerequisite. The supported 3.x subset does not establish compatibility with Audacity 4.x or arbitrary plugins.

Surround is rejected by default. Explicit **split-mono** export creates speaker-labeled stems and preserves each source channel's PCM, placement, gain and mute/solo. It does not reproduce native surround speaker routing or front-pair pan in Audacity. The 64-track/512-clip limits still apply after channel and overlap splitting; choose a surround WAV, REAPER package or native JSON when an explicit surround layout is required.

## REAPER

The ZIP contains `project.rpp` and relative `media/*.wav`. Extract them together and keep the media directory beside the project. A `websoundedit-project.json` sidecar preserves the project name, output layout and supported tags; it does not replace the native RPP. Supported material covers one active file take per item, clip positions, visible source trims, names, constant item gain/polarity, direct track gain/pan/mute/solo, point markers, fixed tempo/time signature and canonical mono/stereo/5.1/7.1 PCM. Built-in media decoding handles WAV; other supported file sources require an explicit local decoder or a WAV conversion.

Visible trims and constant item gain/polarity are rendered into imported clip PCM. Overlapping exported clips use REAPER's **Always mix** behavior; overlapping replacement-mix items are rejected on import. The supported pan law is translated to preserve audible gains, and mixed-layout tracks can split into native tracks. When a surround source must feed a smaller output layout, the static downmix, gain and pan are rendered into new PCM rather than discarding channels through a direct master send.

Unsupported active plugin chains, automation envelopes, changing tempo maps, regions, complex sends/folders, custom routing, comping, multiple takes, source transformations, pitch/time shifts, active item fades, take panning and nonfile sources are rejected with a compatibility explanation. In REAPER, render/freeze complex tracks to WAV stems and retry transfer. A loose `.rpp` refers to external files; upload those media bytes explicitly. Absolute paths in a project are matched only as aliases to supplied media; they are never opened from the host filesystem or fetched over the network.

The package sidecar preserves the WebSoundEdit output layout. A loose REAPER project's numbered surround channels are interpreted in canonical order with a notice; they do not prove physical speaker routing. Confirm the original source order and actual output hardware. Ambiguous source WAV masks need a known layout at the decoder boundary. Refer to the [input/output layout guide](User-Guide#input-output-and-surround) before making a declaration.

## Conversion and privacy

Changing a file extension does not transcode the audio. Use the editor's actual export format options and confirm the browser/Node encoder availability. Standard edit/export operations process local audio; optional companion actions need explicit connection and permission. Neither a REAPER media path nor a macro can authorize arbitrary filesystem read from browser data.

## Transfer limits and evidence

The editable project remains bounded to ten minutes, 256 MiB of decoded PCM, 64 tracks and 512 clips. Layout/overlap expansion must fit those bounds. The compatibility references document additional parser, archive and native-feature limits. A native grammar probe verifies serialization details; it is not the full open/render/save/reimport gate. Consult the [beta evidence](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) before making a release-specific interchange claim.

## Source and scope

Adapted from the documentation contribution in [PR #5](https://github.com/djshellshoxxx/websoundedit/pull/5), at [commit 9798db8](https://github.com/djshellshoxxx/websoundedit/commit/9798db8c7555fb987132dcf8f9f5412f16196577), and reconciled with the current command schemas and repository guides. This page documents the **1.0.0-beta.1 candidate**; it does not announce a published beta, completed native verification or a live wiki.
