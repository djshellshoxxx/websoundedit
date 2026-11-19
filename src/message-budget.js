/** Conservative structured-message cost; reject before cloning into a worker.
 * Inspect data descriptors rather than executing getters. Array slots and all
 * pending values reserve capacity before traversal; binary sizes come from
 * intrinsic accessors, never properties supplied by a caller.
 */
const MAX_NODES = 1_000_000;
const limitError = message => Object.assign(new Error(message), { code: 'RESOURCE_LIMIT' });
const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const viewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const sharedLength = typeof SharedArrayBuffer === 'undefined' ? null : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const containerBrands = [
  Object.getOwnPropertyDescriptor(Map.prototype, 'size').get,
  Object.getOwnPropertyDescriptor(Set.prototype, 'size').get,
  ...(sharedLength ? [sharedLength] : []),
];
const plainMessageError = () => new TypeError('Command messages require plain objects, arrays or PCM buffers.');

function binaryStorage(item) {
  if (ArrayBuffer.isView(item)) {
    let buffer;
    try { buffer = typedBuffer.call(item); } catch { buffer = viewBuffer.call(item); }
    let byteLength;
    try { byteLength = bufferLength.call(buffer); }
    catch { if (!sharedLength) throw plainMessageError(); byteLength = sharedLength.call(buffer); }
    return { buffer, byteLength };
  }
  // An ArrayBuffer can retain its cloneable storage after its prototype changes.
  try { return { buffer: item, byteLength: bufferLength.call(item) }; } catch { return null; }
}

function hiddenContainer(item) {
  for (const getSize of containerBrands) {
    try { getSize.call(item); return true; } catch { /* Not this built-in brand. */ }
  }
  return false;
}

export function messageCost(value, limit = 768 * 1024 * 1024) {
  const seen = new Set(), buffers = new Set(), stack = [value];
  let bytes = 0, nodes = 0;
  const charge = amount => {
    bytes += amount;
    if (bytes > limit) throw limitError('Queued audio messages exceed the data budget.');
  };
  while (stack.length) {
    if (++nodes > MAX_NODES) throw limitError('Message contains too many values.');
    const item = stack.pop();
    if (typeof item === 'string') charge(item.length * 2);
    else if (typeof item === 'number' || typeof item === 'boolean') charge(8);
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item); charge(32);
      const isArray = Array.isArray(item), storage = isArray ? null : binaryStorage(item);
      if (storage) {
        if (!buffers.has(storage.buffer)) { buffers.add(storage.buffer); charge(storage.byteLength); }
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (isArray ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype) || hiddenContainer(item)) throw plainMessageError();
        const remaining = MAX_NODES - nodes - stack.length;
        const length = isArray ? Object.getOwnPropertyDescriptor(item, 'length').value : 0;
        if (isArray && length > remaining) throw limitError('Message array exceeds its element limit.');
        const keys = Reflect.ownKeys(item);
        if (keys.length - (isArray ? 1 : 0) > remaining) throw limitError('Message contains too many values.');
        if (isArray && keys.length !== length + 1) throw new TypeError('Command message arrays must be dense and contain only indexed values.');
        for (const key of keys) {
          if (isArray && key === 'length') continue;
          if (typeof key !== 'string' || isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new TypeError('Command message contains an unsupported property.');
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError('Command message accessors are not accepted.');
          if (isArray && !descriptor.enumerable) throw new TypeError('Command message array indices must be enumerable.');
          charge(key.length * 2);
          stack.push(descriptor.value);
        }
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new TypeError('Command messages cannot contain executable or unsupported values.');
  }
  return bytes;
}
