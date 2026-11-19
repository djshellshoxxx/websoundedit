# Macros, action recording and batch processing

[Home](Home) · [User Guide](User-Guide#macros-visual-steps-and-batches) · [Developer Guide](Developer-Guide#macros-and-command-schemas) · [Troubleshooting](Troubleshooting#a-macro-fails-or-seems-to-skip-files) · [Full Macro 1 reference](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md)

These instructions describe **1.0.0-beta.1**. Check the [guide version](Home) and [beta verification record](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/audits/BETA_1_0_SUMMARY.md) against the running editor.

The **WebSoundEdit Macro 1** format is UTF-8 text saved as `.wsemacro`. Visual action recording, the simple step builder and typed programs share this exact representation. It is a bounded interpreter, **not JavaScript eval**: arbitrary browser globals, Node filesystem access, shell commands and network URLs are unavailable. Every invoked editor operation must be in the registered command catalog.

## Record a reusable action sequence

Open **Macros → Record actions**, start recording, perform the actual edits, stop and review the resulting **Script**. Record timing is optional. Without it, only semantic action order is retained; with it, waits capture meaningful gaps. Successful actions are recorded, not every mouse movement or failed command. A portable recorded import uses the `input` variable rather than embedding file bytes or a filesystem path. Supply that input when running the macro. Selected clip/track references can be made portable; explicit references to another track or a live layer keep their IDs, so review those before reuse.

The **Visual steps** view can reorder/edit top-level consecutive command calls, including expressions in their argument fields. Use drag controls or the up/down buttons. A script containing variable declarations, conditions or loops stays intact in **Script** mode; it is never silently flattened into steps. Validate before running, then save to the local macro library or download the text file. See the [illustrated workflow index](User-Guide#illustrated-workflow-index) for the planned action-recorder, visual-step and batch views.

## Grammar and variables

Commands use `method({ named: arguments });` syntax. Variables support `let`, assignment and arithmetic. Blocks support `if / else`, `repeat`, `for ... of`, `while`, `break`, `continue`, and `wait({seconds:...})` or `wait({beats:...})`. The interpreter enforces source, nesting, collection, iteration, time, command and output limits. Missing own properties and invalid schema parameters are errors.

Inputs must be supplied explicitly. The macro context exposes `inputs`, current `project`, `selection` and, during batch operation, `input`/`file`. File aliases contain `id`, `name`, `stem` and `size`. They are not arbitrary disk paths. The normal Run button supplies `input` when a first alias is available. Context objects are snapshots; query project state again if a previous command changed a value you need.

## Example: trim the ends and normalize

Select a clip before executing this program. Its output contains **committed** audio, not a temporary preview.

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: "cleaned-sample"});
```

`trimSilence` trims leading/trailing quiet audio only; it does not collapse interior pauses. Normalization is sample-peak based.

## Example: batch cleanup and conversion

Choose this saved macro in **Batch files**, select explicit input files, and choose continue-on-error only if desired. Since there is no explicit `file.import`, the batch runner imports the current input automatically.

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "flac", raw: true, name: input.stem});
```

Each batch file starts in a cleared editor and is processed sequentially. The browser snapshots the original project and selection, stops batch-owned live resources, then restores that session once after success, error or cancellation. It does not rearm imported triggers or reconnect devices as part of restoration. Node batches use a separate editor per input.

The browser batch owns the project from snapshot through restoration. Outside edits, imports, exports and MIDI actions return `BUSY`; an earlier command still decoding or editing must finish before batch admission. Status, navigation and the persistent **Stop batch** control remain usable after the macro panel closes. Normal **Run macro** execution remains interactive. Use concrete commands such as `effect.gain` and `file.export` in batches; unsafe UI action wrappers are rejected before the snapshot.

Completed outputs are retained. Download each output as it completes, or download the collected ZIP after processing. Supplied browser inputs are bounded to 128 aliases and collected output to 128 MiB; use smaller batches or the CLI output directory for larger jobs.

```bash
node scripts/cli.mjs --batch --input kick.wav --input snare.wav --macro cleanup.wsemacro --output-dir exports
```

For compressed output on Node, native FFmpeg must support the requested encoder.

## Musical timing and automation

With at least four beats of audio in the project, this script plays from the beginning and stops after a four-beat wait at the current tempo:

```wsemacro
// WebSoundEdit Macro 1
transport.play({scope: "mix", position: 0});
wait({beats: 4});
transport.stop({});
```

Use `automation.set` with timeline points and stable rack-stage IDs for smooth, repeatable parameter changes during playback. Waits are cancellable sequencing delays; an automation lane follows the audio clock. The [Developer Guide's filter-ramp example](Developer-Guide#macros-and-command-schemas) and [full macro reference](https://github.com/djshellshoxxx/websoundedit/blob/main/docs/MACROS.md) show automation and live loop-layer control.

## Shortcuts, imports and devices

Save a macro, then open **Shortcuts & imports** to assign a shortcut or choose an **After manual import** macro. Enable those triggers locally. Loading a project, settings file or script restores definitions without arming triggers, starting capture or opening a network connection. Manual-import hooks are suppressed during macro/batch imports to prevent recursive processing.

MIDI pedal mappings have their own local arm control, rising-edge detection and debounce. Device-dependent commands still need the browser's supported APIs, access grants and any required user interaction. Streaming commands select only a named destination configured in the optional companion; the language has no arbitrary URL or socket function.

## Troubleshooting scripts

Use **Validate** before Run. Invalid syntax, unknown commands or statically invalid arguments prevent the program from starting. Dynamic arguments, devices and storage are checked during execution; a later runtime error can leave earlier edits and outputs completed. A macro is not one automatic undo transaction, and cancellation cannot revoke an exported file or transmitted packet.

Unsupported browser-only commands fail with capability errors in headless CLI/HTTP use. If a script uses `file.import`, supply its aliases first. `macro.status({})` reports execution/batch progress, per-file results and collected-output counts. **Stop** cancels waits and future actions cooperatively; a current atomic command may finish first. See [macro troubleshooting](Troubleshooting#a-macro-fails-or-seems-to-skip-files) for `BUSY`, alias and output-limit recovery.

## Source and scope

Adapted from the documentation contribution in [PR #5](https://github.com/djshellshoxxx/websoundedit/pull/5), at [commit 9798db8](https://github.com/djshellshoxxx/websoundedit/commit/9798db8c7555fb987132dcf8f9f5412f16196577), and reconciled with the current command schemas and repository guides.
