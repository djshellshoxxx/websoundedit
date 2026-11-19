export class EngineClient extends EventTarget {
  constructor() {
    super(); this.nextId = 0; this.pending = new Map(); this.state = null;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'});
    this.worker.onmessage = ({data}) => {
      const pending = this.pending.get(data.id); if(!pending) return;
      this.pending.delete(data.id); this.state = data.state;
      if (data.error) pending.reject(Object.assign(new Error(data.error.message), {code:data.error.code}));
      else pending.resolve(data.result);
      this.dispatchEvent(new CustomEvent('state', {detail:{state:data.state,method:pending.method}}));
    };
    this.worker.onerror = error => { for(const p of this.pending.values()) p.reject(new Error(error.message || 'Audio worker stopped. Reload the saved project.')); this.pending.clear(); };
  }
  execute(method, params={}) { return new Promise((resolve,reject) => {const id=++this.nextId; this.pending.set(id,{resolve,reject,method}); this.worker.postMessage({id,method,params});}); }
  getState() { return this.state; }
  commands() { return this.execute('$commands'); }
}
