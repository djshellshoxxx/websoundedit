import { STEM_MODEL } from './model.js';
import { validateStemAudio } from './pipeline.js';

function abortError(message = 'Stem separation cancelled. Reload the model to run again.') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

/** One dedicated worker and one active operation; cancellation releases both. */
export class StemSeparationClient {
  constructor({ onProgress = () => {} } = {}) {
    this.onProgress = onProgress;
    this.worker = null;
    this.pending = null;
    this.watchdog = null;
    this.nextId = 0;
    this.isReady = false;
    this.disposed = false;
  }

  _assertAvailable() {
    if (this.disposed) throw new Error('The stem separator has been disposed.');
    if (this.pending) throw new Error('A stem operation is already running. Wait or cancel it first.');
  }

  _stop(error) {
    this._clearWatchdog();
    const pending = this.pending;
    this.pending = null;
    this.isReady = false;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    pending?.reject(error);
  }

  _clearWatchdog() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  _armWatchdog() {
    this._clearWatchdog();
    const pending = this.pending;
    if (!pending) return;
    const loading = pending.method === 'loadModel';
    this.watchdog = setTimeout(() => {
      if (this.pending !== pending) return;
      const message = loading
        ? 'Model loading stopped making progress for 3 minutes. The worker was released. This device may lack memory or processing resources; reload the model or try another device.'
        : 'Stem separation stopped making progress for 5 minutes. The worker was released. This device may lack memory or processing resources; reload the model and try a shorter excerpt or another device.';
      this._stop(Object.assign(new Error(message), { name: 'TimeoutError' }));
    }, loading ? 180_000 : 300_000);
    // Node-based transport tests must not retain the process for a browser timer.
    this.watchdog?.unref?.();
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker || !this.pending || data?.id !== this.pending.id) return;
      if (data.type === 'progress') {
        this._armWatchdog();
        // A UI reporter cannot strand a running model by throwing.
        try { this.onProgress(data.progress); } catch { /* Reporting is optional. */ }
        return;
      }
      const pending = this.pending;
      if (data.type === 'error') {
        this._stop(Object.assign(new Error(data.error?.message || 'Stem separation failed.'), { name: data.error?.name || 'Error' }));
        return;
      }
      if (data.type !== 'result' || (pending.method === 'loadModel' && data.result?.ready !== true)) {
        this._stop(new Error('The stem worker returned an unreadable response. Reload the model.'));
        return;
      }
      this._clearWatchdog();
      this.pending = null;
      if (pending.method === 'loadModel') this.isReady = true;
      pending.resolve(data.result);
    };
    worker.onerror = event => {
      if (worker === this.worker) this._stop(new Error(event.message || 'The stem worker stopped. Reload the model.'));
    };
    worker.onmessageerror = () => {
      if (worker === this.worker) this._stop(new Error('The stem worker could not read its response. Reload the model.'));
    };
    return worker;
  }

  _request(method, params, transfer = []) {
    const worker = this._ensureWorker(), id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending = { id, method, resolve, reject };
      this._armWatchdog();
      try { worker.postMessage({ id, method, ...params }, transfer); }
      catch (error) { this._stop(error); }
    });
  }

  async loadModel(file) {
    this._assertAvailable();
    if (!(file instanceof Blob) || file.size !== STEM_MODEL.byteLength) throw new RangeError(`Choose the supported ${STEM_MODEL.filename} model (${STEM_MODEL.byteLength} bytes).`);
    this._stop(abortError('The previous stem model was released.'));
    const runtimeURL = new URL(`${import.meta.env?.BASE_URL || './'}stems-runtime/`, globalThis.location?.href || import.meta.url).href;
    return this._request('loadModel', { file, runtimeURL });
  }

  async separate(audio) {
    this._assertAvailable();
    if (!this.isReady) throw new Error('Load the supported local model before separating audio.');
    validateStemAudio(audio);
    // Only copies are transferred; the editor's source samples stay attached.
    const channels = audio.channels.map(channel => channel.slice());
    return this._request('separate', { audio: { sampleRate: audio.sampleRate, channels } }, channels.map(channel => channel.buffer));
  }

  cancel() { this._stop(abortError()); }
  dispose() { this.disposed = true; this._stop(abortError('The stem separator was disposed.')); }
}
