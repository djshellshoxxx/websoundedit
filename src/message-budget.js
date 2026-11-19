/** Conservative structured-message cost; reject before cloning into a worker.
 * Read only own data descriptors so a preflight estimate never invokes a getter.
 * Structured-clone arrays must be dense and bounded: holes can otherwise make
 * a near-zero cost estimate for a very large destination allocation.
 */
const MAX_NODES = 1_000_000;
const limitError = message => Object.assign(new Error(message), { code: 'RESOURCE_LIMIT' });
export function messageCost(value, limit = 768 * 1024 * 1024) {
  const seen = new Set(), buffers = new Set(), stack = [value];
  let bytes = 0, nodes = 0;
  while (stack.length) {
    if (++nodes > MAX_NODES) throw limitError('Message contains too many values.');
    const item = stack.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item); bytes += 32;
      const buffer = ArrayBuffer.isView(item) ? item.buffer : item instanceof ArrayBuffer ? item : null;
      if (buffer) {
        if (!buffers.has(buffer)) { buffers.add(buffer); bytes += buffer.byteLength; }
      } else {
        const isArray = Array.isArray(item);
        if (isArray ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
          throw new TypeError('Command messages require plain objects, arrays or PCM buffers.');
        }
        if (isArray && item.length > MAX_NODES - nodes) throw limitError('Message array exceeds its element limit.');
        const keys = Reflect.ownKeys(item);
        if (keys.length > MAX_NODES - nodes + (isArray ? 1 : 0)) throw limitError('Message contains too many values.');
        if (isArray && keys.length !== item.length + 1) throw new TypeError('Command message arrays must be dense and contain only indexed values.');
        for (const key of keys) {
          if (isArray && key === 'length') continue;
          if (typeof key !== 'string' || isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) {
            throw new TypeError('Command message contains an unsupported property.');
          }
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError('Command message accessors are not accepted.');
          }
          bytes += key.length * 2;
          stack.push(descriptor.value);
        }
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new TypeError('Command messages cannot contain executable or unsupported values.');
    }
    if (bytes > limit) throw limitError('Queued audio messages exceed the data budget.');
  }
  return bytes;
}
