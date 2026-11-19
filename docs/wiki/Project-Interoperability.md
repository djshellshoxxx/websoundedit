# Project interoperability: native sessions, Audacity, REAPER and audio exports

[[Home]] · [[User Guide]] · [Full Audacity guide](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/AUDACITY.md) · [Full REAPER guide](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/REAPER.md)

## Which output should I choose?

| Goal | Choose | What it preserves |
| --- | --- | --- |
| Reopen the editable WebSoundEdit project | Native session JSON | Supported clips, embedded PCM, arrangement, selection, project metadata and editing settings |
| Move only one editable track | Save single-track session | That track and its valid related edit/session references |
| Print finished audio | WAV/FLAC/Opus/available codec | Rendered PCM, not the editor's history or racks |
| Share separate tracks | All-stems ZIP | Independent named track renders; confirm alignment/range |
| Transfer to Audacity | Native AUP3 or legacy AUP exchange | Documented audio/clip/track subset and metadata |
| Transfer to REAPER | RPP/media ZIP | Genuine project.rpp plus relative WAV media; documented subset |

## Audacity

WebSoundEdit writes real AUP3 SQLite and legacy AUP/data-folder formats, not a renamed JSON project. Supported interchange includes mono/stereo PCM clips, positions, basic mix, labels and tags. Advanced plugins, envelopes, unsupported time/pitch transforms and certain overlap semantics require rendering. Surround can be exported only through an explicit per-speaker split-mono policy; it is not a native Audacity surround mixer. For legacy Audacity 3.4.2 AUP import, prepare an empty Audacity project with a matching sample rate; AUP3 avoids that legacy-specific prerequisite.

## REAPER

The ZIP contains `project.rpp` and relative `media/*.wav`. Extract together and keep the media directory beside the project. Supported material covers one active PCM file take per item, clip positions, visible source trims, names, overlap sums, track constant gain/pan/mute/solo, markers, fixed tempo/time signature and canonical mono/stereo/5.1/7.1 PCM.

Unsupported active plugin chains, automation envelopes, complex sends/folders, comping, multi-take projects, source transformations, pitch/time shifts, item fades and nonfile sources are not silently approximated. In REAPER, render/freeze complex tracks to WAV stems and retry transfer. A loose `.rpp` refers to external files; upload those media bytes explicitly. Absolute paths in a project are matched only as aliases to supplied media; they are never opened from the host filesystem or fetched over the network.

The source layouts and output layout must be explicit. A REAPER master with numbered channels does not imply OS speaker mapping. Confirm any 5.1/7.1 routing using the actual destination hardware. The importer reports potentially ambiguous media and refuses unsafe conversions.

## Conversion and privacy

Changing a file extension does not transcode the audio. Use the editor's actual export format options and confirm the browser/Node encoder availability. Standard edit/export operations process local audio; optional companion actions need explicit connection and permission. Neither a REAPER media path nor a macro can authorize arbitrary filesystem read from browser data.
