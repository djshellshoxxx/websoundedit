import { encodeOpus } from './opus.js';

// One worker handles one export and is terminated by its owner afterward. PCM
// arrives in transferred copies, leaving the editor's original samples intact.
self.onmessage = async ({ data: { audio, bitrate } }) => {
  try {
    const bytes = await encodeOpus(audio, {
      bitrate,
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'result', bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
