/** Portable-project recovery in IndexedDB, never localStorage PCM.
 * https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
 */
const DATABASE = 'websoundedit';
const VERSION = 1;
const STORE = 'recovery';
const KEY = 'current';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Recovery storage is unavailable in this browser. Export a project JSON to keep your work.')); return; }
    let settled = false;
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('Recovery storage is blocked by another open editor tab. Close that tab and retry.'));
    };
    request.onerror = () => { settled = true; reject(request.error || new Error('Could not open recovery storage.')); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
async function transact(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let value, transaction, request;
    try {
      transaction = db.transaction(STORE, mode);
      request = operation(transaction.objectStore(STORE));
    } catch (error) { db.close(); reject(error); return; }
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => { db.close(); resolve(value); };
    const failed = () => { db.close(); reject(transaction.error || request.error || new Error('Recovery storage transaction failed.')); };
    transaction.onerror = failed;
    transaction.onabort = failed;
  });
}
export async function saveRecovery(projectObject) {
  if (!projectObject || typeof projectObject !== 'object' || Array.isArray(projectObject)) throw new TypeError('Recovery requires a project object.');
  const savedAt = Date.now();
  await transact('readwrite', (store) => store.put({ version: 1, savedAt, project: projectObject }, KEY));
  return { savedAt };
}
export async function loadRecovery() {
  const record = await transact('readonly', (store) => store.get(KEY));
  return record?.version === 1 ? record.project : null;
}
export async function clearRecovery() {
  await transact('readwrite', (store) => store.delete(KEY));
}
