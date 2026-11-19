# Post-publication baseline audit and correction checkpoint

The requested fuzz, QA/QC, code audit, deep bug investigation and security review began after Pages 0.2 publication was verified. Runtime source matched release `5906ba639d5c56e6d64a6c0eb64a8f469fc09d72`; initial failing evidence was preserved in remote commit `09d2c8e927c6078010a6490cebacd865ac4b2d39` before corrections.

| Lane | Reproduction and correction evidence |
| --- | --- |
| [Audio and project state](AUDIO_BASELINE_0_2.md) | Fixed realistic saved-project stack overflow, generated names beyond load limits, and explicit trim selection inconsistency. 2,400 stateful commands, 600 DSP cases, 1,800 WAV roundtrips and 1,800 WAV mutations reran with zero failures. |
| [UI and MIDI](UI_BASELINE_0_2.md) | Fixed cross-track note timing, rejected ambiguous same-track nested note-offs, canceled late microphone permissions/stale take decoding, restored invalid preferences/typed fields. 8,192 seeded MIDI/mapping/rack cases pass. |
| [Interchange and parser security](INTERCHANGE_BASELINE_0_2.md) | Fixed generated SQLite columns, ZIP size/CRC validation, XML complexity/depth consistency and PCM validation. Added shared 20,000-block DEFLATE work ceiling. 1,691 corpus cases plus six focused reproductions now have zero invalid accepted results; independent zlib comparisons included. |
| [API and security](API_BASELINE_0_2.md) | Fixed aggregate admission, worker lifecycle and invalid parameter normalization; hardened response expansion and aborted jobs. 1,210 negative cases and bounded concurrency probes pass. npm audit reported zero known dependency vulnerabilities. |

Combined correction checkout: **157 Node tests passed, zero failures/skips**, plus production build and built API verification. Audio and UI workers independently reviewed each other's assigned baseline boundaries and root's API queue/lifecycle corrections; root reviewed MIDI recording lifecycle and interchange changes, identifying the extra nested-note-off and compressed-work limits that were then added and tested.

Fresh browser regressions and genuine native Audacity exchange are submitted to CI before any release. Prior main's 31 browser cases and native exchange success remain historical evidence, not mislabeled post-correction results. A cloud-browser interruption prevented completing an additional live project-export smoke after the successful live version/asset/demo observation.

The beta implementation follows this correction checkpoint. It still requires its own complete audit/fuzz cycle, browser/native compatibility gates, actual illustrated help, Pages verification and GitHub prerelease. No physical guitar/MIDI/surround or multi-hour hardware recording claim is made.
