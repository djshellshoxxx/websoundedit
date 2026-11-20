/** Exact, user-supplied research model supported by the isolated Stem Lab.
 * No model weights are bundled or downloaded by the application.
 * See docs/STEM_ISOLATION.md for provenance and release qualification.
 */
export const STEM_MODEL = Object.freeze({
  id: 'htdemucs-onnx-fp16weights-d54ed9e',
  filename: 'htdemucs_fp16weights.onnx',
  revision: 'd54ed9eb60e258ea82131c6ee14578628816456a',
  byteLength: 165612636,
  sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
  sampleRate: 44100,
  segmentFrames: 343980,
  overlapFrames: 85995,
  maxSeconds: 30,
  inputName: 'mix',
  outputName: 'stems',
  stemNames: Object.freeze(['drums', 'bass', 'other', 'vocals']),
  modelCardUrl: 'https://huggingface.co/StemSplitio/htdemucs-onnx/blob/d54ed9eb60e258ea82131c6ee14578628816456a/README.md',
  modelFileUrl: 'https://huggingface.co/StemSplitio/htdemucs-onnx/blob/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx',
});
