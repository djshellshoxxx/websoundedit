import { messageCost } from './message-budget.js';
export class EngineClient extends EventTarget {
  constructor({ maxPending = 32, maxPendingBytes = 768 * 1024 * 1024 } = {}) {
    super();
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32 || !Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1 || maxPendingBytes > 768 * 1024 * 1024) throw new RangeError('Invalid audio worker queue limits.');
    this.nextId = 0; this.pending = new Map(); this.state = null; this.queuedBytes = 0;
    this.maxPending = maxPending; this.maxPendingBytes = maxPendingBytes; this.failure = null;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'});
    this.worker.onmessage = ({data}) => {
      const pending = this.pending.get(data?.id); if(!pending) return;
      this._release(data.id); if (data.state) this.state = data.state;
      if (data.error) pending.reject(Object.assign(new Error(data.error.message), {code:data.error.code}));
      else pending.resolve(data.result);
      if (data.state) this.dispatchEvent(new CustomEvent('state', {detail:{state:data.state,method:pending.method}}));
    };
    this.worker.onerror = error => this._fail(Object.assign(new Error(error.message || 'Audio worker stopped. Reload the saved project.'), { code: 'WORKER_FAILED' }));
    this.worker.onmessageerror = () => this._fail(Object.assign(new Error('The audio worker returned an unreadable response. Reload the saved project.'), { code: 'WORKER_FAILED' }));
  }
  _release(id) { const entry = this.pending.get(id); if (entry) { this.pending.delete(id); this.queuedBytes -= entry.bytes; } }
  _fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.queuedBytes = 0; this.worker.terminate?.();
  }
  execute(method, params={}) {
    return new Promise((resolve,reject) => {
      if (this.failure) { reject(this.failure); return; }
      if (typeof method !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) { reject(new TypeError('Commands require a method string and a parameters object.')); return; }
      if (this.pending.size >= this.maxPending) { reject(Object.assign(new Error('Audio worker queue is full. Wait for the active edit.'), { code: 'RESOURCE_LIMIT' })); return; }
      let bytes;
      try { bytes = messageCost(params, this.maxPendingBytes - this.queuedBytes); } catch (error) { reject(error); return; }
      const id=++this.nextId; this.pending.set(id,{resolve,reject,method,bytes}); this.queuedBytes += bytes;
      try { this.worker.postMessage({id,method,params}); } catch (error) { this._release(id); reject(error); }
    });
  }
  getState() { return this.state; }
  commands() { return this.execute('$commands'); }
  dispose() { this._fail(Object.assign(new Error('The audio editor has been disposed.'), { code: 'DISPOSED' })); }
}
