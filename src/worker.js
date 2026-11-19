import { AudioEditor, COMMANDS } from './engine.js';
const editor = new AudioEditor();
let queue = Promise.resolve();
self.onmessage = ({data}) => {
  queue = queue.then(async () => {
    try {
      const result = data.method === '$commands' ? COMMANDS : await editor.execute(data.method, data.params || {});
      self.postMessage({ id: data.id, result, state: editor.getState() });
    } catch (error) { self.postMessage({ id: data.id, error: { message: error.message, code: error.code || error.name }, state: editor.getState() }); }
  });
};
