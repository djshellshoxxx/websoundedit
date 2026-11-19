# Beta interface, documentation and batch ownership review

The UI lane implements addressable Options/Help/Macros/Performance views, global hover/focus guidance, theme preferences, selection zoom, per-track close/save/export, explicit speaker selection, source-layout declarations, MIDI pedal mappings, live rack controls, capture layers, archive controls and automation editing. The complete user and macro guides describe the actual command contracts. Six documented macro programs were parsed, schema-validated against 129 available descriptors, canonically formatted and reparsed.

## Concrete integration findings

The initial batch implementation took a project snapshot before claiming its running lock. Two simultaneous batch calls could both enter. The corrected implementation claims cancellation/ownership before awaiting the snapshot. A second caller fails cleanly; cancellation during a held snapshot prevents edits; the original project/selection restores once even if teardown fails.

A later real-editor reproduction held a batch step and issued an outside UI gain edit and API export. Both succeeded in the temporary batch project; the outside export increased the collection from one expected output to two, and restoration erased the outside edit. The correction uses a private owner token and scoped runtime/file guards from acquisition through restoration. Outside origin strings cannot forge ownership. Nested commands inherit the actual owner through the runtime context. A batch rejects admission while another command, including a decoding import, is still active.

The regression holds the snapshot, execution and restoration separately. It checks outside UI/API/MIDI/macro/internal/batch mutations, outside output collection, nested owned execution, cancellation, delayed picker completion and prior command admission. Status, safe navigation and cancellation remain available. A persistent Stop batch banner provides cancellation after the macro view closes. Ordinary Run macros remain interactive.

The UI also checks ownership after delayed settings/script reads and save-picker completion, suppresses MIDI and gestures during batch ownership, and prevents recovery/settings persistence of temporary batch projects. Direct convenience API and file-alias paths use the same guards. This is application concurrency control; arbitrary trusted JavaScript with direct internal engine access is outside that boundary.

A source-layout gap was corrected by adding an explicit 5.1/7.1 declaration to canonical file import and an Auto/read-file preference in Options. A real maskless surround WAV proves automatic/mismatched declarations reject before replacement, while a matching declaration preserves all six channels. Output project layout remains a separate choice.

Other reviewed corrections cover prevalidating replacement recipes' live settings, preserving settings through teardown, stale rack updates, exact clicked-track exports, keyboard Escape behavior, delayed input teardown and unarmed imported MIDI/macro triggers. Known missing live capabilities are marked unavailable in the browser command catalog so macro preflight fails before earlier edits.

## Executed evidence

The final focused UI logic/MIDI/baseline group passed **22/22 tests with zero skips**. The root coordinator then ran the entire integrated suite: **299/299 Node tests passed**, all seven deterministic fuzz gates passed, and the production build/DOM-free SDK check passed. These are separate runs; overlapping counts are not added together.

`tests/beta-ui.spec.js`, `tests/live-audio.spec.js`, the preserved browser suites and `tests/help-capture.spec.js` exercise the actual production bundle in CI. The added batch-browser regression checks external edits/exports, a settings read started before ownership, the cancel banner and exact restoration. The capability regression checks an unavailable AudioWorklet before a prior generated-audio command can mutate the session. Those browser cases are written; their executed results are recorded in the combined release report after CI.

## Help images

The capture spec measures actual live DOM bounds, overlays numbered callouts with arrows, and captures the running interface on desktop and mobile. It produces 13 PNGs and a manifest containing captions, alt text, dimensions, callout bounds and source commit. The images must be downloaded and visually reviewed before `HELP_IMAGES` is populated and the beta is published. No synthetic screenshot or unexecuted browser result is represented as evidence.
