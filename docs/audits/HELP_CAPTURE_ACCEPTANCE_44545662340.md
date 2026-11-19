# Illustrated Help capture acceptance

## Decision and provenance

**All 22 fresh screenshots are accepted for the illustrated guide.** Each original PNG was visually inspected, including both mobile views. This set replaces the rejected first capture set documented in [the earlier review](HELP_CAPTURE_REVIEW_44534120888.md). Annotation text now fits its rectangles, arrow targets remain visible, and the mobile Options checkbox has the corrected compact layout.

The images were captured by the real running application in [Actions run 44545662340](https://github.com/djshellshoxxx/websoundedit/actions/runs/44545662340), from 14:50:35 to 14:50:45 UTC on 2026-11-19. That candidate passed 333 Node tests, seven fuzz suites, dependency audit with zero advisories, native Audacity and REAPER verification, and 55 browser tests. The one browser skip was the intentional post-deployment Pages check. The [candidate evidence record](BETA_1_0_CI_CORRECTED.json) preserves those results separately from this image acceptance.

| Provenance field | Value |
| --- | --- |
| Application version | `1.0.0-beta.1` |
| Candidate commit | `127664458a725b76db183e243806c4b7c27bdbdd` |
| Captured CI checkout | `19cc781cf492c6b9678e045c4f242bbf3091c4a4` |
| Matching application tree | `50bd6e45fe84b737bae843757e11bc36ec7191c8` |
| Evidence artifact | `14540739177` |
| Artifact SHA-256 | `d02981ccb8d8a7cbe7b9bb92a455db9bd961c3ddd0bbe9fc296bd0cbff17f2c9` |
| Original capture manifest SHA-256 | `9f9cee621ec5dcd30645134aa3f681d5be5cff5590d9c3d8856986b4983bbf51` |
| Original PNG total | `4141095` bytes |

The original PNGs are copied unchanged into [public/help](../../public/help/). The [original capture manifest](../../public/help/capture-manifest.json) retains the captured commit, timestamps, captions, accessibility text and DOM measurements. [provenance.json](../../public/help/provenance.json) adds the review decision, exact source mapping and a SHA-256 hash for each image. No image was retouched, regenerated or assigned a different capture commit.

## Visual acceptance

| Original capture | Chapter | Accepted content |
| --- | --- | --- |
| `guide-editor-desktop.png` | Navigation | Selection zoom, explicit track Save / Export, collapsible tools and colorful waveforms. |
| `guide-effects-desktop.png` | Effects | Three ordered rack stages, wet/dry controls, process mode and the complete XY pad. |
| `guide-channel-layout.png` | Surround | All four canonical speaker orders and the separate actual-output distinction. |
| `guide-midi-pedals.png` | MIDI | Unarmed pedal actions, command target, threshold and debounce controls. |
| `guide-macros-desktop.png` | Macros | Structured loop script, validation and run controls. |
| `guide-long-recorder.png` | Recording | Idle recorder source and separate committed/queued counters. |
| `guide-companion-streaming.png` | Streaming | Disconnected companion, empty token and unavailable destination/profile choices. |
| `guide-project-compatibility.png` | Compatibility | Native session, Audacity, REAPER and explicit Audacity surround policy. |
| `guide-sample-keys.png` | Keys | Actual uncertain/tonal estimates, confidence, colors and manual overrides. |
| `guide-export-metadata.png` | Export | Scope, source, format/layout and format-specific metadata support. |
| `guide-live-layers.png` | Looping | An actual short captured program layer with independent playback/mute/delete controls. |
| `guide-editor-mobile.png` | Tracks | Track export and selection zoom remain clear at 390 pixels. |
| `guide-options-mobile.png` | Navigation | Wrapped navigation, theme selection and the repaired compact guidance checkbox. |
| `guide-input-options.png` | Recording | Idle input, source/device/channels/gain and monitoring off. |
| `guide-output-options.png` | Surround | Explicit monitoring layout and actual reported maximum of two channels. |
| `guide-metadata-editor.png` | Export | Saved title/artist, available tag fields and Save metadata control. |
| `guide-macro-recording.png` | Macros | Two actual recorded commands, untimed mode and Finish recording. |
| `guide-macro-visual-steps.png` | Macros | Those two recorded steps, editable arguments and reorder controls. |
| `guide-batch-preparation.png` | Macros | Saved cleanup macro, two supplied files, error policy and Run batch before execution. |
| `guide-effect-automation.png` | Effects | Saved filter lane with 500 Hz at zero seconds and 5500 Hz at four seconds. |
| `guide-selection-editing.png` | Editing | Two-second selection, explicit channel scope and ready gain preview with Apply. |
| `guide-recovery-controls.png` | Recovery | Guidance links and the recovery-copy control without deleting data. |

Several focused dialogs continue below their scroll area; the illustrated target controls are visible. Captions distinguish an idle recorder and batch preparation from completed capture or processing. Device screens do not claim a physical microphone, MIDI controller or surround speaker test. The companion remains disconnected and contains no credential.

## Integration checks and remaining gate

Static integration checks passed for **22 unique PNGs covering all 14 chapters**, exact original byte hashes, PNG dimensions, non-placeholder captions/descriptions, and **61 callouts with 98 measured text rows** inside their label rectangles. The application manifest uses relative `help/…png` paths so the existing Vite base URL resolves assets on project Pages. Original captions, alt text and dimensions are retained in `HELP_IMAGES`.

The new `tests/help-images.spec.js` navigates every chapter in the actual Help view, checks all 22 rendered figures and descriptions, triggers native lazy loading, verifies natural dimensions and resolved URLs, and rejects page errors. It was added after this passing capture run: **its browser execution remains pending the final integration CI**. JavaScript syntax and whitespace checks pass locally. Final CI, Pages image loading and publication are separate required checks; this report does not claim they have already occurred.
