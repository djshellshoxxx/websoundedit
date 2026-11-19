# First beta help capture review

## Evidence and provenance

The help-capture browser test passed in [Actions run 44534120888](https://github.com/djshellshoxxx/websoundedit/actions/runs/44534120888). Its complete manifest contains **22 PNGs and 61 DOM-measured callouts**, captured from the real running application on 2026-11-19, from 14:12:34 to 14:12:46 UTC. All 22 images were visually reviewed. This passing capture test does not turn the run's other browser failures into successful verification.

- Captured version: `1.0.0-beta.1`.
- Captured synthetic merge: `887497fe5aada524565d24b5948dd4a872624227`.
- Captured tree: `62f52485acf68a5efe0d763059f55d426991c5f7`; the application tree matches candidate `517f7d33547dfa6fa3b2c83bd223bdca1b11fd4d`.
- Evidence artifact SHA-256: `e4058ce4db0e0fc5d1fe82d8b750d5a05561e96ffbe95eb79ff21e6949d5e448`.
- Original `help-captures.json` SHA-256: `4c761ab4e4c2d5a15b69b594189f5f3d10069bd16029677cf3cfa438f008db63`.
- Original PNG bytes, total: `4112441`.
- Artifact directory: `test-results/browser/help-capture-capture-the-a-068ef-rrows-on-desktop-and-mobile/`.

The source manifest, PNGs and their recorded commit remain unchanged. Corrected images must receive the provenance of their own subsequent capture; they must not be presented as images from this run.

## Review decision

**Recapture the complete set before populating the public Help image manifest.** Several annotation strings escape their 230-pixel rectangles because the old helper wraps by character count without measuring the numbered prefix. The mobile Options image also reveals a product layout defect: a checkbox inherits the full-width form-input rule and squeezes its text into a vertical column.

The reviewed screens otherwise show real editor, project, device, recording, macro and automation states. Idle devices are represented as idle; the streaming form is disconnected with no token. The loop image contains an actual program capture. The recorder image does not claim a long physical recording was performed.

| Capture | Review observation |
| --- | --- |
| `guide-editor-desktop.png` | Selection/collapse annotation text escapes its box; editor controls and waveform targets are visible. |
| `guide-effects-desktop.png` | XY and processing-mode annotation text needs measured wrapping; all three stages and the XY pad are visible. |
| `guide-channel-layout.png` | Layout cards, speaker labels and actual destination distinction are visible; recheck annotation padding after wrapping. |
| `guide-midi-pedals.png` | Focused pedal controls are visible; annotation padding needs the shared correction. No device connection is fabricated. |
| `guide-macros-desktop.png` | Structured script, validation result and run controls are legible. |
| `guide-long-recorder.png` | Idle recorder, source and committed/queued counters are visible; recapture with measured label widths. |
| `guide-companion-streaming.png` | Token annotation overflows; disconnected state and empty credentials are accurate. |
| `guide-project-compatibility.png` | Native choices and surround policy are visible; RPP annotation overflows. Lower import buttons continue below the dialog scroll area. |
| `guide-sample-keys.png` | Real uncertain/tonal estimates and overrides are visible; label/confidence annotation overflows. |
| `guide-export-metadata.png` | Scope, committed/live source and metadata note are legible. |
| `guide-live-layers.png` | Actual captured layer and independent controls are visible. |
| `guide-editor-mobile.png` | Selection zoom and direct track export remain usable within 390 pixels. |
| `guide-options-mobile.png` | Reject: the full-width checkbox rule compresses its guidance text into a vertical column. |
| `guide-input-options.png` | Idle input and disabled monitoring are accurate; source annotation needs measured wrapping. |
| `guide-output-options.png` | Actual maximum channel count and monitoring choice are visible; both labels need measured wrapping. |
| `guide-metadata-editor.png` | Saved title/artist and Save metadata control are legible. |
| `guide-macro-recording.png` | Two actual successful commands and untimed recording state are visible. |
| `guide-macro-visual-steps.png` | Two recorded steps, editable arguments and reorder controls are visible; later run controls continue below the scroller. |
| `guide-batch-preparation.png` | Saved macro, two supplied files, error policy and Run batch are visible; no processing completion is claimed. |
| `guide-effect-automation.png` | Actual 500-to-5500 Hz lane and saved status are visible. |
| `guide-selection-editing.png` | Real scoped gain preview and Apply are visible; channel annotation overflows. |
| `guide-recovery-controls.png` | Recovery guidance and the untouched Clear recovery control are visible. |

## Corrections prepared for the next run

The screenshot helper now waits for the fonts, measures the complete numbered label with SVG text metrics, wraps by its available pixel width and adjusts box height. Every rendered text row is checked against its enclosing rectangle before capture. Row bounds are retained in the incremental manifest alongside the target and label bounds.

Checkbox sizing is explicitly compact inside form-grid labels. The Options/Help browser regression now measures the checkbox and its label at mobile width. Its Help navigation selector is scoped to the active Options content, because the workbench legitimately has another navigation-guide link in the background.

The separate live-rack browser trace reported `Unsupported effects rack settings`. All four live-to-UI rack loads now include the required settings version. Its existing regression asserts successful Live mode entry and uses the actual string IDs returned by the rack API.

Local verification for this correction checkpoint: JavaScript syntax and whitespace checks passed; the five rack-configuration tests passed. Browser rendering, mobile layout and the new measured annotation bounds still require the next CI execution. After reviewing those fresh PNGs, populate `public/help/` and `HELP_IMAGES` together, preserve their new capture provenance, and check every rendered Help image loads with the expected natural dimensions and accessible description.
