import { saveRecovery, clearRecovery } from './storage.js';

/** Debounce snapshots and order storage writes without retaining stale audio.
 * A clear or batch transition invalidates snapshots still being serialized.
 * Clears also wait behind writes already in progress, so their completion means
 * an older write cannot recreate the recovery record afterward.
 */
export class RecoveryScheduler {
  constructor({ snapshot, save = saveRecovery, clear = clearRecovery, onState = () => {}, delay = 1600, setTimer = (callback, ms) => globalThis.setTimeout(callback, ms), clearTimer = timer => globalThis.clearTimeout(timer) }) {
    this.snapshot = snapshot;
    this.save = save;
    this.remove = clear;
    this.onState = onState;
    this.delay = delay;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.revision = 0;
    this.timer = null;
    this.writes = Promise.resolve();
  }
  _notify(state, error) {
    try { this.onState(state, error); } catch { /* UI observers do not change storage outcomes. */ }
  }
  _enqueue(operation) {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  cancel() {
    this.revision++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  schedule() {
    this.cancel();
    const revision = this.revision;
    this._notify('pending');
    this.timer = this.setTimer(() => {
      this.timer = null;
      return this._capture(revision);
    }, this.delay);
  }
  async _capture(revision) {
    if (revision !== this.revision) return;
    try {
      const project = await this.snapshot();
      if (revision !== this.revision) return;
      await this._enqueue(async () => {
        if (revision !== this.revision) return;
        await this.save(project);
        if (revision === this.revision) this._notify('saved');
      });
    } catch (error) {
      if (revision === this.revision) this._notify('error', error);
    }
  }
  async clear() {
    this.cancel();
    const revision = this.revision;
    try {
      await this._enqueue(() => this.remove());
      if (revision === this.revision) this._notify('cleared');
      return { cleared: true };
    } catch (error) {
      if (revision === this.revision) this._notify('error', error);
      throw error;
    }
  }
}
