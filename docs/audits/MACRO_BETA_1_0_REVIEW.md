# Independent macro / command data-boundary review

Scope: read-only review of `src/macro.js`, `src/command-schema.js`, `src/command-runtime.js` and `src/macro-recorder.js` during the 1.0 beta implementation. The reviewing agent reported findings; the root implementation owner made the fixes. The checks below were rerun independently against the corrected shared tree. No user project, filesystem destination or network target was modified by these reproductions.

Severity refers to effect within the supported API contract. These are implementation-stage defects, not evidence that a published release was exploited. The external-AST/accessor reproductions require caller-supplied JavaScript objects; a plain macro text or JSON file cannot contain a JavaScript getter or method.

## Six confirmed findings and correction recheck

| ID | Severity | Confirmed reproduction and consequence | Root-owned correction; independent result |
| --- | --- | --- | --- |
| MAC-01 | P2 | With a context variable `bpm:120`, `track.add({name:"before"}); effect.gain({db:999,bpm:bpm});` executed `track.add` before rejecting the statically invalid gain. One dynamic sibling made the entire argument object unknown to preflight. Dynamic argument failures also lost their command/source location. | Validate known object fields and keys even alongside dynamic siblings; attach call-site context to dynamic failures. Recheck: **zero handler calls**, `INVALID_ARGUMENT`, line 1 column 29, completedSteps 0. A separate `let gain=999; effect.gain({db:gain});` fails at line 1 column 15 with command `effect.gain`, completedSteps 0. |
| MAC-02 | P2 | `formatMacro()` read an external root AST's `type` getter before checking its descriptor. The getter ran once, then the AST was rejected. | Inspect the root descriptor first. Recheck: getter invocation count **0**, rejected as an invalid program. A later nested-container follow-up is recorded separately below. |
| MAC-03 | P2 | `MacroRunner.run('let x=1;', {variables:{sparse:new Array(200000)}})` bypassed per-element copying counts. Heap checking spread the sparse array into function arguments and threw raw `RangeError: Maximum call stack size exceeded`. | Bound array length, require dense data properties, and avoid the spread. Recheck: deterministic `MacroError`, `RESOURCE_LIMIT`, “Macro array exceeds its item limit.” |
| MAC-04 | P2 | A generic command schema accepted `{buffers:Array(300).fill(new Uint8Array(1024*1024))}`. Per-value binary bounds existed, but the logical 300 MiB payload had no aggregate binary limit. The reproduction allocated only one shared 1 MiB array. | Add aggregate binary and general-data budgets. Recheck: `CommandValidationError`, `INVALID_ARGUMENT`, rejection at `params.buffers.256` for exceeding the aggregate **256 MiB** binary budget. |
| MAC-05 | P1 | Starting from `parseMacro('let a = x.y;')`, set the noncomputed member property's literal value to `y; track.remove({}); //`. `formatMacro()` emitted two statements, including `track.remove`, from one AST statement. Only formatting/reparsing was exercised; no command ran. | Require a Boolean access mode and a safe identifier literal for dot properties before code generation. Recheck: formatting rejects “A dot property must be a safe identifier.” No additional statement is emitted. |
| MAC-06 | P2 | An externally supplied AST with one literal containing 131,073 characters formatted to 131,101 bytes despite the 128 KiB macro source limit. | Bound aggregate AST text/keys and formatter output. Recheck: `MacroError`, “Macro AST text exceeds its source budget.” |

The root owner reported 18 focused macro tests passing after these corrections. The independent review reran the exact reproductions above and confirmed the listed behavior. It did not independently run every root-owned test or establish that no other macro defect remains.

## Follow-up from the same object boundary

After the six correction checks, two additional small JavaScript-object cases were confirmed and reported to the root owner:

1. **Nested AST getter, P2 API hardening:** parse `repeat(1){}`, replace the loop body's `type` property with a getter returning `BlockStatement`, then call `formatMacro()`. The parent shape check reads that getter once before the child node's descriptor check rejects it. A complete descriptor-only container preflight is needed before direct nested reads.
2. **Input-owned array method, P2 API hardening:** pass a dense `[1]` in `variables`, replacing its own `map` method with a function that increments a counter and returns `[]`. `safeValue()` invokes that method and the run succeeds. Indexed copying from already-validated data descriptors should not call methods supplied by the input object.

The root owner subsequently replaced nested type reads with descriptor-only checks, rejected malformed AST array containers and changed data-array/typed-array copying to indexed reads. Independent correction recheck: the nested getter invocation count is **0** before rejection; the input-owned array method invocation count is **0**, and the extra non-index array property is rejected (“Macro arrays accept indexed data only.”). The root owner reported 19 focused macro tests passing after the follow-up fixes.

Both follow-ups are therefore fixed for the exercised reproductions. They were not macro-text execution escapes: the reproductions deliberately supplied executable JavaScript properties through the public data API. No general exploitability claim is made.

## Independent deterministic fuzz and further correction recheck

Run `node tests/fuzz/macros.mjs docs/audits/MACRO_BETA_1_0_FUZZ.json`. The harness uses seeds `0x4d414331`, `0x4d414332` and `0x4d414333`. It never evaluates macro source as ambient JavaScript. Its numeric oracle computes expected results directly from generated scalar inputs rather than using the macro AST or interpreter helpers.

The initial run, preserved in `MACRO_BETA_1_0_FUZZ_INITIAL.json`, exercised **5,120 cases** and passed 5,117 in 3,497 ms on Node `v24.22.3`. The three failures were concrete caller-object boundary cases:

| Finding | Initial observation | Root correction; independent recheck |
| --- | --- | --- |
| Nonenumerable command getter, P2 | A hidden `name` accessor on `track.add` parameters passed validation, leaving executable data for a later handler read. | Inspect all own keys and descriptors before values. Rejected as `CommandValidationError`, getter calls **0**. |
| Nonenumerable array-index getter, P2 | A hidden accessor at `selection.set`'s `channels[0]` ran once during array-item schema validation. | Check dense array data descriptors, including nonenumerable indices. Rejected as `CommandValidationError`, getter calls **0**. |
| Inherited AST location getter, P2 | `ast.loc = Object.create({get line(){...},column:1})` invoked the inherited getter twice during formatting. | Require a plain location object and own numeric data descriptors. Rejected as `MacroError`, getter calls **0**. |

The independent corrected rerun passed **5,120 / 5,120** in **3,342 ms** with the same corpus SHA-256 `358e0ebed48ffc0214d7f785679c126101d6f28a96aa834c8e54a8be547162cc`. Its report contains source-file hashes and measured phase durations. Counts were:

- **4,096 parser mutations:** 2,267 accepted and semantically identical after parse→format→parse with locations omitted; 1,829 controlled syntax rejections.
- **512 generated valid programs:** arithmetic, comparison, Boolean logic, repeat/for/while, break/continue and object/array reads all matched the independent oracle.
- **512 schema/control/object cases:** 128 valid schemas, 128 invalid schemas, 128 later static errors rejected before earlier edits, 64 dynamic errors with command/location/completed-step evidence, 32 cancellation/busy/resource cases and 32 hostile-data cases.
- **Zero** unexpected raw parser errors, forbidden getter calls, ambient network calls or `Object.prototype` changes in the corrected run.

The bounds cases include command/iteration/value/time budgets, pre-aborted and in-flight cancellation, busy preflight, runtime queue limits, aggregate binary/text payloads, source byte/depth limits, sparse/cyclic data and unavailable commands. The corpus is deliberately bounded; these timings and cases do not establish exhaustive correctness, protection from arbitrary JavaScript `Proxy` behavior, or browser/hardware-independent performance.

## Boundaries and remaining evidence

The reviewed interpreter dispatches named registered commands and does not use `eval` or ambient JavaScript function execution for macro text. Own-property restrictions, forbidden prototype keys, preflight capability checks, operation/iteration limits, cancellation and aggregate variable bounds remain part of the contract. This review and corpus concentrated on concrete counterexamples to those boundaries; browser integration and end-to-end release workflow gates remain separate evidence recorded by the root owner.

## External PR #3: nested commands concealed by a flat visual step

Reviewed the metadata and both changed-file patches of [PR #3](https://github.com/djshellshoxxx/websoundedit/pull/3), head `034f207bdc994a631fbe082bfdbaca474c531cbf`, against the current integration tree rather than replacing files from its older base. The initial current `src/macro.js` SHA-256 was `6ebb6d76e8b1e9e0513917416e2c0674f4fe15986ceadf3399dbc1a4987168af`.

**Confirmed reproduction:** `stepsToMacro([{method:'track.add',paramsSource:'{name: project.new({name: "Replaced"})}'}])` produced a macro which `macroToSteps()` represented as exactly one `track.add` step. Running that text against a fresh, synthetic `AudioEditor` with one preexisting track invoked `project.new` before rejecting the outer `track.add` name. The initial project had one track; afterwards its name was `Replaced` and it had zero tracks. The error was `MacroError`, `INVALID_ARGUMENT`, `params.name: expected string`, with `completedSteps: 1`. This is a visual representation defect with concrete project replacement; the text language intentionally permits registered command composition. No user project was opened or changed by the reproduction.

**Patch review and integration:** the PR's guards at both conversion boundaries address the correct scope. The integrated helper traverses only the defined semantic children of validated expression ASTs. This differs from the proposed generic `Object.entries()` traversal, which would also inspect ignored extra object fields and property-wrapper `type` getters on caller-supplied ASTs. The narrow traversal does not introduce that extra object-access surface. `stepsToMacro()` now rejects a nested call with guidance to use the text editor; `macroToSteps()` returns `null` for text or validated AST input that contains a nested call. Parser, interpreter, command dispatch and recorder source were unchanged.

**Independent corrected verification:** `node --test tests/macro.test.js tests/macro-visual-step-guard.test.js` passed **28 / 28**, zero skipped or failed, in **553.112 ms** on the local Node runner. Five new tests cover the reported reset case, nested calls in every expression container (including inactive Boolean branches), ordinary visual expressions and round-trip preservation, ignored extra-field getters with invocation count **0**, and actual text execution of `track.add({name: project.state({}).name})`. That text still executes `project.state` then `track.add`, reports two completed commands and creates the expected named track. Existing macro, recorder, schema and command ownership regressions also passed. No claim is made here about a subsequent CI run or release deployment.
