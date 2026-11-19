/** In-memory project ZIP reader. Validation and extraction use one entry list;
 * no archive path is ever opened on the filesystem or fetched from the network.
 */
import { inflateBounded, MAX_DEFLATE_BLOCKS } from './bounded-inflate.js';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; }
export function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => part === '..' || part === '.')) throw new Error('Project archive contains an unsafe file path.');
  return value;
}
function sameBytes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function checkExtra(view, start, length) {
  const end = start + length;
  for (let cursor = start; cursor < end;) {
    if (cursor + 4 > end) throw new Error('Invalid ZIP extra field.');
    const kind = view.getUint16(cursor, true), size = view.getUint16(cursor + 2, true); cursor += 4;
    if (kind === 1) throw new Error('Unsupported ZIP64 project archive.');
    if (cursor + size > end) throw new Error('Invalid ZIP extra field.'); cursor += size;
  }
}
export function readProjectZip(bytes, {
  accept = () => true,
  maxTotalBytes = 320 * 1024 * 1024,
  maxEntryBytes = () => 256 * 1024 * 1024,
} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > maxTotalBytes || bytes.length < 22) throw new Error('Invalid or oversized project ZIP.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  if (end < 0) throw new Error('Invalid project ZIP directory.');
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), directoryEnd = start + view.getUint32(end + 12, true);
  if (count !== view.getUint16(end + 8, true) || count > 20000 || count === 65535 || directoryEnd > end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)) throw new Error('Unsupported ZIP64, multipart or oversized project archive.');
  let cursor = start, total = 0; const seen = new Set(), entries = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid project ZIP entry.');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), checksum = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true);
    const extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength + extra + comment > directoryEnd || flags & ~0x080e || view.getUint16(cursor + 34, true)) throw new Error('Invalid or encrypted project ZIP entry.');
    if ((view.getUint32(cursor + 38, true) >>> 16 & 0xf000) === 0xa000) throw new Error('Symbolic links are unsupported in project archives.');
    const encodedName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), path = safeArchivePath(new TextDecoder('utf-8', { fatal: true }).decode(encodedName));
    if (seen.has(path)) throw new Error('Duplicate project ZIP path.'); seen.add(path);
    if (size > maxEntryBytes(path) || size > 256 * 1024 * 1024 || (total += size) > maxTotalBytes) throw new Error('Project archive exceeds the decompressed size limit.');
    if (compressed === 0xffffffff || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) throw new Error('Invalid project ZIP payload.');
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true), payload = local + 30 + localNameLength + localExtra;
    if (payload + compressed > start || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || ![0, 8].includes(method) || (method === 0 && compressed !== size)) throw new Error('Invalid project ZIP payload size or compression.');
    if (!sameBytes(encodedName, bytes.subarray(local + 30, local + 30 + localNameLength))) throw new Error('ZIP local and central filenames disagree.');
    for (const [offset, expected] of [[14, checksum], [18, compressed], [22, size]]) {
      const value = view.getUint32(local + offset, true);
      if (value !== expected && (!(flags & 8) || value !== 0)) throw new Error('ZIP local and central checksum or sizes disagree.');
    }
    checkExtra(view, cursor + 46 + nameLength, extra); checkExtra(view, local + 30 + localNameLength, localExtra);
    let payloadEnd = payload + compressed;
    if (flags & 8) {
      if (payloadEnd + 12 > start) throw new Error('Truncated ZIP data descriptor.');
      const matches = at => at + 12 <= start && view.getUint32(at, true) === checksum && view.getUint32(at + 4, true) === compressed && view.getUint32(at + 8, true) === size;
      // CRC32 can itself equal the optional signature. Test the complete
      // unsigned descriptor before deciding that its first word is a prefix.
      if (!matches(payloadEnd)) {
        if (view.getUint32(payloadEnd, true) !== 0x08074b50 || !matches(payloadEnd + 4)) throw new Error('ZIP data descriptor disagrees with its directory.');
        payloadEnd += 4;
      }
      payloadEnd += 12;
    }
    entries.push({ path, local, payload, payloadEnd, compressed, size, method, checksum }); cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== directoryEnd) throw new Error('Invalid project ZIP central-directory length.');
  let previousEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) { if (entry.local < previousEnd) throw new Error('Overlapping project ZIP payloads.'); previousEnd = entry.payloadEnd; }
  const files = new Map(), blockBudget = { remaining: MAX_DEFLATE_BLOCKS };
  for (const entry of entries) {
    if (!accept(entry.path) || entry.path.endsWith('/')) continue;
    const compressed = bytes.subarray(entry.payload, entry.payload + entry.compressed);
    const output = entry.method === 0 ? compressed.slice() : inflateBounded(compressed, entry.size, { blockBudget });
    if (output.length !== entry.size || crc32(output) !== entry.checksum) throw new Error(`Project ZIP checksum or size mismatch: ${entry.path}`);
    files.set(entry.path, output);
  }
  return files;
}
