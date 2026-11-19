/** Conservative structured-message cost; reject before cloning into a worker. */
export function messageCost(value, limit = 768 * 1024 * 1024) {
  const seen = new Set(), buffers = new Set(), stack = [value];
  let bytes = 0, nodes = 0;
  while (stack.length) {
    if (++nodes > 1000000) throw Object.assign(new Error('Message contains too many values.'), { code: 'RESOURCE_LIMIT' });
    const item = stack.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item); bytes += 32;
      const buffer = ArrayBuffer.isView(item) ? item.buffer : item instanceof ArrayBuffer ? item : null;
      if (buffer) { if (!buffers.has(buffer)) { buffers.add(buffer); bytes += buffer.byteLength; } }
      else {
        if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Command messages require plain objects, arrays or PCM buffers.');
        for (const key of Object.keys(item)) { bytes += key.length * 2; stack.push(item[key]); }
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new TypeError('Command messages cannot contain executable or unsupported values.');
    if (bytes > limit) throw Object.assign(new Error('Queued audio messages exceed the data budget.'), { code: 'RESOURCE_LIMIT' });
  }
  return bytes;
}
