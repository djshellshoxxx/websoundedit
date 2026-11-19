# Macros, action recording and batch processing

WebSoundEdit 1.0 beta uses one text format, **WebSoundEdit Macro 1**, for recorded actions and written automation. Open **Macros** from the workbench, or use the addressable `#macros/editor` view. A saved `.wsemacro` file is UTF-8 text that you can read, edit and keep in version control.

The browser workbench, JavaScript API and optional local companion share command names and parameter schemas. Their available capabilities differ: an audio-device command requires a browser runtime, and a local file must be explicitly supplied before a macro can import it. Use the running environment's catalog to discover what it can do.

Related references: [User guide](USER_GUIDE.md), [API reference](API.md), [1.0 beta specification](specs/BETA_1_0.md), [release verification](VERIFICATION.md).

## Record an editing workflow

1. Open **Macros → Record actions**.
2. Leave **Record timing** off for a repeatable editing sequence. Enable it when the pauses between completed actions matter.
3. Click **Start recording**, return to the editor and perform the operations you want to repeat.
4. Return to **Record actions** and finish recording. Review the resulting text in **Edit & run**.
5. Give the macro a name, validate it, save it in the macro library or download a `.wsemacro` file.

The recorder captures successful semantic commands, such as selecting a region, applying gain, updating metadata or exporting a file. It does not turn every preview pointer movement, navigation click, failed command or state query into an audio edit. Commands invoked internally by a macro or batch are not recorded again.

Portable recording removes the current selected clip/track ID where the command can use the selection. An operation on a different explicitly chosen track keeps that track ID. Commands that require a live-layer ID keep it as well. Review those references before applying a recording to another project.

A recorded `file.import` uses the variable `input` instead of storing file contents or a filesystem path. Supply the file through **Batch files**, the browser file control or the API before running the macro. Device credentials and companion tokens are never included in recorded text.

### Timing and musical automation

Ordinary recording preserves command order and omits the time spent thinking between actions. **Record timing** adds explicit `wait` calls for elapsed gaps. This is useful for a sequence of transport and capture events.

For a repeatable smooth filter sweep, use `automation.set` with timeline points. Those values follow the audio clock. A sequence of UI waits is not a substitute for an automation lane.

## Edit steps or edit a program

**Visual steps** supports a top-level sequence of command calls. You can change its argument expressions, add a command, drag steps, or use the up/down and remove buttons. The text remains the saved representation.

If a program contains variable declarations, conditions or loops, Visual steps leaves the script intact and asks you to continue in **Script** mode. It never silently flattens control flow. **Format** produces canonical spacing; **Validate** checks syntax, known commands and statically known parameters. Values computed during a run are validated again when each command executes.

## Language reference

This is a bounded command language with JavaScript-like notation. It is not arbitrary JavaScript.

| Construct | Example | Meaning |
| --- | --- | --- |
| Command | `effect.gain({db: -3});` | Execute one registered command with an object of arguments. |
| Variable | `let gain = -3;` | Define a value in the current scope. |
| Assignment | `gain += 1;` | Update an existing variable. `=`, `+=`, `-=`, `*=` and `/=` are supported. |
| Condition | `if (gain < 0) { effect.gain({db: gain}); }` | Execute a block conditionally; `else` and `else if` are supported. |
| Repeat | `repeat (3) { effect.gain({db: -1}); }` | Repeat a block a bounded number of times. This example applies three edits. |
| Array loop | `for (file of inputs) { file.import({input: file}); }` | Iterate an array. `for (let file of inputs)` is also accepted. |
| Conditional loop | `while (gain < 0) { gain += 1; }` | Repeat while a condition remains true, subject to the iteration limit. |
| Loop control | `break;` / `continue;` | Exit or advance the surrounding loop. |
| Own-property read | `input.stem`, `layers[0].trackId` | Read a supplied object's own field or an array index. Missing fields are errors. |
| Time wait | `wait({seconds: 0.25});` | Wait with cancellation support. |
| Beat wait | `wait({beats: 4});` | Convert beats using the current project tempo at that wait. |

Values include finite numbers, strings, booleans, `null`, arrays and objects. Arithmetic, comparison and Boolean expressions are supported. Use braces around control-flow blocks and semicolons after statements. Comments can identify a program with `// WebSoundEdit Macro 1`.

There is no ambient `window`, `document`, Node filesystem, shell or arbitrary network function. Prototype access and function creation are unavailable. A command name must exist in the supplied catalog. Files are represented by explicit aliases; network streams choose a configured companion destination.

### Context variables

The browser macro runner supplies a bounded `project` description, the current `selection`, and an `inputs` array of file aliases. Batch processing additionally supplies `input` and `file` for the current file. An alias has `id`, `name`, `stem` and `size` fields.

The editor's Run button also supplies `input` when a first file alias is available. A shortcut or on-import script should use the context it actually receives, rather than assume a particular file is present. The on-import hook receives `imported` results and `inputs`; it operates on the successfully imported current project.

Initial context values are snapshots. If an earlier command changes the selection, tracks or tempo, query the state again when you need fresh values. The `wait({beats: ...})` implementation reads current tempo separately for each wait.

Keep command results small when assigning them to variables. Analysis results, clip IDs and loop-layer lists are suitable. Large PCM arrays or encoded files can exceed the macro value budget. Execute an export as a statement instead of retaining its bytes in a variable.

## Example 1: clean the selected sample and export

Select a clip first. This program clears any narrower selection, trims quiet ends, normalizes its peak and exports the resulting whole clip. `raw: true` bypasses track gain/pan; it still includes the edits just committed to the clip's samples.

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: "cleaned-sample"});
```

Trim quiet ends differs from removing every quiet region inside a recording. Normalization here is sample-peak normalization, not a LUFS or oversampled true-peak target. Change `format` to an encoder available in the active runtime, such as `flac`.

## Example 2: isolated cleanup and conversion batch

Save this script, open **Batch files**, choose that macro and supply one or more input files. The batch imports the current file automatically because the script contains no `file.import` call.

```wsemacro
// WebSoundEdit Macro 1
selection.clear({});
effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
effect.normalize({targetDb: -1});
file.export({scope: "clip", format: "flac", raw: true, name: input.stem});
```

Each file starts in a cleared editor. The browser snapshots the original session and selection, processes files sequentially, stops batch-owned live resources and restores that original session once after completion, error or cancellation. Permission grants and trigger arming are not restored from the snapshot. The Node batch uses a separate editor for each input.

The browser batch owns the editor and its output collection from the start of that snapshot until restoration finishes. During this interval, outside edits, imports, exports, MIDI controls and project replacement are rejected with `BUSY`. You can close the macro view, read status, browse Options or Help and stop the batch from the persistent banner. Navigation does not grant a command permission to modify the batch's project. A command already running, such as an audio import still decoding, must finish before the batch can begin. Normal **Run** macros remain interactive, including live performance controls.

Use semantic commands such as `effect.gain`, `project.save` and `file.export` inside a batch. UI action wrappers that perform edits or open a file picker, such as `ui.project.save`, are rejected before the snapshot; the script should describe the actual operation. `macro.status({})` reports whether a batch owns the session, its progress, per-file results and the collected-output count. **Stop batch** cancels the remaining work and retains completed outputs while the original session is restored.

The default is to stop on the first error. **Continue to the next file after an error** deliberately retains per-file failures and attempts later files. Completed output remains available. **Download each output as it completes** creates individual downloads; otherwise use **Download collected outputs ZIP** after the run.

Collected browser outputs and a stem ZIP are each bounded to 128 MiB. Split larger jobs into smaller batches or use the CLI with an output directory. Output names are sanitized and made unique without relying on case differences.

The same saved file can be used locally:

```bash
node scripts/cli.mjs --batch \
  --input kick.wav --input snare.wav \
  --macro cleanup.wsemacro --output-dir exports
```

Native FFmpeg is required for non-WAV formats in the Node/CLI environment. `--continue-on-error` opts into continuing after a failed file. The CLI chooses destination paths; the macro receives aliases and filename stems, not unrestricted filesystem access.

## Example 3: an explicit input loop

This alternative is useful when you want the script itself to control imports. Supply files before running it.

```wsemacro
// WebSoundEdit Macro 1
for (file of inputs) {
  file.import({input: file, replace: true});
  effect.trimSilence({thresholdDb: -48, minDuration: 0.05, padding: 0.01});
  effect.normalize({targetDb: -1});
  file.export({scope: "clip", format: "wav", bitDepth: 24, raw: true, name: file.stem});
}
```

A normal Run does not provide the batch's session-restoration wrapper. This program intentionally replaces the current project and leaves the last imported file open. Save your session first, or use **Batch files** for isolation. Import hooks do not recursively run during either kind of macro import.

## Example 4: a filter ramp over looped transport

Use a project containing at least eight seconds of audio. The program installs a master low-pass filter, defines an eight-second sweep and plays a loop. Stage ID `sweep-filter` connects the automation to the correct rack instance.

```wsemacro
// WebSoundEdit Macro 1
live.rack.set({target: "master", chain: [
  {id: "sweep-filter", effect: "filter", enabled: true, wet: 1,
   params: {type: "lowpass", frequency: 240, q: 0.707}}
]});
automation.set({target: "master", enabled: true, lanes: [
  {slotId: "sweep-filter", param: "frequency", points: [
    {time: 0, value: 240, curve: "linear"},
    {time: 8, value: 6000, curve: "linear"}
  ]}
]});
transport.set({bpm: 120, loop: true, loopStart: 0, loopEnd: 8});
transport.play({scope: "mix", position: 0});
wait({beats: 16});
transport.stop({});
```

Automation times are project-timeline seconds. Rendering a range beginning at ten seconds evaluates the lane at ten seconds. Live rendering starts effect history empty at the requested range start and ends at the requested boundary. To capture feedback already sounding in the running graph, use the recorder.

To export the current live settings explicitly:

```wsemacro
// WebSoundEdit Macro 1
file.export({scope: "mix", format: "wav", bitDepth: 32, live: true, start: 0, end: 8, name: "live-rack-render"});
```

## Example 5: capture and control a live layer

This example captures the playing master program, so it does not request a microphone. It waits for a new layer to appear, then mutes, unmutes and stops only that layer. The completed track remains editable.

```wsemacro
// WebSoundEdit Macro 1
let before = loop.track.list({});
transport.set({bpm: 120, loop: true, loopStart: 0, loopEnd: 8});
transport.play({scope: "mix", position: 0});
loop.capture.start({source: "master", beats: 4, quantize: "beat", name: "Four-beat layer"});
let layers = before;
repeat (8) {
  wait({beats: 1});
  layers = loop.track.list({});
  if (layers.length > before.length) { break; }
}
if (layers.length > before.length) {
  let layer = layers[layers.length - 1];
  loop.track.mute({trackId: layer.trackId, muted: true});
  wait({beats: 2});
  loop.track.mute({trackId: layer.trackId, muted: false});
  wait({beats: 4});
  loop.track.stop({trackId: layer.trackId});
}
transport.stop({});
```

For microphone or interface capture, explicitly start the input in **Options → Audio input**, then choose `source: "input"`. A script cannot make a browser permission prompt succeed without the required interaction. `loop.capture.toggle` is a useful MIDI pedal action; define its beats/source/quantization arguments and arm pedal mappings locally.

`loop.track.remove` removes the editable track as well as its live voice. Use `loop.track.stop` to keep the track. Project replacement stops live input, capture, layers and MIDI voices; loading definitions does not resume them.

## Shortcuts and on-import processing

Save the macro, open **Macros → Local triggers**, assign an unused shortcut and enable saved shortcuts for the current local session. The editor rejects duplicate macro shortcuts and conflicts with its workbench actions. Sequential keys work as well as modified single keys. Normal text entry retains its editing behavior.

To automate manual imports, choose a saved macro under **After manual import** and explicitly arm it. A successful manual batch invokes it once after its imports finish. A cleanup macro can trim, normalize and export the selected imported sample. It should not contain another manual import workflow. Imports performed by a macro or batch do not invoke the hook again.

Project/settings/script imports may restore definitions but never the armed state. MIDI pedal action mappings have their own local arm control, per-input rising-edge tracking and debounce. A release or repeated held value does not fire a second capture.

## API entry points

The running workbench exposes the full catalog and browser adapters:

```js
await websoundedit.ready;
const catalog = websoundedit.commandCatalog();
const command = catalog.find(item => item.method === 'live.param.set');
console.log(command.schema, command.capabilities);

await websoundedit.execute('macro.run', {
  text: 'effect.gain({db: -3});',
  variables: {}
});
await websoundedit.execute('macro.cancel', {});
```

`websoundedit.inputs.supply(files)` accepts actual browser `File` objects and returns aliases. `file.import` accepts an alias ID or alias record. For a source with unidentified surround order, explicitly pass `layout: "5.1"` or `layout: "7.1"` only when that speaker order is known. Omitting `layout` reads the source metadata; a manual-import preference does not silently change a script or API import. The UI command `ui.file.export` opens a dialog; `file.export` performs the concrete export. Likewise, `ui.options`, `ui.macros`, `ui.performance` and `ui.help` navigate within the workbench.

For an embedded application, the built `api.js` exports `parseMacro`, `validateMacro`, `formatMacro`, `macroToSteps`, `stepsToMacro`, `MacroRunner`, `ActionRecorder`, `CommandRuntime`, `createCoreRuntime` and `createBrowserRuntime`. The core runtime has no browser dialogs or local file adapter. The browser runtime adds live audio and companion commands; a host supplies its own concrete file/UI adapters where needed. The shipped workbench does that registration for you.

## Errors, cancellation and bounds

Validation is not a promise that a later device, storage operation or dynamically calculated value will succeed. Runtime errors include the command, location and completed-step count when available. A plain macro applies commands in order; it is not one automatic undo transaction. Completed exports, recordings and network packets cannot be undone by rolling back an editor snapshot.

**Stop** cancels waits and checks between commands. An atomic edit already executing can finish before cancellation takes effect. The batch wrapper still performs teardown and its single session restore. The recorder preserves completed archive chunks after a recoverable failure.

| Resource | Default bound |
| --- | --- |
| Macro source | 128 KiB UTF-8 |
| Tokens / AST nodes | 30,000 / 20,000 |
| Nesting depth | 48 |
| Total loop iterations | 10,000 |
| Completed commands | 10,000 |
| Interpreter operations | 200,000 |
| Macro value graph | 50,000 nodes and 8 MiB |
| Single string | 131,072 code units, also subject to the byte/memory bounds |
| Wall-clock run time | Four hours, including waits |
| Saved browser macro library | 32 macros; 512 KiB of saved text including the draft |
| Supplied browser batch inputs | 128 unique file aliases |
| Collected outputs / stem archive | 128 MiB |

The SDK can lower interpreter limits for a run; it cannot raise these built-in maxima. The editor's ten-minute/256 MiB resident project limits remain independent of the long recording archive. Read the active command catalog and `audio.capabilities` for device, output, graph and recording support. See [verification](VERIFICATION.md) for actual tested evidence rather than inferring support from a button or code example.
