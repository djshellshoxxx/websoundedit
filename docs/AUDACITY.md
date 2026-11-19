# Audacity project and metadata compatibility

WebSoundEdit loads and saves real Audacity **3.x `.aup3` projects** and legacy **`.aup` plus `_data` audio blocks**. Conversion runs locally in the browser. SQLite WASM and the XML/ZIP libraries are shipped with the app; no project audio is uploaded.

## Save and open

- Use **Save project**, then choose **Audacity AUP3** for one self-contained project file.
- Choose **Audacity AUP ZIP** for legacy interchange. Extract the downloaded ZIP before opening `project.aup` in Audacity. Keep `project_data` beside that file.
- **Audacity 3.4.2 legacy import:** set the blank Audacity project's sample rate to the rate listed in the ZIP's `README.txt` before opening an AUP. That version creates imported clips at the current project rate before applying the file's rate, which can move clip offsets when the rates differ. AUP3 avoids this legacy import issue.
- Use **Open project** for AUP3 or a ZIP containing exactly one legacy `.aup` and its matching `_data` folder.
- For a loose legacy project, select its containing folder so the browser can provide both the `.aup` and every referenced audio block. A standalone `.aup` contains instructions, not its audio.
- Save and close an AUP3 in Audacity before importing it. Files with pending recovery/autosave data are rejected; importing a stale saved state would be misleading.

Native WebSoundEdit JSON remains the complete session format. Save a JSON copy when you need effect rack drafts, themes, key estimates/colors, MIDI mappings, or other editor settings. Audacity exports contain committed audio. Apply a preview before exporting if you want that processing in Audacity.

## Preserved and translated data

| Data | Behavior |
| --- | --- |
| Mono/stereo audio | Exact float PCM on export; 16-bit and 24-bit integer Audacity blocks convert to float on import. No lossy audio encoding. |
| Clip names and placement | Preserved as sample audio and clip offsets; selection edits already applied in WebSoundEdit remain in the PCM. |
| Track names, mute and solo | Preserved. A source gain of zero becomes an explicitly muted track. |
| Gain and pan | Translated mathematically to preserve the audible mix. Audacity uses linear balance panning; WebSoundEdit uses equal-power mono panning and cosine stereo balance, so displayed control values can differ. |
| Mixed mono/stereo clips in one track | Split into a mono and a stereo track group when exported. This preserves source PCM and playback gains because Audacity track channel layouts are fixed. |
| Overlapping clips in one track | Split into separate Audacity track lanes. Every lane keeps the source gain, pan, mute and solo settings, so simultaneous clips still sum correctly. Adjacent clips can share a lane; the 64-track limit applies after splitting. |
| Sample rates | Project rate is preserved. Imported tracks with another rate are resampled to the project rate and reported. |
| Labels | Point labels become markers. Range label start markers are displayed; range ends are kept in project settings for subsequent Audacity export. |
| Metadata | Title, artist, album, album artist, composer, genre, date, track/disc, comment, copyright, BPM and key are exchanged as Audacity project tags. Unrecognized imported tags are reported. |
| Hidden clip trims | Visible audio and placement are preserved by rendering trims into imported PCM. Hidden trimmed audio is not retained; the import reports this. |

The export uses Audacity's 3.0-compatible SQLite schema and the 1.3 XML format. It writes actual `project`, `autosave` and `sampleblocks` tables, the `AUDY` application identifier, a binary XML dictionary/document, float audio blocks, and waveform summary triples. The `.aup3` extension is never used for JSON. Legacy export includes genuine little-endian AU blocks with Audacity waveform summaries.

## Unsupported Audacity features

The importer rejects sound-changing features that the editor cannot reproduce accurately: realtime effect plugins, volume envelopes with points, non-unit realtime stretch, realtime pitch shift, tempo-stretched clips, note tracks, time-warp tracks, external/aliased audio blocks and missing blocks. Compressed legacy AUP projects containing external audio import references must first be opened and saved as a self-contained AUP3 in Audacity. Render other unsupported tracks or export audio stems in Audacity first. It also rejects cut-line edit history and malformed native tracks containing overlapping clips rather than silently changing their playback.

Unaligned left/right stereo clips or independently mixed stereo channels require a stereo audio export from Audacity. Projects with audio before time zero, beyond the ten-minute timeline, over 64 track groups, over 512 clips, or above the 256 MiB decoded PCM budget do not fit the current editor. Newer database/XML schemas, including Audacity 4.x formats, are not claimed to be supported. There is no universal round-trip guarantee for every Audacity version or plugin.

The reader checks container size, XML nesting and dictionary references, finite/sample-magnitude bounds, sequence/block lengths, decompressed ZIP totals, and archive paths. XML nodes, depth and attribute counts are bounded before DOM allocation. SQLite tables must match the supported ordinary Audacity schema; virtual/generated columns are rejected before reading their values. ZIP checks cover local/central names and sizes, data descriptors, payload bounds, CRC-32 and exact output length. A DEFLATE symbol preflight rejects expansion beyond the declared size before output is allocated or expanded. At most **20,000 DEFLATE blocks across all extracted entries in one archive** are supported, including empty blocks; this also bounds repeated Huffman-table parsing. ZIP64 is rejected, and extraction uses the validated directory entries directly. Internal XML entities and external audio aliases are not resolved. A failed import does not replace the open editor project.

## Metadata in exported audio

The metadata editor updates project tags. Audio export writes tags independently of the audio samples.

| Container | Embedded metadata |
| --- | --- |
| WAV | Standard RIFF `LIST/INFO`: title, artist, album, genre, date, track, comment and copyright. Other fields remain in the project and are reported as omitted. |
| Opus | UTF-8 `OpusTags` / Vorbis comments in the dedicated Ogg Opus encoder. |
| MP3, FLAC, Ogg Vorbis, M4A, ALAC, WMA | Tags passed to the container's FFmpeg metadata writer. Exact field display depends on the container and player. |
| AIFF | FFmpeg ID3v2 writing is enabled explicitly when tags are provided. |
| Raw AAC / ADTS | These project tags are not embedded. The export UI reports the limitation; M4A is the tagged AAC alternative. |

Tag values are bounded text and are passed as structured argument values, never executed as shell strings. Title and artist are independently checked with native FFprobe across WAV, MP3, FLAC, M4A, AIFF and Opus in the automated metadata suite.

## Verification

`tests/audacity.test.js` checks real SQLite structure, modern and legacy project round trips, stereo PCM, timing, tags, mix state, labels, overlap lane splitting, binary XML, AU decoding, recovery rejection and malformed input. `tests/metadata.test.js` verifies metadata round trips and independent native FFprobe reads. The native application gate also checks that overlapping exported clips contribute to Audacity's rendered mix. Native verification results and the exact Audacity version are recorded in the release verification notes when available.

## Primary format references

- [Audacity project documentation](https://manual.audacityteam.org/man/audacity_projects.html)
- [Legacy Audacity 2.x projects](https://manual.audacityteam.org/man/audacity_2.html)
- [Audacity 3.7.9 SQLite schema and project writer](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectFileIO.cpp)
- [Audacity 3.7.9 binary XML field layout](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectSerializer.cpp)
- [Audacity 3.7.9 sample block format and summaries](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/SqliteSampleBlock.cpp)
- [Audacity 3.7.9 track serialization and pan law](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-wave-track/WaveTrack.cpp)
- [Audacity 3.7.9 clip serialization](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-wave-track/WaveClip.cpp)
- [Audacity 2.4.2 AU block layout](https://github.com/audacity/audacity/blob/Audacity-2.4.2/src/blockfile/SimpleBlockFile.cpp)
- [Audacity 2.4.2 waveform summary layout](https://github.com/audacity/audacity/blob/Audacity-2.4.2/src/BlockFile.cpp)
- [Audacity 3.4.2 legacy AUP importer and project-rate ordering](https://github.com/audacity/audacity/blob/Audacity-3.4.2/modules/mod-aup/ImportAUP.cpp)
- [Audacity 3.4.2 deferred track-rate application](https://github.com/audacity/audacity/blob/Audacity-3.4.2/libraries/lib-wave-track/WaveTrack.cpp)
- [RIFF/WAVE chunk layout](https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html)
- [RFC 7845: Ogg Opus and OpusTags](https://www.rfc-editor.org/rfc/rfc7845.html)

The implementation was written for this repository from file-format behavior. It does not bundle Audacity implementation code or native application binaries.
