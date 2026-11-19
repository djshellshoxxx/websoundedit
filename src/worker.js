import { AudioEditor, COMMANDS } from './engine.js';
import { messageCost } from './message-budget.js';
const editor = new AudioEditor();
let queue = Promise.resolve(), jobs = 0, bytes = 0;
self.onmessage = ({data}) => {
  if (!data || !Number.isSafeInteger(data.id) || data.id < 1) return;
  let cost;
  const errorResponse = error => self.postMessage({ id: data.id, error: { message: error.message, code: error.code || error.name }, state: editor.getState() });
  try {
    if (jobs >= 32) throw Object.assign(new Error('Audio worker queue is full.'), { code: 'RESOURCE_LIMIT' });
    cost = messageCost(data.params, 768 * 1024 * 1024 - bytes);
  } catch (error) { errorResponse(error); return; }
  jobs++; bytes += cost;
  const task = async () => {
    try {
      const params = data.params === undefined ? {} : data.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Command parameters must be an object.');
      const result = data.method === '$commands' ? COMMANDS : await editor.execute(data.method, params);
      self.postMessage({ id: data.id, result, state: editor.getState() });
    } catch (error) { errorResponse(error); }
    finally { jobs--; bytes -= cost; }
  };
  queue = queue.then(task, task).catch(() => {});
};
