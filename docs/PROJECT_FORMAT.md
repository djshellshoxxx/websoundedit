# Portable project and settings JSON v1

A project file is a self-contained snapshot of the current edit. It contains metadata, tracks, clip placements and **actual edited PCM**; it does not require the original audio files to remain available. It does not contain undo history or clipboard contents. Use `project.save`/`project.load` rather than manually constructing PCM envelopes.

## Root object

```json
{
  "format": "websoundedit",
  "version": 1,
  "name": "Session name",
  "sampleRate": 48000,
  "bpm": 120,
  "beatsPerBar": 4,
  "beatOffset": 0,
  "tracks": [],
  "markers": [],
  "selection": null,
  "settings": {},
  "selectedTrackId": null,
  "selectedClipId": null
}
```

All clips share the project sample rate. Current support is mono or stereo and 8,000–192,000 Hz integer sample rates. The app normally works at 48 kHz. Tempo is 20–400 BPM. A clip's start is on the timeline; selection endpoints are relative to their clip. IDs are unique strings made from ASCII letters, numbers, `_` and `-`, at most 100 characters.

## Track and clip

```json
{
  "id": "track_example",
  "name": "Drums",
  "gainDb": 0,
  "pan": 0,
  "mute": false,
  "solo": false,
  "clips": [
    {
      "id": "clip_example",
      "name": "Loop",
      "start": 2,
      "audio": {
        "encoding": "f32le-base64",
        "sampleRate": 48000,
        "frames": 1,
        "channels": ["AAAAAA==", "AAAAAA=="]
      }
    }
  ]
}
```

Each channel string encodes one contiguous array of IEEE-754 32-bit floating-point samples, little-endian, in standard base64. Channel strings contain exactly `frames × 4` bytes before base64. The one-frame example above contains silence in both channels. Samples may exceed ±1 internally and are preserved exactly in project JSON. NaN, Infinity, unequal channel lengths and malformed encodings are rejected.

Metadata does not store references to executable code, remote URLs or arbitrary local paths. Import only recognizes the versioned fields it uses. Unknown project versions are rejected explicitly. Imported PCM is validated before replacing the current session; a failed load leaves the current project intact. Settings objects reject prototype-related keys and non-finite numbers.

## Selection and markers

```json
{
  "selection": {
    "trackId": "track_example",
    "clipId": "clip_example",
    "start": 0.25,
    "end": 1.25,
    "channels": "all"
  },
  "markers": [
    { "id": "marker_example", "name": "Drop", "time": 16 }
  ]
}
```

`channels` is `all`, `left` or `right`; right requires stereo. Selections must be nonempty after snapping to samples. Markers use timeline seconds. A loaded selection must refer to a valid clip.

## Settings files

```json
{
  "format": "websoundedit-settings",
  "version": 1,
  "settings": {
    "shortcuts": {},
    "effects": {},
    "ui": {}
  }
}
```

The engine stores JSON settings and validates their size and basic safety. The browser adapter owns meanings such as shortcuts, zoom and effect drafts. `settings.save` returns the wrapper; `settings.load` accepts `{settings: wrapper}` or `{settings: plainSettingsObject}`. The settings limit is 1 MiB. Settings do not embed audio; use a project for portable audio and edit state.

## Size and recovery

PCM is uncompressed inside the JSON. A 60-second 48 kHz stereo clip contains 23,040,000 bytes of float PCM; its base64 channel payloads take approximately 30,720,000 characters, plus JSON metadata. Compressed MP3/FLAC inputs therefore become much larger project files after decoding. The engine limits decoded project PCM to 256 MiB, tracks to 64, clips to 512, markers to 1,000 and timeline duration to 10 minutes.

The current project is fully recoverable from a valid saved file, including edited sample data and placements. Undo/redo entries are intentionally session-local and are not recovered from JSON. A project is not the same as an exported listening file: use audio export for a WAV/MP3/etc mix, and save project JSON to continue editing.
