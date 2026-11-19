# Macros, action recording and batch processing

[[Home]] · [[Developer Guide]] · [Full Macro 1 reference](https://github.com/djshellshoxxx/websoundedit/blob/codex/v1-beta-performance-20261119/docs/MACROS.md)

The **WebSoundEdit Macro 1** format is UTF-8 text saved as `.wsemacro`. Visual action recording, the simple step builder and typed programs share this exact representation. It is a bounded interpreter, **not JavaScript eval**: arbitrary browser globals, Node filesystem access, shell commands and network URLs are unavailable. Every invoked editor operation must be in the registered command catalog.

## Record a reusable action sequence

Open **Macros → Record actions**, start recording, perform the actual edits, stop and review the resulting **Script**. Record timing is optional. Without it, only semantic action order is retained; with it, waits capture meaningful gaps. Successful actions are recorded, not every mouse movement or failed command. Stored import actions use explicit input aliases rather than embedding file bytes.

The **Visual steps** view can reorder/edit simple consecutive command calls. If the source contains conditions, loops or variables, edit the text directly; the UI must not flatten structured logic or conceal nested commands in a single visual step. Validate before running. Save to the local macro library or download the text file.

## Grammar and variables

Commands use `method({ named: arguments });` syntax. Variables support `let`, assignment and arithmetic. Blocks support `if / else`, `repeat`, `for ... of`, `while`, `break`, `continue`, and `wait({seconds:...})` or `wait({beats:...})`. The interpreter enforces source, nesting, collection, iteration, time, command and output limits. Missing own properties and invalid schema parameters are errors.

Inputs must be supplied explicitly. The macro context exposes `inputs`, current `project`, `selection` and, during batch operation, `input`/`file`. File aliases offer fields such as `stem`, `name` and `size`. They are not arbitrary disk paths.

## Example: trim the ends and normalize

Select a clip before executing this program. Its output contains **committed** audio, not a temporary preview.

```js
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: "cleaned-sample"});
```

`trimSilence` trims leading/trailing quiet audio only; it does not collapse interior pauses. Normalization is sample-peak based.

## Example: batch cleanup and conversion

Choose this saved macro in **Batch files**, select explicit input files, and choose continue-on-error only if desired. Since there is no explicit `file.import`, the batch runner imports the current input automatically.

```js
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "flac", raw: true, name: input.stem});
```

Each batch file is processed sequentially in an isolated/cleared session. The browser captures the original editor project and restores it at the end or after cancellation; outside edits and exports are blocked while the batch owns that session. The batch Stop control remains usable even when the macro panel closes. Completed files are not rolled back. Browser collected output is bounded to 128 MiB; use smaller batches or the CLI output directory for larger jobs.

```bash
node scripts/cli.mjs --batch --input kick.wav --input snare.wav --macro cleanup.wsemacro --output-dir exports
```

For compressed output on Node, native FFmpeg must support the requested encoder.

## Example: loop control and musical automation

```js
// WebSoundEdit Macro 1
transport.play({});
wait({beats: 4});
transport.stop({});
```

Smooth parameter changes during playback should use `automation.set` points referenced by stable effect IDs, rather than trying to synthesize timing with rapid UI clicks. Live capture and external MIDI require explicit browser capabilities and permissions. Scripts imported from projects or downloaded from another source cannot auto-arm import triggers, seize devices or choose arbitrary UDP destinations. A locally armed on-import trigger is suppressed during a macro/batch's internal imports.

## Troubleshooting scripts

Use **Validate** before Run. A static failure prevents prior edits; a runtime error reports the command and completed work, but cannot revoke an already exported file or transmitted packet. Unsupported browser-only commands fail with capability errors in headless CLI/HTTP use. If a script uses `file.import`, ensure its aliases were supplied. Use `macro.status({})` for batch progress and output collection; Stop to cancel cooperatively.
