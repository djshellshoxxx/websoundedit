# Stem Lab: neural isolation prototype

Stem Lab explores real model-based source separation in WebSoundEdit's static browser application.
It is an experimental workflow separate from the existing stereo center/side presets.
Those presets remain useful spatial effects; their channel arithmetic cannot identify instruments.
Stem Lab instead runs a pretrained HTDemucs neural network to estimate four musical sources.

## Try the prototype

1. Open **Stem Lab** from the editor's preset panel, or open `stem-lab.html` directly.
2. Choose the supported ONNX model from your own computer, then select **Load model**. See its identity below.
3. Choose a mono or stereo WAV clip no longer than **30 seconds**, up to **24 MiB**.
4. Run separation. Input is resampled to **44,100 Hz** with the browser's native audio resampler when needed.
5. Audition or download **vocals**, **drums**, **bass**, **other**, or **instrumental**.
6. Import a downloaded stem into the editor to continue editing. The source clip remains unchanged.

Output downloads are stereo **32-bit float WAV at 44,100 Hz**.
Float export preserves predicted values above full scale instead of clipping them during export.
The separate 16-bit playback previews clamp values outside full scale; downloads retain the float predictions.
The instrumental is the sum of the three predicted non-vocal stems: drums, bass, and other.
It is not the original mix with a center channel removed.

Mono input is duplicated into both model channels; separation does not require stereo differences.
Inputs with more than two channels are outside this prototype's supported contract.
The duration limit applies before inference; the prototype does not silently truncate a longer track.
WAV is the intentionally narrow input format for this experiment. Convert other formats in the editor first.
Inputs must contain finite samples within full scale, including after resampling.
If a source is rejected for peaks, normalize it to -1 dBFS in the editor and export again to leave resampling headroom.

## Supported model

Only this exact file is accepted. The prototype checks its size and SHA-256 before loading it.
Renaming a different model does not make it compatible.

| Property | Required value |
| --- | --- |
| Publisher repository | `StemSplitio/htdemucs-onnx` |
| Filename | `htdemucs_fp16weights.onnx` |
| Revision | `d54ed9eb60e258ea82131c6ee14578628816456a` |
| Size | `165612636` bytes, approximately 166 MB |
| SHA-256 | `d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a` |
| Model family | Single HTDemucs model with four meaningful output stems |

The [pinned model card](https://huggingface.co/StemSplitio/htdemucs-onnx/blob/d54ed9eb60e258ea82131c6ee14578628816456a/README.md)
and [pinned file metadata](https://huggingface.co/StemSplitio/htdemucs-onnx/blob/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx)
identify the research artifact. Acquire it separately under the applicable terms.
The application does not fetch, bundle, or redistribute model weights.
The similarly named fine-tuned specialist models are not interchangeable: only their designated source row is intended for use.

## Inference contract

| Property | Contract |
| --- | --- |
| Runtime | ONNX Runtime Web `1.31.1`, WebAssembly CPU execution |
| Input tensor | `mix`, float32, `[1, 2, 343980]` |
| Input layout | Planar stereo: all left-channel samples, then all right-channel samples |
| Model sample rate | `44100` Hz |
| Segment length | `343980` frames, or 7.8 seconds |
| Output tensor | `stems`, float32, `[1, 4, 2, 343980]` |
| Output source order | `drums`, `bass`, `other`, `vocals` |
| Segment overlap | `85995` frames, or 25% |
| Segment stride | `257985` frames |
| Final segment | Right-pad with zeros; discard padded output frames |

The input is raw waveform PCM. Do **not** add an external track mean/std normalization or denormalization step.
This export contains HTDemucs' own waveform and spectrogram branch normalization and scale restoration.
The [reference inference implementation](https://huggingface.co/StemSplitio/htdemucs-onnx/blob/d54ed9eb60e258ea82131c6ee14578628816456a/infer.py)
feeds raw float32 chunks to the graph, and the
[exporter](https://github.com/StemSplit/demucs-onnx/blob/85db5c80aba33f0f2bdf88034a4be6539feec85b/src/demucs_onnx/export/exporter.py)
exports the patched model directly, not the higher-level Demucs `Separator` API wrapper.
That wrapper's additional track normalization must not be assumed to be part of this interface.

Overlapping predictions are accumulated with strictly positive weights and divided by the accumulated weight.
Nonzero window endpoints avoid dropping the first and last predicted samples, including very short clips.
See the original [Demucs overlap-add implementation](https://github.com/facebookresearch/demucs/blob/main/demucs/apply.py).
Returned stems retain the resampled input's frame count and timing.
No independent loudness normalization is applied to each stem, so their relative levels remain usable for mixing.

## Local processing and cancellation

The model and audio are selected with local file inputs and processed in memory.
Stem Lab makes no model download, audio upload, or telemetry request.
The runtime JavaScript and WASM are served with the application from its own origin.
The prototype does not persist the selected model or audio between page loads.
Opening a provenance link is a separate browser navigation to the named external site.

Inference runs in a dedicated worker. Cancel terminates that worker, including an active inference call.
Retrying after cancellation requires a new runtime session; the interface must not publish a stale result.
Single-threaded WASM avoids requiring cross-origin isolation headers on GitHub Pages.
This prototype does not claim WebGPU acceleration or real-time processing.
See [ONNX environment options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

Graph optimization is disabled to avoid the large initialization spike observed with this graph.
A main-thread watchdog releases an unresponsive worker after 180 seconds without model-loading progress,
or 300 seconds without separation progress. Explicit Cancel remains available during either operation.

## Resources and evidence limits

The model publisher reports approximately **1.1 GB of native runtime RAM** for this model family.
That is an upstream measurement, not a measured browser requirement or guaranteed upper bound.
The fp16-stored file reduces model storage; execution remains float32 and does not halve working memory.
For a 30-second clip, the five stereo float outputs alone contain approximately **53 MB** of PCM.
Input, resampling, export copies, runtime initialization, and network activations require additional memory.
The 30-second cap bounds audio allocations; it does not make the neural model lightweight.
Use a desktop with substantial free memory for initial evaluation.
Browser/device memory limits can terminate a tab even when the model file is much smaller than available RAM.
See [ONNX guidance for large models](https://onnxruntime.ai/docs/tutorials/web/large-models.html).

The implementation's integration tests do not establish musical separation quality.
Actual browser inference, listening quality, and device performance require separate recorded evidence.
Until those results are recorded for this revision, treat all three as unqualified prototype behavior.
Synthetic or mocked inference tests can validate chunking and UI behavior but cannot establish stem quality.

### Repeatable execution checks

`node --test tests/stems-runtime.test.js tests/stem-wav-admission.test.js tests/wav.test.js`
checks bounded source admission, tensor layout, overlap boundaries, cancellation and WAV preservation with synthetic predictions.

To execute the real model in the same WASM runtime under Node, supply its local path:

```bash
npm run test:stem-model -- /path/to/htdemucs_fp16weights.onnx
```

This optional check uses nine seconds of centered synthetic instruments and two inference chunks.
It records `test-results/stem-model-node.json` only after successful inference and float WAV round trips.
It is an execution check, not a music-quality benchmark or a browser qualification.

For actual browser inference, build the app and run:

```bash
WSE_STEM_MODEL_PATH=/path/to/htdemucs_fp16weights.onnx npx playwright test tests/stem-model.spec.js --project=chromium
```

The ordinary browser suite skips this expensive test when the model path is absent.
The separate `Verify neural stem prototype` CI workflow obtains the pinned model only for ephemeral research testing,
checks its hash, runs this browser test, and removes the file. Model weights are excluded from published artifacts;
the real-model test disables tracing so a model upload cannot become a trace attachment.
No user audio is used. The application itself never obtains model weights from the network.

## Model provenance and release gates

Demucs code is MIT-licensed. The ONNX conversion's model card also labels the converted artifact MIT.
However, the original model author explicitly distinguishes the pretrained weights from the MIT code license
in [Demucs issue 327](https://github.com/facebookresearch/demucs/issues/327), describing the weights as supplied for scientific purposes.
The conversion's label does not resolve that upstream discrepancy.
This prototype therefore distributes only the integration and runtime, with a user-supplied research model.
See [third-party notices](THIRD_PARTY.md) for the component distinction.

Before replacing or promoting the production presets:

1. Resolve the model's permitted use and redistribution terms, or select a model with suitable explicit terms.
   Verify the runtime release's source correspondence and complete bundled notices described in [third-party notices](THIRD_PARTY.md).
2. Run the exact model and runtime in supported browsers; record successful initialization, finite output, cancellation, and timing.
3. Evaluate real music against known stems, including mono, off-center vocals, reverb, dense mixes, and instrumental-only material.
4. Listen for vocal bleed, missing instruments, artifacts, and discontinuities; measure separation quality against reference stems where available.
5. Measure cold-start time, processing time, peak memory, and cancellation on representative desktop and mobile devices.

Neural estimates may contain bleed or remove desired content. A successful tensor-shape check is not a quality score.
The five downloadable outputs are four model estimates plus one derived mix, not five independently trained predictions.
