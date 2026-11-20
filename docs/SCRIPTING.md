# Scripting, randomization and batch audio

Open **Macros → Edit & run** to write a program, load an example, record editor actions or run a saved macro. Open **Batch audio** or **Macros → Batch files** to process supplied files in sequence. The same Macro 1 interpreter is used by the browser, CLI and local companion.

## Quick conversion and processing without writing a script

In **Batch files**, choose **Convert audio / apply a preset**. Choose an output format, an optional audio preset, and whether to peak-normalize each result to −1 dBFS afterward. Supply the input files and choose **Run batch**. **View the generated script** shows exactly which processing and export commands will run.

The conversion recipe exports the raw selected clip so track panning and project mixdown do not change its channel count. It uses the current project's sample rate. Each encoder still enforces its supported channel layouts and resource limits. The optional normalization is sample-peak normalization, not integrated-loudness or true-peak certification.

Supported audio export choices are **WAV, MP3, FLAC, Ogg Vorbis, Opus, M4A/AAC, raw AAC, AIFF, ALAC and WMA v2**. ALAC uses an M4A container. These formats can also be supplied to Import audio; the decoder reads the actual file contents. An unavailable codec, malformed file or unsupported layout produces a visible error. The conversion engine is served with the application and processes files on the device.

The batch starts each input in a cleared temporary session, runs the commands, collects exports and restores the original open project afterward. The script draft is retained. Download outputs individually as they finish, or download the collected ZIP at the end. **Stop macro** cancels after the current atomic operation; completed outputs remain available and the original session is restored. **Continue to the next file after an error** retains a per-file result list.

A batch accepts up to 128 unique supplied aliases. Input bytes, render allocations and collected exports keep their existing limits; the UI displays the output collection bound. A script cannot read arbitrary paths or URLs. The CLI accepts explicit input paths as command-line arguments and gives their bytes to the same interpreter as aliases.

## Language essentials

Macro 1 uses data expressions and named calls, rather than evaluating JavaScript. Every tool or command accepts **one argument object**:

```js
let levels = [-12, -9, -6, -3];
let total = array.sum({values: levels});
let average = array.mean({values: levels});
let gain = math.dbToGain({db: average});
```

Supported syntax includes:

- `let` variables; reassignment and `+=`, `-=`, `*=`, `/=`.
- Finite numbers, strings, booleans, `null`, arrays and plain objects.
- Arithmetic, comparisons, short-circuit `&&`/`||` and `!`.
- Own-property reads, including `values[0]`, `values.length` and `record.name`.
- `if`/`else`, nested `repeat`, `while` and `for (item of values)` loops.
- `break` and `continue` in loops.
- `wait({seconds: ...})` or tempo-relative `wait({beats: ...})`.
- Named editor commands such as `effect.normalize`, `selection.set`, `file.export` and `history.undo`.

Array helpers return new arrays. Keep a result by assigning it back; ordinary JavaScript array methods and property assignment are not part of Macro 1:

```js
let levels = [-12, -6];
levels = array.append({values: levels, value: -3});
levels = array.set({values: levels, index: 0, value: -9});
let ordered = array.sort({values: levels});
```

Variables declared inside a block stay in that block. Assigning an existing outer variable changes that variable. `for` iterates the evaluated array, so replacing an outer variable with another array does not extend a loop already in progress.

## Random number generator

Each execution owns its pseudo-random sequence. An execution without an explicit seed starts with a fresh seed. Seed once at the beginning for repeatable results across runs and browser/CLI runtimes:

```js
random.seed({seed: "my-sample-set"});
let gainDb = random.float({min: -6, max: -1});
let semitones = random.int({min: -3, max: 3});
let choice = random.choice({values: ["wav", "flac"]});
let order = array.shuffle({values: [1, 2, 3, 4]});
```

`random.float` includes the minimum and excludes the maximum. With no arguments it returns a number in `[0, 1)`. `random.int` includes both integer endpoints. Seeds are either unsigned 32-bit integers or nonempty strings of up to 256 UTF-16 code units. The generator is intended for creative variation, sampling and repeatable tests, not cryptographic keys.

Putting the same seed inside a repeated block deliberately restarts the same sequence. In a batch, each input is a separate execution: a fixed seed at the start of the script gives each file the same sequence. To vary by filename, use `random.seed({seed: input.stem});`.

## Nested loops and arrays

```js
random.seed({seed: 2026});
let rows = [];
for (gain of array.range({start: -12, end: 1, step: 3})) {
  let row = [];
  for (pan of [-1, 0, 1]) {
    row = array.append({
      values: row,
      value: {gainDb: gain, pan: pan, variation: random.int({min: 1, max: 4})}
    });
  }
  rows = array.append({values: rows, value: row});
}
let firstPan = rows[0][0].pan;
```

Nested loops share one iteration and operation budget. They do not each receive a fresh limit. The example library contains a six-tone sound bank, a repeatable six-variation audio export, and an array workbench that computes data without changing audio.

After a normal script finishes, expand **Run result and variables**. The preview shows returned variables and the last command result. **Download result JSON** saves the complete result; a long visual preview is shortened explicitly. Audio samples and large binary results should be exported with `file.export` instead of retained as macro variables.

## Data-tool reference

All arguments below are object properties. Optional properties appear in brackets. The searchable in-app reference is under **Macros → Random, arrays & math**.

| Tool | Arguments | Result |
| --- | --- | --- |
| `random.seed` | `seed` | Restart the sequence; return its normalized numeric seed |
| `random.float` | `[min]`, `[max]` | Random number; defaults 0 and 1 |
| `random.int` | `min`, `max` | Inclusive random integer, within signed 32-bit bounds |
| `random.choice` | `values` | One item from a nonempty array |
| `array.range` | `end`, `[start]`, `[step]` | Integer sequence; start defaults 0, step defaults 1, end excluded |
| `array.length` | `values` | Item count |
| `array.append` | `values`, `value` | Copy with one appended item |
| `array.set` | `values`, `index`, `value` | Copy with an existing index replaced; no sparse arrays |
| `array.concat` | `arrays` | Concatenate up to 128 arrays |
| `array.slice` | `values`, `[start]`, `[end]` | Interval copy; negative positions count from the end |
| `array.reverse` | `values` | Reversed copy |
| `array.sort` | `values`, `[descending]` | Numeric sort or deterministic UTF-16 string order; homogeneous types |
| `array.shuffle` | `values` | Fisher–Yates shuffle of a copy using the run's random sequence |
| `array.sum` | `values` | Finite numeric sum; empty array returns zero |
| `array.mean` | `values` | Mean of a nonempty numeric array |
| `math.abs`, `math.ceil`, `math.floor`, `math.sqrt` | `value` | Standard numeric result; square root rejects negative values |
| `math.round` | `value`, `[digits]` | Round to 0–9 decimal places; default zero |
| `math.pow` | `base`, `exponent` | Finite power |
| `math.min`, `math.max` | `values` | Extreme value of a nonempty numeric array |
| `math.clamp` | `value`, `min`, `max` | Value limited to the ordered bounds |
| `math.lerp` | `start`, `end`, `amount` | Linear interpolation, amount 0–1 |
| `math.dbToGain` | `db` | Amplitude gain from −300 to +300 dB |
| `math.gainToDb` | `gain` | Amplitude decibels; zero gain returns `null` |
| `text.string` | `value` | String representation of a finite scalar |
| `text.number` | `value` | Complete finite decimal numeric string, including exponents |
| `text.trim`, `text.lower`, `text.upper` | `value` | Whitespace/case transformation |
| `text.join` | `values`, `[separator]` | Join scalars; default separator is empty |
| `text.split` | `value`, `separator` | Split at a nonempty literal separator |
| `text.replace` | `value`, `search`, `replacement`, `[all]` | Literal replacement; all matches by default |

Text replacement does not interpret regular expressions or replacement tokens such as `$&`. Helpers keep data finite and bounded. Array helpers produce at most 10,000 items; smaller caller-supplied budgets can reduce that limit. Text is bounded at 131,072 UTF-16 code units and the aggregate value budget still applies.

## Audio processing and multi-format exports

Use the same commands as the visible tools. This program applies a preset and exports three formats for each batch input:

```js
effect.preset({presetId: "auto-limiter"});
for (format of ["wav", "flac", "mp3"]) {
  file.export({
    format: format,
    scope: "clip",
    raw: true,
    name: input.stem + "-" + format
  });
}
```

The batch makes `input`, `file` and `inputs` available. An alias has `id`, `name`, `stem` and `size`. The default per-file import happens automatically if the program has no `file.import` command. For explicit import, use `file.import({input: input.id});`.

The browser API can run a supplied program without replacing the draft:

```js
await websoundedit.execute('macro.batch', {
  text: 'effect.normalize({targetDb:-1}); file.export({format:"flac",scope:"clip",raw:true,name:input.stem});',
  inputIds: suppliedAliases.map(input => input.id),
  continueOnError: true,
  download: false
});
```

Supply the files through the GUI or the existing file-supply API before running this command. Choose either `macroId` or `text`; omitting both uses the current draft. The local companion already accepts explicit batch text and now gains the same data tools through the shared interpreter.

## Execution behavior and limits

Static syntax, command names and known argument shapes are checked before running the program. Dynamic values are validated when their call executes. A normal macro preserves completed atomic edits if a later command fails or the user stops it; use Undo for those edits. A batch restores its saved session after success, failure or cancellation and retains completed outputs.

Default bounds include 128 KiB source, 48 parser nesting levels, 10,000 loop iterations total, 10,000 named calls, 200,000 operations, 50,000 value nodes and 8 MiB of retained macro data. Builtin calls count toward the named-call limit, and array/string processing also consumes the operation budget. The runner yields regularly so Stop can be handled between bounded operations.

Scripts use registered command capabilities. They cannot evaluate JavaScript, call arbitrary object methods, access DOM globals, read unsupplied files or manufacture device permissions. Imported macros and project definitions do not arm capture or automatic triggers. Use the visible controls to enable device access and local triggers when needed.
