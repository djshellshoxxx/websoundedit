/** Admission is held through response completion, including slow readers. */
export class ApiAdmission {
  constructor({ maxJobs = 8, maxBytes = 512 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 64 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new RangeError('Invalid API admission limits.');
    this.maxJobs = maxJobs; this.maxBytes = maxBytes; this.jobs = 0; this.bytes = 0;
  }
  acquire() {
    const fail = () => { throw Object.assign(new Error('Local API queue is full. Retry after an active request completes.'), { code: 'QUEUE_LIMIT', status: 429 }); };
    if (this.jobs >= this.maxJobs) fail();
    this.jobs++;
    let bytes = 0, released = false;
    return {
      reserve: size => { if (released || !Number.isSafeInteger(size) || size < 0) throw new TypeError('Invalid body reservation.'); if (size > this.maxBytes - this.bytes) fail(); this.bytes += size; bytes += size; },
      release: () => { if (!released) { released = true; this.jobs--; this.bytes -= bytes; } },
    };
  }
  state() { return { jobs: this.jobs, bytes: this.bytes, maxJobs: this.maxJobs, maxBytes: this.maxBytes }; }
}

export function boundedJson(value, maxBytes = 384 * 1024 * 1024) {
  const stack = [{ value, depth: 0 }]; let budget = 0, count = 0;
  const fail = () => { throw Object.assign(new Error('JSON response exceeds its limit. Use the binary export endpoint for large PCM.'), { code: 'RESOURCE_LIMIT', status: 413 }); };
  while (stack.length) {
    const { value: item, depth } = stack.pop();
    if (++count > 2000000 || depth > 64) fail();
    if (item instanceof Float32Array) budget += item.length * 26 + 2;
    else if (typeof item === 'string') budget += jsonStringSize(item);
    else if (item && typeof item === 'object') {
      budget += 2;
      for (const key of Object.keys(item)) { budget += jsonStringSize(key) + 2; stack.push({ value: item[key], depth: depth + 1 }); }
    } else budget += 26;
    if (budget > maxBytes) fail();
  }
  const result = JSON.stringify(value, (_, item) => item instanceof Float32Array ? Array.from(item) : item);
  if (Buffer.byteLength(result) > maxBytes) fail();
  return result;
}

function jsonStringSize(text) {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
